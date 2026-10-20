const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');
const XLSX = require('xlsx');

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const q = req.query.q || '';
  let parts;
  if (q) {
    parts = db.prepare(`SELECT * FROM spare_parts
      WHERE sap_part_no LIKE ? OR rnd_part_no LIKE ? OR material_description LIKE ?
      ORDER BY material_description LIMIT 200`).all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    parts = db.prepare('SELECT * FROM spare_parts ORDER BY material_description LIMIT 200').all();
  }
  const total = db.prepare('SELECT COUNT(*) as c FROM spare_parts').get().c;
  const priceDate = db.prepare('SELECT MAX(price_date) AS d FROM spare_parts').get().d;
  res.render('spare-parts/list', { title: 'Spare Parts Master', parts, q, total, priceDate });
});

// ── AJAX autocomplete ─────────────────────────────────────────────────────────
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT id, sap_part_no, rnd_part_no, material_description,
      hsn_code, tax_rate, mrp_basic, mrp_gst, mrp_price, ndp_basic, ndp_gst, ndp_price
    FROM spare_parts
    WHERE sap_part_no LIKE ? OR rnd_part_no LIKE ? OR material_description LIKE ?
    ORDER BY material_description LIMIT 20`).all(`%${q}%`, `%${q}%`, `%${q}%`);
  res.json(rows);
});

// ── Single part ───────────────────────────────────────────────────────────────
router.get('/:id/json', (req, res) => {
  const part = db.prepare('SELECT * FROM spare_parts WHERE id=?').get(req.params.id);
  res.json(part || {});
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.material_description?.trim()) {
    req.session.flash = { error: 'Material description is required.' };
    return res.redirect('/spare-parts');
  }
  db.prepare(`INSERT INTO spare_parts
    (sap_part_no,rnd_part_no,material_description,hsn_code,tax_rate,
     ndp_basic,ndp_gst,ndp_price,mrp_basic,mrp_gst,mrp_price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.sap_part_no||'', f.rnd_part_no||'', f.material_description.trim(),
         f.hsn_code||'', +f.tax_rate||18,
         +f.ndp_basic||0, +f.ndp_gst||0, +f.ndp_price||0,
         +f.mrp_basic||0, +f.mrp_gst||0, +f.mrp_price||0);
  req.session.flash = { success: 'Part added.' };
  res.redirect('/spare-parts');
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE spare_parts SET
    sap_part_no=?,rnd_part_no=?,material_description=?,hsn_code=?,tax_rate=?,
    ndp_basic=?,ndp_gst=?,ndp_price=?,mrp_basic=?,mrp_gst=?,mrp_price=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(f.sap_part_no||'', f.rnd_part_no||'', f.material_description||'',
         f.hsn_code||'', +f.tax_rate||18,
         +f.ndp_basic||0, +f.ndp_gst||0, +f.ndp_price||0,
         +f.mrp_basic||0, +f.mrp_gst||0, +f.mrp_price||0, req.params.id);
  req.session.flash = { success: 'Part updated.' };
  res.redirect('/spare-parts');
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM spare_parts WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Part deleted.' };
  res.redirect('/spare-parts');
});

// ── Admin: delete all ─────────────────────────────────────────────────────────
router.post('/delete-all', (req, res) => {
  if (res.locals.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });
  const count = db.prepare('SELECT COUNT(*) as c FROM spare_parts').get().c;
  db.prepare('DELETE FROM spare_parts').run();
  auditLog(req.session?.userId, 'PARTS_DELETE_ALL', 'spare_parts', '', `deleted=${count}`);
  req.session.flash = { success: `All ${count} parts deleted.` };
  res.redirect('/spare-parts');
});

