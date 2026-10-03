const express = require('express');
const router  = express.Router();
const { db, getSettings, nextSpareQuotationNumber, formatINR, numberToWords, auditLog } = require('../db');
const { generatePDF } = require('../pdf');
const path = require('path');
const fs   = require('fs');
const QRCode = require('qrcode');

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const { status, q, from, to } = req.query;
  const uid = req.session.userId;

  let sql = `SELECT sq.*, u.full_name as creator_name
    FROM spare_quotations sq LEFT JOIN users u ON u.id=sq.created_by WHERE 1=1`;
  const params = [];

  if (!isAdmin) { sql += ' AND sq.created_by=?'; params.push(uid); }
  if (status)   { sql += ' AND sq.status=?'; params.push(status); }
  if (from)     { sql += ' AND date(sq.created_at)>=?'; params.push(from); }
  if (to)       { sql += ' AND date(sq.created_at)<=?'; params.push(to); }
  if (q)        { sql += ' AND (sq.quotation_no LIKE ? OR sq.customer_name LIKE ? OR sq.machine_no LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY sq.created_at DESC';

  const quotations = db.prepare(sql).all(...params);
  res.render('spare-quotations/list', { title: 'Spare Part Quotations', quotations, status: status||'', q: q||'', from: from||'', to: to||'', formatINR });
});

// ── New form ──────────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const s = getSettings();
  const machine_no = req.query.machine_no || '';
  let machine = null;
  if (machine_no) {
    machine = db.prepare('SELECT * FROM sold_machines WHERE machine_no=? COLLATE NOCASE').get(machine_no);
  }
  const salespersons = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name ASC').all();
  res.render('spare-quotations/form', {
    title: 'New Spare Part Quotation',
    quotation: null, items: [],
    machine, s, salespersons,
    defaultSalesperson: s.contact_name || '',
    formatINR
  });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.customer_name?.trim()) {
    req.session.flash = { error: 'Customer name is required.' };
    return res.redirect('/spare-quotations/new');
  }

  // Parse items from JSON
  let items = [];
  try { items = JSON.parse(f.items_json || '[]'); } catch(e) {}
  if (!items.length) {
    req.session.flash = { error: 'Add at least one spare part to the quotation.' };
    return res.redirect('/spare-quotations/new');
  }

  // Calculate totals
  let totalBasic = 0, totalGst = 0, grandTotal = 0;
  items.forEach(it => {
    totalBasic  += it.line_basic || 0;
    totalGst    += it.tax_amount || 0;
    grandTotal  += it.line_total || 0;
  });
  const roundedGrand = Math.round(grandTotal);
  const roundoffAmt  = parseFloat((roundedGrand - grandTotal).toFixed(2));
  grandTotal = roundedGrand;

  const { quotationNo, financialYear, serialNumber } = nextSpareQuotationNumber();

  // Find sold_machine_id
  let soldMachineId = null;
  if (f.machine_no) {
    const sm = db.prepare('SELECT id FROM sold_machines WHERE machine_no=? COLLATE NOCASE').get(f.machine_no);
    if (sm) soldMachineId = sm.id;
  }

  // Resolve salesperson_id
  const spId = f.salesperson_id ? parseInt(f.salesperson_id) : null;
  let spName = f.salesperson || '';
  if (spId) {
    const spRow = db.prepare('SELECT name FROM salespersons WHERE id=?').get(spId);
    if (spRow) spName = spRow.name;
  }

  const info = db.prepare(`INSERT INTO spare_quotations
    (quotation_no,serial_number,financial_year,sold_machine_id,machine_no,customer_name,
     customer_address,customer_gstin,contact_person,mobile,place_of_supply,
     tax_mode,salesperson,salesperson_id,validity_days,remarks,terms,status,show_discount,quotation_date,
     total_basic,total_gst,grand_total,roundoff_amount,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(quotationNo, serialNumber, financialYear, soldMachineId,
         f.machine_no||'', f.customer_name.trim(), f.customer_address||'',
         f.customer_gstin||'', f.contact_person||'', f.mobile||'',
         f.place_of_supply||'', f.tax_mode||'CGST_SGST',
         spName, spId, +f.validity_days||7,
         f.remarks||'', f.terms||'', 'draft',
         f.show_discount === 'on' ? 1 : 0,
         f.quotation_date || new Date().toISOString().slice(0,10),
         totalBasic, totalGst, grandTotal, roundoffAmt, req.session.userId);

  const qid = info.lastInsertRowid;
  const insertItem = db.prepare(`INSERT INTO spare_quotation_items
    (quotation_id,part_no,description,hsn,qty,basic_rate,discount_percent,
     discount_amount,tax_rate,tax_amount,net_rate,line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach(it => insertItem.run(qid, it.part_no||'', it.description||'', it.hsn||'',
    it.qty||1, it.basic_rate||0, it.discount_percent||0, it.discount_amount||0,
    it.tax_rate||18, it.tax_amount||0, it.net_rate||0, it.line_total||0));

  auditLog(req.session.userId, 'SPARE_QTN_CREATED', 'spare_quotations', qid, quotationNo);
  req.session.flash = { success: `Quotation ${quotationNo} created.` };
  res.redirect(`/spare-quotations/${qid}`);
});

