// Machine quotations (create, edit, cancel, PDF) and the profit calculator.
const express = require('express');
const { db, getSettings, nextQuotationNumber, calcQuotation, formatINR, numberToWords } = require('../db');
const { requireLogin, requireAdmin, requirePerm } = require('../lib/auth');
const { generatePDFWithLetterhead } = require('../pdf');
const { paymentQr } = require('../services/paymentQr');
const { LETTERHEAD_PATH, BULL_LOGO_B64, PAYMENT_QR_B64 } = require('../lib/assets');
const { todayIST } = require('../lib/dates');

const router = express.Router();

// ── Machine quotation helpers ─────────────────────────────────────────────────
// Date printed on the quotation: chosen date, or creation date for older quotations
function quotationDateOf(q) {
  return q.quotation_date || String(q.created_at || '').slice(0, 10) || todayIST();
}

// A quotation is valid till the last day (30th/31st, 28th/29th in Feb) of its month
function quotationValidTill(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Terms printed on every machine quotation (PDF + quotation page)
function machineQuotationTerms(validTill) {
  return [
    { label: 'Price Validity',  text: `This quotation is valid till ${validTill}.` },
    { label: 'Delivery',        text: '01 to 02 weeks, Ex-Meerut, from the date of receipt of the buyer firm\'s executable order.' },
    { label: 'Payment Terms',   text: '100% in advance with order, payable by demand draft in favour of Super Allied.' },
    { label: 'Warranty',        text: '01 Year or 2000 Hours. Engine warranty applicable as per manufacturer guidelines.' },
    { label: 'Taxes & Duties',  text: 'Applicable at the time of delivery; charged at the rate prevailing on the date of dispatch.' },
    { label: 'For Financer',    text: 'Please address your delivery order & payment in favour of Super Allied.' },
  ];
}

function fmtLongDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Date, salesperson and additional items from the quotation form.
// The salesperson must be chosen; name/phone are copied from the salesperson record.
// An inactive salesperson is only accepted if already on the quotation being edited.
function parseQuotationExtras(body, existing) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.quotation_date || '') ? body.quotation_date : todayIST();

  const spId = parseInt(body.salesperson_id) || 0;
  const sp = spId ? db.prepare('SELECT id, name, phone, active FROM salespersons WHERE id=?').get(spId) : null;
  if (!sp || (!sp.active && existing?.salesperson_id !== sp.id)) return { error: 'Please choose the salesperson for this quotation.' };

  const descs   = [].concat(body.extra_desc   ?? []);
  const amounts = [].concat(body.extra_amount ?? []);
  const items = Array.from({ length: Math.max(descs.length, amounts.length) }, (_, i) =>
                       ({ description: String(descs[i] ?? '').trim(), amount: Math.max(0, parseFloat(amounts[i]) || 0) }))
                     .filter(it => it.description || it.amount);
  if (items.some(it => !it.description)) return { error: 'Each additional item needs a description.' };

  return { date, salesperson: sp, extraItems: JSON.stringify(items) };
}



// Customer ids printed on a machine quotation: GSTIN and/or PAN when present,
// otherwise Aadhaar (masked to the last 4 digits).
function quotationCustomerIds(q) {
  const ids = [];
  if (q.customer_gstin) ids.push({ label: 'GSTIN', value: q.customer_gstin });
  if (q.customer_pan)   ids.push({ label: 'PAN',   value: q.customer_pan });
  if (!ids.length && q.customer_aadhaar)
    ids.push({ label: 'Aadhaar', value: 'XXXX XXXX ' + q.customer_aadhaar.slice(-4) });
  return ids;
}

