// Delivery challans and dispatch slips, made from an approved spare quotation.
//   Approved quotation ─ Convert ─► Delivery challan (never deleted)
//     ├─ Accountant: sees the priced challan, enters the Tally invoice number
//     └─ Store / parts: sees the dispatch slip (parts and quantities, no prices),
//        marks it dispatched, which takes the parts out of stock
//   Admin can cancel a challan with a reason; dispatched stock is put back.
const express = require('express');
const router  = express.Router();
const path = require('path');
const { db, getSettings, nextChallanNumber, formatINR, numberToWords, auditLog, createNotification } = require('../db');
const { accountsDesk, storeDesk } = require('../lib/org');
const { generatePDFWithLetterhead } = require('../pdf');
const LETTERHEAD_PATH = path.join(__dirname, '..', 'Super Allied Letterhead.pdf');

// Who may do what (admin has '*')
const can = (res, p) => res.locals.hasPerm('*') || res.locals.hasPerm(p);
const seesPrices = (res) => can(res, 'challans') || can(res, 'spare_quotations');
const canAccess  = (res) => seesPrices(res) || can(res, 'dispatch');
router.use((req, res, next) => canAccess(res) ? next() : (req.session.flash = { error: "You don't have permission to access this area." }, res.redirect('/')));

// All-or-nothing database work (node:sqlite has no db.transaction helper)
const tx = (fn) => () => {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
};

const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function load(id) {
  const c = db.prepare(`SELECT c.*, q.quotation_no, q.quotation_date, q.customer_name, q.customer_address, q.customer_gstin,
      q.contact_person, q.mobile, q.place_of_supply, q.tax_mode, q.machine_no, q.sold_machine_id, q.salesperson, q.salesperson_id,
      q.total_basic, q.total_gst, q.grand_total, q.roundoff_amount, q.show_discount, q.created_by AS quotation_by,
      cu.full_name AS created_by_name, du.full_name AS dispatched_by_name, iu.full_name AS invoiced_by_name, xu.full_name AS cancelled_by_name
    FROM spare_challans c JOIN spare_quotations q ON q.id = c.quotation_id
    LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users du ON du.id = c.dispatched_by
    LEFT JOIN users iu ON iu.id = c.invoiced_by LEFT JOIN users xu ON xu.id = c.cancelled_by
    WHERE c.id = ?`).get(id);
  if (!c) return null;
  const items = db.prepare('SELECT * FROM spare_quotation_items WHERE quotation_id=? ORDER BY id').all(c.quotation_id);
  return { c, items };
}

// Stock part for a quotation line: matched by SAP or R&D part number. `tracked`
// = the part has a stock record; untracked parts are dispatched without a stock check.
function stockFor(partNo) {
  const no = String(partNo || '').trim();
  if (!no) return null;
  return db.prepare(`SELECT sp.id, sp.sap_part_no, sa.stock_quantity, (sa.part_id IS NOT NULL) AS tracked
    FROM spare_parts sp LEFT JOIN stock_availability sa ON sa.part_id = sp.id
    WHERE sp.sap_part_no = ? COLLATE NOCASE OR sp.rnd_part_no = ? COLLATE NOCASE
    ORDER BY (sa.part_id IS NOT NULL) DESC LIMIT 1`).get(no, no) || null;
}

const stageOf = (c) => c.status === 'cancelled' ? 'cancelled'
  : c.invoiced_at && c.dispatched_at ? 'done'
  : c.dispatched_at ? 'to_invoice'
  : 'to_dispatch';

