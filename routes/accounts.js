// ── Accounts module routes (/accounts) ────────────────────────────────────────
// Thin layer over services/accounts: parse input, call the engine (which checks
// permissions and runs the transaction), render. Every POST needs the CSRF token.
// Permissions: accounts_view (sales, own customers) · accounts (accountant) ·
// accounts_approve (accounts manager) · accounts_reports (management) · admin.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const router = express.Router();
const { db, numberToWords, createNotification } = require('../db');
const { generatePDF, generatePDFWithLetterhead } = require('../pdf');
const { createAccounts, AccError, inr, rupees, todayIST, isDate, MODES, PURPOSES, DOC_TYPES, RECEIVABLE } = require('../services/accounts/engine');
const { createQueries } = require('../services/accounts/queries');
const { createReports } = require('../services/accounts/reports');
const files = require('../services/accounts/files');

const acc = createAccounts(db);
const qr = createQueries(acc);
const reports = createReports(acc, qr);
const LETTERHEAD_PATH = path.join(__dirname, '..', 'Super Allied Letterhead.pdf');

// ── Request context ───────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const u = res.locals.user;
  req.actor = { id: u.id, role: u.role };
  if (!req.session.accCsrf) req.session.accCsrf = crypto.randomBytes(24).toString('hex');
  Object.assign(res.locals, {
    csrf: req.session.accCsrf, inr, rupees, MODES, PURPOSES, DOC_TYPES, today: todayIST(),
    accCan: (p) => acc.can(req.actor, p), seeAll: acc.canSeeAll(req.actor), invoiceStatus: qr.invoiceStatus,
    money: (p) => rupees(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
  if (req.method === 'POST') {
    const token = req.body?._csrf || req.get('x-csrf-token');
    const a = Buffer.from(String(token || '')), b = Buffer.from(req.session.accCsrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      if (req.is('json')) return res.status(403).json({ ok: false, error: 'Your session expired. Reload the page and try again.' });
      req.session.flash = { error: 'Your session expired. Please try again.' };
      return res.redirect(req.get('referer')?.startsWith(req.protocol + '://' + req.get('host')) ? req.get('referer') : '/accounts');
    }
  }
  next();
});

// Page-level guard; the engine re-checks every write.
const need = (...perms) => (req, res, next) => {
  if (perms.some(p => p === 'all' ? acc.canSeeAll(req.actor) : acc.can(req.actor, p))) return next();
  if (req.is('json') || req.xhr) return res.status(403).json({ ok: false, error: 'You are not authorised to do this.' });
  res.status(403);
  req.session.flash = { error: 'You are not authorised to open that Accounts page.' };
  res.redirect(acc.can(req.actor, 'accounts_view') ? '/accounts/customers' : '/');
};

// Engine errors → flash + redirect (forms) or JSON (fetch)
function handle(fn, back) {
  return async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      if (!(e instanceof AccError)) return next(e);
      if (req.is('json')) return res.status(e.status || 400).json({ ok: false, error: e.message, duplicateId: e.duplicateId });
      req.session.flash = { error: e.message };
      if (e.status === 403) res.status(403);
      res.redirect(typeof back === 'function' ? back(req) : back || req.get('referer') || '/accounts');
    }
  };
}
const id = (req) => Number(req.params.id) || 0;
const arr = (v) => (v === undefined ? [] : [].concat(v));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ── Shared form data ──────────────────────────────────────────────────────────
function customersFor(actor) {
  const sc = qr.scope(actor, 'c.id');
  return db.prepare(`SELECT c.id, c.name, c.phone, c.gstin, c.city FROM customers c WHERE c.deleted_at IS NULL ${sc.sql} ORDER BY c.name`).all(...sc.params);
}
const salespersons = () => db.prepare('SELECT id, name FROM salespersons WHERE active=1 ORDER BY name').all();
const branches = () => String(acc.settings().acc_branches || '').split(',').map(s => s.trim()).filter(Boolean);
const staff = () => db.prepare("SELECT id, full_name, username FROM users WHERE is_hr_active=1 ORDER BY full_name").all();
const monthStart = () => todayIST().slice(0, 8) + '01';

// Filters from the query string, validated. defaultMonth: no query at all → this month.
function parseFilters(q, { defaultMonth = false } = {}) {
  const f = {};
  const fresh = !Object.keys(q).length;
  f.from = isDate(q.from) ? q.from : fresh && defaultMonth ? monthStart() : '';
  f.to = isDate(q.to) ? q.to : fresh && defaultMonth ? todayIST() : '';
  ['customer_id', 'salesperson_id', 'user_id'].forEach(k => { if (Number(q[k]) > 0) f[k] = Number(q[k]); });
  if (q.branch && branches().includes(q.branch)) f.branch = q.branch;
  if (DOC_TYPES[q.doc_type]) f.doc_type = q.doc_type;
  if (MODES[q.mode]) f.mode = q.mode;
  if (/^[a-z_]{1,20}$/.test(q.status || '')) f.status = q.status;
  if (q.q) f.q = String(q.q).slice(0, 60);
  return f;
}
function filterContext(req, f) {
  return { f, customers: customersFor(req.actor), salespersons: salespersons(), branches: branches(), qs: new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString() };
}

function canViewInvoice(actor, inv) { return inv && (acc.canSeeAll(actor) || (inv.status !== 'draft' && acc.canViewCustomer(actor, inv.customer_id))); }

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (!acc.canSeeAll(req.actor)) return res.redirect(acc.can(req.actor, 'accounts_view') ? '/accounts/customers' : '/');
  const f = parseFilters(req.query, { defaultMonth: true });
  res.render('accounts/dashboard', { title: 'Accountant Dashboard', ...filterContext(req, f), d: qr.dashboard(req.actor, f) });
});

