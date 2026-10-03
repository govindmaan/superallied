const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');
const XLSX = require('xlsx');

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const q = req.query.q || '';
  let rows;
  const showInactive = req.query.show_inactive === '1';
  const activeCond = showInactive ? '' : 'AND COALESCE(sm.is_active,1)=1';
  if (q) {
    rows = db.prepare(`
      SELECT sm.*, COUNT(sq.id) as quotation_count
      FROM sold_machines sm
      LEFT JOIN spare_quotations sq ON sq.sold_machine_id = sm.id
      WHERE (sm.machine_no LIKE ? COLLATE NOCASE OR sm.customer_name LIKE ? OR sm.chassis_number LIKE ?
         OR sm.engine_number LIKE ? OR sm.mobile_1 LIKE ? OR sm.mobile_2 LIKE ?)
         ${activeCond}
      GROUP BY sm.id ORDER BY sm.created_at DESC
    `).all(...Array(6).fill(`%${q}%`));
  } else {
    rows = db.prepare(`
      SELECT sm.*, COUNT(sq.id) as quotation_count
      FROM sold_machines sm
      LEFT JOIN spare_quotations sq ON sq.sold_machine_id = sm.id
      WHERE 1=1 ${activeCond}
      GROUP BY sm.id ORDER BY sm.created_at DESC
    `).all();
  }
  res.render('sold-machines/list', { title: 'Sold Machines Registry', rows, q, showInactive });
});

