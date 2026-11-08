// Push notifications in the browser: registers the service worker, keeps this
// device's subscription in step with the server, offers a one-time "turn on"
// prompt, and drives the controls on My Profile (#pushCard).
(function () {
  var T = window.T || function (s) { return s; };
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var DISMISS_KEY = 'push-prompt-dismissed';

  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function keyBytes(b64) {
    var s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, function (c) { return c.charCodeAt(0); });
  }
  var reg = supported ? navigator.serviceWorker.register('/sw.js') : Promise.reject(new Error('unsupported'));

  function currentSub() { return reg.then(function (r) { return r.pushManager.getSubscription(); }); }

  function enable() {
    var ask = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    return ask.then(function (p) {
      if (p !== 'granted') throw new Error(T('Notifications are blocked in this browser. Allow them in the browser settings for this site.'));
      return Promise.all([reg, fetch('/push/key', { credentials: 'same-origin' }).then(function (r) { return r.json(); })]);
    }).then(function (x) {
      var r = x[0], key = x[1].key;
      return r.pushManager.getSubscription().then(function (s) {
        return s || r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      });
    }).then(function (s) { return post('/push/subscribe', { subscription: s.toJSON() }); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  }
  function disable() {
    return currentSub().then(function (s) {
      if (!s) return;
      return post('/push/unsubscribe', { endpoint: s.endpoint }).then(function () { return s.unsubscribe(); });
    });
  }

  // Already allowed on this device: make sure the server has it (e.g. after a different user logged in here)
  if (supported && Notification.permission === 'granted') {
    currentSub().then(function (s) { if (s) post('/push/subscribe', { subscription: s.toJSON() }); }).catch(function () {});
  }

  // ── One-time prompt at the top of the page ──
  function showPrompt() {
    if (!supported || Notification.permission !== 'default' || document.getElementById('pushCard')) return;
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch (e) {}
    var main = document.querySelector('.main-content');
    if (!main) return;
    var bar = document.createElement('div');
    bar.className = 'alert alert-info d-flex align-items-center gap-2 py-2 small push-prompt';
    bar.innerHTML = '<i class="bi bi-bell-fill"></i><span class="flex-grow-1"></span>' +
      '<button type="button" class="btn btn-sm btn-primary push-yes"></button>' +
      '<button type="button" class="btn btn-sm btn-link text-muted push-no"></button>';
    bar.querySelector('span').textContent = T('Get check-in reminders and updates (expense paid, salary credited, approvals) as notifications.');
    bar.querySelector('.push-yes').textContent = T('Turn on');
    bar.querySelector('.push-no').textContent = T('Not now');
    bar.querySelector('.push-no').onclick = function () { try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {} bar.remove(); };
    bar.querySelector('.push-yes').onclick = function () {
      enable().then(function () { bar.remove(); }).catch(function (e) { alert(e.message); bar.remove(); });
    };
    main.insertBefore(bar, main.firstChild);
  }

  // ── My Profile card ──
  function card() {
    var c = document.getElementById('pushCard');
    if (!c) return;
    var status = c.querySelector('[data-push=status]'), on = c.querySelector('[data-push=on]'),
        off = c.querySelector('[data-push=off]'), test = c.querySelector('[data-push=test]'), hint = c.querySelector('[data-push=hint]');
    function show(text, isOn) {
      status.textContent = text;
      on.classList.toggle('d-none', !!isOn); off.classList.toggle('d-none', !isOn); test.classList.toggle('d-none', !isOn);
    }
    function refresh() {
      if (!supported) {
        on.classList.add('d-none'); off.classList.add('d-none'); test.classList.add('d-none');
        status.textContent = iOS && !standalone ? T('On iPhone, first add this app to your Home Screen (Share → Add to Home Screen), then open it from there.')
                                                : T('This browser does not support notifications.');
        return;
      }
      if (Notification.permission === 'denied') {
        on.classList.add('d-none'); off.classList.add('d-none'); test.classList.add('d-none');
        status.textContent = T('Notifications are blocked in this browser. Allow them in the browser settings for this site.');
        return;
      }
      currentSub().then(function (s) { show(s ? T('On for this device.') : T('Off for this device.'), !!s); }).catch(function () { show(T('Off for this device.'), false); });
    }
    function busy(btn, p) {
      btn.disabled = true;
      return p.catch(function (e) { alert(e.message); }).then(function () { btn.disabled = false; refresh(); });
    }
    on.onclick = function () { status.textContent = T('Turning on…'); busy(on, enable()); };
    off.onclick = function () { busy(off, disable()); };
    test.onclick = function () { busy(test, post('/push/test').then(function (r) { if (r.error) throw new Error(r.error); })); };
    if (hint && iOS && !standalone) hint.classList.remove('d-none');
    refresh();
  }

  function init() { showPrompt(); card(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