// ── Customer accounts ─────────────────────────────────────────────────────────
router.get('/customers', need('accounts_view', 'all'), (req, res) => {
  const f = parseFilters(req.query);
  const out = reports.run(req.actor, 'customer-outstanding', { ...f, status: f.status || 'all' });
  let rows = out.rows;
  if (f.q) rows = rows.filter(r => r.customer_name.toLowerCase().includes(f.q.toLowerCase()));
  res.render('accounts/customers', { title: 'Customer Accounts', ...filterContext(req, f), rows, totals: out.totals });
});

router.get('/customers/:id', need('accounts_view', 'all'), (req, res) => {
  if (!acc.canViewCustomer(req.actor, id(req))) { req.session.flash = { error: 'You cannot view this customer’s account.' }; return res.redirect('/accounts/customers'); }
  const a = qr.customerAccount(id(req));
  if (!a) return res.redirect('/accounts/customers');
  const from = isDate(req.query.from) ? req.query.from : '', to = isDate(req.query.to) ? req.query.to : '';
  res.render('accounts/customer', { title: a.c.name + ' — Account', a, led: qr.ledger(a.c.id, { from, to }), from, to, tab: req.query.tab || 'ledger' });
});

router.get('/customers/:id/statement.:fmt(pdf|csv|xlsx)', need('accounts_view', 'all'), handle(async (req, res) => {
  if (!acc.canViewCustomer(req.actor, id(req))) throw new AccError('You cannot view this customer’s account.', 403);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id(req));
  const from = isDate(req.query.from) ? req.query.from : '', to = isDate(req.query.to) ? req.query.to : '';
  const led = qr.ledger(c.id, { from, to });
  acc.audit(req.actor, 'statement_exported', 'acc_customer', c.id, { format: req.params.fmt, from, to });
  const fname = `Statement-${c.name.replace(/[^\w]+/g, '_').slice(0, 40)}-${todayIST()}`;
  const rows = [['Date', 'Document', 'Description', 'Debit', 'Credit', 'Balance'],
    ['', '', 'Opening balance', '', '', drcr(led.opening)],
    ...led.rows.map(r => [r.date, r.doc, r.description, r.debit ? rupees(r.debit) : '', r.credit ? rupees(r.credit) : '', drcr(r.balance)]),
    ['', '', 'Total / closing balance', rupees(led.totals.debit), rupees(led.totals.credit), drcr(led.closing)]];
  if (req.params.fmt === 'csv') return sendCsv(res, fname, rows);
  if (req.params.fmt === 'xlsx') return sendXlsx(res, fname, 'Statement', rows);
  const html = await renderView(req, 'accounts/statement-pdf', { c, led, from, to, s: acc.settings() });
  sendPdf(res, fname, await generatePDFWithLetterhead(html, LETTERHEAD_PATH));
}, (req) => `/accounts/customers/${id(req)}`));
const drcr = (p) => `${rupees(Math.abs(p)).toFixed(2)} ${p > 0 ? 'Dr' : p < 0 ? 'Cr' : ''}`.trim();

// Linked documents for one customer — feeds the dependent dropdowns on the forms
router.get('/api/customers/:id/docs', need('accounts_view', 'all'), (req, res) => {
  const cid = id(req);
  if (!acc.canViewCustomer(req.actor, cid)) return res.status(403).json({ ok: false, error: 'Not allowed' });
  const c = db.prepare('SELECT id, name, gstin, phone, address, city, state FROM customers WHERE id=?').get(cid);
  const quotations = db.prepare(`SELECT q.id, q.quotation_number, q.salesperson_id, m.display_name AS machine FROM quotations q JOIN machines m ON m.id=q.machine_id
    WHERE q.customer_id=? AND q.cancelled_at IS NULL ORDER BY q.id DESC`).all(cid).map(q => ({ ...q, ...qr.quotationFinancials(q.id) }));
  const challans = qr.challanList(req.actor, { customer_id: cid }).map(ch => ({ id: ch.id, challan_number: ch.challan_number, challan_date: ch.challan_date,
    quotation_id: ch.quotation_id, machine: [ch.machine_name, ch.machine_details, ch.chassis_number && 'Chassis ' + ch.chassis_number].filter(Boolean).join(' · '),
    challan_value: ch.challan_value, invoice_numbers: ch.invoice_numbers, salesperson_id: ch.salesperson_id,
    invoice_ids: db.prepare(`SELECT ic.invoice_id AS id FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id WHERE ic.challan_id=? AND i.status IN ('uploaded','verified')`).all(ch.id).map(r => r.id) }));
  const invoices = qr.invoiceList(req.actor, { customer_id: cid }).filter(i => RECEIVABLE.includes(i.doc_type))
    .map(i => ({ id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, due_date: i.due_date, total: i.total_amount,
      balance: i.balance_amount, available: acc.invoiceAvailable(i.id), quotation_id: i.quotation_id, status: qr.invoiceStatus(i).label }));
  const payments = qr.paymentList(req.actor, { customer_id: cid, unallocatedOnly: true }).map(p => ({ id: p.id, receipt_number: p.receipt_number,
    payment_date: p.payment_date, amount: p.amount, unallocated: p.unallocated_amount, purpose: PURPOSES[p.purpose], mode: MODES[p.mode], clearance: p.clearance_status }));
  const credits = qr.invoiceList(req.actor, { customer_id: cid, doc_type: 'credit_note' }).filter(i => i.balance_amount > 0)
    .map(i => ({ id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, balance: i.balance_amount }));
  res.json({ ok: true, customer: c, quotations, challans, invoices, payments, credits });
});

