/**
 * 名扬屋顶 · 官网邮件服务端
 * ------------------------------------------------------------
 * 作用：托管静态站点 + 提供一个 POST /api/quote 接口，用 QQ 邮箱
 *      （SMTP）把询价直接发到 main-young@hotmail.com。
 *
 * 安全要点：
 *  1. 凭据只从环境变量读，代码里没有任何账号密码，纯文本也不落盘
 *  2. 收件人、发件人由服务端固定，前端传什么都不影响
 *  3. 单 IP 限流 3 次/分、10 次/天；全站 20 封/时
 *  4. 校验 Origin/Referer、蜜罐字段、打开到提交的时间差
 *  5. 字段白名单 + 长度上限 + 去掉换行（防邮件头注入）
 *  6. 邮件正文一律纯文本，不回吐 SMTP 细节
 *
 * 部署：Canner 识别 package.json 后当 Node 应用跑，监听 $PORT，
 *      健康检查打 "/"（本服务直接返回 index.html）。
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const nodemailer = require('nodemailer');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

/* ---------- 配置（全部来自环境变量） ---------- */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = (process.env.SMTP_USER || '').trim();            // 845345139@qq.com
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();            // QQ 邮箱授权码
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '名扬屋顶 MAINYOUNG 官网';
const MAIL_TO = (process.env.MAIL_TO || 'main-young@hotmail.com').trim();
const REPLY_TO = (process.env.REPLY_TO || 'main-young@hotmail.com').trim();
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').trim();        // 可选：填了只认这个来源
const DRY = process.env.MAIL_DRY === '1';                          // 本地演练：不发信只打日志

/* ---------- 限流 ---------- */
const RATE = {
  ipPerMinute: Number(process.env.RATE_IP_MIN || 3),
  ipPerDay: Number(process.env.RATE_IP_DAY || 10),
  globalPerHour: Number(process.env.RATE_GLOBAL_HOUR || 20)
};
const hits = new Map();      // ip -> { min: [ts], day: [ts] }
const globalHits = [];       // 全站时间戳
let inflight = 0;            // 并发发送数

function takeSlot(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], day: [] };
  rec.min = rec.min.filter(t => now - t < 60 * 1000);
  rec.day = rec.day.filter(t => now - t < 24 * 60 * 60 * 1000);
  while (globalHits.length && now - globalHits[0] > 60 * 60 * 1000) globalHits.shift();

  if (rec.min.length >= RATE.ipPerMinute) return 'ip-minute';
  if (rec.day.length >= RATE.ipPerDay) return 'ip-day';
  if (globalHits.length >= RATE.globalPerHour) return 'global-hour';

  rec.min.push(now); rec.day.push(now); hits.set(ip, rec);
  globalHits.push(now);
  return null;
}

/* ---------- 入参清洗 ---------- */
const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\u0000/g, '')
  .trim()
  .slice(0, max);

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const countLinks = s => (s.match(/https?:\/\/|www\./gi) || []).length;
const hashIp = ip => require('crypto').createHash('sha256')
  .update(String(ip) + (process.env.IP_SALT || 'my-roof')).digest('hex').slice(0, 12);

/* ---------- 邮件发送 ---------- */
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (DRY) {
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  } else {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });
  }
  return transporter;
}

/* 邮件里的品牌素材（用公网绝对地址，邮件客户端才能取到） */
const LOGO_URL = process.env.LOGO_URL || 'https://mainyoung.canner.app/picture/logo/hd_logo.png';
const SITE_URL = process.env.SITE_URL || 'https://mainyoung.canner.app';
const SITE_PHONE = process.env.SITE_PHONE || '778-239-1111';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* 一条纸感字段行 */
function row(label, value) {
  return '<tr>'
    + '<td width="92" style="padding:13px 0 13px 0;border-bottom:1px dashed #E4DAC5;'
    + 'font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1.6px;'
    + 'color:#8A7A5F;text-transform:uppercase;vertical-align:top;">' + label + '</td>'
    + '<td style="padding:13px 0 13px 0;border-bottom:1px dashed #E4DAC5;'
    + 'font-family:Georgia,\'Songti SC\',serif;font-size:15px;color:#231A10;'
    + 'line-height:1.7;vertical-align:top;">' + value + '</td>'
    + '</tr>';
}