// ── Create (called from the quotation page; see routes/spare-quotations.js) ────
// Returns { id, challanNo } or { error }.
function createFromQuotation(qid, userId, { challan_date, remarks } = {}) {
  const q = db.prepare('SELECT * FROM spare_quotations WHERE id=?').get(qid);
  if (!q) return { error: 'Quotation not found.' };
  if (q.approval_status !== 'approved') return { error: 'Only an approved quotation can be converted to a delivery challan.' };
  if (q.status === 'cancelled') return { error: 'This quotation is cancelled.' };
  const live = db.prepare("SELECT challan_no FROM spare_challans WHERE quotation_id=? AND status<>'cancelled'").get(qid);
  if (live) return { error: `This quotation already has delivery challan ${live.challan_no}.` };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(challan_date || '') ? challan_date : today();

  const make = tx(() => {
    const { challanNo, financialYear, serialNumber } = nextChallanNumber();
    const id = Number(db.prepare(`INSERT INTO spare_challans (challan_no, serial_number, financial_year, quotation_id, challan_date, remarks, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(challanNo, serialNumber, financialYear, qid, date, String(remarks || '').trim(), userId).lastInsertRowid);
    db.prepare("UPDATE spare_quotations SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(qid);
    return { id, challanNo };
  });
  const out = make();
  auditLog(userId, 'CHALLAN_CREATED', 'spare_challans', out.id, `${out.challanNo} from ${q.quotation_no}`);

  const value = '₹' + formatINR(q.grand_total);
  accountsDesk().forEach(u => createNotification(u.id, 'Delivery challan to invoice',
    `${out.challanNo} · ${q.customer_name} · ${value} (from ${q.quotation_no})`, 'info', `/challans/${out.id}`));
  storeDesk().forEach(u => createNotification(u.id, 'Dispatch slip: parts to send',
    `${out.challanNo} · ${q.customer_name}${q.machine_no ? ' · ' + q.machine_no : ''}`, 'info', `/challans/${out.id}/slip`));
  return out;
}
router.createFromQuotation = createFromQuotation;

// ── Register ──────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const prices = seesPrices(res);
  // Default tab: store staff start on what is waiting to go, accounts on what to invoice
  const tab = req.query.tab || (can(res, 'dispatch') && !can(res, 'challans') ? 'to_dispatch' : can(res, 'challans') && !can(res, 'dispatch') ? 'to_invoice' : 'all');
  const q = String(req.query.q || '').trim();
  let sql = `SELECT c.*, sq.quotation_no, sq.customer_name, sq.machine_no, sq.grand_total
    FROM spare_challans c JOIN spare_quotations sq ON sq.id = c.quotation_id WHERE 1=1`;
  const params = [];
  if (tab === 'to_dispatch') sql += " AND c.status<>'cancelled' AND c.dispatched_at IS NULL";
  if (tab === 'to_invoice')  sql += " AND c.status<>'cancelled' AND c.invoiced_at IS NULL";
  if (tab === 'done')        sql += " AND c.status<>'cancelled' AND c.invoiced_at IS NOT NULL AND c.dispatched_at IS NOT NULL";
  if (tab === 'cancelled')   sql += " AND c.status='cancelled'";
  if (q) { sql += ' AND (c.challan_no LIKE ? OR sq.quotation_no LIKE ? OR sq.customer_name LIKE ? OR sq.machine_no LIKE ? OR c.invoice_no LIKE ?)'; params.push(...Array(5).fill(`%${q}%`)); }
  sql += ' ORDER BY c.id DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, stage: stageOf(r) }));
  const counts = db.prepare(`SELECT
      SUM(status<>'cancelled' AND dispatched_at IS NULL) AS to_dispatch,
      SUM(status<>'cancelled' AND invoiced_at IS NULL)   AS to_invoice
    FROM spare_challans`).get();
  res.render('challans/list', { title: prices ? 'Delivery Challans' : 'Dispatch Slips', rows, tab, q, counts, prices, formatINR });
});

// ── Delivery challan (priced) ─────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  if (!seesPrices(res)) return res.redirect(`/challans/${req.params.id}/slip`);
  const d = load(req.params.id);
  if (!d) return res.redirect('/challans');
  res.render('challans/view', { title: `Delivery Challan ${d.c.challan_no}`, ...d, stage: stageOf(d.c), formatINR,
    canInvoice: can(res, 'challans'), canDispatch: can(res, 'dispatch'), canCancel: res.locals.hasPerm('*') });
});

// ── Dispatch slip (no prices) ─────────────────────────────────────────────────
router.get('/:id/slip', (req, res) => {
  const d = load(req.params.id);
  if (!d) return res.redirect('/challans');
  const lines = d.items.map(it => {
    const s = stockFor(it.part_no);
    return { part_no: it.part_no, description: it.description, qty: it.qty,
      tracked: !!(s && s.tracked), in_stock: s && s.tracked ? s.stock_quantity : null };
  });
  const moved = db.prepare('SELECT part_id, qty, restored FROM spare_challan_stock WHERE challan_id=?').all(d.c.id);
  res.render('challans/slip', { title: `Dispatch Slip ${d.c.challan_no}`, c: d.c, lines, moved, stage: stageOf(d.c),
    canDispatch: can(res, 'dispatch'), prices: seesPrices(res) });
});

// ── Mark dispatched: takes tracked parts out of stock ─────────────────────────
router.post('/:id/dispatch', (req, res) => {
  if (!can(res, 'dispatch')) return res.status(403).send('Only store and parts staff can mark a slip dispatched.');
  const d = load(req.params.id);
  if (!d) return res.redirect('/challans');
  const back = `/challans/${d.c.id}/slip`;
  if (d.c.status === 'cancelled') { req.session.flash = { error: 'This challan is cancelled.' }; return res.redirect(back); }
  if (d.c.dispatched_at) { req.session.flash = { error: 'Already marked dispatched.' }; return res.redirect(back); }

  // Need per tracked part (the same part can appear on two lines)
  const need = new Map();
  for (const it of d.items) {
    const s = stockFor(it.part_no);
    if (!s || !s.tracked) continue;
    const row = need.get(s.id) || { part: s, qty: 0, name: it.description };
    row.qty += Math.ceil(parseFloat(it.qty) || 0);
    need.set(s.id, row);
  }
  const short = [...need.values()].filter(r => (r.part.stock_quantity || 0) < r.qty);
  if (short.length) {
    req.session.flash = { error: 'Not enough stock to dispatch: ' + short.map(r => `${r.name} (${r.part.sap_part_no}) needs ${r.qty}, in stock ${r.part.stock_quantity || 0}`).join('; ') + '. Update Stock Availability first.' };
    return res.redirect(back);
  }

  tx(() => {
    const take = db.prepare('UPDATE stock_availability SET stock_quantity = stock_quantity - ?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE part_id=?');
    const log  = db.prepare('INSERT INTO spare_challan_stock (challan_id, part_id, qty) VALUES (?,?,?)');
    for (const r of need.values()) { take.run(r.qty, req.session.userId, r.part.id); log.run(d.c.id, r.part.id, r.qty); }
    db.prepare('UPDATE spare_challans SET dispatched_by=?, dispatched_at=CURRENT_TIMESTAMP, dispatch_notes=? WHERE id=?')
      .run(req.session.userId, String(req.body.dispatch_notes || '').trim(), d.c.id);
  })();
  auditLog(req.session.userId, 'CHALLAN_DISPATCHED', 'spare_challans', d.c.id, `${d.c.challan_no}; stock out: ${[...need.values()].map(r => `${r.part.sap_part_no}×${r.qty}`).join(', ') || 'none tracked'}`);
  const who = res.locals.user?.full_name || 'Store';
  // Whoever made the challan and whoever made the quotation (often the same person)
  new Set([d.c.created_by, d.c.quotation_by].filter(Boolean)).forEach(id =>
    createNotification(id, 'Parts dispatched', `${d.c.challan_no} · ${d.c.customer_name} — dispatched by ${who}.`, 'success', `/challans/${d.c.id}`));
  req.session.flash = { success: `${d.c.challan_no} marked dispatched.` };
  res.redirect(back);
});

// ── Accountant: Tally invoice number ──────────────────────────────────────────
router.post('/:id/invoice', (req, res) => {
  if (!can(res, 'challans')) return res.status(403).send('Only accounts can enter the invoice.');
  const d = load(req.params.id);
  if (!d) return res.redirect('/challans');
  const back = `/challans/${d.c.id}`;
  const no = String(req.body.invoice_no || '').trim();
  if (d.c.status === 'cancelled') { req.session.flash = { error: 'This challan is cancelled.' }; return res.redirect(back); }
  if (!no) { req.session.flash = { error: 'Enter the Tally invoice number.' }; return res.redirect(back); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.invoice_date || '') ? req.body.invoice_date : today();
  db.prepare('UPDATE spare_challans SET invoice_no=?, invoice_date=?, invoiced_by=?, invoiced_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(no, date, req.session.userId, d.c.id);
  auditLog(req.session.userId, d.c.invoiced_at ? 'CHALLAN_INVOICE_CHANGED' : 'CHALLAN_INVOICED', 'spare_challans', d.c.id,
    `${d.c.challan_no}: ${d.c.invoice_no ? d.c.invoice_no + ' → ' : ''}${no}`);
  req.session.flash = { success: `Invoice ${no} saved on ${d.c.challan_no}.` };
  res.redirect(back);
});

// ── Admin: cancel (never delete). Dispatched stock is put back. ───────────────
router.post('/:id/cancel', (req, res) => {
  if (!res.locals.hasPerm('*')) return res.status(403).send('Only an admin can cancel a delivery challan.');
  const d = load(req.params.id);
  if (!d) return res.redirect('/challans');
  const back = `/challans/${d.c.id}`;
  const reason = String(req.body.reason || '').trim();
  if (d.c.status === 'cancelled') { req.session.flash = { error: 'Already cancelled.' }; return res.redirect(back); }
  if (!reason) { req.session.flash = { error: 'Give a reason for cancelling.' }; return res.redirect(back); }
  tx(() => {
    for (const m of db.prepare('SELECT * FROM spare_challan_stock WHERE challan_id=? AND restored=0').all(d.c.id)) {
      db.prepare('UPDATE stock_availability SET stock_quantity = stock_quantity + ?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE part_id=?').run(m.qty, req.session.userId, m.part_id);
      db.prepare('UPDATE spare_challan_stock SET restored=1 WHERE id=?').run(m.id);
    }
    db.prepare("UPDATE spare_challans SET status='cancelled', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, cancel_reason=? WHERE id=?")
      .run(req.session.userId, reason, d.c.id);
  })();
  auditLog(req.session.userId, 'CHALLAN_CANCELLED', 'spare_challans', d.c.id, `${d.c.challan_no}: ${reason}`);
  const ids = new Set([d.c.created_by, d.c.quotation_by, ...accountsDesk().map(u => u.id), ...(d.c.dispatched_at ? [] : storeDesk().map(u => u.id))]);
  ids.delete(req.session.userId); ids.delete(null); ids.delete(undefined);
  ids.forEach(id => createNotification(id, 'Delivery challan cancelled', `${d.c.challan_no} · ${d.c.customer_name} — ${reason}`, 'warning', back));
  req.session.flash = { success: `${d.c.challan_no} cancelled.${d.c.dispatched_at ? ' Dispatched parts were put back in stock.' : ''}` };
  res.redirect(back);
});

// ── PDFs (English, on the letterhead) ─────────────────────────────────────────
async function pdfOf(app, id, kind) {
  const d = load(id);
  if (!d) return null;
  const s = getSettings();
  const machine = d.c.sold_machine_id ? db.prepare('SELECT model FROM sold_machines WHERE id=?').get(d.c.sold_machine_id) : null;
  const sp = d.c.salesperson_id ? db.prepare('SELECT name, phone FROM salespersons WHERE id=?').get(d.c.salesperson_id) : null;
  const html = await new Promise((ok, no) => app.render(kind === 'slip' ? 'challans/slip-pdf' : 'challans/pdf', {
    c: d.c, items: d.items, settings: s, numberToWords, machineModel: machine?.model || '',
    salesperson: { name: sp?.name || d.c.salesperson || '', phone: sp?.phone || '' },
  }, (e, h) => e ? no(e) : ok(h)));
  const buffer = await generatePDFWithLetterhead(html, LETTERHEAD_PATH, { fitOnePage: true, minScale: 0.85 });
  return { buffer, filename: `${kind === 'slip' ? 'Dispatch-Slip' : 'Delivery-Challan'}-${d.c.challan_no.replace(/\//g, '-')}.pdf` };
}
const sendPdf = (kind) => async (req, res) => {
  if (kind === 'challan' && !seesPrices(res)) return res.redirect(`/challans/${req.params.id}/slip`);
  try {
    const pdf = await pdfOf(req.app, req.params.id, kind);
    if (!pdf) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
    res.send(pdf.buffer);
  } catch (err) {
    console.error('Challan PDF error:', err);
    req.session.flash = { error: 'PDF generation failed.' };
    res.redirect(`/challans/${req.params.id}${kind === 'slip' ? '/slip' : ''}`);
  }
};
router.get('/:id/pdf', sendPdf('challan'));
router.get('/:id/slip/pdf', sendPdf('slip'));

module.exports = router;
