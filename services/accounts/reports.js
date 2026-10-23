// ── Accounts reports ──────────────────────────────────────────────────────────
// One definition per report: the same rows() feed the screen, CSV, Excel and PDF,
// so an export always matches the filtered table on screen.
// Column types: money (paise), date, int, text.

const { MODES, PURPOSES, DOC_TYPES, RECEIVABLE, todayIST } = require('./engine');

const BANK_MODES = ['upi', 'neft', 'rtgs', 'imps', 'bank_transfer', 'card', 'other'];
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function createReports(acc, qr) {
  const db = acc.db;

  // Collections grouped by day or month (live money only: not cancelled, not bounced)
  function collections(actor, f, unit) {
    const rows = new Map();
    qr.paymentList(actor, f).filter(p => p.clearance_status !== 'bounced').forEach(p => {
      const key = unit === 'month' ? p.payment_date.slice(0, 7) : p.payment_date;
      const r = rows.get(key) || rows.set(key, { period: key, receipts: 0, cash: 0, upi: 0, bank: 0, cheque: 0, card_other: 0, uncleared: 0, total: 0 }).get(key);
      r.receipts++; r.total += p.amount;
      if (p.mode === 'cash') r.cash += p.amount;
      else if (p.mode === 'upi') r.upi += p.amount;
      else if (['neft', 'rtgs', 'imps', 'bank_transfer'].includes(p.mode)) r.bank += p.amount;
      else if (p.mode === 'cheque') { r.cheque += p.amount; if (p.clearance_status !== 'cleared') r.uncleared += p.amount; }
      else r.card_other += p.amount;
    });
    return [...rows.values()].sort((a, b) => b.period.localeCompare(a.period));
  }
  const collectionCols = (label) => [['period', label, 'text'], ['receipts', 'Receipts', 'int'], ['cash', 'Cash', 'money'], ['upi', 'UPI', 'money'],
    ['bank', 'NEFT/RTGS/IMPS/Bank', 'money'], ['cheque', 'Cheque', 'money'], ['uncleared', 'of which cheques not cleared', 'money'],
    ['card_other', 'Card/Other', 'money'], ['total', 'Total received', 'money']];

  const paymentRow = (p) => ({
    receipt_number: p.receipt_number, link: `/accounts/receipts/${p.receipt_id}`, payment_date: p.payment_date, customer_name: p.customer_name,
    purpose: PURPOSES[p.purpose], mode: MODES[p.mode], reference: p.reference, amount: p.amount, allocated: p.allocated_amount,
    unallocated: p.unallocated_amount, docs: [p.quotation_number && 'Q ' + p.quotation_number, p.challan_number && 'DC ' + p.challan_number,
      p.invoice_numbers && 'Inv ' + p.invoice_numbers].filter(Boolean).join(' · '),
    received_by: p.received_by_name, verification: cap(p.verification_status), clearance: cap(p.clearance_status),
    clearance_date: p.clearance_date, bank_reference: p.bank_reference, bank_name: p.bank_name, cheque_date: p.cheque_date,
    status: p.status === 'cancelled' ? 'Cancelled' : p.clearance_status === 'bounced' ? 'Bounced' : 'Issued',
  });

  const invoiceRow = (i, today) => ({
    invoice_number: i.invoice_number, link: `/accounts/invoices/${i.id}`, doc_type: DOC_TYPES[i.doc_type], invoice_date: i.invoice_date,
    customer_name: i.customer_name, total: i.total_amount, settled: i.allocated_amount, balance: i.balance_amount, due_date: i.due_date,
    days_overdue: i.due_date && i.due_date < today && i.balance_amount > 0 ? daysBetween(i.due_date, today) : 0,
    status: qr.invoiceStatus(i, today).label, quotation: i.quotation_number, challans: i.challan_numbers, salesperson: i.salesperson_name,
    branch: i.branch, uploaded_at: i.uploaded_at, uploaded_by: i.created_by_name,
  });

  const defs = [
    { key: 'daily-collection', title: 'Daily collection report', filters: ['date', 'customer', 'branch', 'salesperson', 'mode'],
      columns: collectionCols('Date'), rows: (a, f) => collections(a, f, 'day') },
    { key: 'monthly-collection', title: 'Monthly collection report', filters: ['date', 'customer', 'branch', 'salesperson', 'mode'],
      columns: collectionCols('Month'), rows: (a, f) => collections(a, f, 'month') },

    { key: 'customer-outstanding', title: 'Customer outstanding report', filters: ['customer', 'branch', 'salesperson', 'status'],
      statuses: [['', 'With a balance or advance'], ['all', 'All customers with records']],
      columns: [['customer_name', 'Customer', 'text'], ['gstin', 'GSTIN', 'text'], ['invoiced', 'Invoiced (Tally)', 'money'], ['credit_notes', 'Credit notes', 'money'],
        ['settled', 'Settled on invoices', 'money'], ['outstanding', 'Invoice outstanding', 'money'], ['overdue', 'of which overdue', 'money'],
        ['unallocated', 'Unallocated advances', 'money'], ['unused_credit', 'Unused credit notes', 'money'], ['net', 'Net receivable', 'money']],
      rows: (a, f) => {
        const t = todayIST(), map = new Map();
        const row = (id, name, gstin) => map.get(id) || map.set(id, { id, customer_name: name, gstin, link: `/accounts/customers/${id}`,
          invoiced: 0, credit_notes: 0, settled: 0, outstanding: 0, overdue: 0, unallocated: 0, unused_credit: 0, net: 0 }).get(id);
        qr.invoiceList(a, { customer_id: f.customer_id, branch: f.branch, salesperson_id: f.salesperson_id }).forEach(i => {
          const r = row(i.customer_id, i.customer_name, i.customer_master_gstin);
          if (i.doc_type === 'credit_note') { r.credit_notes += i.total_amount; r.unused_credit += i.balance_amount; return; }
          r.invoiced += i.total_amount; r.settled += i.allocated_amount; r.outstanding += i.balance_amount;
          if (i.due_date && i.due_date < t) r.overdue += i.balance_amount;
        });
        qr.paymentList(a, { customer_id: f.customer_id, branch: f.branch, salesperson_id: f.salesperson_id, unallocatedOnly: true })
          .forEach(p => { row(p.customer_id, p.customer_name, '').unallocated += p.unallocated_amount; });
        return [...map.values()].map(r => ({ ...r, net: r.outstanding - r.unallocated - r.unused_credit }))
          .filter(r => f.status === 'all' || r.outstanding || r.unallocated || r.unused_credit)
          .sort((x, y) => y.net - x.net);
      } },

    { key: 'invoice-outstanding', title: 'Invoice-wise outstanding report', filters: ['date', 'customer', 'branch', 'salesperson', 'doctype', 'status'],
      statuses: [['open', 'Open balance'], ['partial', 'Partially paid'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue']], defaultStatus: 'open',
      columns: [['invoice_number', 'Invoice', 'text'], ['invoice_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['total', 'Invoice total', 'money'],
        ['settled', 'Paid / adjusted', 'money'], ['balance', 'Outstanding', 'money'], ['due_date', 'Due', 'date'], ['days_overdue', 'Days overdue', 'int'], ['status', 'Status', 'text']],
      rows: (a, f) => { const t = todayIST(); return qr.invoiceList(a, { ...f, status: f.status || 'open' }).filter(i => RECEIVABLE.includes(i.doc_type)).map(i => invoiceRow(i, t)); } },

    { key: 'overdue-invoices', title: 'Overdue invoice report', filters: ['customer', 'branch', 'salesperson'],
      columns: [['invoice_number', 'Invoice', 'text'], ['invoice_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['due_date', 'Due', 'date'],
        ['days_overdue', 'Days overdue', 'int'], ['bucket', 'Age', 'text'], ['total', 'Invoice total', 'money'], ['balance', 'Outstanding', 'money'], ['salesperson', 'Salesperson', 'text']],
      rows: (a, f) => { const t = todayIST(); return qr.invoiceList(a, { ...f, status: 'overdue' }).filter(i => RECEIVABLE.includes(i.doc_type)).map(i => invoiceRow(i, t))
        .map(r => ({ ...r, bucket: r.days_overdue <= 30 ? '1–30 days' : r.days_overdue <= 60 ? '31–60 days' : r.days_overdue <= 90 ? '61–90 days' : '90+ days' }))
        .sort((x, y) => y.days_overdue - x.days_overdue); } },

    { key: 'customer-advances', title: 'Customer advance report', filters: ['date', 'customer', 'branch', 'salesperson', 'mode', 'status'],
      statuses: [['', 'All advances'], ['unallocated', 'With balance pending allocation']],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['docs', 'Against', 'text'],
        ['mode', 'Mode', 'text'], ['amount', 'Advance', 'money'], ['allocated', 'Allocated to invoices', 'money'], ['unallocated', 'Pending allocation', 'money'], ['status', 'Status', 'text']],
      rows: (a, f) => qr.paymentList(a, { ...f, purpose: 'quotation_advance', unallocatedOnly: f.status === 'unallocated' }).map(paymentRow) },

    { key: 'unallocated-payments', title: 'Unallocated payment report', filters: ['date', 'customer', 'branch', 'salesperson', 'mode'],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['purpose', 'Purpose', 'text'],
        ['mode', 'Mode', 'text'], ['clearance', 'Clearance', 'text'], ['amount', 'Received', 'money'], ['allocated', 'Allocated', 'money'], ['unallocated', 'Unallocated', 'money']],
      rows: (a, f) => qr.paymentList(a, { ...f, unallocatedOnly: true }).map(paymentRow) },

    { key: 'receipt-register', title: 'Receipt register', filters: ['date', 'customer', 'branch', 'salesperson', 'mode', 'status'],
      statuses: [['', 'All'], ['issued', 'Issued'], ['cancelled', 'Cancelled']],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Payment date', 'date'], ['customer_name', 'Customer', 'text'], ['purpose', 'Purpose', 'text'],
        ['mode', 'Mode', 'text'], ['reference', 'Reference', 'text'], ['docs', 'Linked documents', 'text'], ['amount', 'Amount', 'money'],
        ['received_by', 'Received by', 'text'], ['status', 'Status', 'text']],
      rows: (a, f) => qr.paymentList(a, { ...f, includeCancelled: true }).filter(p => !f.status || (f.status === 'cancelled') === (p.status === 'cancelled')).map(paymentRow) },

    { key: 'cash-register', title: 'Cash register', filters: ['date', 'customer', 'branch', 'salesperson', 'status'],
      statuses: [['', 'All'], ['pending', 'Awaiting verification'], ['verified', 'Verified']],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['docs', 'Linked documents', 'text'],
        ['amount', 'Amount', 'money'], ['received_by', 'Received by', 'text'], ['verification', 'Verification', 'text']],
      rows: (a, f) => qr.paymentList(a, { ...f, mode: 'cash', verification: f.status || undefined }).map(paymentRow) },

    { key: 'bank-register', title: 'Bank / UPI collection register', filters: ['date', 'customer', 'branch', 'salesperson', 'mode', 'status'],
      statuses: [['', 'All'], ['pending', 'Awaiting verification'], ['verified', 'Verified'], ['rejected', 'Rejected']],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['mode', 'Mode', 'text'],
        ['reference', 'UTR / Txn ID', 'text'], ['amount', 'Amount', 'money'], ['bank_reference', 'Bank statement ref', 'text'], ['clearance_date', 'Credited on', 'date'],
        ['verification', 'Verification', 'text']],
      rows: (a, f) => qr.paymentList(a, { ...f, modes: f.mode ? undefined : BANK_MODES, verification: f.status || undefined }).filter(p => p.mode !== 'cash' && p.mode !== 'cheque').map(paymentRow) },

    { key: 'cheque-status', title: 'Cheque status report', filters: ['date', 'customer', 'branch', 'salesperson', 'status'],
      statuses: [['', 'All'], ['received', 'Received'], ['deposited', 'Deposited'], ['cleared', 'Cleared'], ['bounced', 'Bounced']],
      columns: [['receipt_number', 'Receipt', 'text'], ['payment_date', 'Received', 'date'], ['customer_name', 'Customer', 'text'], ['reference', 'Cheque no.', 'text'],
        ['bank_name', 'Bank', 'text'], ['cheque_date', 'Cheque date', 'date'], ['amount', 'Amount', 'money'], ['clearance', 'Status', 'text'], ['clearance_date', 'Cleared / bounced on', 'date']],
      rows: (a, f) => qr.paymentList(a, { ...f, mode: 'cheque', clearance: f.status || undefined, includeCancelled: true }).map(paymentRow) },

    { key: 'challan-vs-invoice', title: 'Delivery challan vs invoice report', filters: ['date', 'customer', 'branch', 'salesperson'],
      columns: [['challan_number', 'Challan', 'text'], ['challan_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['machine', 'Machine', 'text'],
        ['challan_value', 'Challan value', 'money'], ['quotation_number', 'Quotation', 'text'], ['invoice_numbers', 'Tally invoice', 'text'], ['invoice_uploaded_on', 'Invoice uploaded', 'date'],
        ['invoice_total', 'Invoice total', 'money'], ['received', 'Received', 'money'], ['invoice_balance', 'Outstanding', 'money'], ['recon_status', 'Status', 'text']],
      rows: (a, f) => qr.reconciliation(a, f).challans.map(ch => ({ ...ch, link: `/accounts/challans/${ch.id}`,
        machine: [ch.machine_name, ch.machine_details, ch.chassis_number && 'Chassis ' + ch.chassis_number].filter(Boolean).join(' · ') })) },

    { key: 'quotations-awaiting-advance', title: 'Quotations awaiting advance', filters: ['date', 'customer', 'salesperson'],
      columns: [['quotation_number', 'Quotation', 'text'], ['quotation_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['machine_name', 'Machine', 'text'],
        ['salesperson', 'Salesperson', 'text'], ['status', 'Quotation status', 'text'], ['value', 'Quotation value', 'money']],
      rows: (a, f) => {
        const qDate = "COALESCE(q.quotation_date, date(q.created_at,'+330 minutes'))";
        const fl = qr.filters(f, { date: qDate, customer: 'q.customer_id', salesperson: 'q.salesperson_id' }), sc = qr.scope(a, 'q.customer_id');
        const s = acc.settings();
        return db.prepare(`SELECT q.*, ${qDate} AS qd, c.name AS customer_name, m.display_name AS machine_name, COALESCE(sp.name, q.salesperson_name) AS spn
          FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN machines m ON m.id=q.machine_id LEFT JOIN salespersons sp ON sp.id=q.salesperson_id
          WHERE q.cancelled_at IS NULL AND q.status<>'rejected'
            AND NOT EXISTS (SELECT 1 FROM acc_payments p WHERE p.quotation_id=q.id AND p.purpose='quotation_advance' AND ${qr.LIVE_PAY})
            AND NOT EXISTS (SELECT 1 FROM acc_invoices i WHERE i.quotation_id=q.id AND ${qr.ACTIVE_INV})
            ${fl.sql} ${sc.sql} ORDER BY qd DESC`).all(...fl.params, ...sc.params)
          .map(q => ({ quotation_number: q.quotation_number, link: `/quotations/${q.id}`, quotation_date: q.qd, customer_name: q.customer_name,
            machine_name: q.machine_name, salesperson: q.spn, status: cap(q.status), value: qr.quotationValue(q, s) }));
      } },

    { key: 'challans-awaiting-invoice', title: 'Challans awaiting invoice upload', filters: ['date', 'customer', 'branch', 'salesperson'],
      columns: [['challan_number', 'Challan', 'text'], ['challan_date', 'Date', 'date'], ['days', 'Days waiting', 'int'], ['customer_name', 'Customer', 'text'],
        ['machine', 'Machine', 'text'], ['quotation_number', 'Quotation', 'text'], ['challan_value', 'Challan value', 'money'], ['paid_against_challan', 'Paid against challan', 'money']],
      rows: (a, f) => { const t = todayIST(); return qr.challanList(a, f).filter(ch => ch.invoice_expected && !ch.invoice_numbers)
        .map(ch => ({ ...ch, link: `/accounts/challans/${ch.id}`, days: daysBetween(ch.challan_date, t),
          machine: [ch.machine_name, ch.machine_details].filter(Boolean).join(' · ') })).sort((x, y) => y.days - x.days); } },

    { key: 'invoice-upload-register', title: 'Invoice upload register', filters: ['date', 'customer', 'branch', 'salesperson', 'doctype', 'status'],
      statuses: [['', 'All except drafts'], ['draft', 'Drafts (not confirmed)'], ['cancelled', 'Cancelled']],
      columns: [['invoice_number', 'Number', 'text'], ['doc_type', 'Type', 'text'], ['invoice_date', 'Invoice date', 'date'], ['customer_name', 'Customer', 'text'],
        ['total', 'Total', 'money'], ['quotation', 'Quotation', 'text'], ['challans', 'Challans', 'text'], ['uploaded_at', 'Uploaded', 'text'], ['uploaded_by', 'By', 'text'],
        ['revisions', 'File revisions', 'int'], ['status', 'Status', 'text']],
      rows: (a, f) => { const t = todayIST(); return qr.invoiceList(a, { ...f, includeDrafts: f.status === 'draft', includeCancelled: !f.status })
        .map(i => ({ ...invoiceRow(i, t), revisions: db.prepare('SELECT COUNT(*) AS n FROM acc_invoice_files WHERE invoice_id=?').get(i.id).n })); } },

    { key: 'cancellations', title: 'Cancelled receipt and reversal report', filters: ['date', 'customer', 'status'],
      statuses: [['', 'All'], ['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected']],
      columns: [['kind', 'Type', 'text'], ['number', 'Document', 'text'], ['date', 'Requested / reversed', 'text'], ['customer_name', 'Customer', 'text'],
        ['amount', 'Amount', 'money'], ['reason', 'Reason', 'text'], ['requested_by', 'Requested by', 'text'], ['decided_by', 'Decided by', 'text'], ['status', 'Status', 'text']],
      rows: (a, f) => {
        const sc = qr.scope(a, 'p.customer_id');
        const dw = [], dp = [];
        if (f.from) { dw.push("date(x.requested_at,'+330 minutes') >= ?"); dp.push(f.from); }
        if (f.to) { dw.push("date(x.requested_at,'+330 minutes') <= ?"); dp.push(f.to); }
        if (f.customer_id) { dw.push('p.customer_id = ?'); dp.push(Number(f.customer_id)); }
        if (f.status) { dw.push('x.status = ?'); dp.push(f.status); }
        const recs = db.prepare(`SELECT x.*, r.receipt_number, r.id AS rid, p.amount, c.name AS customer_name, ru.full_name AS rq, du.full_name AS dq
          FROM acc_cancellations x JOIN acc_receipts r ON r.id=x.receipt_id JOIN acc_payments p ON p.id=r.payment_id JOIN customers c ON c.id=p.customer_id
          LEFT JOIN users ru ON ru.id=x.requested_by LEFT JOIN users du ON du.id=x.decided_by
          WHERE 1=1 ${dw.length ? ' AND ' + dw.join(' AND ') : ''} ${sc.sql} ORDER BY x.id DESC`).all(...dp, ...sc.params)
          .map(x => ({ kind: 'Receipt cancellation', number: x.receipt_number + (x.cancellation_number ? ' → ' + x.cancellation_number : ''), link: `/accounts/receipts/${x.rid}`,
            date: String(x.requested_at).slice(0, 16), customer_name: x.customer_name, amount: x.amount, reason: x.reason, requested_by: x.rq, decided_by: x.dq, status: cap(x.status) }));
        if (f.status && f.status !== 'approved') return recs;
        const aw = [], ap = [];
        if (f.from) { aw.push("date(al.reversed_at,'+330 minutes') >= ?"); ap.push(f.from); }
        if (f.to) { aw.push("date(al.reversed_at,'+330 minutes') <= ?"); ap.push(f.to); }
        if (f.customer_id) { aw.push('i.customer_id = ?'); ap.push(Number(f.customer_id)); }
        const isc = qr.scope(a, 'i.customer_id');
        const revs = db.prepare(`SELECT al.*, i.invoice_number, c.name AS customer_name, u.full_name AS who, r.receipt_number
          FROM acc_allocations al JOIN acc_invoices i ON i.id=al.invoice_id JOIN customers c ON c.id=i.customer_id
          LEFT JOIN users u ON u.id=al.reversed_by LEFT JOIN acc_receipts r ON r.payment_id=al.payment_id
          WHERE al.status='reversed' ${aw.length ? ' AND ' + aw.join(' AND ') : ''} ${isc.sql} ORDER BY al.reversed_at DESC`).all(...ap, ...isc.params)
          .map(al => ({ kind: 'Allocation reversal', number: `${al.receipt_number || 'Credit/adjustment'} → ${al.invoice_number}`, link: `/accounts/invoices/${al.invoice_id}`,
            date: String(al.reversed_at).slice(0, 16), customer_name: al.customer_name, amount: al.amount, reason: al.reverse_reason, requested_by: al.who, decided_by: al.who, status: 'Reversed' }));
        return [...recs, ...revs];
      } },

    { key: 'audit', title: 'User activity and audit report', filters: ['date', 'user'], audit: true,
      columns: [['when', 'When (UTC)', 'text'], ['user', 'User', 'text'], ['action', 'Action', 'text'], ['entity', 'Record', 'text'], ['details', 'Details', 'text']],
      rows: (a, f) => qr.activity(a, { limit: 5000, from: f.from, to: f.to, user_id: f.user_id })
        .map(r => ({ when: r.created_at, user: r.full_name || r.username || '—', action: cap(r.action), entity: `${r.entity.replace('acc_', '')} #${r.entity_id}`, details: r.details })) },
  ];

  const byKey = Object.fromEntries(defs.map(d => [d.key, d]));
  function run(actor, key, f) {
    const def = byKey[key];
    if (!def) return null;
    const rows = def.rows(actor, f);
    const totals = {};
    def.columns.filter(c => c[2] === 'money').forEach(([k]) => { totals[k] = rows.reduce((t, r) => t + (r[k] || 0), 0); });
    return { def, rows, totals };
  }
  return { defs, byKey, run };
}

module.exports = { createReports };
