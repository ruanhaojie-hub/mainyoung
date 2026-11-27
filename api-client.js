/**
 * 官网表单 → 自家接口 的桥接脚本
 * -----------------------------------------------------------
 * 由 server.js 自动注入到 index.html 末尾，页面本身不用改一行。
 * 作用：把页面原本发往 formsubmit.co / formspree.io / web3forms.com
 *      的 POST 请求，改道到本站的 /api/quote，并保持返回结构一致
 *      （{success:"true"} 让页面照旧显示"已发送"）。
 * 附带：加一个隐藏蜜罐字段 + 记录页面打开时间，供服务端判断机器人。
 */
(function () {
  if (window.__myQuoteBridge) { return; }
  window.__myQuoteBridge = true;

  var openedAt = Date.now();
  var hp = null;
  var form = document.getElementById('quoteForm');
  if (form) {
    hp = document.createElement('input');
    hp.type = 'text';
    hp.name = '__hp';
    hp.autocomplete = 'off';
    hp.tabIndex = -1;
    hp.setAttribute('aria-hidden', 'true');
    hp.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    form.appendChild(hp);
  }

  if (!window.fetch) { return; }
  var orig = window.fetch.bind(window);

  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : ((input && input.url) || '');
      var isOurForm = init && init.method === 'POST' &&
        /formsubmit\.co|formspree\.io|web3forms\.com/i.test(url);
      if (isOurForm) {
        var body = {};
        try { body = JSON.parse(init.body || '{}'); } catch (e) { body = {}; }
        body._elapsed = Date.now() - openedAt;
        body._hp = hp ? hp.value : '';

        return orig('/api/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (r) {
          if (r.ok) {
            return new Response(JSON.stringify({ success: 'true' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return r;   // 失败原样交给页面，由它弹兜底面板
        });
      }
    } catch (e) { /* 落到原生 fetch */ }
    return orig(input, init);
  };
})();