// ── Delivery challans ─────────────────────────────────────────────────────────
router.get('/challans', need('accounts_view', 'all'), (req, res) => {
  const f = parseFilters(req.query);
  res.render('accounts/challans', { title: 'Delivery Challans', ...filterContext(req, f), rows: qr.challanList(req.actor, { ...f, includeCancelled: f.status === 'all' }) });
});
router.get('/challans/new', need('accounts'), (req, res) => {
  res.render('accounts/challan-form', { title: 'Record Delivery Challan', customers: customersFor(req.actor), salespersons: salespersons(), branches: branches(),
    machines: db.prepare('SELECT id, display_name FROM machines WHERE active=1 ORDER BY display_name').all(), prefill: req.query });
});
router.post('/challans', need('accounts'), handle((req, res) => {
  const ch = acc.createChallan(req.actor, req.body);
  req.session.flash = { success: `Delivery challan ${ch.challan_number} recorded.` };
  res.redirect(`/accounts/challans/${ch.id}`);
}, '/accounts/challans/new'));
router.get('/challans/:id', need('accounts_view', 'all'), (req, res) => {
  const ch = qr.challanList(req.actor, { includeCancelled: true }).find(x => x.id === id(req));
  if (!ch) { req.session.flash = { error: 'Challan not found.' }; return res.redirect('/accounts/challans'); }
  const invoices = db.prepare(`SELECT i.* FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id WHERE ic.challan_id=? AND i.status<>'draft'`).all(ch.id);
  const payments = qr.paymentList(req.actor, { customer_id: ch.customer_id, includeCancelled: true }).filter(p => p.challan_id === ch.id);
  res.render('accounts/challan', { title: 'Challan ' + ch.challan_number, ch, invoices, payments, received: qr.challanReceived(ch), history: history('acc_challan', ch.id) });
});
router.post('/challans/:id/cancel', need('accounts_approve'), handle((req, res) => {
  acc.cancelChallan(req.actor, id(req), req.body.reason);
  req.session.flash = { success: 'Delivery challan cancelled.' };
  res.redirect(`/accounts/challans/${id(req)}`);
}, (req) => `/accounts/challans/${id(req)}`));

// ── Tally invoices ────────────────────────────────────────────────────────────
router.get('/invoices', need('accounts_view', 'all'), (req, res) => {
  const f = parseFilters(req.query);
  const lifecycle = ['uploaded', 'verified'].includes(req.query.lifecycle) ? req.query.lifecycle : '';
  const rows = qr.invoiceList(req.actor, { ...f, lifecycle, includeDrafts: f.status === 'draft' && acc.can(req.actor, 'accounts') });
  res.render('accounts/invoices', { title: 'Invoice Register', ...filterContext(req, f), lifecycle, rows });
});

router.get('/invoices/upload', need('accounts'), (req, res) => {
  const s = acc.settings();
  res.render('accounts/invoice-upload', { title: 'Upload Tally Invoice', customers: customersFor(req.actor), salespersons: salespersons(), branches: branches(),
    token: crypto.randomUUID(), maxMb: parseInt(s.acc_max_upload_mb) || 10, prefill: req.query });
});

// PDF text suggestions (unverified)
router.post('/invoices/extract', need('accounts'), handle((req, res) => {
  const up = files.validateUpload(req.body.file, parseInt(acc.settings().acc_max_upload_mb) || 10);
  res.json({ ok: true, suggestions: files.suggest(up, acc.settings().company_gstin) });
}));

// Save as Draft with the file, then go to the review screen
router.post('/invoices', need('accounts'), handle((req, res) => {
  const up = files.validateUpload(req.body.file, parseInt(acc.settings().acc_max_upload_mb) || 10);
  const existing = req.body.client_token && db.prepare('SELECT id FROM acc_invoices WHERE client_token=?').get(String(req.body.client_token));
  if (existing) return res.json({ ok: true, redirect: `/accounts/invoices/${existing.id}/review` });
  const stored = files.store(up.buffer, up.ext, 'inv');
  try {
    const inv = acc.createInvoiceDraft(req.actor, { ...req.body, challan_ids: arr(req.body.challan_ids), extracted_json: req.body.extracted ? JSON.stringify(req.body.extracted) : '' },
      { ...stored, originalName: up.originalName, mime: up.mime });
    res.json({ ok: true, redirect: `/accounts/invoices/${inv.id}/review` });
  } catch (e) { files.remove(stored.storedName); throw e; }
}));

function invoiceDetail(invId) {
  const i = db.prepare(`SELECT i.*, c.name AS customer_name, c.gstin AS master_gstin, c.address, c.city, c.state, c.phone, q.quotation_number, q.customer_id AS q_customer,
      ai.invoice_number AS against_number, sp.name AS salesperson_name, cu.full_name AS created_by_name, vu.full_name AS verified_by_name, xu.full_name AS cancelled_by_name
    FROM acc_invoices i JOIN customers c ON c.id=i.customer_id LEFT JOIN quotations q ON q.id=i.quotation_id LEFT JOIN acc_invoices ai ON ai.id=i.against_invoice_id
    LEFT JOIN salespersons sp ON sp.id=i.salesperson_id LEFT JOIN users cu ON cu.id=i.created_by LEFT JOIN users vu ON vu.id=i.verified_by LEFT JOIN users xu ON xu.id=i.cancelled_by
    WHERE i.id=?`).get(invId);
  if (!i) return null;
  i.challans = db.prepare('SELECT ch.* FROM acc_invoice_challans ic JOIN acc_challans ch ON ch.id=ic.challan_id WHERE ic.invoice_id=?').all(i.id);
  i.files = db.prepare('SELECT f.*, u.full_name FROM acc_invoice_files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE invoice_id=? ORDER BY revision DESC').all(i.id);
  i.allocations = db.prepare(`SELECT a.*, r.receipt_number, r.id AS receipt_id, p.payment_date, p.mode, p.clearance_status, cn.invoice_number AS cn_number, inv2.invoice_number AS target_number,
      adj.adjustment_type, u.full_name AS by_name, ru.full_name AS reversed_by_name
    FROM acc_allocations a LEFT JOIN acc_payments p ON p.id=a.payment_id LEFT JOIN acc_receipts r ON r.payment_id=a.payment_id
    LEFT JOIN acc_invoices cn ON cn.id=a.credit_note_id LEFT JOIN acc_invoices inv2 ON inv2.id=a.invoice_id LEFT JOIN acc_adjustments adj ON adj.id=a.adjustment_id
    LEFT JOIN users u ON u.id=a.allocated_by LEFT JOIN users ru ON ru.id=a.reversed_by
    WHERE a.invoice_id=? OR a.credit_note_id=? ORDER BY a.id DESC`).all(i.id, i.id);
  i.adjustments = db.prepare('SELECT a.*, u.full_name AS req_name, d.full_name AS dec_name FROM acc_adjustments a LEFT JOIN users u ON u.id=a.requested_by LEFT JOIN users d ON d.id=a.decided_by WHERE invoice_id=? ORDER BY id DESC').all(i.id);
  i.notes = db.prepare("SELECT id, invoice_number, doc_type, total_amount, status FROM acc_invoices WHERE against_invoice_id=? AND status<>'draft'").all(i.id);
  i.available = RECEIVABLE.includes(i.doc_type) ? acc.invoiceAvailable(i.id) : i.balance_amount;
  return i;
}