// ── New form ──────────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('sold-machines/form', { title: 'Register Machine', machine: null });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.machine_no?.trim()) {
    req.session.flash = { error: 'Machine No is required.' };
    return res.redirect('/sold-machines/new');
  }
  if (db.prepare('SELECT id FROM sold_machines WHERE machine_no=? COLLATE NOCASE').get(f.machine_no.trim())) {
    req.session.flash = { error: `Machine No "${f.machine_no.trim()}" already exists.` };
    return res.redirect('/sold-machines/new');
  }
  const info = db.prepare(`INSERT INTO sold_machines
    (machine_no,chassis_number,engine_number,model,customer_name,customer_address,
     place_of_supply,contact_person,mobile_1,mobile_2,finance_type,financier,
     registration_no,gst_number,pan_number,dealer,date_of_sale,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.machine_no.trim(), f.chassis_number||'', f.engine_number||'', f.model||'',
         f.customer_name.trim(), f.customer_address||'', f.place_of_supply||'',
         f.contact_person||'', f.mobile_1||'', f.mobile_2||'',
         f.finance_type||'Cash', f.financier||'', f.registration_no||'',
         f.gst_number||'', f.pan_number||'', f.dealer||'',
         f.date_of_sale||null, req.session.userId);
  auditLog(req.session.userId, 'MACHINE_CREATED', 'sold_machines', info.lastInsertRowid, f.machine_no.trim());
  req.session.flash = { success: `Machine ${f.machine_no.trim()} registered.` };
  res.redirect(`/sold-machines/${info.lastInsertRowid}`);
});

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const machine = db.prepare('SELECT * FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  const quotations = db.prepare(`
    SELECT sq.*, COUNT(sqi.id) as item_count
    FROM spare_quotations sq
    LEFT JOIN spare_quotation_items sqi ON sqi.quotation_id = sq.id
    WHERE sq.sold_machine_id = ?
    GROUP BY sq.id ORDER BY sq.created_at DESC
  `).all(req.params.id);
  const { formatINR } = require('../db');
  res.render('sold-machines/profile', { title: `Machine: ${machine.machine_no}`, machine, quotations, formatINR });
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const machine = db.prepare('SELECT * FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  res.render('sold-machines/form', { title: 'Edit Machine', machine });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE sold_machines SET
    chassis_number=?,engine_number=?,model=?,customer_name=?,customer_address=?,
    place_of_supply=?,contact_person=?,mobile_1=?,mobile_2=?,finance_type=?,
    financier=?,registration_no=?,gst_number=?,pan_number=?,dealer=?,
    date_of_sale=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(f.chassis_number||'', f.engine_number||'', f.model||'',
         f.customer_name||'', f.customer_address||'', f.place_of_supply||'',
         f.contact_person||'', f.mobile_1||'', f.mobile_2||'',
         f.finance_type||'Cash', f.financier||'', f.registration_no||'',
         f.gst_number||'', f.pan_number||'', f.dealer||'',
         f.date_of_sale||null, req.params.id);
  auditLog(req.session.userId, 'MACHINE_UPDATED', 'sold_machines', req.params.id, '');
  req.session.flash = { success: 'Machine record updated.' };
  res.redirect(`/sold-machines/${req.params.id}`);
});

// ── Deactivate (admin only) ───────────────────────────────────────────────────
router.post('/:id/deactivate', (req, res) => {
  if (req.session.userRole !== 'admin') return res.status(403).send('Forbidden');
  const machine = db.prepare('SELECT machine_no FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  db.prepare('UPDATE sold_machines SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  auditLog(req.session.userId, 'MACHINE_DEACTIVATED', 'sold_machines', req.params.id, machine.machine_no);
  req.session.flash = { success: `Machine ${machine.machine_no} deactivated.` };
  res.redirect('/sold-machines');
});

// ── Reactivate (admin only) ───────────────────────────────────────────────────
router.post('/:id/reactivate', (req, res) => {
  if (req.session.userRole !== 'admin') return res.status(403).send('Forbidden');
  const machine = db.prepare('SELECT machine_no FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  db.prepare('UPDATE sold_machines SET is_active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  auditLog(req.session.userId, 'MACHINE_REACTIVATED', 'sold_machines', req.params.id, machine.machine_no);
  req.session.flash = { success: `Machine ${machine.machine_no} reactivated.` };
  res.redirect('/sold-machines?show_inactive=1');
});

// ── Parse preview (for field mapping) ────────────────────────────────────────
router.post('/parse-preview', (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.json({ ok: false, error: 'No data.' });
    const buf  = Buffer.from(data, 'base64');
    const wb   = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
    if (!rows.length) return res.json({ ok: false, error: 'Empty file.' });
    const headers = rows[0].map(h => String(h).trim()).filter(Boolean);
    const sample  = rows.slice(1, 4).map(r => headers.map((_, i) => String(r[i]||'')));
    res.json({ ok: true, headers, sample });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Excel import ──────────────────────────────────────────────────────────────
router.post('/import/excel', (req, res) => {
  try {
    const { data, mapping } = req.body;
    if (!data) return res.json({ ok: false, error: 'No data received.' });
    const buf  = Buffer.from(data, 'base64');
    const wb   = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    // mapping: { machine_no: 'ColHeader', customer_name: 'ColHeader', ... }
    // fallback: legacy fixed column names
    const m = mapping || {};
    const g = (row, field, ...fallbacks) => {
      if (m[field]) return String(row[m[field]] ?? '').trim();
      for (const k of fallbacks) { const v = row[k]; if (v !== undefined && String(v).trim()) return String(v).trim(); }
      return '';
    };

    let inserted = 0, skipped = 0, errors = [];
    const stmt = db.prepare(`INSERT OR IGNORE INTO sold_machines
      (machine_no,chassis_number,engine_number,model,customer_name,customer_address,
       place_of_supply,contact_person,mobile_1,mobile_2,finance_type,financier,
       registration_no,gst_number,pan_number,dealer,date_of_sale,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const row of rows) {
      const mno  = g(row, 'machine_no',   'Machine No', 'machine_no', 'Machine Number', 'MachineNo');
      if (!mno) { skipped++; continue; }
      const cust = g(row, 'customer_name','Customer Name', 'customer_name', 'Name', 'CustomerName');
      try {
        const info = stmt.run(
          mno,
          g(row,'chassis_number','Chassis Number','Chassis No','chassis_number'),
          g(row,'engine_number', 'Engine Number', 'Engine No', 'engine_number'),
          g(row,'model',         'Model','model','Machine Model'),
          cust,
          g(row,'customer_address','Customer Address','Address','customer_address'),
          g(row,'place_of_supply', 'Place of Supply','State','place_of_supply'),
          g(row,'contact_person',  'Contact Person','Contact','contact_person'),
          g(row,'mobile_1',        'Mobile 1','Mobile','Phone','mobile_1'),
          g(row,'mobile_2',        'Mobile 2','Alt Mobile','mobile_2'),
          g(row,'finance_type',    'Finance Type','Finance','finance_type') || 'Cash',
          g(row,'financier',       'Financier','Bank','financier'),
          g(row,'registration_no', 'Registration No','Reg No','Reg Number','registration_no'),
          g(row,'gst_number',      'GST Number','GSTIN','gst_number'),
          g(row,'pan_number',      'PAN Number','PAN','pan_number'),
          g(row,'dealer',          'Dealer','dealer'),
          g(row,'date_of_sale',    'Date of Sale','Sale Date','date_of_sale') || null,
          req.session.userId
        );
        if (info.changes > 0) inserted++; else skipped++;
      } catch(e) { errors.push(`${mno}: ${e.message}`); }
    }
    auditLog(req.session?.userId, 'MACHINES_IMPORT', 'sold_machines', '', `inserted=${inserted}`);
    res.json({ ok: true, inserted, skipped, errors });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
