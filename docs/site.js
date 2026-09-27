/* TradeMind 展示站 — 复制到剪贴板等小交互（无依赖，可离线） */
(function () {
  'use strict';

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function bindCopy(btn) {
    btn.addEventListener('click', function () {
      var val = btn.getAttribute('data-copy') || '';
      var label = btn.getAttribute('data-label') || '复制';
      var doneLabel = btn.getAttribute('data-done-label') || '已复制';
      var timer = null;

      var done = function (ok) {
        btn.classList.add('done');
        btn.textContent = ok ? '\u2713 ' + doneLabel : '复制失败，请手动选中';
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(function () {
          btn.classList.remove('done');
          btn.textContent = label;
        }, 1800);
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(val).then(
          function () { done(true); },
          function () { done(fallbackCopy(val)); }
        );
      } else {
        done(fallbackCopy(val));
      }
    });
  }

  function init() {
    document.querySelectorAll('[data-copy]').forEach(bindCopy);
    var y = document.querySelectorAll('[data-year]');
    y.forEach(function (el) { el.textContent = String(new Date().getFullYear()); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