// ── Export CSV ────────────────────────────────────────────────────────────────
router.get('/export/csv', (req, res) => {
  const parts = db.prepare('SELECT sap_part_no,rnd_part_no,material_description,hsn_code,tax_rate,ndp_basic,ndp_gst,ndp_price,mrp_basic,mrp_gst,mrp_price FROM spare_parts ORDER BY material_description').all();
  const header = 'SAP Part No.,RND Part No.,Material Description,HSN Code,Tax Rate,NDP Basic,NDP GST,NDP Price,MRP Basic,MRP GST,MRP Price';
  const esc = v => '"' + String(v||'').replace(/"/g, '""') + '"';
  const rows = parts.map(p => [
    esc(p.sap_part_no), esc(p.rnd_part_no), esc(p.material_description),
    esc(p.hsn_code), p.tax_rate,
    p.ndp_basic, p.ndp_gst, p.ndp_price,
    p.mrp_basic, p.mrp_gst, p.mrp_price
  ].join(','));
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="spare-parts.csv"');
  res.send(csv);
});

// ── Excel import ──────────────────────────────────────────────────────────────
// Price lists converted from PDF carry line breaks inside cells ("RND Part⏎no.",
// "7T00D0040⏎075 -CE") and repeat header names ("GST" twice). Read every sheet
// through readSheet so headers are single-line and unique (GST, GST_1) and both
// the column mapping and the import see exactly the same names.
const oneLine = v => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

function readSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1, raw: true });
  const seen = {};
  const headers = (grid[0] || []).map(h => {
    const base = oneLine(h);
    if (!base) return '';
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] === 1 ? base : `${base}_${seen[base] - 1}`;
  });
  const rows = grid.slice(1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']).filter(([h]) => h)));
  return { headers: headers.filter(Boolean), rows };
}

// Part numbers / codes: a line break is a wrap inside the number, so join without a space
const codeText = v => String(v ?? '').replace(/\s*[\r\n]+\s*/g, '').trim();

