// Language switch. Pages are drawn on the server, so switching reloads the page;
// anything typed into a form is kept in sessionStorage across the reload and put back.
(function () {
  var KEY = 'lang-restore';
  var SKIP = /^(hidden|password|file|submit|button|reset|image)$/;

  function fields() {
    return [].slice.call(document.querySelectorAll('form input[name], form select[name], form textarea[name]'))
      .filter(function (el) { return !SKIP.test(el.type) && !el.disabled; });
  }
  function keyOf(el, i) { return (el.form ? [].indexOf.call(document.forms, el.form) : -1) + ':' + el.name + ':' + i; }

  function save() {
    var seen = {}, data = {};
    fields().forEach(function (el) {
      var base = (el.form ? [].indexOf.call(document.forms, el.form) : -1) + ':' + el.name;
      var i = seen[base] = (seen[base] || 0) + 1;
      var k = keyOf(el, i);
      if (el.type === 'checkbox' || el.type === 'radio') data[k] = el.checked;
      else if (el.multiple) data[k] = [].map.call(el.selectedOptions, function (o) { return o.value; });
      else data[k] = el.value;
    });
    try { sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname + location.search, data: data })); } catch (e) {}
  }

  function restore() {
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem(KEY)); sessionStorage.removeItem(KEY); } catch (e) { return; }
    if (!saved || saved.path !== location.pathname + location.search) return;
    var seen = {};
    fields().forEach(function (el) {
      var base = (el.form ? [].indexOf.call(document.forms, el.form) : -1) + ':' + el.name;
      var i = seen[base] = (seen[base] || 0) + 1;
      var v = saved.data[keyOf(el, i)];
      if (v === undefined) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = v;
      else if (el.multiple) [].forEach.call(el.options, function (o) { o.selected = v.indexOf(o.value) >= 0; });
      else el.value = v;
    });
  }

  window.setLang = function (lang) {
    if (lang === window.LANG) return;
    save();
    fetch('/lang', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ lang: lang }), credentials: 'same-origin' })
      .then(function () { location.reload(); })
      .catch(function () { document.cookie = 'lang=' + lang + ';path=/;max-age=31536000;samesite=lax'; location.reload(); });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore);
  else restore();
})();