// Checks shown on the review screen (and on the invoice page) — warnings, not blocks
function invoiceWarnings(i) {
  const w = [];
  if (i.basic_value + i.gst_amount !== i.total_amount) w.push(`Basic + GST is ${inr(i.basic_value + i.gst_amount)}, total entered is ${inr(i.total_amount)} (difference ${inr(i.total_amount - i.basic_value - i.gst_amount)} — round-off / TCS?).`);
  if (i.customer_gstin && i.master_gstin && i.customer_gstin !== i.master_gstin) w.push(`GSTIN on invoice (${i.customer_gstin}) differs from the customer master (${i.master_gstin}).`);
  if (!i.customer_gstin && i.master_gstin) w.push('No GSTIN entered from the invoice; the customer master has ' + i.master_gstin + '.');
  if (i.quotation_id && i.q_customer !== i.customer_id) w.push(`Quotation ${i.quotation_number} belongs to a different customer.`);
  if (i.quotation_id && RECEIVABLE.includes(i.doc_type)) {
    const v = qr.quotationFinancials(i.quotation_id).value;
    if (Math.abs(v - i.total_amount) >= 100) w.push(`Quotation ${i.quotation_number} value is ${inr(v)}; the invoice is ${inr(i.total_amount)}. The invoice is recorded as uploaded from Tally — nothing is changed to match.`);
  }
  i.challans.forEach(ch => {
    if (ch.customer_id !== i.customer_id) w.push(`Delivery challan ${ch.challan_number} belongs to a different customer.`);
    if (ch.challan_value && i.challans.length === 1 && Math.abs(ch.challan_value - i.total_amount) >= 100 && RECEIVABLE.includes(i.doc_type))
      w.push(`Challan ${ch.challan_number} value is ${inr(ch.challan_value)}; the invoice is ${inr(i.total_amount)}.`);
  });
  if (i.doc_type === 'tax_invoice' && i.challan_expected && !i.challans.length) w.push('No delivery challan is linked, but one is expected.');
  if (i.due_date && i.due_date < todayIST() && i.status === 'draft') w.push(`Due date ${i.due_date} has already passed — the invoice will show as overdue.`);
  return w;
}

router.get('/invoices/:id/review', need('accounts'), (req, res) => {
  const i = invoiceDetail(id(req));
  if (!i) return res.redirect('/accounts/invoices');
  if (i.status !== 'draft') return res.redirect(`/accounts/invoices/${i.id}`);
  let extracted = null; try { extracted = i.extracted_json ? JSON.parse(i.extracted_json) : null; } catch (e) {}
  res.render('accounts/invoice-review', { title: 'Review ' + i.invoice_number, i, warnings: invoiceWarnings(i), extracted });
});
router.post('/invoices/:id/confirm', need('accounts'), handle((req, res) => {
  const inv = acc.confirmInvoice(req.actor, id(req));
  // Let the salesperson who made the quotation know the invoice is available
  const q = inv.quotation_id && db.prepare('SELECT user_id, quotation_number FROM quotations WHERE id=?').get(inv.quotation_id);
  if (q && q.user_id !== req.actor.id) createNotification(q.user_id, 'Tally invoice uploaded', `Invoice ${inv.invoice_number} for quotation ${q.quotation_number} is now in Accounts.`, 'info', `/accounts/invoices/${inv.id}`);
  req.session.flash = { success: `${DOC_TYPES[inv.doc_type]} ${inv.invoice_number} saved.` };
  res.redirect(`/accounts/invoices/${inv.id}`);
}, (req) => `/accounts/invoices/${id(req)}/review`));
router.post('/invoices/:id/discard', need('accounts'), handle((req, res) => {
  acc.discardDraft(req.actor, id(req)).forEach(n => { try { files.remove(n); } catch (e) {} });
  req.session.flash = { success: 'Draft discarded. Nothing was saved.' };
  res.redirect('/accounts/invoices/upload');
}));

router.get('/invoices/:id', need('accounts_view', 'all'), (req, res) => {
  const i = invoiceDetail(id(req));
  if (!canViewInvoice(req.actor, i)) { req.session.flash = { error: 'Invoice not found.' }; return res.redirect('/accounts/invoices'); }
  if (i.status === 'draft') return res.redirect(`/accounts/invoices/${i.id}/review`);
  res.render('accounts/invoice', { title: `${DOC_TYPES[i.doc_type]} ${i.invoice_number}`, i, warnings: acc.canSeeAll(req.actor) ? invoiceWarnings(i) : [],
    history: acc.canSeeAll(req.actor) ? history('acc_invoice', i.id) : [] });
});