// ── Quotations ────────────────────────────────────────────────────────────────
router.get('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const { status, q } = req.query;
  let sql = `SELECT qo.*, c.name as customer_name, m.display_name as machine_name, cu.full_name as cancelled_by_name
             FROM quotations qo
             JOIN customers c ON c.id = qo.customer_id
             JOIN machines m  ON m.id = qo.machine_id
             LEFT JOIN users cu ON cu.id = qo.cancelled_by`;
  const params = [];
  const conds = [];
  if (!isAdmin) { conds.push('qo.user_id = ?'); params.push(req.session.userId); }
  // Cancelled quotations: never shown to users; admin sees them (or only them via the filter)
  if (!isAdmin || (status && status !== 'cancelled')) conds.push('qo.cancelled_at IS NULL');
  if (status === 'cancelled') conds.push('qo.cancelled_at IS NOT NULL');
  else if (status) { conds.push('qo.status = ?'); params.push(status); }
  if (q)        { conds.push('(c.name LIKE ? OR qo.quotation_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY qo.created_at DESC';
  const quotations = db.prepare(sql).all(...params);
  const s = getSettings();
  res.render('quotations', { title: 'Quotations', quotations, status: status||'', q: q||'', formatINR, calcQuotation, settings: s });
});

router.get('/quotations/new', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin      = res.locals.user?.role === 'admin';
  const machines     = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers    = isAdmin
    ? db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY name').all()
    : db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL AND created_by=? ORDER BY name').all(req.session.userId);
  const salespersons = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name').all();
  const prefill      = req.query.customer_id || '';
  const s            = getSettings();
  res.render('quotation-form', { title: 'New Quotation', quotation: null, machines, customers, salespersons, prefill, formatINR, settings: s,
    quotationDate: todayIST(), quotationValidTill });
});

router.post('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes,
  } = req.body;

  if (!customer_id || !machine_id || !basic_price) {
    req.session.flash = { error: 'Customer, machine and price are required.' };
    return res.redirect('/quotations/new');
  }
  const extras = parseQuotationExtras(req.body, null);
  if (extras.error) {
    req.session.flash = { error: extras.error };
    return res.redirect('/quotations/new');
  }

  const { quotationNumber, financialYear, serialNumber } = nextQuotationNumber();
  db.prepare(`INSERT INTO quotations
    (quotation_number,financial_year,serial_number,customer_id,machine_id,user_id,
     quantity,basic_price,transit_insurance,tax_mode,cgst_rate,sgst_rate,igst_rate,
     has_tcs,tcs_rate,insurance_amount,trc,handling_charges,transport_charges,hp_with,notes,salesperson_name,salesperson_phone,tyre_option,salesperson_id,
     quotation_date,extra_items)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      quotationNumber, financialYear, serialNumber,
      +customer_id, +machine_id, req.session.userId,
      +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'',
      extras.salesperson.name, extras.salesperson.phone||'',
      req.body.tyre_option||'IT', extras.salesperson.id,
      extras.date, extras.extraItems
    );
  req.session.flash = { success: `Quotation ${quotationNumber} created.` };
  res.redirect('/quotations');
});

router.get('/quotations/:id', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           c.pan as customer_pan, c.aadhaar as customer_aadhaar,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series, cu.full_name as cancelled_by_name
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    LEFT JOIN users cu ON cu.id = qo.cancelled_by
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.redirect('/quotations');
  if (!isAdmin && (q.user_id !== req.session.userId || q.cancelled_at)) return res.redirect('/quotations');
  const s = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  const qDate = quotationDateOf(q);
  res.render('quotation-view', { title: `Quotation ${q.quotation_number}`, q, calc, specs, formatINR, customerIds: quotationCustomerIds(q),
    quotationDate: fmtLongDate(qDate), validTill: fmtLongDate(quotationValidTill(qDate)),
    terms: machineQuotationTerms(fmtLongDate(quotationValidTill(qDate))) });
});

router.get('/quotations/:id/edit', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin   = res.locals.user?.role === 'admin';
  const quotation = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!quotation) return res.redirect('/quotations');
  if (!isAdmin && (quotation.user_id !== req.session.userId || quotation.cancelled_at)) return res.redirect('/quotations');
  if (quotation.cancelled_at) {
    req.session.flash = { error: 'This quotation is cancelled. Restore it before editing.' };
    return res.redirect(`/quotations/${quotation.id}`);
  }
  const machines  = db.prepare('SELECT * FROM machines WHERE active = 1 OR id = ? ORDER BY model_series, display_name').all(quotation.machine_id);
  const customers = isAdmin
    ? db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL OR id=? ORDER BY name').all(quotation.customer_id)
    : db.prepare('SELECT * FROM customers WHERE (deleted_at IS NULL OR id=?) AND created_by=? ORDER BY name').all(quotation.customer_id, req.session.userId);
  const s         = getSettings();
  // Active salespersons, plus the one already on this quotation even if since deactivated
  const salespersons2 = db.prepare('SELECT id,name FROM salespersons WHERE active=1 OR id=? ORDER BY name').all(quotation.salesperson_id || 0);
  res.render('quotation-form', { title: 'Edit Quotation', quotation, machines, customers, salespersons: salespersons2, prefill: '', formatINR, settings: s,
    quotationDate: quotationDateOf(quotation), quotationValidTill });
});

router.post('/quotations/:id', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id, salesperson_id, cancelled_at FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || existing.cancelled_at || (!isAdmin && existing.user_id !== req.session.userId)) {
    req.session.flash = { error: existing?.cancelled_at ? 'This quotation is cancelled.' : `You don't have permission to edit this quotation.` };
    return res.redirect('/quotations');
  }
  const extras = parseQuotationExtras(req.body, existing);
  if (extras.error) {
    req.session.flash = { error: extras.error };
    return res.redirect(`/quotations/${req.params.id}/edit`);
  }
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes, status,
    tyre_option,
  } = req.body;
  db.prepare(`UPDATE quotations SET
    customer_id=?,machine_id=?,quantity=?,basic_price=?,transit_insurance=?,
    tax_mode=?,cgst_rate=?,sgst_rate=?,igst_rate=?,has_tcs=?,tcs_rate=?,
    insurance_amount=?,trc=?,handling_charges=?,transport_charges=?,hp_with=?,notes=?,status=?,
    salesperson_name=?,salesperson_phone=?,salesperson_id=?,tyre_option=?,quotation_date=?,extra_items=?
    WHERE id=?`)
    .run(
      +customer_id, +machine_id, +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'', status||'draft',
      extras.salesperson.name, extras.salesperson.phone||'', extras.salesperson.id,
      tyre_option||'IT', extras.date, extras.extraItems,
      req.params.id
    );
  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/quotations/${req.params.id}`);
});

router.post('/quotations/:id/delete', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id, cancelled_at FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || (!isAdmin && (existing.user_id !== req.session.userId || existing.cancelled_at))) {
    req.session.flash = { error: `You don't have permission to cancel this quotation.` };
    return res.redirect('/quotations');
  }
  // Soft delete: hidden from users, admin still sees it marked Cancelled.
  db.prepare('UPDATE quotations SET cancelled_at=CURRENT_TIMESTAMP, cancelled_by=? WHERE id=? AND cancelled_at IS NULL').run(req.session.userId, req.params.id);
  req.session.flash = { success: 'Quotation cancelled.' };
  res.redirect('/quotations');
});