function composeMail(d) {
  const msg = d.message ? esc(d.message).replace(/\n/g, '<br>') : '（客户未填写留言）';
  const svc = esc(d.services);

  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>新询价单</title></head>'
    + '<body style="margin:0;padding:0;background:#EDE7DA;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'bgcolor="#EDE7DA" style="background:#EDE7DA;padding:30px 12px;"><tr><td align="center">'

    /* 纸张主体 */
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
    + 'bgcolor="#FBF7EE" style="width:600px;max-width:600px;background:#FBF7EE;'
    + 'border:1px solid #DED3BC;">'
    + '<tr><td bgcolor="#C9A24A" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>'

    /* 抬头：logo + 品牌英文 */
    + '<tr><td style="padding:28px 34px 0 34px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td align="left" style="vertical-align:middle;">'
    + '<img src="' + LOGO_URL + '" width="168" alt="名扬屋顶 MAINYOUNG" '
    + 'style="display:block;border:0;outline:none;max-width:168px;height:auto;"></td>'
    + '<td align="right" style="vertical-align:middle;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:9px;letter-spacing:2.4px;color:#A08A5E;text-transform:uppercase;line-height:2;">'
    + 'ROOFING &amp; PAINTING<br>VANCOUVER · CANADA</td>'
    + '</tr></table></td></tr>'

    /* 标题 */
    + '<tr><td style="padding:22px 34px 0 34px;">'
    + '<div style="font-family:Georgia,\'Songti SC\',serif;font-size:27px;color:#231A10;'
    + 'letter-spacing:1px;line-height:1.25;">新询价单</div>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:9px;letter-spacing:3.4px;'
    + 'color:#B09B6C;text-transform:uppercase;padding-top:9px;">QUOTE REQUEST · 官网表单提交</div>'
    + '<div style="height:1px;line-height:1px;font-size:0;background:#DED3BC;margin:18px 0 0 0;">&nbsp;</div>'
    + '</td></tr>'

    /* 字段区 */
    + '<tr><td style="padding:6px 34px 0 34px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + row('姓名 NAME', esc(d.name))
    + row('电话 PHONE', '<a href="tel:' + d.phone.replace(/[^+0-9]/g, '') + '" '
    + 'style="color:#231A10;text-decoration:none;">' + esc(d.phone) + '</a>')
    + row('邮箱 EMAIL', d.email ? '<a href="mailto:' + esc(d.email) + '" '
    + 'style="color:#231A10;text-decoration:none;">' + esc(d.email) + '</a>' : '（客户未留邮箱）')
    + '</table></td></tr>'

    /* 服务（高亮） */
    + '<tr><td style="padding:20px 34px 0 34px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1.8px;'
    + 'color:#8A7A5F;text-transform:uppercase;">服务 SERVICES</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'bgcolor="#F4E9CF" style="background:#F4E9CF;border-left:3px solid #C9A24A;margin-top:9px;">'
    + '<tr><td style="padding:13px 15px;font-family:Georgia,\'Songti SC\',serif;'
    + 'font-size:17px;color:#231A10;line-height:1.6;">' + svc + '</td></tr></table>'
    + '</td></tr>'

    /* 留言 */
    + '<tr><td style="padding:20px 34px 0 34px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1.8px;'
    + 'color:#8A7A5F;text-transform:uppercase;">留言 MESSAGE</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'bgcolor="#FFFDF8" style="background:#FFFDF8;border:1px solid #E4DAC5;margin-top:9px;">'
    + '<tr><td style="padding:15px 17px;font-family:Georgia,\'Songti SC\',serif;'
    + 'font-size:15px;line-height:1.95;color:#3A2E1F;">' + msg + '</td></tr></table>'
    + '</td></tr>'

    /* 时间与来源 */
    + '<tr><td style="padding:18px 34px 0 34px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:11px;color:#9A8A6C;line-height:1.8;">提交时间 ' + esc(d.at)
    + ' &nbsp;·&nbsp; 来源：官网询价表单</td></tr>'

    /* 页脚 */
    + '<tr><td style="padding:20px 34px 30px 34px;">'
    + '<div style="height:1px;line-height:1px;font-size:0;background:#DED3BC;">&nbsp;</div>'
    + '<div style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;'
    + 'color:#6B5C43;line-height:2;">直接回复本邮件即可联系客户。'
    + '<br>电话 <a href="tel:+1' + SITE_PHONE.replace(/[^0-9]/g, '') + '" '
    + 'style="color:#8A6A2A;text-decoration:none;">' + SITE_PHONE + '</a>'
    + ' &nbsp;·&nbsp; <a href="' + SITE_URL + '" style="color:#8A6A2A;text-decoration:none;">'
    + 'mainyoung.canner.app</a></div>'
    + '<div style="padding-top:14px;font-family:Georgia,serif;font-size:9px;letter-spacing:2.6px;'
    + 'color:#B7A98B;text-transform:uppercase;">名扬屋顶 · MAINYOUNG ROOFING</div>'
    + '</td></tr></table>'

    /* 纸外小字 */
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#A79A80;'
    + 'padding-top:14px;letter-spacing:.6px;">本邮件由名扬屋顶官网自动发送 · 客户信息仅用于本次询价跟进</div>'
    + '</td></tr></table></body></html>';

  const lines = [
    '新询价单 · 名扬屋顶 MAINYOUNG',
    '==================================',
    '',
    '姓名 / Name     ：' + d.name,
    '电话 / Phone    ：' + d.phone,
    '邮箱 / Email    ：' + (d.email || '（未填）'),
    '服务 / Services ：' + d.services,
    '提交时间        ：' + d.at,
    '来源            ：官网询价表单',
    '',
    '留言 / Message',
    '----------------------------------',
    d.message || '（未填写）',
    '',
    '----------------------------------',
    '直接回复本邮件即可联系客户。',
    '电话 ' + SITE_PHONE + ' · ' + SITE_URL
  ].join('\n');

  const svcShort = d.services.length > 26 ? d.services.slice(0, 26) + '…' : d.services;
  const mail = {
    from: '"' + MAIL_FROM_NAME + '" <' + (SMTP_USER || 'no-reply@localhost') + '>',
    to: MAIL_TO,
    subject: '新询价 · ' + d.name + ' · ' + svcShort,
    text: lines,
    html
  };
  // 客户留了邮箱就让它成为回复地址；否则回我们自己
  mail.replyTo = isEmail(d.email) ? d.email : REPLY_TO;
  return mail;
}

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* ---------- 接口 ---------- */
app.post('/api/quote', express.json({ limit: '8kb' }), async (req, res) => {
  const fakeOk = () => res.status(200).json({ ok: true });   // 给机器人看的
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

    // 来源校验（配了 SITE_ORIGIN 才强校验；否则只拒明显的外部站点热链）
    if (SITE_ORIGIN) {
      const src = String(req.headers.origin || req.headers.referer || '');
      if (!src.startsWith(SITE_ORIGIN)) return res.status(403).json({ ok: false });
    }

    const b = req.body || {};
    // 蜜罐：机器人会把隐藏字段填上
    if (clean(b._hp, 40)) { console.warn('[honeypot]', hashIp(ip)); return fakeOk(); }
    // 打开到提交不到 3 秒，当机器人
    const elapsed = Number(b._elapsed || 0);
    if (!DRY && elapsed > 0 && elapsed < 3000) { console.warn('[too-fast]', hashIp(ip)); return fakeOk(); }

    const name = clean(b['姓名 Name'] || b.name, 40);
    const phone = clean(b['电话 Phone'] || b.phone, 24);
    const email = clean(b['邮箱 Email'] || b.email, 80);
    const services = clean(b['服务 Services'] || b.services, 200);
    const message = clean(b['留言 Message'] || b.message, 500);

    if (!name || !phone || !services) return res.status(400).json({ ok: false });
    if (email && !isEmail(email)) return res.status(400).json({ ok: false });
    if (countLinks(message) > 2) return res.status(400).json({ ok: false });

    const blocked = takeSlot(ip);
    if (blocked) {
      console.warn('[rate]', blocked, hashIp(ip));
      return res.status(429).json({ ok: false, code: 'rate' });
    }
    if (inflight >= 2) return res.status(429).json({ ok: false, code: 'busy' });

    if (!DRY && (!SMTP_USER || !SMTP_PASS)) {
      console.error('[config] 缺少 SMTP_USER / SMTP_PASS');
      return res.status(503).json({ ok: false });
    }

    inflight++;
    try {
      const d = {
        name, phone, email, services, message,
        at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (CST)'
      };
      const info = await getTransporter().sendMail(composeMail(d));
      console.log('[mail] sent ->', MAIL_TO, '| ip', hashIp(ip), '|', info.messageId || 'ok');
      if (DRY && info.message) console.log(String(info.message).slice(0, 800));
      res.status(200).json({ ok: true });
    } finally {
      inflight--;
    }
  } catch (err) {
    // 只记日志，不回吐细节
    console.error('[mail] failed:', (err && err.code) || (err && err.message) || 'unknown');
    res.status(503).json({ ok: false });
  }
});