// ── View ──────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const q = db.prepare('SELECT sq.*, u.full_name as creator_name FROM spare_quotations sq LEFT JOIN users u ON u.id=sq.created_by WHERE sq.id=?').get(req.params.id);
  if (!q) return res.redirect('/spare-quotations');
  const items = db.prepare('SELECT * FROM spare_quotation_items WHERE quotation_id=?').all(req.params.id);
  const flash = req.session.flash || {};
  delete req.session.flash;
  const isAdmin = req.session.userRole === 'admin';
  res.render('spare-quotations/view', { title: `Quotation ${q.quotation_no}`, q, items, formatINR, flash, user: req.session, isAdmin });
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const quotation = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(req.params.id);
  if (!quotation) return res.redirect('/spare-quotations');
  const rawItems = db.prepare('SELECT * FROM spare_quotation_items WHERE quotation_id=?').all(req.params.id);
  // Add computed line_basic for the form's JS
  const items = rawItems.map(it => ({
    ...it,
    line_basic: parseFloat(((it.basic_rate * it.qty) - it.discount_amount).toFixed(2))
  }));
  const s = getSettings();
  let machine = null;
  if (quotation.machine_no) {
    machine = db.prepare('SELECT * FROM sold_machines WHERE machine_no=? COLLATE NOCASE').get(quotation.machine_no);
  }
  const salespersons = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name ASC').all();
  res.render('spare-quotations/form', {
    title: `Edit ${quotation.quotation_no}`,
    quotation, items, machine, s, salespersons,
    defaultSalesperson: s.contact_name || '',
    formatINR
  });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  let items = [];
  try { items = JSON.parse(f.items_json || '[]'); } catch(e) {}

  let totalBasic = 0, totalGst = 0, grandTotal = 0;
  items.forEach(it => {
    totalBasic  += it.line_basic || 0;
    totalGst    += it.tax_amount || 0;
    grandTotal  += it.line_total || 0;
  });
  const roundedGrand2 = Math.round(grandTotal);
  const roundoffAmt2  = parseFloat((roundedGrand2 - grandTotal).toFixed(2));
  grandTotal = roundedGrand2;

  let soldMachineId = null;
  if (f.machine_no) {
    const sm = db.prepare('SELECT id FROM sold_machines WHERE machine_no=? COLLATE NOCASE').get(f.machine_no);
    if (sm) soldMachineId = sm.id;
  }

  const spId2 = f.salesperson_id ? parseInt(f.salesperson_id) : null;
  let spName2 = f.salesperson || '';
  if (spId2) {
    const spRow2 = db.prepare('SELECT name FROM salespersons WHERE id=?').get(spId2);
    if (spRow2) spName2 = spRow2.name;
  }

  db.prepare(`UPDATE spare_quotations SET
    sold_machine_id=?,machine_no=?,customer_name=?,customer_address=?,customer_gstin=?,
    contact_person=?,mobile=?,place_of_supply=?,tax_mode=?,salesperson=?,salesperson_id=?,
    validity_days=?,remarks=?,terms=?,status=?,show_discount=?,quotation_date=?,
    total_basic=?,total_gst=?,grand_total=?,roundoff_amount=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(soldMachineId, f.machine_no||'', f.customer_name||'', f.customer_address||'',
         f.customer_gstin||'', f.contact_person||'', f.mobile||'',
         f.place_of_supply||'', f.tax_mode||'CGST_SGST', spName2, spId2,
         +f.validity_days||7, f.remarks||'', f.terms||'', f.status||'draft',
         f.show_discount === 'on' ? 1 : 0,
         f.quotation_date || new Date().toISOString().slice(0,10),
         totalBasic, totalGst, grandTotal, roundoffAmt2, req.params.id);

  // Replace items
  db.prepare('DELETE FROM spare_quotation_items WHERE quotation_id=?').run(req.params.id);
  const insertItem = db.prepare(`INSERT INTO spare_quotation_items
    (quotation_id,part_no,description,hsn,qty,basic_rate,discount_percent,
     discount_amount,tax_rate,tax_amount,net_rate,line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach(it => insertItem.run(req.params.id, it.part_no||'', it.description||'', it.hsn||'',
    it.qty||1, it.basic_rate||0, it.discount_percent||0, it.discount_amount||0,
    it.tax_rate||18, it.tax_amount||0, it.net_rate||0, it.line_total||0));

  auditLog(req.session.userId, 'SPARE_QTN_UPDATED', 'spare_quotations', req.params.id, '');
  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/spare-quotations/${req.params.id}`);
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM spare_quotations WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Quotation deleted.' };
  res.redirect('/spare-quotations');
});

// ── Clone ─────────────────────────────────────────────────────────────────────
router.post('/:id/clone', (req, res) => {
  const orig  = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(req.params.id);
  const oitems = db.prepare('SELECT * FROM spare_quotation_items WHERE quotation_id=?').all(req.params.id);
  if (!orig) return res.redirect('/spare-quotations');

  const { quotationNo, financialYear, serialNumber } = nextSpareQuotationNumber();
  const info = db.prepare(`INSERT INTO spare_quotations
    (quotation_no,serial_number,financial_year,sold_machine_id,machine_no,customer_name,
     customer_address,customer_gstin,contact_person,mobile,place_of_supply,
     tax_mode,salesperson,validity_days,remarks,terms,status,
     total_basic,total_gst,grand_total,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(quotationNo, serialNumber, financialYear, orig.sold_machine_id,
         orig.machine_no, orig.customer_name, orig.customer_address, orig.customer_gstin,
         orig.contact_person, orig.mobile, orig.place_of_supply, orig.tax_mode,
         orig.salesperson, orig.validity_days, orig.remarks, orig.terms, 'draft',
         orig.total_basic, orig.total_gst, orig.grand_total, req.session.userId);

  const newId = info.lastInsertRowid;
  const insertItem = db.prepare(`INSERT INTO spare_quotation_items
    (quotation_id,part_no,description,hsn,qty,basic_rate,discount_percent,
     discount_amount,tax_rate,tax_amount,net_rate,line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  oitems.forEach(it => insertItem.run(newId, it.part_no, it.description, it.hsn,
    it.qty, it.basic_rate, it.discount_percent, it.discount_amount,
    it.tax_rate, it.tax_amount, it.net_rate, it.line_total));

  req.session.flash = { success: `Cloned as ${quotationNo}.` };
  res.redirect(`/spare-quotations/${newId}`);
});

// ── Status update ─────────────────────────────────────────────────────────────
router.post('/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft','sent','confirmed','cancelled'];
  if (!validStatuses.includes(status)) return res.json({ ok: false, error: 'Invalid status' });
  db.prepare('UPDATE spare_quotations SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

// ── Submit for approval ───────────────────────────────────────────────────────
router.post('/:id/submit-approval', (req, res) => {
  const q = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.redirect('/spare-quotations');
  db.prepare("UPDATE spare_quotations SET approval_status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  admins.forEach(a => {
    try {
      db.prepare('INSERT INTO notifications (user_id,type,message,link) VALUES (?,?,?,?)').run(
        a.id, 'approval_request',
        `Quotation ${q.quotation_no} submitted for approval by ${res.locals.user?.full_name||'salesperson'}`,
        `/spare-quotations/${q.id}`
      );
    } catch(e) {}
  });
  req.session.flash = { success: 'Submitted for approval. Admin has been notified.' };
  res.redirect(`/spare-quotations/${req.params.id}`);
});

// ── Approve / Reject ──────────────────────────────────────────────────────────
router.post('/:id/approve', (req, res) => {
  if (res.locals.user?.role !== 'admin') return res.status(403).send('Admin only');
  const { action, notes } = req.body;
  const q = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.redirect('/spare-quotations');
  const newApproval = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE spare_quotations SET approval_status=?,approval_notes=?,approved_by=?,approved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(newApproval, notes||'', req.session.userId, req.params.id);
  if (q.created_by) {
    try {
      db.prepare('INSERT INTO notifications (user_id,type,message,link) VALUES (?,?,?,?)').run(
        q.created_by, newApproval,
        `Your quotation ${q.quotation_no} has been ${newApproval}${notes ? ': ' + notes : ''}`,
        `/spare-quotations/${q.id}`
      );
    } catch(e) {}
  }
  req.session.flash = { success: `Quotation ${newApproval}.` };
  res.redirect(`/spare-quotations/${req.params.id}`);
});

// ── PDF ───────────────────────────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const q = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).send('Not found');
  const items = db.prepare('SELECT * FROM spare_quotation_items WHERE quotation_id=? ORDER BY id').all(req.params.id);
  const s = getSettings();

  const LOGO_PATH = path.join(__dirname, '..', 'public', 'bull-logo.jpg');
  const logoB64 = fs.existsSync(LOGO_PATH)
    ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

  // UPI QR — use UPI format if UPI ID set, else plain text
  let qrData;
  if (s.company_upi) {
    const upiName = encodeURIComponent(s.company_name || 'Super Allied');
    const upiNote = encodeURIComponent(q.quotation_no);
    qrData = `upi://pay?pa=${s.company_upi}&pn=${upiName}&am=${q.grand_total}&cu=INR&tn=${upiNote}`;
  } else {
    qrData = `${s.company_name || 'Super Allied'} | ${q.quotation_no} | ₹${q.grand_total}`;
  }
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 120, margin: 1, errorCorrectionLevel: 'M' });

  const isAdmin = res.locals.user?.role === 'admin';
  const html = await new Promise((resolve, reject) =>
    res.app.render('spare-quotations/pdf', {
      q, items, settings: s, formatINR, numberToWords,
      logoB64, qrDataUrl, isAdmin
    }, (err, h) => err ? reject(err) : resolve(h)));

  try {
    const pdfBuffer = await generatePDF(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${q.quotation_no.replace(/\//g,'-')}.pdf"`);
    res.send(pdfBuffer);
  } catch(err) {
    console.error('PDF error:', err);
    req.session.flash = { error: 'PDF generation failed.' };
    res.redirect(`/spare-quotations/${req.params.id}`);
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports/summary', (req, res) => {
  const { from, to, salesperson, machine_no, customer } = req.query;
  let sql = `SELECT sq.*, u.full_name as creator_name FROM spare_quotations sq
    LEFT JOIN users u ON u.id=sq.created_by WHERE 1=1`;
  const params = [];
  if (from)       { sql += ' AND date(sq.created_at)>=?'; params.push(from); }
  if (to)         { sql += ' AND date(sq.created_at)<=?'; params.push(to); }
  if (salesperson){ sql += ' AND sq.salesperson LIKE ?'; params.push(`%${salesperson}%`); }
  if (machine_no) { sql += ' AND sq.machine_no LIKE ?'; params.push(`%${machine_no}%`); }
  if (customer)   { sql += ' AND sq.customer_name LIKE ?'; params.push(`%${customer}%`); }
  sql += ' ORDER BY sq.created_at DESC';

  const quotations = db.prepare(sql).all(...params);
  const totalValue = quotations.reduce((s, q) => s + (q.grand_total || 0), 0);

  // Top parts
  const topParts = db.prepare(`SELECT sqi.description, sqi.part_no,
    SUM(sqi.qty) as total_qty, SUM(sqi.line_total) as total_value, COUNT(*) as times_quoted
    FROM spare_quotation_items sqi
    JOIN spare_quotations sq ON sq.id=sqi.quotation_id
    WHERE 1=1 ${from ? 'AND date(sq.created_at)>=?' : ''} ${to ? 'AND date(sq.created_at)<=?' : ''}
    GROUP BY sqi.part_no, sqi.description ORDER BY times_quoted DESC LIMIT 10`
  ).all(...[from,to].filter(Boolean));

  res.render('spare-quotations/reports', {
    title: 'Spare Parts Reports', quotations, totalValue, topParts,
    from: from||'', to: to||'', salesperson: salesperson||'',
    machine_no: machine_no||'', customer: customer||'', formatINR
  });
});

module.exports = router;