router.post('/quotations/:id/restore', requireLogin, requireAdmin, (req, res) => {
  db.prepare('UPDATE quotations SET cancelled_at=NULL, cancelled_by=NULL WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Quotation restored.' };
  res.redirect(`/quotations/${req.params.id}`);
});

router.get('/quotations/:id/pdf', requireLogin, requirePerm('quotations'), async (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           c.pan as customer_pan, c.aadhaar as customer_aadhaar,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q || q.cancelled_at) return res.status(404).send('Not found');
  if (!isAdmin && q.user_id !== req.session.userId) return res.status(403).send('Forbidden');

  const s    = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  // Payment QR from the master bank / UPI settings (fixed image only if neither is set)
  const qr = await paymentQr(s, calc.total, q.quotation_number);
  const html = await new Promise((resolve, reject) => {
    const qDate = quotationDateOf(q);
    res.app.render('quotation-pdf', { q, calc, specs, settings: s, formatINR, customerIds: quotationCustomerIds(q),
      quotationDate: fmtLongDate(qDate).toUpperCase(), validTill: fmtLongDate(quotationValidTill(qDate)),
      terms: machineQuotationTerms(fmtLongDate(quotationValidTill(qDate))), numberToWords, bullLogoB64: BULL_LOGO_B64, paymentQrB64: qr?.dataUrl || PAYMENT_QR_B64, qr }, (err, html) => {
      if (err) reject(err); else resolve(html);
    });
  });

  try {
    const pdfBuffer = await generatePDFWithLetterhead(html, LETTERHEAD_PATH, { fitOnePage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quotation-${q.quotation_number.replace('/', '-')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    req.session.flash = { error: 'PDF generation failed. Is Puppeteer installed?' };
    res.redirect(`/quotations/${req.params.id}`);
  }
});

// ── Calculator (admin only) ───────────────────────────────────────────────────
router.get('/calculator', requireLogin, requireAdmin, (req, res) => {
  const machines = db.prepare('SELECT id, display_name, model_series, basic_price FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  res.render('calculator', { title: 'Profit Calculator', machines, formatINR });
});

module.exports = router;