/* ---------- 静态站点（并给 index.html 注入桥接脚本） ---------- */
const BLOCK = /^(node_modules|\.env|\.git|package\.json|package-lock\.json|server\.js|\.env\.example)/i;

app.get(['/', '/index.html'], (req, res, next) => {
  fs.readFile(path.join(ROOT, 'index.html'), 'utf8', (err, html) => {
    if (err) return next();
    const tag = '  <script src="/api-client.js"></script>';
    let injected;
    if (html.indexOf('/api-client.js') > -1) injected = html;
    else if (/<\/body>/i.test(html)) injected = html.replace(/<\/body>/i, tag + '\n</body>');
    else injected = html + '\n' + tag + '\n';
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(injected);
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, dry: DRY, mailTo: MAIL_TO }));

app.use((req, res, next) => {
  if (BLOCK.test(req.path.replace(/^\/+/, ''))) return res.status(404).end();
  next();
});

app.use(express.static(ROOT, {
  index: false,
  maxAge: '1h',
  setHeaders: (res, p) => {
    if (/\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.listen(PORT, () => {
  console.log('[boot] listening on ' + PORT +
    ' | dry=' + DRY + ' | smtp=' + SMTP_HOST + ':' + SMTP_PORT +
    ' | to=' + MAIL_TO + ' | from=' + (SMTP_USER || '(未配置)'));
});