router.get('/invoices/:id/file/:rev', need('accounts_view', 'all'), (req, res) => {
  const i = db.prepare('SELECT * FROM acc_invoices WHERE id=?').get(id(req));
  const okDraft = i?.status === 'draft' && acc.can(req.actor, 'accounts');
  if (!i || (!okDraft && !canViewInvoice(req.actor, i))) return res.status(404).send('Not found');
  const f = db.prepare('SELECT * FROM acc_invoice_files WHERE invoice_id=? AND revision=?').get(i.id, Number(req.params.rev) || 0);
  const p = f && files.filePath(f.stored_name);
  if (!p) return res.status(404).send('File not found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  const name = `${i.invoice_number.replace(/[^\w\-]+/g, '-')}-r${f.revision}.${f.stored_name.split('.').pop()}`;
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.sendFile(p);
});

router.get('/invoices/:id/edit', need('accounts'), (req, res) => {
  const i = invoiceDetail(id(req));
  if (!i || i.status === 'cancelled') return res.redirect('/accounts/invoices');
  res.render('accounts/invoice-edit', { title: 'Edit ' + i.invoice_number, i, customers: customersFor(req.actor), salespersons: salespersons(), branches: branches() });
});
router.post('/invoices/:id', need('accounts'), handle((req, res) => {
  const before = db.prepare('SELECT status FROM acc_invoices WHERE id=?').get(id(req));
  acc.updateInvoice(req.actor, id(req), { ...req.body, challan_ids: req.body.challans_loaded === '1' ? arr(req.body.challan_ids) : undefined }, req.body.change_reason);
  req.session.flash = { success: 'Invoice updated. The change is in its history.' };
  res.redirect(before?.status === 'draft' ? `/accounts/invoices/${id(req)}/review` : `/accounts/invoices/${id(req)}`);
}, (req) => `/accounts/invoices/${id(req)}/edit`));

router.post('/invoices/:id/file', need('accounts'), handle((req, res) => {
  const up = files.validateUpload(req.body.file, parseInt(acc.settings().acc_max_upload_mb) || 10);
  const stored = files.store(up.buffer, up.ext, 'inv');
  try {
    const rev = acc.replaceInvoiceFile(req.actor, id(req), { ...stored, originalName: up.originalName, mime: up.mime }, req.body.reason);
    res.json({ ok: true, revision: rev });
  } catch (e) { files.remove(stored.storedName); throw e; }
}));
router.post('/invoices/:id/verify', need('accounts_approve'), handle((req, res) => {
  acc.verifyInvoice(req.actor, id(req));
  req.session.flash = { success: 'Invoice verified.' };
  res.redirect(req.body.back === 'approvals' ? '/accounts/approvals' : `/accounts/invoices/${id(req)}`);
}));
router.post('/invoices/:id/cancel', need('accounts_approve'), handle((req, res) => {
  acc.cancelInvoice(req.actor, id(req), req.body.reason);
  req.session.flash = { success: 'Invoice marked cancelled. Its file and history are kept.' };
  res.redirect(`/accounts/invoices/${id(req)}`);
}, (req) => `/accounts/invoices/${id(req)}`));
router.post('/invoices/:id/adjustments', need('accounts'), handle((req, res) => {
  acc.requestAdjustment(req.actor, id(req), req.body);
  req.session.flash = { success: 'Adjustment request sent for approval.' };
  res.redirect(`/accounts/invoices/${id(req)}`);
}, (req) => `/accounts/invoices/${id(req)}`));

// ── Receipts (Generate Receipt = record money received + its receipt) ─────────
router.get('/receipts/new', need('accounts'), (req, res) => {
  res.render('accounts/receipt-form', { title: 'Generate Receipt', customers: customersFor(req.actor), salespersons: salespersons(), branches: branches(),
    staff: staff(), token: crypto.randomUUID(), prefill: req.query });
});

router.post('/receipts', need('accounts'), handle(async (req, res) => {
  const b = req.body;
  const allocations = arr(b.alloc_invoice).map((inv, k) => ({ invoice_id: inv, amount: arr(b.alloc_amount)[k] }));
  const out = acc.recordPayment(req.actor, { ...b, allocations });
  if (!out.duplicate && process.env.ACC_RECEIPT_PDF !== 'off') storeReceiptPdf(req, out.receipt.id).catch(e => console.error('Receipt PDF store failed:', e.message));
  req.session.flash = { success: out.duplicate ? `This payment was already saved as receipt ${out.receipt.receipt_number}.` : `Receipt ${out.receipt.receipt_number} generated for ${inr(out.payment.amount)}.` };
  res.redirect(`/accounts/receipts/${out.receipt.id}`);
}, (req) => '/accounts/receipts/new?' + new URLSearchParams({ customer_id: req.body.customer_id || '' })));

function receiptData(receiptId) {
  const r = db.prepare(`SELECT r.*, p.*, r.id AS id, r.status AS receipt_status, p.status AS payment_status, p.id AS payment_id,
      c.name AS customer_name, c.address, c.city, c.state, c.gstin, c.phone, q.quotation_number, ch.challan_number,
      ru.full_name AS received_by_name, pu.full_name AS prepared_by_name, sp.name AS salesperson_name, vu.full_name AS verified_by_name
    FROM acc_receipts r JOIN acc_payments p ON p.id=r.payment_id JOIN customers c ON c.id=p.customer_id
    LEFT JOIN quotations q ON q.id=p.quotation_id LEFT JOIN acc_challans ch ON ch.id=p.challan_id
    LEFT JOIN users ru ON ru.id=p.received_by LEFT JOIN users pu ON pu.id=r.prepared_by LEFT JOIN salespersons sp ON sp.id=p.salesperson_id
    LEFT JOIN users vu ON vu.id=p.verified_by WHERE r.id=?`).get(receiptId);
  if (!r) return null;
  r.allocations = db.prepare(`SELECT a.*, i.invoice_number, i.invoice_date, i.total_amount, i.balance_amount, q.quotation_number AS inv_quotation FROM acc_allocations a
    JOIN acc_invoices i ON i.id=a.invoice_id LEFT JOIN quotations q ON q.id=i.quotation_id WHERE a.payment_id=? ORDER BY a.id`).all(r.payment_id);
  // Invoices linked through the challan (shown even before allocation)
  r.challanInvoices = r.challan_id ? db.prepare(`SELECT i.invoice_number FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
    WHERE ic.challan_id=? AND i.status IN ('uploaded','verified')`).all(r.challan_id).map(x => x.invoice_number) : [];
  r.cancellation = db.prepare(`SELECT x.*, u.full_name AS req_name, d.full_name AS dec_name FROM acc_cancellations x LEFT JOIN users u ON u.id=x.requested_by
    LEFT JOIN users d ON d.id=x.decided_by WHERE receipt_id=? ORDER BY id DESC`).all(r.id);
  r.cheque = db.prepare('SELECT e.*, u.full_name FROM acc_cheque_events e LEFT JOIN users u ON u.id=e.created_by WHERE payment_id=? ORDER BY e.id').all(r.payment_id);
  r.words = amountWords(r.amount);
  r.qfin = r.quotation_id ? qr.quotationFinancials(r.quotation_id) : null;
  return r;
}
function amountWords(paise) {
  const rs = Math.floor(paise / 100), ps = paise % 100;
  const w = numberToWords(rs);
  return ps ? w.replace(/ Rupees Only$/, ` Rupees and ${numberToWords(ps).replace(/ Rupees Only$/, '')} Paise Only`) : w;
}
function renderView(req, view, data) {
  return new Promise((resolve, reject) => req.app.render(view, { ...data, money: (p) => rupees(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    inr, MODES, PURPOSES, DOC_TYPES, bullLogoB64: req.app.locals.bullLogoB64 }, (e, h) => e ? reject(e) : resolve(h)));
}
async function receiptPdf(req, r) {
  return generatePDFWithLetterhead(await renderView(req, 'accounts/receipt-pdf', { r, s: acc.settings() }), LETTERHEAD_PATH, { fitOnePage: true });
}
// Keep the original receipt PDF as issued, so later changes never alter it
async function storeReceiptPdf(req, receiptId) {
  const r = receiptData(receiptId);
  if (!r || r.pdf_stored_name) return;
  const st = files.store(await receiptPdf(req, r), 'pdf', 'rct');
  db.prepare("UPDATE acc_receipts SET pdf_stored_name=? WHERE id=? AND pdf_stored_name=''").run(st.storedName, receiptId);
}
function canViewReceipt(actor, r) { return r && (acc.canSeeAll(actor) || acc.canViewCustomer(actor, r.customer_id)); }

router.get('/receipts/:id', need('accounts_view', 'all'), (req, res) => {
  const r = receiptData(id(req));
  if (!canViewReceipt(req.actor, r)) { req.session.flash = { error: 'Receipt not found.' }; return res.redirect('/accounts'); }
  res.render('accounts/receipt', { title: 'Receipt ' + r.receipt_number, r, s: acc.settings(), history: acc.canSeeAll(req.actor) ? history('acc_receipt', r.id) : [] });
});
router.get('/receipts/:id/pdf', need('accounts_view', 'all'), handle(async (req, res) => {
  const r = receiptData(id(req));
  if (!canViewReceipt(req.actor, r)) throw new AccError('Receipt not found.', 404);
  const fname = `Receipt-${r.receipt_number.replace(/[^\w\-]+/g, '-')}${req.query.original ? '-original' : ''}`;
  const stored = r.pdf_stored_name && files.filePath(r.pdf_stored_name);
  // Issued: the stored original. Cancelled: a fresh copy stamped CANCELLED (original still downloadable).
  let buf;
  if (stored && (r.receipt_status === 'issued' || req.query.original)) buf = require('fs').readFileSync(stored);
  else {
    buf = await receiptPdf(req, r);
    if (r.receipt_status === 'issued' && !r.pdf_stored_name) {
      const st = files.store(buf, 'pdf', 'rct');
      db.prepare("UPDATE acc_receipts SET pdf_stored_name=? WHERE id=? AND pdf_stored_name=''").run(st.storedName, r.id);
    }
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${fname}.pdf"`);
  res.send(buf);
}, (req) => `/accounts/receipts/${id(req)}`));
router.post('/receipts/:id/cancel', need('accounts'), handle((req, res) => {
  const out = acc.requestReceiptCancellation(req.actor, id(req), req.body.reason);
  req.session.flash = { success: out.executed ? `Receipt cancelled (${out.request.cancellation_number}). Its allocations were reversed.` : 'Cancellation request sent to the accounts manager for approval.' };
  res.redirect(`/accounts/receipts/${id(req)}`);
}, (req) => `/accounts/receipts/${id(req)}`));

// ── Payment Entry (payments register, cheque + verification workflow) ─────────
router.get('/payments', need('accounts', 'accounts_approve', 'accounts_reports'), (req, res) => {
  const f = parseFilters(req.query);
  const v = ['pending', 'verified', 'rejected'].includes(req.query.verification) ? req.query.verification : '';
  const rows = qr.paymentList(req.actor, { ...f, verification: v || undefined, includeCancelled: f.status === 'cancelled' })
    .filter(p => f.status !== 'cancelled' || p.status === 'cancelled');
  res.render('accounts/payments', { title: 'Payment Entry', ...filterContext(req, f), verification: v, rows });
});
router.post('/payments/:id/cheque', need('accounts'), handle((req, res) => {
  acc.updateCheque(req.actor, id(req), req.body);
  req.session.flash = { success: `Cheque marked ${req.body.status}.` };
  res.redirect(req.get('referer') || '/accounts/payments');
}));
router.post('/payments/:id/verify', need('accounts_approve'), handle((req, res) => {
  acc.verifyPayment(req.actor, id(req), req.body);
  req.session.flash = { success: `Payment ${req.body.decision}.` };
  res.redirect(req.get('referer') || '/accounts/payments');
}));
router.post('/payments/:id/reference', need('accounts'), handle((req, res) => {
  acc.updatePaymentReference(req.actor, id(req), req.body);
  req.session.flash = { success: 'Payment details updated.' };
  res.redirect(req.get('referer') || '/accounts/payments');
}));

// ── Payment Allocation ────────────────────────────────────────────────────────
router.get('/allocations', need('accounts', 'accounts_approve'), (req, res) => {
  const cid = Number(req.query.customer_id) || 0;
  const recent = db.prepare(`SELECT a.*, i.invoice_number, c.name AS customer_name, r.receipt_number, r.id AS receipt_id, cn.invoice_number AS cn_number, u.full_name AS by_name
    FROM acc_allocations a JOIN acc_invoices i ON i.id=a.invoice_id JOIN customers c ON c.id=i.customer_id
    LEFT JOIN acc_receipts r ON r.payment_id=a.payment_id LEFT JOIN acc_invoices cn ON cn.id=a.credit_note_id LEFT JOIN users u ON u.id=a.allocated_by
    ${cid ? 'WHERE i.customer_id=?' : ''} ORDER BY a.id DESC LIMIT 50`).all(...(cid ? [cid] : []));
  res.render('accounts/allocations', { title: 'Payment Allocation', customers: customersFor(req.actor), cid, recent,
    pre: { payment_id: Number(req.query.payment_id) || 0, credit_note_id: Number(req.query.credit_note_id) || 0, invoice_id: Number(req.query.invoice_id) || 0 } });
});
router.post('/allocations', need('accounts'), handle((req, res) => {
  const b = req.body;
  const [kind, srcId] = String(b.source || '').split(':');
  const lines = arr(b.alloc_invoice).map((inv, k) => ({ invoice_id: inv, amount: arr(b.alloc_amount)[k] }));
  const n = acc.allocate(req.actor, { payment_id: kind === 'p' ? Number(srcId) : null, credit_note_id: kind === 'cn' ? Number(srcId) : null, lines, remarks: b.remarks });
  req.session.flash = { success: `${n} allocation${n > 1 ? 's' : ''} saved.` };
  res.redirect(`/accounts/allocations?customer_id=${Number(b.customer_id) || ''}`);
}, (req) => `/accounts/allocations?customer_id=${Number(req.body.customer_id) || ''}`));
router.post('/allocations/:id/reverse', need('accounts_approve'), handle((req, res) => {
  acc.reverseAllocation(req.actor, id(req), req.body.reason);
  req.session.flash = { success: 'Allocation reversed. The balances were recalculated.' };
  res.redirect(req.get('referer') || '/accounts/allocations');
}));

// ── Approvals (accounts manager inbox) ────────────────────────────────────────
router.get('/approvals', need('accounts', 'accounts_approve'), (req, res) => {
  const data = {
    cancellations: db.prepare(`SELECT x.*, r.receipt_number, r.id AS rid, p.amount, p.mode, c.name AS customer_name, u.full_name AS req_name
      FROM acc_cancellations x JOIN acc_receipts r ON r.id=x.receipt_id JOIN acc_payments p ON p.id=r.payment_id JOIN customers c ON c.id=p.customer_id
      LEFT JOIN users u ON u.id=x.requested_by WHERE x.status='pending' ORDER BY x.id`).all(),
    adjustments: db.prepare(`SELECT a.*, i.invoice_number, i.balance_amount, c.name AS customer_name, u.full_name AS req_name FROM acc_adjustments a
      JOIN acc_invoices i ON i.id=a.invoice_id JOIN customers c ON c.id=i.customer_id LEFT JOIN users u ON u.id=a.requested_by WHERE a.status='pending' ORDER BY a.id`).all(),
    invoices: qr.invoiceList(req.actor, { lifecycle: 'uploaded' }),
    payments: qr.paymentList(req.actor, { verification: 'pending' }).filter(p => p.clearance_status !== 'bounced'),
    drafts: qr.invoiceList(req.actor, { status: 'draft', includeDrafts: true }),
  };
  res.render('accounts/approvals', { title: 'Approvals & Verification', ...data });
});
router.post('/cancellations/:id/decide', need('accounts_approve'), handle((req, res) => {
  const ok = acc.decideCancellation(req.actor, id(req), req.body.decision === 'approve', req.body.remarks);
  req.session.flash = { success: ok ? 'Receipt cancelled and its allocations reversed.' : 'Cancellation request rejected.' };
  res.redirect(req.get('referer') || '/accounts/approvals');
}));
router.post('/adjustments/:id/decide', need('accounts_approve'), handle((req, res) => {
  acc.decideAdjustment(req.actor, id(req), req.body.decision === 'approve', req.body.remarks);
  req.session.flash = { success: req.body.decision === 'approve' ? 'Adjustment approved and applied.' : 'Adjustment rejected.' };
  res.redirect(req.get('referer') || '/accounts/approvals');
}));

// ── Reconciliation ────────────────────────────────────────────────────────────
router.get('/reconciliation', need('all'), (req, res) => {
  const f = parseFilters(req.query);
  const showResolved = req.query.resolved === '1';
  const rec = qr.reconciliation(req.actor, f);
  res.render('accounts/reconciliation', { title: 'Delivery Challan Reconciliation', ...filterContext(req, f), rec, showResolved,
    flags: rec.flags.filter(x => showResolved || !x.resolved) });
});
router.post('/reconciliation/resolve', need('accounts'), handle((req, res) => {
  acc.resolveDiscrepancy(req.actor, req.body);
  req.session.flash = { success: 'Marked as resolved with your remarks.' };
  res.redirect('/accounts/reconciliation');
}, '/accounts/reconciliation'));

// ── Collection register ───────────────────────────────────────────────────────
const VIEWS = { all: null, cash: ['cash'], bank: ['upi', 'neft', 'rtgs', 'imps', 'bank_transfer'], upi: ['upi'], cheque: ['cheque'], other: ['card', 'other'] };
router.get('/collections', need('all'), (req, res) => {
  const f = parseFilters(req.query, { defaultMonth: true });
  const view = VIEWS[req.query.view] !== undefined ? req.query.view : 'all';
  const rows = qr.paymentList(req.actor, { ...f, modes: VIEWS[view] || undefined, includeCancelled: true });
  const live = rows.filter(p => p.status === 'active' && p.clearance_status !== 'bounced');
  const daily = reports.run(req.actor, 'daily-collection', { ...f, modes: VIEWS[view] || undefined });
  res.render('accounts/collections', { title: 'Collection Register', ...filterContext(req, f), view, rows, live, daily: daily.rows.slice(0, 31), dailyTotals: daily.totals });
});

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports', need('all'), (req, res) => res.render('accounts/reports', { title: 'Outstanding & Reports', defs: reports.defs }));
router.get('/reports/:key', need('all'), handle(async (req, res) => {
  const def = reports.byKey[req.params.key];
  if (!def) throw new AccError('Unknown report.', 404);
  if (def.audit && !(acc.can(req.actor, 'accounts_approve') || acc.can(req.actor, 'accounts_reports'))) throw new AccError('Only managers can see the audit report.', 403);
  const f = parseFilters(req.query, { defaultMonth: def.filters.includes('date') });
  if (!f.status && def.defaultStatus) f.status = def.defaultStatus;
  const out = reports.run(req.actor, def.key, f);
  const fmt = req.query.format;
  if (['csv', 'xlsx', 'pdf'].includes(fmt)) {
    acc.audit(req.actor, 'report_exported', 'acc_report', def.key, { format: fmt, filters: f, rows: out.rows.length });
    const fname = `${def.key}-${todayIST()}`;
    const table = [def.columns.map(c => c[1]), ...out.rows.map(r => def.columns.map(([k, , t]) => t === 'money' ? rupees(r[k]) : r[k] ?? '')),
      ...(Object.keys(out.totals).length ? [def.columns.map(([k, , t], n) => t === 'money' ? rupees(out.totals[k]) : n === 0 ? 'Total' : '')] : [])];
    if (fmt === 'csv') return sendCsv(res, fname, table);
    if (fmt === 'xlsx') return sendXlsx(res, fname, def.title.slice(0, 30), table);
    const html = await renderView(req, 'accounts/report-pdf', { def, out, f, s: acc.settings(), filterText: describeFilters(f) });
    return sendPdf(res, fname, await generatePDF(html));
  }
  res.render('accounts/report', { title: def.title, def, out, ...filterContext(req, f), users: def.audit ? staff() : [] });
}, '/accounts/reports'));
function describeFilters(f) {
  const parts = [];
  if (f.from || f.to) parts.push(`${f.from || 'start'} to ${f.to || 'today'}`);
  if (f.customer_id) parts.push('Customer: ' + (db.prepare('SELECT name FROM customers WHERE id=?').get(f.customer_id)?.name || f.customer_id));
  if (f.salesperson_id) parts.push('Salesperson: ' + (db.prepare('SELECT name FROM salespersons WHERE id=?').get(f.salesperson_id)?.name || ''));
  if (f.branch) parts.push('Branch: ' + f.branch);
  if (f.mode) parts.push('Mode: ' + MODES[f.mode]);
  if (f.doc_type) parts.push('Type: ' + DOC_TYPES[f.doc_type]);
  if (f.status) parts.push('Status: ' + f.status);
  return parts.join(' · ') || 'All records';
}

// ── Audit log ─────────────────────────────────────────────────────────────────
router.get('/audit', need('accounts_approve', 'accounts_reports'), (req, res) => {
  const f = parseFilters(req.query, { defaultMonth: true });
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = qr.activity(req.actor, { limit: 101, offset: (page - 1) * 100, from: f.from, to: f.to, user_id: f.user_id,
    entity: /^acc_[a-z]+$/.test(req.query.entity || '') ? req.query.entity : undefined, action: req.query.action ? String(req.query.action).slice(0, 40) : undefined });
  res.render('accounts/audit', { title: 'Accounts Audit Log', f, rows: rows.slice(0, 100), more: rows.length > 100, page, users: staff(), entity: req.query.entity || '', action: req.query.action || '' });
});
function history(entity, entityId) {
  return db.prepare(`SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity=? AND a.entity_id=? ORDER BY a.id DESC LIMIT 100`).all(entity, String(entityId));
}

// ── Settings (admin) ──────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  if (req.actor.role !== 'admin') { req.session.flash = { error: 'Admin access required.' }; return res.redirect('/accounts'); }
  const perms = db.prepare("SELECT role, GROUP_CONCAT(permission, ', ') AS p FROM role_permissions WHERE permission LIKE 'accounts%' GROUP BY role ORDER BY role").all();
  res.render('accounts/settings', { title: 'Accounts Settings', s: acc.settings(), perms });
});
router.post('/settings', handle((req, res) => {
  acc.saveSettings(req.actor, req.body);
  req.session.flash = { success: 'Accounts settings saved.' };
  res.redirect('/accounts/settings');
}, '/accounts/settings'));

// ── Export helpers ────────────────────────────────────────────────────────────
function sendCsv(res, name, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
}
function sendXlsx(res, name, sheet, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet.replace(/[\\/?*[\]:]/g, ' '));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
function sendPdf(res, name, buf) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  res.send(buf);
}

module.exports = router;
module.exports.acc = acc;