// Excel date serial, "31.07.2026", "31/07/2026" or "2026-07-31" -> "2026-07-31"
function toIsoDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = oneLine(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);           if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ── Parse preview (for field mapping) ────────────────────────────────────────
router.post('/parse-preview', (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.json({ ok: false, error: 'No data.' });
    const { headers, rows } = readSheet(Buffer.from(data, 'base64'));
    if (!headers.length) return res.json({ ok: false, error: 'Empty file.' });
    const sample = rows.slice(0, 3).map(r => headers.map(h => oneLine(r[h])));
    res.json({ ok: true, headers, sample, rowCount: rows.length });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

router.post('/import/excel', (req, res) => {
  try {
    const { data, mode, mapping } = req.body; // mode: 'insert' or 'upsert'
    if (!data) return res.json({ ok: false, error: 'No data received.' });
    const { rows } = readSheet(Buffer.from(data, 'base64'));
    // Mapping values are header names; clean them the same way as the sheet's headers
    const mp = Object.fromEntries(Object.entries(mapping || {}).map(([k, v]) => [k, oneLine(v)]).filter(([, v]) => v));

    let inserted = 0, updated = 0, skipped = 0, errors = [];

    // Helper: mapping-aware column getter with legacy fallbacks
    const gRaw = (row, field, ...legacy) => {
      if (mp[field]) return row[mp[field]] ?? '';
      for (const k of legacy) { const v = row[k]; if (v !== undefined && String(v).trim()) return v; }
      return '';
    };
    const gStr  = (row, field, ...legacy) => oneLine(gRaw(row, field, ...legacy));
    const gCode = (row, field, ...legacy) => codeText(gRaw(row, field, ...legacy));
    const gNum = (row, field, ...legacy) => {
      if (mp[field]) return parseFloat(row[mp[field]]) || 0;
      for (const k of legacy) { const v = row[k]; if (v !== undefined && v !== '') return parseFloat(v) || 0; }
      return 0;
    };

    db.exec('BEGIN TRANSACTION');
    try {
    for (const row of rows) {
      const desc = gStr(row,'material_description','Material Description','material_description');
      const sap  = gCode(row,'sap_part_no','SAP Part No.','SAP Part no.','sap_part_no');
      if (!desc) { skipped++; continue; }

      const ndpBasic = gNum(row,'ndp_basic','NDP Basic','    NDP Basic','ndp_basic');
      const mrpBasic = gNum(row,'mrp_basic','MRP Basic','    MRP Basic','mrp_basic');
      const taxRate  = gNum(row,'tax_rate','TAX_RATE','Tax Rate') || 18;
      const ndpGst   = gNum(row,'ndp_gst','GST','        GST','ndp_gst') || Math.round(ndpBasic * taxRate / 100 * 100) / 100;
      const mrpGst   = gNum(row,'mrp_gst','GST_1','        GST_1','mrp_gst') || Math.round(mrpBasic * taxRate / 100 * 100) / 100;
      const ndpPrice = gNum(row,'ndp_price','NDP','          NDP','ndp_price') || ndpBasic + ndpGst;
      const mrpPrice = gNum(row,'mrp_price','MRP','          MRP','mrp_price') || mrpBasic + mrpGst;
      const rnd      = gCode(row,'rnd_part_no','RND Part No.','RND Part no.','rnd_part_no');
      const hsn      = gCode(row,'hsn_code','HSN CODE','HSN Code','HSN','hsn_code');
      const priceDate = toIsoDate(gRaw(row,'price_date','Pricing Date','Price Date','price_date'));

      try {
        if (mode === 'upsert' && sap) {
          const existing = db.prepare('SELECT id FROM spare_parts WHERE sap_part_no=?').get(sap);
          if (existing) {
            db.prepare(`UPDATE spare_parts SET rnd_part_no=?,material_description=?,hsn_code=?,
              tax_rate=?,ndp_basic=?,ndp_gst=?,ndp_price=?,mrp_basic=?,mrp_gst=?,mrp_price=?,
              price_date=COALESCE(?, price_date), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(rnd, desc, hsn, taxRate, ndpBasic, ndpGst, ndpPrice, mrpBasic, mrpGst, mrpPrice, priceDate, existing.id);
            updated++;
          } else {
            db.prepare(`INSERT INTO spare_parts (sap_part_no,rnd_part_no,material_description,
              hsn_code,tax_rate,ndp_basic,ndp_gst,ndp_price,mrp_basic,mrp_gst,mrp_price,price_date)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(sap, rnd, desc, hsn, taxRate, ndpBasic, ndpGst, ndpPrice, mrpBasic, mrpGst, mrpPrice, priceDate);
            inserted++;
          }
        } else {
          db.prepare(`INSERT INTO spare_parts (sap_part_no,rnd_part_no,material_description,
            hsn_code,tax_rate,ndp_basic,ndp_gst,ndp_price,mrp_basic,mrp_gst,mrp_price,price_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(sap, rnd, desc, hsn, taxRate, ndpBasic, ndpGst, ndpPrice, mrpBasic, mrpGst, mrpPrice, priceDate);
          inserted++;
        }
      } catch(e) { errors.push(`${sap||desc}: ${e.message}`); skipped++; }
    }
    db.exec('COMMIT');
    } catch(txErr) { db.exec('ROLLBACK'); throw txErr; }
    auditLog(req.session?.userId, 'PARTS_IMPORT', 'spare_parts', '', `inserted=${inserted} updated=${updated}`);
    res.json({ ok: true, inserted, updated, skipped, errors });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Export sample Excel ───────────────────────────────────────────────────────
router.get('/export/sample', (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    ['SAP Part No.', 'RND Part No.', 'Material Description', 'HSN CODE', 'TAX_RATE', 'NDP Basic', 'NDP', 'MRP Basic', 'MRP'],
    ['1234567890', 'RND001', 'Sample Filter Element', '84212990', 18, 250, 295, 350, 413],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Spare Parts');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="spare-parts-sample.xlsx"');
  res.send(buf);
});

module.exports = router;
