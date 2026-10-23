// ── Accounts read side: dashboard, customer account, ledger, registers ────────
// Every figure is computed from records. Stages of one sale (quotation →
// challan → Tally invoice) are reported side by side and never added together.
// "Outstanding" comes only from uploaded/verified receivables and allocations.

const { todayIST, RECEIVABLE, rupees } = require('./engine');

const ACTIVE_INV = "i.status IN ('uploaded','verified')";
const RECV = `i.doc_type IN (${RECEIVABLE.map(t => `'${t}'`).join(',')})`;
// Money that really arrived: not cancelled, not a bounced cheque
const LIVE_PAY = "p.status='active' AND p.clearance_status<>'bounced'";

function createQueries(acc) {
  const db = acc.db;
  const { calcQuotation } = require('../../db');

  // Salespeople only see customers they created or quoted
  function scope(actor, col) {
    if (acc.canSeeAll(actor)) return { sql: '', params: [] };
    return { sql: ` AND ${col} IN (SELECT c2.id FROM customers c2 WHERE c2.created_by=? UNION SELECT q2.customer_id FROM quotations q2 WHERE q2.user_id=?)`,
             params: [actor.id, actor.id] };
  }

  // Shared WHERE builder. map: which column each filter applies to on this query.
  function filters(f, map) {
    const w = [], p = [];
    const add = (cond, ...v) => { w.push(cond); p.push(...v); };
    if (map.date && f.from) add(`${map.date} >= ?`, f.from);
    if (map.date && f.to)   add(`${map.date} <= ?`, f.to);
    if (map.customer && f.customer_id) add(`${map.customer} = ?`, Number(f.customer_id));
    if (map.salesperson && f.salesperson_id) add(`${map.salesperson} = ?`, Number(f.salesperson_id));
    if (map.branch && f.branch) add(`${map.branch} = ?`, f.branch);
    if (map.docType && f.doc_type) add(`${map.docType} = ?`, f.doc_type);
    if (map.mode && f.mode) add(`${map.mode} = ?`, f.mode);
    return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p };
  }
  function invoiceStatusFilter(f) {
    const t = todayIST();
    return {
      unpaid:  { sql: " AND i.payment_status='unpaid'", params: [] },
      partial: { sql: " AND i.payment_status='partial'", params: [] },
      paid:    { sql: " AND i.payment_status IN ('paid','credit_adjusted')", params: [] },
      overdue: { sql: ' AND i.balance_amount>0 AND i.due_date < ?', params: [t] },
      open:    { sql: ' AND i.balance_amount>0', params: [] },
    }[f.status] || { sql: '', params: [] };
  }

  // ── Quotation figures ───────────────────────────────────────────────────────
  const settings = () => acc.settings();
  function quotationValue(q, s) { return Math.round(calcQuotation(q, s || settings()).total * 100); }
  function quotationFinancials(quotationId) {
    const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
    if (!q) return null;
    const value = quotationValue(q);
    const adv = db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS s, COALESCE(SUM(p.unallocated_amount),0) AS u FROM acc_payments p
      WHERE p.quotation_id=? AND p.purpose='quotation_advance' AND ${LIVE_PAY}`).get(q.id);
    const received = db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS s FROM acc_payments p WHERE p.quotation_id=? AND ${LIVE_PAY}`).get(q.id).s;
    const invoiced = db.prepare(`SELECT COALESCE(SUM(i.total_amount),0) AS s FROM acc_invoices i WHERE i.quotation_id=? AND ${ACTIVE_INV} AND ${RECV}`).get(q.id).s;
    return { value, advance: adv.s, advanceUnallocated: adv.u, received, invoiced, remaining: Math.max(0, value - received) };
  }

  // ── Labels ──────────────────────────────────────────────────────────────────
  function invoiceStatus(i, today = todayIST()) {
    if (i.status === 'draft') return { label: 'Draft', cls: 'bg-secondary' };
    if (i.status === 'cancelled') return { label: 'Cancelled', cls: 'bg-dark' };
    if (i.doc_type === 'credit_note') return i.payment_status === 'paid' ? { label: 'Credit Note Adjusted', cls: 'bg-info text-dark' }
      : i.payment_status === 'partial' ? { label: 'Partly Adjusted', cls: 'bg-info text-dark' } : { label: i.status === 'verified' ? 'Verified' : 'Uploaded', cls: 'bg-primary' };
    if (i.payment_status === 'paid') return { label: 'Paid', cls: 'bg-success' };
    if (i.payment_status === 'credit_adjusted') return { label: 'Credit Note Adjusted', cls: 'bg-info text-dark' };
    if (i.balance_amount > 0 && i.due_date && i.due_date < today) return { label: 'Overdue', cls: 'bg-danger' };
    if (i.payment_status === 'partial') return { label: 'Partially Paid', cls: 'bg-warning text-dark' };
    return i.status === 'verified' ? { label: 'Verified', cls: 'bg-primary' } : { label: 'Uploaded', cls: 'bg-light text-dark border' };
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────
  function dashboard(actor, f) {
    const s = settings(), today = todayIST();
    const sc = (col) => scope(actor, col);
    const pf = filters(f, { date: 'p.payment_date', customer: 'p.customer_id', salesperson: 'p.salesperson_id', branch: 'p.branch', mode: 'p.mode' });
    const pAll = filters(f, { customer: 'p.customer_id', salesperson: 'p.salesperson_id', branch: 'p.branch', mode: 'p.mode' });
    const inf = filters(f, { date: 'i.invoice_date', customer: 'i.customer_id', salesperson: 'i.salesperson_id', branch: 'i.branch', docType: 'i.doc_type' });
    const iAll = filters(f, { customer: 'i.customer_id', salesperson: 'i.salesperson_id', branch: 'i.branch', docType: 'i.doc_type' });
    const ist = invoiceStatusFilter(f);
    const one = (sql, ...params) => db.prepare(sql).get(...params);
    const ps = sc('p.customer_id'), is = sc('i.customer_id');

    // Quotations (operational, not receivables)
    const qDate = "COALESCE(q.quotation_date, date(q.created_at,'+330 minutes'))";
    const qf = filters(f, { date: qDate, customer: 'q.customer_id', salesperson: 'q.salesperson_id' });
    const qs = sc('q.customer_id');
    const quotes = db.prepare(`SELECT q.* FROM quotations q WHERE q.cancelled_at IS NULL ${qf.sql} ${qs.sql}`).all(...qf.params, ...qs.params);
    const advByQuote = new Map(db.prepare(`SELECT p.quotation_id AS id, SUM(p.amount) AS s FROM acc_payments p
      WHERE p.purpose='quotation_advance' AND ${LIVE_PAY} AND p.quotation_id IS NOT NULL GROUP BY p.quotation_id`).all().map(r => [r.id, r.s]));
    const invoicedQuotes = new Set(db.prepare(`SELECT DISTINCT i.quotation_id AS id FROM acc_invoices i WHERE ${ACTIVE_INV} AND i.quotation_id IS NOT NULL`).all().map(r => r.id));
    const awaiting = quotes.filter(q => q.status !== 'rejected' && !advByQuote.has(q.id) && !invoicedQuotes.has(q.id));

    const chf = filters(f, { date: 'ch.challan_date', customer: 'ch.customer_id', salesperson: 'ch.salesperson_id', branch: 'ch.branch' });
    const chs = sc('ch.customer_id');
    const days = parseInt(s.acc_challan_invoice_days) || 7;
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10);
    const challanNoInv = `ch.status='active' AND ch.invoice_expected=1 AND NOT EXISTS (SELECT 1 FROM acc_invoice_challans ic
      JOIN acc_invoices i ON i.id=ic.invoice_id WHERE ic.challan_id=ch.id AND ${ACTIVE_INV})`;

    const k = {
      quotationsInPeriod: { count: quotes.length, value: quotes.reduce((t, q) => t + quotationValue(q, s), 0) },
      awaitingAdvance: { count: awaiting.length, value: awaiting.reduce((t, q) => t + quotationValue(q, s), 0) },
      advances: one(`SELECT COUNT(*) AS count, COALESCE(SUM(p.amount),0) AS value, COALESCE(SUM(p.unallocated_amount),0) AS unallocated
        FROM acc_payments p WHERE p.purpose='quotation_advance' AND ${LIVE_PAY} ${pf.sql} ${ps.sql}`, ...pf.params, ...ps.params),
      challanValue: one(`SELECT COUNT(*) AS count, COALESCE(SUM(ch.challan_value),0) AS value FROM acc_challans ch WHERE ch.status='active' ${chf.sql} ${chs.sql}`, ...chf.params, ...chs.params),
      challansAwaiting: one(`SELECT COUNT(*) AS count, COALESCE(SUM(ch.challan_date <= ?),0) AS late FROM acc_challans ch WHERE ${challanNoInv} ${chf.sql} ${chs.sql}`, cutoff, ...chf.params, ...chs.params),
      invoicesUploaded: one(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN ${RECV} THEN i.total_amount END),0) AS value FROM acc_invoices i
        WHERE ${ACTIVE_INV} AND date(i.uploaded_at,'+330 minutes') BETWEEN ? AND ? ${iAll.sql} ${is.sql}`, f.from || '0000-01-01', f.to || '9999-12-31', ...iAll.params, ...is.params),
      invoiceValue: one(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN ${RECV} THEN i.total_amount END),0) AS value,
        COALESCE(SUM(CASE WHEN i.doc_type='credit_note' THEN i.total_amount END),0) AS credit_notes
        FROM acc_invoices i WHERE ${ACTIVE_INV} ${inf.sql} ${ist.sql} ${is.sql}`, ...inf.params, ...ist.params, ...is.params),
      paidAgainstInvoices: one(`SELECT COALESCE(SUM(a.amount),0) AS value FROM acc_allocations a JOIN acc_invoices i ON i.id=a.invoice_id
        WHERE a.status='active' AND ${ACTIVE_INV} ${inf.sql} ${ist.sql} ${is.sql}`, ...inf.params, ...ist.params, ...is.params),
      payments: one(`SELECT COUNT(*) AS count, COALESCE(SUM(p.amount),0) AS value,
        COALESCE(SUM(CASE WHEN p.mode='cheque' AND p.clearance_status<>'cleared' THEN p.amount END),0) AS uncleared
        FROM acc_payments p WHERE ${LIVE_PAY} ${pf.sql} ${ps.sql}`, ...pf.params, ...ps.params),
      outstanding: one(`SELECT COUNT(*) AS count, COALESCE(SUM(i.balance_amount),0) AS value FROM acc_invoices i
        WHERE ${ACTIVE_INV} AND ${RECV} AND i.balance_amount>0 ${iAll.sql} ${ist.sql} ${is.sql}`, ...iAll.params, ...ist.params, ...is.params),
      overdue: one(`SELECT COUNT(*) AS count, COALESCE(SUM(i.balance_amount),0) AS value FROM acc_invoices i
        WHERE ${ACTIVE_INV} AND ${RECV} AND i.balance_amount>0 AND i.due_date < ? ${iAll.sql} ${is.sql}`, today, ...iAll.params, ...is.params),
      unallocated: one(`SELECT COUNT(*) AS count, COALESCE(SUM(p.unallocated_amount),0) AS value FROM acc_payments p
        WHERE ${LIVE_PAY} AND p.unallocated_amount>0 ${pAll.sql} ${ps.sql}`, ...pAll.params, ...ps.params),
      unusedCredit: one(`SELECT COALESCE(SUM(i.balance_amount),0) AS value FROM acc_invoices i WHERE ${ACTIVE_INV} AND i.doc_type='credit_note' ${iAll.sql} ${is.sql}`, ...iAll.params, ...is.params),
      receipts: one(`SELECT COUNT(*) AS count FROM acc_receipts r JOIN acc_payments p ON p.id=r.payment_id
        WHERE r.status='issued' AND r.receipt_date BETWEEN ? AND ? ${pAll.sql} ${ps.sql}`, f.from || '0000-01-01', f.to || '9999-12-31', ...pAll.params, ...ps.params),
    };
    const pending = {
      payments: db.prepare("SELECT COUNT(*) AS c FROM acc_payments WHERE status='active' AND verification_status='pending' AND clearance_status<>'bounced'").get().c,
      cheques: db.prepare("SELECT COUNT(*) AS c FROM acc_payments WHERE status='active' AND mode='cheque' AND clearance_status IN ('received','deposited')").get().c,
      invoices: db.prepare("SELECT COUNT(*) AS c FROM acc_invoices WHERE status='uploaded'").get().c,
      drafts: db.prepare("SELECT COUNT(*) AS c FROM acc_invoices WHERE status='draft'").get().c,
      cancellations: db.prepare("SELECT COUNT(*) AS c FROM acc_cancellations WHERE status='pending'").get().c,
      adjustments: db.prepare("SELECT COUNT(*) AS c FROM acc_adjustments WHERE status='pending'").get().c,
    };
    return { k, pending, activity: activity(actor, { limit: 15 }), challanDays: days };
  }

  function activity(actor, { limit = 50, from, to, user_id, entity, action, offset = 0 } = {}) {
    const w = ["a.entity LIKE 'acc_%'"], p = [];
    if (from) { w.push("date(a.created_at,'+330 minutes') >= ?"); p.push(from); }
    if (to) { w.push("date(a.created_at,'+330 minutes') <= ?"); p.push(to); }
    if (user_id) { w.push('a.user_id = ?'); p.push(Number(user_id)); }
    if (entity) { w.push('a.entity = ?'); p.push(entity); }
    if (action) { w.push('a.action LIKE ?'); p.push(`%${action}%`); }
    return db.prepare(`SELECT a.*, u.full_name, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE ${w.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
  }

  // ── Customer account ────────────────────────────────────────────────────────
  function customerAccount(customerId) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
    if (!c) return null;
    const s = settings();
    const quotations = db.prepare(`SELECT q.*, m.display_name AS machine_name FROM quotations q JOIN machines m ON m.id=q.machine_id
      WHERE q.customer_id=? ORDER BY q.id DESC`).all(c.id).map(q => ({ ...q, fin: quotationFinancials(q.id) }));
    const challans = challanList({ id: 0, role: 'admin' }, { customer_id: c.id, includeCancelled: true });
    const invoices = invoiceList({ id: 0, role: 'admin' }, { customer_id: c.id, includeDrafts: false, includeCancelled: true });
    const payments = paymentList({ id: 0, role: 'admin' }, { customer_id: c.id, includeCancelled: true });
    const allocations = db.prepare(`SELECT a.*, i.invoice_number, i.doc_type, r.receipt_number, cn.invoice_number AS cn_number, adj.adjustment_type
      FROM acc_allocations a JOIN acc_invoices i ON i.id=a.invoice_id
      LEFT JOIN acc_receipts r ON r.payment_id=a.payment_id LEFT JOIN acc_invoices cn ON cn.id=a.credit_note_id
      LEFT JOIN acc_adjustments adj ON adj.id=a.adjustment_id
      WHERE i.customer_id=? ORDER BY a.id DESC`).all(c.id);
    const sum = (sql) => db.prepare(sql).get(c.id).s;
    const summary = {
      invoiced: sum(`SELECT COALESCE(SUM(total_amount),0) AS s FROM acc_invoices i WHERE customer_id=? AND ${ACTIVE_INV} AND ${RECV}`),
      creditNotes: sum(`SELECT COALESCE(SUM(total_amount),0) AS s FROM acc_invoices i WHERE customer_id=? AND ${ACTIVE_INV} AND doc_type='credit_note'`),
      received: sum(`SELECT COALESCE(SUM(amount),0) AS s FROM acc_payments p WHERE customer_id=? AND ${LIVE_PAY}`),
      outstanding: sum(`SELECT COALESCE(SUM(balance_amount),0) AS s FROM acc_invoices i WHERE customer_id=? AND ${ACTIVE_INV} AND ${RECV}`),
      overdue: db.prepare(`SELECT COALESCE(SUM(balance_amount),0) AS s FROM acc_invoices i WHERE customer_id=? AND ${ACTIVE_INV} AND ${RECV} AND due_date < ?`).get(c.id, todayIST()).s,
      unallocated: sum(`SELECT COALESCE(SUM(unallocated_amount),0) AS s FROM acc_payments p WHERE customer_id=? AND ${LIVE_PAY}`),
      unusedCredit: sum(`SELECT COALESCE(SUM(balance_amount),0) AS s FROM acc_invoices i WHERE customer_id=? AND ${ACTIVE_INV} AND doc_type='credit_note'`),
      uncleared: sum(`SELECT COALESCE(SUM(amount),0) AS s FROM acc_payments p WHERE customer_id=? AND ${LIVE_PAY} AND mode='cheque' AND clearance_status<>'cleared'`),
    };
    return { c, quotations, challans, invoices, payments, allocations, summary, settings: s };
  }

  // Ledger convention: Debit = amount the customer owes us (Tally invoices, debit notes,
  // reversal of a receipt that is cancelled / bounced). Credit = money received, credit
  // notes and approved adjustments. Balance = Debit − Credit: "Dr" = receivable,
  // "Cr" = advance / credit held for the customer. Allocations only match documents
  // to each other, so they never change the balance.
  function ledger(customerId, { from, to } = {}) {
    const rows = [];
    const push = (date, doc, description, debit, credit, link, seq) => rows.push({ date, doc, description, debit, credit, link, seq });
    db.prepare(`SELECT * FROM acc_invoices WHERE customer_id=? AND status IN ('uploaded','verified','cancelled') AND uploaded_at IS NOT NULL`).all(customerId).forEach(i => {
      const label = { tax_invoice: 'Tally tax invoice', debit_note: 'Debit note', other: 'Tally document', credit_note: 'Credit note' }[i.doc_type];
      const link = `/accounts/invoices/${i.id}`;
      if (i.doc_type === 'credit_note') push(i.invoice_date, i.invoice_number, label, 0, i.total_amount, link, 2);
      else push(i.invoice_date, i.invoice_number, label + (i.machine_details ? ' — ' + i.machine_details.slice(0, 60) : ''), i.total_amount, 0, link, 1);
      if (i.status === 'cancelled') {
        const d = String(i.cancelled_at).slice(0, 10);
        if (i.doc_type === 'credit_note') push(d, i.invoice_number, 'Credit note cancelled', i.total_amount, 0, link, 3);
        else push(d, i.invoice_number, 'Invoice cancelled', 0, i.total_amount, link, 3);
      }
    });
    db.prepare(`SELECT p.*, r.receipt_number, r.id AS receipt_id, c.cancellation_number, c.decided_at FROM acc_payments p
      JOIN acc_receipts r ON r.payment_id=p.id
      LEFT JOIN acc_cancellations c ON c.receipt_id=r.id AND c.status='approved' WHERE p.customer_id=?`).all(customerId).forEach(p => {
      const link = `/accounts/receipts/${p.receipt_id}`;
      const ref = p.reference ? ` (${p.reference})` : '';
      push(p.payment_date, p.receipt_number, `Receipt — ${p.mode.toUpperCase()}${ref}${p.mode === 'cheque' && p.clearance_status !== 'cleared' ? ' · cheque ' + p.clearance_status : ''}`, 0, p.amount, link, 2);
      if (p.status === 'cancelled') push(String(p.decided_at || '').slice(0, 10) || p.payment_date, p.cancellation_number || p.receipt_number,
        p.clearance_status === 'bounced' ? 'Cheque bounced — receipt cancelled' : 'Receipt cancelled', p.amount, 0, link, 3);
      else if (p.clearance_status === 'bounced') push(p.clearance_date || p.payment_date, p.receipt_number, 'Cheque bounced', p.amount, 0, link, 3);
    });
    db.prepare(`SELECT a.*, i.invoice_number FROM acc_adjustments a JOIN acc_invoices i ON i.id=a.invoice_id
      WHERE i.customer_id=? AND a.status='approved'`).all(customerId).forEach(a => {
      push(String(a.decided_at).slice(0, 10), a.invoice_number, `Approved ${a.adjustment_type.replace('_', '-')} — ${a.reason.slice(0, 60)}`, 0, a.amount, `/accounts/invoices/${a.invoice_id}`, 4);
    });
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    let bal = 0, opening = 0;
    const out = [];
    for (const r of rows) {
      bal += r.debit - r.credit;
      if (from && r.date < from) { opening = bal; continue; }
      if (to && r.date > to) continue;
      out.push({ ...r, balance: bal });
    }
    const closing = out.length ? out[out.length - 1].balance : opening;
    return { opening, rows: out, closing, totals: { debit: out.reduce((t, r) => t + r.debit, 0), credit: out.reduce((t, r) => t + r.credit, 0) } };
  }

  // ── Registers ───────────────────────────────────────────────────────────────
  function invoiceList(actor, f = {}) {
    const fl = filters(f, { date: 'i.invoice_date', customer: 'i.customer_id', salesperson: 'i.salesperson_id', branch: 'i.branch', docType: 'i.doc_type' });
    const st = invoiceStatusFilter(f), sc = scope(actor, 'i.customer_id');
    const w = [];
    if (!f.includeDrafts) w.push("i.status<>'draft'");
    if (!f.includeCancelled && f.status !== 'cancelled') w.push("i.status<>'cancelled'");
    if (f.status === 'cancelled') w.push("i.status='cancelled'");
    if (f.status === 'draft') w.push("i.status='draft'");
    if (f.lifecycle) w.push(`i.status='${f.lifecycle === 'verified' ? 'verified' : 'uploaded'}'`);
    const qParams = [];
    if (f.q) { w.push('(i.invoice_number LIKE ? OR c.name LIKE ?)'); qParams.push(`%${f.q}%`, `%${f.q}%`); }
    return db.prepare(`SELECT i.*, c.name AS customer_name, c.gstin AS customer_master_gstin, q.quotation_number, sp.name AS salesperson_name,
        u.full_name AS created_by_name,
        (SELECT GROUP_CONCAT(ch.challan_number, ', ') FROM acc_invoice_challans ic JOIN acc_challans ch ON ch.id=ic.challan_id WHERE ic.invoice_id=i.id) AS challan_numbers,
        (SELECT COALESCE(SUM(amount),0) FROM acc_allocations WHERE invoice_id=i.id AND status='pending') AS pending_amount
      FROM acc_invoices i JOIN customers c ON c.id=i.customer_id LEFT JOIN quotations q ON q.id=i.quotation_id
      LEFT JOIN salespersons sp ON sp.id=i.salesperson_id LEFT JOIN users u ON u.id=i.created_by
      WHERE 1=1 ${w.length ? ' AND ' + w.join(' AND ') : ''} ${fl.sql} ${st.sql} ${sc.sql}
      ORDER BY i.invoice_date DESC, i.id DESC LIMIT ?`).all(...qParams, ...fl.params, ...st.params, ...sc.params, f.limit || 2000);
  }

  function paymentList(actor, f = {}) {
    const fl = filters(f, { date: 'p.payment_date', customer: 'p.customer_id', salesperson: 'p.salesperson_id', branch: 'p.branch', mode: 'p.mode' });
    const sc = scope(actor, 'p.customer_id');
    const w = [], pre = [];
    if (!f.includeCancelled) w.push("p.status='active'");
    if (f.modes) w.push(`p.mode IN (${f.modes.map(m => `'${m.replace(/[^a-z_]/g, '')}'`).join(',')})`);
    if (f.purpose) { w.push('p.purpose=?'); pre.push(f.purpose); }
    if (f.verification) { w.push('p.verification_status=?'); pre.push(f.verification); }
    if (f.clearance) { w.push('p.clearance_status=?'); pre.push(f.clearance); }
    if (f.unallocatedOnly) w.push("p.unallocated_amount>0 AND p.clearance_status<>'bounced'");
    if (f.q) { w.push('(r.receipt_number LIKE ? OR c.name LIKE ? OR p.reference LIKE ?)'); pre.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    return db.prepare(`SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, r.receipt_number, r.id AS receipt_id, r.status AS receipt_status, r.receipt_date,
        q.quotation_number, ch.challan_number, sp.name AS salesperson_name, ru.full_name AS received_by_name, vu.full_name AS verified_by_name,
        (SELECT GROUP_CONCAT(i.invoice_number, ', ') FROM acc_allocations a JOIN acc_invoices i ON i.id=a.invoice_id
           WHERE a.payment_id=p.id AND a.status IN ('active','pending')) AS invoice_numbers
      FROM acc_payments p JOIN customers c ON c.id=p.customer_id JOIN acc_receipts r ON r.payment_id=p.id
      LEFT JOIN quotations q ON q.id=p.quotation_id LEFT JOIN acc_challans ch ON ch.id=p.challan_id
      LEFT JOIN salespersons sp ON sp.id=p.salesperson_id LEFT JOIN users ru ON ru.id=p.received_by LEFT JOIN users vu ON vu.id=p.verified_by
      WHERE 1=1 ${w.length ? ' AND ' + w.join(' AND ') : ''} ${fl.sql} ${sc.sql}
      ORDER BY p.payment_date DESC, p.id DESC LIMIT ?`).all(...pre, ...fl.params, ...sc.params, f.limit || 2000);
  }

  function challanList(actor, f = {}) {
    const fl = filters(f, { date: 'ch.challan_date', customer: 'ch.customer_id', salesperson: 'ch.salesperson_id', branch: 'ch.branch' });
    const sc = scope(actor, 'ch.customer_id');
    const w = [];
    if (!f.includeCancelled) w.push("ch.status='active'");
    const pre = [];
    if (f.q) { w.push('(ch.challan_number LIKE ? OR c.name LIKE ? OR ch.chassis_number LIKE ?)'); pre.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    return db.prepare(`SELECT ch.*, c.name AS customer_name, c.gstin AS customer_gstin, q.quotation_number, m.display_name AS machine_name, sp.name AS salesperson_name,
        (SELECT GROUP_CONCAT(i.invoice_number, ', ') FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
           WHERE ic.challan_id=ch.id AND i.status IN ('uploaded','verified')) AS invoice_numbers,
        (SELECT MIN(date(i.uploaded_at,'+330 minutes')) FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
           WHERE ic.challan_id=ch.id AND i.status IN ('uploaded','verified')) AS invoice_uploaded_on,
        (SELECT COALESCE(SUM(i.total_amount),0) FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
           WHERE ic.challan_id=ch.id AND i.status IN ('uploaded','verified') AND i.doc_type<>'credit_note') AS invoice_total,
        (SELECT COALESCE(SUM(i.balance_amount),0) FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
           WHERE ic.challan_id=ch.id AND i.status IN ('uploaded','verified') AND i.doc_type<>'credit_note') AS invoice_balance,
        (SELECT COALESCE(SUM(p.amount),0) FROM acc_payments p WHERE p.challan_id=ch.id AND p.status='active' AND p.clearance_status<>'bounced') AS paid_against_challan
      FROM acc_challans ch JOIN customers c ON c.id=ch.customer_id LEFT JOIN quotations q ON q.id=ch.quotation_id
      LEFT JOIN machines m ON m.id=ch.machine_id LEFT JOIN salespersons sp ON sp.id=ch.salesperson_id
      WHERE 1=1 ${w.length ? ' AND ' + w.join(' AND ') : ''} ${fl.sql} ${sc.sql}
      ORDER BY ch.challan_date DESC, ch.id DESC LIMIT ?`).all(...pre, ...fl.params, ...sc.params, f.limit || 2000);
  }

  // Money received against a challan or its invoices, without counting the same rupee twice
  function challanReceived(ch) {
    const invIds = db.prepare(`SELECT ic.invoice_id AS id FROM acc_invoice_challans ic JOIN acc_invoices i ON i.id=ic.invoice_id
      WHERE ic.challan_id=? AND i.status IN ('uploaded','verified')`).all(ch.id).map(r => r.id);
    const viaInvoices = invIds.length ? db.prepare(`SELECT COALESCE(SUM(a.amount),0) AS s FROM acc_allocations a
      WHERE a.status='active' AND a.invoice_id IN (${invIds.map(() => '?').join(',')})`).get(...invIds).s : 0;
    const unallocChallanPay = db.prepare(`SELECT COALESCE(SUM(p.unallocated_amount),0) AS s FROM acc_payments p
      WHERE p.challan_id=? AND p.status='active' AND p.clearance_status<>'bounced'`).get(ch.id).s;
    return viaInvoices + unallocChallanPay;
  }

  // ── Reconciliation flags ────────────────────────────────────────────────────
  function reconciliation(actor, f = {}) {
    const s = settings(), today = todayIST();
    const days = parseInt(s.acc_challan_invoice_days) || 7;
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10);
    const challans = challanList(actor, { ...f, includeCancelled: true }).map(ch => {
      const received = challanReceived(ch);
      const status = ch.status === 'cancelled' ? 'Cancelled'
        : !ch.invoice_numbers ? (ch.invoice_expected ? (ch.challan_date <= cutoff ? 'Invoice overdue' : 'Awaiting invoice') : 'No invoice expected')
        : ch.invoice_balance === 0 && ch.invoice_total > 0 ? 'Invoiced · fully paid'
        : received > 0 ? 'Invoiced · partly paid' : 'Invoiced · unpaid';
      return { ...ch, received, recon_status: status };
    });

    const resolved = new Map(db.prepare(`SELECT r.*, u.full_name FROM acc_discrepancy_resolutions r LEFT JOIN users u ON u.id=r.resolved_by`).all()
      .map(r => [`${r.flag_type}:${r.entity_type}:${r.entity_id}`, r]));
    const flags = [];
    const flag = (type, title, entity_type, entity_id, docs, detail, link) => {
      const r = resolved.get(`${type}:${entity_type}:${entity_id}`);
      flags.push({ type, title, entity_type, entity_id, docs, detail, link, resolved: r || null });
    };
    const sc = scope(actor, 'i.customer_id');
    const inv = db.prepare(`SELECT i.*, c.name AS customer_name, c.gstin AS master_gstin FROM acc_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status IN ('uploaded','verified') ${sc.sql}`).all(...sc.params);

    challans.filter(ch => ch.recon_status === 'Invoice overdue').forEach(ch =>
      flag('challan_without_invoice', 'Challan without Tally invoice', 'challan', ch.id, ch.challan_number,
        `${ch.customer_name} · dated ${ch.challan_date} (> ${days} days)`, `/accounts/challans/${ch.id}`));

    inv.filter(i => i.doc_type === 'tax_invoice' && i.challan_expected &&
      !db.prepare('SELECT 1 FROM acc_invoice_challans WHERE invoice_id=?').get(i.id)).forEach(i =>
      flag('invoice_without_challan', 'Invoice without delivery challan', 'invoice', i.id, i.invoice_number, i.customer_name, `/accounts/invoices/${i.id}`));

    // Same number in another FY / type, or ignoring spaces & dashes
    const norm = (n) => n.toUpperCase().replace(/[\s\-_]/g, '');
    const byNorm = new Map();
    db.prepare("SELECT id, invoice_number, financial_year, doc_type FROM acc_invoices WHERE status<>'draft'").all().forEach(i => {
      const k = norm(i.invoice_number); (byNorm.get(k) || byNorm.set(k, []).get(k)).push(i);
    });
    for (const list of byNorm.values()) if (list.length > 1) list.forEach(i =>
      flag('possible_duplicate', 'Possible duplicate invoice number', 'invoice', i.id, i.invoice_number,
        'Also: ' + list.filter(x => x.id !== i.id).map(x => `${x.invoice_number} (FY ${x.financial_year}, ${x.doc_type.replace('_', ' ')})`).join('; '), `/accounts/invoices/${i.id}`));

    inv.forEach(i => {
      if (i.customer_gstin && i.master_gstin && i.customer_gstin !== i.master_gstin)
        flag('gstin_mismatch', 'GSTIN mismatch', 'invoice', i.id, i.invoice_number, `Invoice ${i.customer_gstin} vs customer master ${i.master_gstin}`, `/accounts/invoices/${i.id}`);
      if (i.quotation_id) {
        const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(i.quotation_id);
        if (q && q.customer_id !== i.customer_id)
          flag('customer_mismatch', 'Customer mismatch with quotation', 'invoice', i.id, `${i.invoice_number} ↔ ${q.quotation_number}`, i.customer_name, `/accounts/invoices/${i.id}`);
        if (q && RECEIVABLE.includes(i.doc_type)) {
          const qv = quotationValue(q, s);
          if (Math.abs(qv - i.total_amount) >= 100)
            flag('amount_vs_quotation', 'Invoice amount differs from quotation', 'invoice', i.id, `${i.invoice_number} ↔ ${q.quotation_number}`,
              `Invoice ₹${fmt(i.total_amount)} vs quotation ₹${fmt(qv)} — not changed automatically`, `/accounts/invoices/${i.id}`);
        }
      }
      db.prepare(`SELECT ch.* FROM acc_invoice_challans ic JOIN acc_challans ch ON ch.id=ic.challan_id WHERE ic.invoice_id=?`).all(i.id).forEach(ch => {
        if (ch.customer_id !== i.customer_id)
          flag('customer_mismatch', 'Customer mismatch with challan', 'invoice', i.id, `${i.invoice_number} ↔ ${ch.challan_number}`, i.customer_name, `/accounts/invoices/${i.id}`);
        if (ch.challan_value && RECEIVABLE.includes(i.doc_type) && Math.abs(ch.challan_value - i.total_amount) >= 100 &&
            db.prepare('SELECT COUNT(*) AS n FROM acc_invoice_challans WHERE invoice_id=?').get(i.id).n === 1)
          flag('amount_vs_challan', 'Invoice amount differs from challan value', 'invoice', i.id, `${i.invoice_number} ↔ ${ch.challan_number}`,
            `Invoice ₹${fmt(i.total_amount)} vs challan ₹${fmt(ch.challan_value)}`, `/accounts/invoices/${i.id}`);
        if (ch.status === 'cancelled')
          flag('cancelled_with_allocations', 'Invoice linked to a cancelled challan', 'invoice', i.id, `${i.invoice_number} ↔ ${ch.challan_number}`, i.customer_name, `/accounts/invoices/${i.id}`);
      });
    });

    // Cancelled documents that still hold money
    db.prepare(`SELECT q.id, q.quotation_number, c.name, SUM(p.amount) AS s FROM quotations q JOIN acc_payments p ON p.quotation_id=q.id
      JOIN customers c ON c.id=q.customer_id WHERE q.cancelled_at IS NOT NULL AND p.status='active' AND p.clearance_status<>'bounced' GROUP BY q.id`).all().forEach(q =>
      flag('cancelled_with_allocations', 'Cancelled quotation has active payments', 'quotation', q.id, q.quotation_number, `${q.name} · ₹${fmt(q.s)} received`, `/quotations/${q.id}`));
    db.prepare(`SELECT ch.id, ch.challan_number, c.name, SUM(p.amount) AS s FROM acc_challans ch JOIN acc_payments p ON p.challan_id=ch.id
      JOIN customers c ON c.id=ch.customer_id WHERE ch.status='cancelled' AND p.status='active' AND p.clearance_status<>'bounced' GROUP BY ch.id`).all().forEach(ch =>
      flag('cancelled_with_allocations', 'Cancelled challan has active payments', 'challan', ch.id, ch.challan_number, `${ch.name} · ₹${fmt(ch.s)} received`, `/accounts/challans/${ch.id}`));
    db.prepare(`SELECT i.id, i.invoice_number, SUM(a.amount) AS s FROM acc_invoices i JOIN acc_allocations a ON a.invoice_id=i.id
      WHERE i.status='cancelled' AND a.status IN ('active','pending') GROUP BY i.id`).all().forEach(i =>
      flag('cancelled_with_allocations', 'Cancelled invoice has active allocations', 'invoice', i.id, i.invoice_number, `₹${fmt(i.s)} allocated`, `/accounts/invoices/${i.id}`));

    const counts = {
      fullyPaid: inv.filter(i => RECEIVABLE.includes(i.doc_type) && ['paid', 'credit_adjusted'].includes(i.payment_status)).length,
      partlyPaid: inv.filter(i => RECEIVABLE.includes(i.doc_type) && i.payment_status === 'partial').length,
      unallocated: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(unallocated_amount),0) AS s FROM acc_payments p WHERE ${LIVE_PAY} AND unallocated_amount>0`).get(),
    };
    return { challans, flags, counts, days };
  }
  const fmt = (p) => rupees(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return { scope, filters, invoiceStatusFilter, quotationValue, quotationFinancials, invoiceStatus, dashboard, activity,
           customerAccount, ledger, invoiceList, paymentList, challanList, challanReceived, reconciliation, LIVE_PAY, ACTIVE_INV, RECV };
}

module.exports = { createQueries };
