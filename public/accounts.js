// Accounts module helpers (no framework)
window.SA = (() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const money = (paise) => '₹' + ((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // "1,00,000.50" → 10000050 paise (NaN when invalid)
  const toPaise = (s) => {
    s = String(s ?? '').replace(/[,\s₹]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    const [r, p = ''] = s.split('.');
    return Number(r) * 100 + Number((p + '00').slice(0, 2));
  };
  const rupees = (paise) => ((paise || 0) / 100).toFixed(2);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ...body, _csrf: csrf }) });
    let j; try { j = await r.json(); } catch (e) { j = { ok: false, error: 'Server error (' + r.status + ')' }; }
    return j;
  }
  const fileToData = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });

  // Searchable <select data-search>: a filter box that narrows the options
  function enhanceSelect(sel) {
    if (sel.dataset.enhanced) return;
    sel.dataset.enhanced = 1;
    const box = document.createElement('input');
    box.type = 'search'; box.className = 'form-control form-control-sm search-sel'; box.placeholder = 'Type to search…';
    sel.parentNode.insertBefore(box, sel);
    let all = [...sel.options].map(o => ({ v: o.value, t: o.text, d: o.dataset ? { ...o.dataset } : {} }));
    sel.refreshOptions = () => { all = [...sel.options].map(o => ({ v: o.value, t: o.text, d: { ...o.dataset } })); box.value = ''; };
    box.addEventListener('input', () => {
      const q = box.value.toLowerCase().trim(), cur = sel.value;
      const keep = all.filter((o, i) => (i === 0 && o.v === '') || !q || o.t.toLowerCase().includes(q));
      sel.innerHTML = '';
      keep.forEach(o => { const op = new Option(o.t, o.v, false, o.v === cur); Object.assign(op.dataset, o.d); sel.add(op); });
      const real = keep.filter(o => o.v !== '');
      if (real.length === 1 && sel.value !== real[0].v) { sel.value = real[0].v; sel.dispatchEvent(new Event('change')); }
    });
  }
  document.querySelectorAll('select[data-search]').forEach(enhanceSelect);

  // <form data-confirm="message"> asks before submitting; disables its buttons to stop double submits
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.method.toLowerCase() === 'post') setTimeout(() => f.querySelectorAll('button[type=submit],button:not([type])').forEach(b => { b.disabled = true; }), 0);
  });
  return { csrf, money, toPaise, rupees, esc, postJSON, fileToData, enhanceSelect };
})();
