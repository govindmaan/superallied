// ── Accounts engine: every write in the Accounts module goes through here ─────
// Rules this file enforces (the routes and screens only call it):
//  • A payment is money actually received. Allocation to documents is a
//    separate record, so one payment can settle many invoices and many
//    payments can settle one invoice, without counting money twice.
//  • Nothing is allocated beyond the payment's unallocated balance or the
//    invoice's open balance. Money left over stays with the customer as an
//    advance / credit balance until it is allocated.
//  • Cheques reserve their allocations ("pending") until cleared; a bounced
//    cheque releases them.
//  • Finalised receipts are never deleted — they are cancelled through a
//    reasoned, optionally approved workflow that reverses their allocations.
//  • Permissions are checked here, on the server, for every operation.
//  • Each operation is one BEGIN IMMEDIATE transaction: balances are re-read
//    and re-checked inside the lock, so concurrent requests cannot double-allocate.

const { getUserPermissions } = require('./perms');

class AccError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const MODES = { cash: 'Cash', upi: 'UPI', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', cheque: 'Cheque', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' };
const PURPOSES = {
  quotation_advance: 'Advance against quotation',
  challan_payment:   'Payment against delivery challan',
  invoice_payment:   'Payment against Tally invoice',
  on_account:        'Advance received — pending allocation',
  other:             'Other customer receipt',
};
const DOC_TYPES = { tax_invoice: 'Tax Invoice', credit_note: 'Credit Note', debit_note: 'Debit Note', other: 'Other' };
const RECEIVABLE = ['tax_invoice', 'debit_note', 'other'];
const REF_REQUIRED = ['upi', 'neft', 'rtgs', 'imps', 'cheque', 'bank_transfer'];

const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z'));

// Financial year (Apr–Mar) of a YYYY-MM-DD date, in the app's "26-27" style
function fyOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

// "1,00,000.50" / 100000.5 → 10000050 paise. Rejects negatives, junk and >2 decimals.
function toPaise(v, { allowZero = false, field = 'Amount' } = {}) {
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new AccError(`${field} must be a number with at most 2 decimals.`);
  const [r, p = ''] = s.split('.');
  const paise = Number(r) * 100 + Number((p + '00').slice(0, 2));
  if (!Number.isSafeInteger(paise)) throw new AccError(`${field} is too large.`);
  if (!allowZero && paise <= 0) throw new AccError(`${field} must be more than zero.`);
  return paise;
}
const rupees = (paise) => (paise || 0) / 100;
function inr(paise) {
  return '₹' + rupees(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createAccounts(db) {
  // ── Transactions ────────────────────────────────────────────────────────────
  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();          // already inside this connection's transaction
    db.exec('BEGIN IMMEDIATE');           // write lock first: reads below see the latest committed state
    depth++;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { depth--; }
  }

  // ── Permissions ─────────────────────────────────────────────────────────────
  // actor = { id, role } (from the session). Permissions come from role_permissions.
  function permsOf(actor) {
    if (!actor) return [];
    if (!actor._perms) actor._perms = getUserPermissions(db, actor.role);
    return actor._perms;
  }
  function can(actor, perm) {
    const p = permsOf(actor);
    return p.includes('*') || p.includes(perm);
  }
  // Sees every customer's financial records (accountant, accounts manager, management, admin)
  function canSeeAll(actor) {
    return can(actor, 'accounts') || can(actor, 'accounts_approve') || can(actor, 'accounts_reports');
  }
  function need(actor, perm) {
    if (!actor?.id) throw new AccError('Please log in.', 401);
    if (!can(actor, perm)) throw new AccError('You are not authorised to do this.', 403);
  }
  // Salespeople see customers they created or quoted
  function canViewCustomer(actor, customerId) {
    if (canSeeAll(actor)) return true;
    if (!can(actor, 'accounts_view')) return false;
    return !!db.prepare(`SELECT 1 FROM customers c WHERE c.id=? AND (c.created_by=? OR EXISTS
      (SELECT 1 FROM quotations q WHERE q.customer_id=c.id AND q.user_id=?))`).get(customerId, actor.id, actor.id);
  }

  // ── Audit (existing audit_log table; details = JSON with before/after) ────────
  function audit(actor, action, entity, entityId, data = {}) {
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)')
      .run(actor?.id ?? null, action, entity, String(entityId ?? ''), JSON.stringify(data));
  }

  function settings() {
    return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
  }

  function nextNumber(series, fy) {
    db.prepare('INSERT OR IGNORE INTO acc_sequences (series, financial_year, last_number) VALUES (?,?,0)').run(series, fy);
    db.prepare('UPDATE acc_sequences SET last_number = last_number + 1 WHERE series=? AND financial_year=?').run(series, fy);
    return db.prepare('SELECT last_number AS n FROM acc_sequences WHERE series=? AND financial_year=?').get(series, fy).n;
  }

  // ── Lookups ─────────────────────────────────────────────────────────────────
  function customerOrFail(id) {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(id) || 0);
    if (!c) throw new AccError('Choose an existing customer.');
    return c;
  }
  function invoiceOrFail(id) {
    const inv = db.prepare('SELECT * FROM acc_invoices WHERE id=?').get(Number(id) || 0);
    if (!inv) throw new AccError('Invoice not found.', 404);
    return inv;
  }
  function paymentOrFail(id) {
    const p = db.prepare('SELECT * FROM acc_payments WHERE id=?').get(Number(id) || 0);
    if (!p) throw new AccError('Payment not found.', 404);
    return p;
  }
  function quotationFor(customerId, quotationId) {
    if (!quotationId) return null;
    const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(quotationId));
    if (!q) throw new AccError('Linked quotation not found.');
    return q;
  }
  function challanOrFail(id) {
    const ch = db.prepare('SELECT * FROM acc_challans WHERE id=?').get(Number(id) || 0);
    if (!ch) throw new AccError('Delivery challan not found.');
    return ch;
  }
  const optId = (v) => (Number(v) > 0 ? Number(v) : null);
  const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  function salespersonId(v) {
    const id = optId(v);
    if (id && !db.prepare('SELECT 1 FROM salespersons WHERE id=?').get(id)) throw new AccError('Salesperson not found.');
    return id;
  }

  // Open amount still free to allocate on a receivable: balance minus cheques waiting to clear
  function invoiceAvailable(invoiceId) {
    const inv = db.prepare('SELECT balance_amount FROM acc_invoices WHERE id=?').get(invoiceId);
    const pending = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM acc_allocations WHERE invoice_id=? AND status='pending'").get(invoiceId).s;
    return inv.balance_amount - pending;
  }

  // ── Recalculation (always inside the transaction that changed allocations) ───
  function recalcInvoice(id) {
    const inv = db.prepare('SELECT * FROM acc_invoices WHERE id=?').get(id);
    let allocated, status;
    if (inv.doc_type === 'credit_note') {
      allocated = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM acc_allocations WHERE credit_note_id=? AND status='active'").get(id).s;
      status = allocated === 0 ? 'unpaid' : allocated >= inv.total_amount ? 'paid' : 'partial';
    } else {
      const r = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s, COALESCE(SUM(CASE WHEN credit_note_id IS NOT NULL THEN amount END),0) AS cn
        FROM acc_allocations WHERE invoice_id=? AND status='active'`).get(id);
      allocated = r.s;
      status = allocated === 0 ? 'unpaid' : allocated < inv.total_amount ? 'partial' : r.cn > 0 ? 'credit_adjusted' : 'paid';
    }
    if (allocated > inv.total_amount) throw new AccError(`Allocations exceed the total of ${inv.invoice_number}.`, 409);
    db.prepare('UPDATE acc_invoices SET allocated_amount=?, balance_amount=?, payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(allocated, inv.total_amount - allocated, status, id);
  }
  function recalcPayment(id) {
    const p = db.prepare('SELECT amount FROM acc_payments WHERE id=?').get(id);
    const allocated = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM acc_allocations WHERE payment_id=? AND status IN ('active','pending')").get(id).s;
    if (allocated > p.amount) throw new AccError('Allocations exceed the payment amount.', 409);
    db.prepare('UPDATE acc_payments SET allocated_amount=?, unallocated_amount=? WHERE id=?').run(allocated, p.amount - allocated, id);
  }

  // ── Delivery challans ───────────────────────────────────────────────────────
  function createChallan(actor, d) {
    need(actor, 'accounts');
    return tx(() => {
      const number = text(d.challan_number, 60);
      if (!number) throw new AccError('Enter the delivery challan number.');
      if (!isDate(d.challan_date)) throw new AccError('Enter a valid challan date.');
      const c = customerOrFail(d.customer_id);
      const q = quotationFor(c.id, optId(d.quotation_id));
      if (db.prepare('SELECT 1 FROM acc_challans WHERE challan_number=? COLLATE NOCASE').get(number))
        throw new AccError(`Delivery challan ${number} is already recorded.`, 409);
      const value = String(d.challan_value ?? '').trim() ? toPaise(d.challan_value, { field: 'Challan value' }) : null;
      const r = db.prepare(`INSERT INTO acc_challans (challan_number, challan_date, customer_id, quotation_id, machine_id, machine_details,
          chassis_number, engine_number, challan_value, invoice_expected, branch, salesperson_id, remarks, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, d.challan_date, c.id, q?.id ?? null, optId(d.machine_id),
        text(d.machine_details), text(d.chassis_number, 60), text(d.engine_number, 60), value,
        d.invoice_expected === false || d.invoice_expected === '0' ? 0 : 1, text(d.branch, 60),
        salespersonId(d.salesperson_id) ?? q?.salesperson_id ?? null, text(d.remarks), actor.id);
      const id = Number(r.lastInsertRowid);
      audit(actor, 'challan_created', 'acc_challan', id, { after: { number, customer_id: c.id, value } });
      return db.prepare('SELECT * FROM acc_challans WHERE id=?').get(id);
    });
  }

  function cancelChallan(actor, id, reason) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const ch = challanOrFail(id);
      if (ch.status === 'cancelled') throw new AccError('This challan is already cancelled.');
      if (text(reason).length < 5) throw new AccError('Give a reason for cancelling (at least 5 characters).');
      db.prepare("UPDATE acc_challans SET status='cancelled', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, cancel_reason=? WHERE id=?")
        .run(actor.id, text(reason), ch.id);
      audit(actor, 'challan_cancelled', 'acc_challan', ch.id, { before: { status: ch.status }, after: { status: 'cancelled' }, reason: text(reason) });
    });
  }

  // ── Tally invoices ──────────────────────────────────────────────────────────
  // Shared validation for a new or edited invoice. Returns normalised fields.
  function parseInvoice(d, existing) {
    const docType = d.doc_type || existing?.doc_type;
    if (!DOC_TYPES[docType]) throw new AccError('Choose the document type.');
    const number = text(d.invoice_number ?? existing?.invoice_number, 60).replace(/\s+/g, ' ');
    if (!number) throw new AccError('Enter the Tally invoice number.');
    const date = d.invoice_date ?? existing?.invoice_date;
    if (!isDate(date)) throw new AccError('Enter a valid invoice date.');
    if (date > todayIST()) throw new AccError('Invoice date cannot be in the future.');
    const c = customerOrFail(d.customer_id ?? existing?.customer_id);
    const basic = toPaise(d.basic_value ?? rupees(existing?.basic_value), { allowZero: true, field: 'Basic value' });
    const gst   = toPaise(d.gst_amount ?? rupees(existing?.gst_amount), { allowZero: true, field: 'GST amount' });
    const total = toPaise(d.total_amount ?? rupees(existing?.total_amount), { field: 'Total invoice amount' });
    if (total < basic) throw new AccError('Total invoice amount cannot be less than the basic value.');
    const s = settings();
    let due = d.due_date ?? existing?.due_date ?? '';
    if (due && !isDate(due)) throw new AccError('Enter a valid due date.');
    if (!due && docType !== 'credit_note') {
      const days = parseInt(s.acc_default_due_days) || 0;
      due = new Date(Date.parse(date + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);
    }
    if (due && due < date) throw new AccError('Due date cannot be before the invoice date.');
    const q = quotationFor(c.id, optId(d.quotation_id !== undefined ? d.quotation_id : existing?.quotation_id));
    // challan_ids undefined on an edit = keep the current links
    const rawCh = d.challan_ids !== undefined ? d.challan_ids
      : existing ? db.prepare('SELECT challan_id FROM acc_invoice_challans WHERE invoice_id=?').all(existing.id).map(r => r.challan_id) : [];
    const challanIds = [...new Set([].concat(rawCh).map(Number).filter(n => n > 0))];
    challanIds.forEach(cid => { if (challanOrFail(cid).status !== 'active') throw new AccError('A linked delivery challan is cancelled.'); });
    let against = optId(d.against_invoice_id !== undefined ? d.against_invoice_id : existing?.against_invoice_id);
    if (docType === 'tax_invoice') against = null;
    if (against) {
      const a = invoiceOrFail(against);
      if (a.customer_id !== c.id || !RECEIVABLE.includes(a.doc_type) || ['draft', 'cancelled'].includes(a.status))
        throw new AccError('The original invoice for this note must be an active invoice of the same customer.');
    }
    const gstin = text(d.customer_gstin ?? existing?.customer_gstin, 15).toUpperCase().replace(/\s+/g, '');
    if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw new AccError('GSTIN on the invoice must be 15 characters, e.g. 09ABCDE1234F1Z5.');
    return {
      doc_type: docType, invoice_number: number, invoice_date: date, financial_year: fyOf(date),
      customer_id: c.id, quotation_id: q?.id ?? null, against_invoice_id: against, challanIds,
      machine_details: text(d.machine_details ?? existing?.machine_details, 1000),
      basic_value: basic, gst_amount: gst, total_amount: total, due_date: due || null,
      payment_terms: text(d.payment_terms ?? existing?.payment_terms, 200),
      customer_gstin: gstin,
      challan_expected: ['0', 0, false].includes(d.challan_expected !== undefined ? d.challan_expected : existing?.challan_expected ?? 1) ? 0 : 1,
      branch: text(d.branch ?? existing?.branch, 60),
      salesperson_id: salespersonId(d.salesperson_id !== undefined ? d.salesperson_id : existing?.salesperson_id) ?? q?.salesperson_id ?? null,
      remarks: text(d.remarks ?? existing?.remarks, 1000),
    };
  }

  function duplicateOf(entity, f, exceptId = 0) {
    return db.prepare(`SELECT id, status FROM acc_invoices WHERE business_entity=? AND financial_year=? AND doc_type=?
      AND invoice_number=? AND id<>?`).get(entity, f.financial_year, f.doc_type, f.invoice_number, exceptId);
  }
  function dupError(f, dup) {
    return new AccError(`${DOC_TYPES[f.doc_type]} ${f.invoice_number} for FY ${f.financial_year} is already in the system` +
      (dup.status === 'draft' ? ' as an unconfirmed draft' : dup.status === 'cancelled' ? ' (cancelled)' : '') +
      '. Open it instead of uploading again.', 409, { duplicateId: dup.id });
  }

  // Step 1: save as Draft with its file. file = { storedName, originalName, mime, size, sha256 } (already validated + stored)
  function createInvoiceDraft(actor, d, file) {
    need(actor, 'accounts');
    return tx(() => {
      if (d.client_token) {
        const again = db.prepare('SELECT * FROM acc_invoices WHERE client_token=?').get(String(d.client_token));
        if (again) return again;   // double submission → same draft
      }
      if (!file) throw new AccError('Attach the invoice PDF or scan.');
      const f = parseInvoice(d, null);
      const entity = settings().company_gstin || 'SUPER-ALLIED';
      const dup = duplicateOf(entity, f);
      if (dup) throw dupError(f, dup);
      const r = db.prepare(`INSERT INTO acc_invoices (business_entity, financial_year, doc_type, invoice_number, invoice_date, customer_id,
          quotation_id, against_invoice_id, machine_details, basic_value, gst_amount, total_amount, allocated_amount, balance_amount,
          due_date, payment_terms, customer_gstin, challan_expected, branch, salesperson_id, remarks, extracted_json, status, client_token, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,'draft',?,?)`).run(
        entity, f.financial_year, f.doc_type, f.invoice_number, f.invoice_date, f.customer_id, f.quotation_id, f.against_invoice_id,
        f.machine_details, f.basic_value, f.gst_amount, f.total_amount, f.total_amount, f.due_date, f.payment_terms, f.customer_gstin,
        f.challan_expected, f.branch, f.salesperson_id, f.remarks, d.extracted_json ? String(d.extracted_json).slice(0, 4000) : '',
        d.client_token ? String(d.client_token) : null, actor.id);
      const id = Number(r.lastInsertRowid);
      const link = db.prepare('INSERT OR IGNORE INTO acc_invoice_challans (invoice_id, challan_id) VALUES (?,?)');
      f.challanIds.forEach(cid => link.run(id, cid));
      db.prepare(`INSERT INTO acc_invoice_files (invoice_id, revision, stored_name, original_name, mime, size_bytes, sha256, uploaded_by)
        VALUES (?,1,?,?,?,?,?,?)`).run(id, file.storedName, text(file.originalName, 200), file.mime, file.size, file.sha256, actor.id);
      audit(actor, 'invoice_draft_created', 'acc_invoice', id, { after: { ...f, file: file.originalName } });
      return invoiceOrFail(id);
    });
  }

  // Step 2 (after the review screen): Draft → Uploaded. A credit/debit note is applied to its original invoice.
  function confirmInvoice(actor, id) {
    need(actor, 'accounts');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (inv.status !== 'draft') return inv;          // already confirmed (double click) → no-op
      const dup = duplicateOf(inv.business_entity, inv, inv.id);
      if (dup) throw dupError(inv, dup);
      db.prepare("UPDATE acc_invoices SET status='uploaded', uploaded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(inv.id);
      audit(actor, 'invoice_uploaded', 'acc_invoice', inv.id, { before: { status: 'draft' }, after: { status: 'uploaded' } });
      if (inv.doc_type === 'credit_note' && inv.against_invoice_id) {
        const target = invoiceOrFail(inv.against_invoice_id);
        const amt = Math.min(inv.total_amount, invoiceAvailable(target.id));
        if (amt > 0 && target.status !== 'cancelled') {
          insertAllocation(actor, { invoice_id: target.id, credit_note_id: inv.id, amount: amt, status: 'active', remarks: 'Credit note applied on upload' });
          recalcInvoice(target.id);
          recalcInvoice(inv.id);
        }
      }
      return invoiceOrFail(inv.id);
    });
  }

  function discardDraft(actor, id) {
    need(actor, 'accounts');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (inv.status !== 'draft') throw new AccError('Only an unconfirmed draft can be discarded. Use Cancel for an uploaded invoice.');
      const files = db.prepare('SELECT stored_name FROM acc_invoice_files WHERE invoice_id=?').all(inv.id).map(f => f.stored_name);
      db.prepare('DELETE FROM acc_invoice_files WHERE invoice_id=?').run(inv.id);
      db.prepare('DELETE FROM acc_invoice_challans WHERE invoice_id=?').run(inv.id);
      db.prepare('DELETE FROM acc_invoices WHERE id=?').run(inv.id);
      audit(actor, 'invoice_draft_discarded', 'acc_invoice', inv.id, { before: { invoice_number: inv.invoice_number, total: inv.total_amount } });
      return files;   // caller removes the staged files
    });
  }

  const FIN_FIELDS = ['basic_value', 'gst_amount', 'total_amount', 'due_date', 'invoice_date', 'customer_id', 'invoice_number', 'doc_type'];
  function updateInvoice(actor, id, d, reason) {
    need(actor, 'accounts');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (inv.status === 'cancelled') throw new AccError('A cancelled invoice cannot be edited.');
      if (inv.status === 'verified' && !can(actor, 'accounts_approve'))
        throw new AccError('This invoice is verified. Only an accounts manager can change it.', 403);
      const f = parseInvoice({ ...d, doc_type: d.doc_type || inv.doc_type }, inv);
      const hasAlloc = db.prepare("SELECT 1 FROM acc_allocations WHERE (invoice_id=? OR credit_note_id=?) AND status IN ('active','pending')").get(inv.id, inv.id);
      if (hasAlloc && (f.customer_id !== inv.customer_id || f.doc_type !== inv.doc_type))
        throw new AccError('Reverse this invoice’s payment allocations before changing its customer or type.');
      // allocated + cheques waiting to clear (receivables) / amount of the note already used (credit notes)
      const reserved = RECEIVABLE.includes(inv.doc_type) ? inv.total_amount - invoiceAvailable(inv.id) : inv.allocated_amount;
      if (f.total_amount < reserved) throw new AccError(`Total cannot be less than the ${inr(reserved)} already allocated.`);
      const dup = duplicateOf(inv.business_entity, f, inv.id);
      if (dup) throw dupError(f, dup);
      const before = {}, after = {};
      Object.keys(f).filter(k => k !== 'challanIds').forEach(k => { if (String(inv[k] ?? '') !== String(f[k] ?? '')) { before[k] = inv[k]; after[k] = f[k]; } });
      const oldCh = db.prepare('SELECT challan_id FROM acc_invoice_challans WHERE invoice_id=? ORDER BY challan_id').all(inv.id).map(r => r.challan_id);
      const newCh = [...f.challanIds].sort((a, b) => a - b);
      if (oldCh.join() !== newCh.join()) { before.challans = oldCh; after.challans = newCh; }
      if (!Object.keys(after).length) return inv;
      if (FIN_FIELDS.some(k => k in after) && text(reason).length < 5)
        throw new AccError('Give a reason for changing financial values, dates or the invoice number.');
      db.prepare(`UPDATE acc_invoices SET doc_type=?, invoice_number=?, invoice_date=?, financial_year=?, customer_id=?, quotation_id=?,
          against_invoice_id=?, machine_details=?, basic_value=?, gst_amount=?, total_amount=?, due_date=?, payment_terms=?,
          customer_gstin=?, challan_expected=?, branch=?, salesperson_id=?, remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        f.doc_type, f.invoice_number, f.invoice_date, f.financial_year, f.customer_id, f.quotation_id, f.against_invoice_id,
        f.machine_details, f.basic_value, f.gst_amount, f.total_amount, f.due_date, f.payment_terms, f.customer_gstin,
        f.challan_expected, f.branch, f.salesperson_id, f.remarks, inv.id);
      db.prepare('DELETE FROM acc_invoice_challans WHERE invoice_id=?').run(inv.id);
      const link = db.prepare('INSERT INTO acc_invoice_challans (invoice_id, challan_id) VALUES (?,?)');
      newCh.forEach(cid => link.run(inv.id, cid));
      recalcInvoice(inv.id);
      audit(actor, 'invoice_modified', 'acc_invoice', inv.id, { before, after, reason: text(reason) });
      return invoiceOrFail(inv.id);
    });
  }

  function replaceInvoiceFile(actor, id, file, reason) {
    need(actor, 'accounts');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (inv.status === 'cancelled') throw new AccError('A cancelled invoice’s file cannot be replaced.');
      if (inv.status === 'verified' && !can(actor, 'accounts_approve')) throw new AccError('This invoice is verified. Only an accounts manager can replace its file.', 403);
      if (text(reason).length < 5) throw new AccError('Give a reason for replacing the file.');
      const cur = db.prepare('SELECT * FROM acc_invoice_files WHERE invoice_id=? AND is_current=1').get(inv.id);
      const rev = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS r FROM acc_invoice_files WHERE invoice_id=?').get(inv.id).r;
      db.prepare('UPDATE acc_invoice_files SET is_current=0 WHERE invoice_id=?').run(inv.id);
      db.prepare(`INSERT INTO acc_invoice_files (invoice_id, revision, stored_name, original_name, mime, size_bytes, sha256, replace_reason, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(inv.id, rev, file.storedName, text(file.originalName, 200), file.mime, file.size, file.sha256, text(reason), actor.id);
      audit(actor, 'invoice_file_replaced', 'acc_invoice', inv.id, { before: { revision: cur?.revision, sha256: cur?.sha256 }, after: { revision: rev, sha256: file.sha256 }, reason: text(reason) });
      return rev;
    });
  }

  function verifyInvoice(actor, id) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (inv.status !== 'uploaded') throw new AccError(inv.status === 'verified' ? 'Already verified.' : 'Only an uploaded invoice can be verified.');
      db.prepare("UPDATE acc_invoices SET status='verified', verified_by=?, verified_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actor.id, inv.id);
      audit(actor, 'invoice_verified', 'acc_invoice', inv.id, { before: { status: 'uploaded' }, after: { status: 'verified' } });
    });
  }

  function cancelInvoice(actor, id, reason) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const inv = invoiceOrFail(id);
      if (!['uploaded', 'verified'].includes(inv.status)) throw new AccError('Only an uploaded or verified invoice can be cancelled.');
      if (text(reason).length < 5) throw new AccError('Give a reason for cancelling (at least 5 characters).');
      if (db.prepare("SELECT 1 FROM acc_allocations WHERE (invoice_id=? OR credit_note_id=?) AND status IN ('active','pending')").get(inv.id, inv.id))
        throw new AccError('This document has payment allocations. Reverse them first, then cancel.');
      db.prepare("UPDATE acc_invoices SET status='cancelled', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, cancel_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(actor.id, text(reason), inv.id);
      audit(actor, 'invoice_cancelled', 'acc_invoice', inv.id, { before: { status: inv.status }, after: { status: 'cancelled' }, reason: text(reason) });
    });
  }

  // ── Allocation core ─────────────────────────────────────────────────────────
  function insertAllocation(actor, a) {
    const r = db.prepare(`INSERT INTO acc_allocations (invoice_id, payment_id, credit_note_id, adjustment_id, amount, status, remarks, allocated_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(a.invoice_id, a.payment_id ?? null, a.credit_note_id ?? null, a.adjustment_id ?? null,
      a.amount, a.status, text(a.remarks), actor.id);
    const id = Number(r.lastInsertRowid);
    const src = a.payment_id ? { payment_id: a.payment_id } : a.credit_note_id ? { credit_note_id: a.credit_note_id } : { adjustment_id: a.adjustment_id };
    audit(actor, a.adjustment_id ? 'adjustment_allocated' : a.credit_note_id ? 'credit_note_allocated'
      : a.advance ? 'advance_allocated' : 'payment_allocated', 'acc_allocation', id,
      { after: { invoice_id: a.invoice_id, ...src, amount: a.amount, status: a.status } });
    return id;
  }

  // lines = [{ invoice_id, amount (rupees) }]; validates against the freshest balances
  function applyLines(actor, source, lines) {
    const clean = [].concat(lines || []).map(l => ({ invoice_id: Number(l.invoice_id), raw: l.amount }))
      .filter(l => l.invoice_id > 0 && String(l.raw ?? '').trim() !== '' && Number(String(l.raw).replace(/,/g, '')) !== 0)
      .map(l => ({ invoice_id: l.invoice_id, amount: toPaise(l.raw, { field: 'Allocation amount' }) }));
    if (new Set(clean.map(l => l.invoice_id)).size !== clean.length) throw new AccError('Each invoice can appear only once in an allocation.');
    let available = source.available;
    const touched = [];
    for (const l of clean) {
      const inv = invoiceOrFail(l.invoice_id);
      if (inv.customer_id !== source.customer_id) throw new AccError(`Invoice ${inv.invoice_number} belongs to a different customer.`);
      if (!RECEIVABLE.includes(inv.doc_type)) throw new AccError(`${inv.invoice_number} is a credit note; money can only be allocated to invoices and debit notes.`);
      if (!['uploaded', 'verified'].includes(inv.status)) throw new AccError(`Invoice ${inv.invoice_number} is ${inv.status}; it cannot take payments.`);
      const open = invoiceAvailable(inv.id);
      if (l.amount > open) throw new AccError(`Only ${inr(open)} is open on invoice ${inv.invoice_number}; you entered ${inr(l.amount)}.`, 409);
      if (l.amount > available) throw new AccError(`Only ${inr(available)} of this ${source.label} is unallocated; the allocation totals more.`, 409);
      available -= l.amount;
      insertAllocation(actor, { invoice_id: inv.id, ...source.ref, amount: l.amount, status: source.status, remarks: source.remarks, advance: source.advance });
      touched.push(inv.id);
    }
    touched.forEach(recalcInvoice);
    return clean.length;
  }

  function paymentSource(p) {
    if (p.status !== 'active') throw new AccError('This payment is cancelled.');
    if (p.clearance_status === 'bounced') throw new AccError('This cheque bounced; it cannot be allocated.');
    return { customer_id: p.customer_id, available: p.unallocated_amount, label: 'payment', ref: { payment_id: p.id },
             status: p.mode === 'cheque' && p.clearance_status !== 'cleared' ? 'pending' : 'active',
             advance: p.purpose === 'quotation_advance' || p.purpose === 'on_account' };
  }

  // Allocate an existing payment (or advance) or a credit note to invoices
  function allocate(actor, { payment_id, credit_note_id, lines, remarks }) {
    need(actor, 'accounts');
    return tx(() => {
      let source;
      if (payment_id) {
        source = paymentSource(paymentOrFail(payment_id));
      } else if (credit_note_id) {
        const cn = invoiceOrFail(credit_note_id);
        if (cn.doc_type !== 'credit_note' || !['uploaded', 'verified'].includes(cn.status)) throw new AccError('Choose an uploaded credit note.');
        source = { customer_id: cn.customer_id, available: cn.balance_amount, label: 'credit note', ref: { credit_note_id: cn.id }, status: 'active' };
      } else throw new AccError('Choose the payment or credit note to allocate.');
      source.remarks = remarks;
      const n = applyLines(actor, source, lines);
      if (!n) throw new AccError('Enter at least one allocation amount.');
      if (payment_id) recalcPayment(Number(payment_id)); else recalcInvoice(Number(credit_note_id));
      return n;
    });
  }

  function reverseAllocation(actor, id, reason) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const a = db.prepare('SELECT * FROM acc_allocations WHERE id=?').get(Number(id) || 0);
      if (!a) throw new AccError('Allocation not found.', 404);
      if (a.status === 'reversed') throw new AccError('This allocation is already reversed.');
      if (text(reason).length < 5) throw new AccError('Give a reason for the reversal (at least 5 characters).');
      reverseRow(actor, a, text(reason));
      return a;
    });
  }
  function reverseRow(actor, a, reason) {
    db.prepare("UPDATE acc_allocations SET status='reversed', reversed_by=?, reversed_at=CURRENT_TIMESTAMP, reverse_reason=? WHERE id=?").run(actor.id, reason, a.id);
    recalcInvoice(a.invoice_id);
    if (a.payment_id) recalcPayment(a.payment_id);
    if (a.credit_note_id) recalcInvoice(a.credit_note_id);
    audit(actor, 'allocation_reversed', 'acc_allocation', a.id, { before: { status: a.status, amount: a.amount, invoice_id: a.invoice_id }, after: { status: 'reversed' }, reason });
  }

  // ── Payments + receipts ─────────────────────────────────────────────────────
  // One transaction: payment row, receipt number, optional allocations.
  function recordPayment(actor, d) {
    need(actor, 'accounts');
    return tx(() => {
      if (d.client_token) {
        const again = db.prepare('SELECT * FROM acc_payments WHERE client_token=?').get(String(d.client_token));
        if (again) return { payment: again, receipt: db.prepare('SELECT * FROM acc_receipts WHERE payment_id=?').get(again.id), duplicate: true };
      }
      const c = customerOrFail(d.customer_id);
      if (c.deleted_at) throw new AccError('This customer is deleted.');
      if (!PURPOSES[d.purpose]) throw new AccError('Choose what the payment is for.');
      if (!MODES[d.mode]) throw new AccError('Choose the payment mode.');
      const amount = toPaise(d.amount, { field: 'Amount received' });
      if (!isDate(d.payment_date)) throw new AccError('Enter a valid payment date.');
      if (d.payment_date > todayIST()) throw new AccError('Payment date cannot be in the future — record money when it is actually received.');
      const reference = text(d.reference, 80);
      if (REF_REQUIRED.includes(d.mode) && !reference)
        throw new AccError(d.mode === 'cheque' ? 'Enter the cheque number.' : 'Enter the UTR / transaction reference.');
      if (d.mode === 'cheque' && d.cheque_date && !isDate(d.cheque_date)) throw new AccError('Enter a valid cheque date.');

      let quotation = null, challan = null;
      if (d.purpose === 'quotation_advance') {
        quotation = quotationFor(c.id, optId(d.quotation_id));
        if (!quotation) throw new AccError('Choose the quotation this advance is against.');
        if (quotation.customer_id !== c.id) throw new AccError('That quotation belongs to a different customer.');
        if (quotation.cancelled_at) throw new AccError('That quotation is cancelled.');
      } else if (optId(d.quotation_id)) {
        quotation = quotationFor(c.id, optId(d.quotation_id));
        if (quotation.customer_id !== c.id) throw new AccError('That quotation belongs to a different customer.');
      }
      if (d.purpose === 'challan_payment' || optId(d.challan_id)) {
        if (!optId(d.challan_id)) throw new AccError('Choose the delivery challan.');
        challan = challanOrFail(d.challan_id);
        if (challan.customer_id !== c.id) throw new AccError('That delivery challan belongs to a different customer.');
        if (challan.status !== 'active') throw new AccError('That delivery challan is cancelled.');
        if (!quotation && challan.quotation_id) quotation = quotationFor(c.id, challan.quotation_id);
      }
      const lines = [].concat(d.allocations || []);
      if (d.purpose === 'quotation_advance' && lines.some(l => Number(String(l.amount ?? '').replace(/,/g, '')) > 0))
        throw new AccError('An advance against a quotation stays unallocated until the Tally invoice is uploaded. Allocate it from Payment Allocation then.');
      if (d.purpose === 'invoice_payment' && !lines.some(l => Number(String(l.amount ?? '').replace(/,/g, '')) > 0))
        throw new AccError('Enter how much of this payment goes to each invoice.');

      const isCheque = d.mode === 'cheque';
      const r = db.prepare(`INSERT INTO acc_payments (customer_id, payment_date, amount, allocated_amount, unallocated_amount, mode, reference,
          bank_name, cheque_date, purpose, quotation_id, challan_id, branch, salesperson_id, received_by, remarks,
          clearance_status, client_token, created_by)
        VALUES (?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, d.payment_date, amount, amount, d.mode, reference,
        text(d.bank_name, 80), isCheque && d.cheque_date ? d.cheque_date : null, d.purpose, quotation?.id ?? null, challan?.id ?? null,
        text(d.branch, 60), salespersonId(d.salesperson_id) ?? quotation?.salesperson_id ?? challan?.salesperson_id ?? null,
        optId(d.received_by) ?? actor.id, text(d.remarks, 500), isCheque ? 'received' : 'cleared',
        d.client_token ? String(d.client_token) : null, actor.id);
      const paymentId = Number(r.lastInsertRowid);
      if (isCheque) db.prepare("INSERT INTO acc_cheque_events (payment_id, status, event_date, created_by) VALUES (?,?,?,?)").run(paymentId, 'received', d.payment_date, actor.id);

      const s = settings();
      const rDate = todayIST();   // receipt is issued today; the payment date may be earlier
      const fy = fyOf(rDate);
      const serial = nextNumber('receipt', fy);
      const number = `${s.acc_receipt_prefix || 'SA/RCT'}/${fy}/${String(serial).padStart(4, '0')}`;
      const rr = db.prepare('INSERT INTO acc_receipts (receipt_number, financial_year, serial_number, payment_id, receipt_date, prepared_by) VALUES (?,?,?,?,?,?)')
        .run(number, fy, serial, paymentId, rDate, actor.id);
      audit(actor, 'receipt_created', 'acc_receipt', Number(rr.lastInsertRowid), {
        after: { receipt_number: number, payment_id: paymentId, customer_id: c.id, amount, mode: d.mode, purpose: d.purpose, reference } });

      if (lines.length) {
        const p = paymentOrFail(paymentId);
        applyLines(actor, { ...paymentSource(p), remarks: 'With receipt ' + number }, lines);
        recalcPayment(paymentId);
      }
      return { payment: paymentOrFail(paymentId), receipt: db.prepare('SELECT * FROM acc_receipts WHERE payment_id=?').get(paymentId) };
    });
  }

  function updatePaymentReference(actor, id, d) {
    need(actor, 'accounts');
    return tx(() => {
      const p = paymentOrFail(id);
      if (p.status !== 'active') throw new AccError('This payment is cancelled.');
      if (p.verification_status === 'verified' && !can(actor, 'accounts_approve')) throw new AccError('This payment is verified. Only an accounts manager can change it.', 403);
      const next = { reference: text(d.reference ?? p.reference, 80), bank_name: text(d.bank_name ?? p.bank_name, 80), remarks: text(d.remarks ?? p.remarks, 500) };
      if (REF_REQUIRED.includes(p.mode) && !next.reference) throw new AccError('The reference cannot be blank for this payment mode.');
      const before = {}, after = {};
      Object.keys(next).forEach(k => { if ((p[k] || '') !== next[k]) { before[k] = p[k]; after[k] = next[k]; } });
      if (!Object.keys(after).length) return;
      if (text(d.reason).length < 5) throw new AccError('Give a reason for changing the payment details.');
      db.prepare('UPDATE acc_payments SET reference=?, bank_name=?, remarks=? WHERE id=?').run(next.reference, next.bank_name, next.remarks, p.id);
      audit(actor, 'payment_reference_changed', 'acc_payment', p.id, { before, after, reason: text(d.reason) });
    });
  }

  // Cheque: received → deposited → cleared | bounced
  const CHEQUE_NEXT = { received: ['deposited', 'cleared', 'bounced'], deposited: ['cleared', 'bounced'] };
  function updateCheque(actor, id, { status, event_date, remarks }) {
    need(actor, 'accounts');
    return tx(() => {
      const p = paymentOrFail(id);
      if (p.mode !== 'cheque') throw new AccError('This payment is not a cheque.');
      if (p.status !== 'active') throw new AccError('This payment is cancelled.');
      if (!(CHEQUE_NEXT[p.clearance_status] || []).includes(status)) throw new AccError(`A ${p.clearance_status} cheque cannot be marked ${status}.`);
      const date = isDate(event_date) ? event_date : todayIST();
      if (date < p.payment_date) throw new AccError('That date is before the cheque was received.');
      if (status === 'bounced' && text(remarks).length < 3) throw new AccError('Note why the cheque bounced.');
      db.prepare('UPDATE acc_payments SET clearance_status=?, clearance_date=? WHERE id=?').run(status, status === 'deposited' ? null : date, p.id);
      db.prepare('INSERT INTO acc_cheque_events (payment_id, status, event_date, remarks, created_by) VALUES (?,?,?,?,?)').run(p.id, status, date, text(remarks), actor.id);
      const pend = db.prepare("SELECT * FROM acc_allocations WHERE payment_id=? AND status='pending'").all(p.id);
      if (status === 'cleared') {
        db.prepare("UPDATE acc_allocations SET status='active' WHERE payment_id=? AND status='pending'").run(p.id);
        [...new Set(pend.map(a => a.invoice_id))].forEach(recalcInvoice);
      } else if (status === 'bounced') {
        pend.forEach(a => reverseRow(actor, a, 'Cheque bounced'));
        // Money never arrived: open a cancellation request for its receipt
        const rc = db.prepare('SELECT id FROM acc_receipts WHERE payment_id=?').get(p.id);
        if (rc && !db.prepare("SELECT 1 FROM acc_cancellations WHERE receipt_id=? AND status='pending'").get(rc.id))
          db.prepare("INSERT INTO acc_cancellations (receipt_id, reason, requested_by) VALUES (?,?,?)").run(rc.id, 'Cheque bounced: ' + text(remarks), actor.id);
      }
      recalcPayment(p.id);
      audit(actor, 'cheque_' + status, 'acc_payment', p.id, { before: { clearance_status: p.clearance_status }, after: { clearance_status: status, date }, remarks: text(remarks) });
    });
  }

  // Manual bank reconciliation: accounts manager confirms the money against the bank statement
  function verifyPayment(actor, id, { decision, bank_reference, clearance_date, remarks }) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const p = paymentOrFail(id);
      if (p.status !== 'active') throw new AccError('This payment is cancelled.');
      if (p.verification_status !== 'pending') throw new AccError(`This payment is already ${p.verification_status}.`);
      if (!['verified', 'rejected'].includes(decision)) throw new AccError('Choose verify or reject.');
      if (decision === 'verified' && p.mode === 'cheque' && p.clearance_status !== 'cleared') throw new AccError('A cheque can be verified only after it clears.');
      if (decision === 'rejected' && text(remarks).length < 5) throw new AccError('Give a reason for rejecting.');
      const cd = decision === 'verified' ? (isDate(clearance_date) ? clearance_date : p.clearance_date || p.payment_date) : p.clearance_date;
      db.prepare('UPDATE acc_payments SET verification_status=?, verified_by=?, verified_at=CURRENT_TIMESTAMP, bank_reference=?, clearance_date=? WHERE id=?')
        .run(decision, actor.id, text(bank_reference ?? p.bank_reference, 80), cd, p.id);
      audit(actor, 'payment_' + decision, 'acc_payment', p.id, { before: { verification_status: 'pending' }, after: { verification_status: decision, bank_reference: text(bank_reference), clearance_date: cd }, remarks: text(remarks) });
    });
  }

  // ── Receipt cancellation ────────────────────────────────────────────────────
  function requestReceiptCancellation(actor, receiptId, reason) {
    need(actor, 'accounts');
    return tx(() => {
      const rc = db.prepare('SELECT * FROM acc_receipts WHERE id=?').get(Number(receiptId) || 0);
      if (!rc) throw new AccError('Receipt not found.', 404);
      if (rc.status === 'cancelled') throw new AccError('This receipt is already cancelled.');
      if (text(reason).length < 5) throw new AccError('Give a reason for cancelling (at least 5 characters).');
      let req = db.prepare("SELECT * FROM acc_cancellations WHERE receipt_id=? AND status='pending'").get(rc.id);
      if (!req) {
        const r = db.prepare('INSERT INTO acc_cancellations (receipt_id, reason, requested_by) VALUES (?,?,?)').run(rc.id, text(reason), actor.id);
        req = db.prepare('SELECT * FROM acc_cancellations WHERE id=?').get(Number(r.lastInsertRowid));
        audit(actor, 'receipt_cancel_requested', 'acc_receipt', rc.id, { reason: text(reason), request_id: req.id });
      }
      const needsApproval = settings().acc_cancel_needs_approval !== '0';
      if (!needsApproval || can(actor, 'accounts_approve')) {
        executeCancellation(actor, req, 'Approved by requester');
        return { executed: true, request: db.prepare('SELECT * FROM acc_cancellations WHERE id=?').get(req.id) };
      }
      return { executed: false, request: req };
    });
  }

  function decideCancellation(actor, requestId, approve, remarks) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const req = db.prepare('SELECT * FROM acc_cancellations WHERE id=?').get(Number(requestId) || 0);
      if (!req) throw new AccError('Cancellation request not found.', 404);
      if (req.status !== 'pending') throw new AccError(`This request is already ${req.status}.`);
      if (!approve) {
        if (text(remarks).length < 3) throw new AccError('Say why the request is rejected.');
        db.prepare("UPDATE acc_cancellations SET status='rejected', decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_remarks=? WHERE id=?").run(actor.id, text(remarks), req.id);
        audit(actor, 'receipt_cancel_rejected', 'acc_receipt', req.receipt_id, { request_id: req.id, remarks: text(remarks) });
        return false;
      }
      executeCancellation(actor, req, text(remarks));
      return true;
    });
  }

  function executeCancellation(actor, req, remarks) {
    const rc = db.prepare('SELECT * FROM acc_receipts WHERE id=?').get(req.receipt_id);
    if (rc.status === 'cancelled') throw new AccError('This receipt is already cancelled.');
    const p = paymentOrFail(rc.payment_id);
    const allocs = db.prepare("SELECT * FROM acc_allocations WHERE payment_id=? AND status IN ('active','pending')").all(p.id);
    allocs.forEach(a => reverseRow(actor, a, 'Receipt cancelled: ' + req.reason));
    db.prepare("UPDATE acc_payments SET status='cancelled' WHERE id=?").run(p.id);
    db.prepare("UPDATE acc_receipts SET status='cancelled' WHERE id=?").run(rc.id);
    const fy = fyOf(todayIST());
    const number = `${settings().acc_cancel_prefix || 'SA/RCN'}/${fy}/${String(nextNumber('receipt_cancel', fy)).padStart(4, '0')}`;
    db.prepare(`UPDATE acc_cancellations SET status='approved', decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_remarks=?,
      cancellation_number=?, reversed_allocations=? WHERE id=?`).run(actor.id, remarks || '', number,
      JSON.stringify(allocs.map(a => ({ id: a.id, invoice_id: a.invoice_id, amount: a.amount, status: a.status }))), req.id);
    audit(actor, 'receipt_cancelled', 'acc_receipt', rc.id, {
      before: { status: 'issued', amount: p.amount }, after: { status: 'cancelled', cancellation_number: number },
      reason: req.reason, reversed_allocations: allocs.length });
  }

  // ── Controlled adjustments (write-off / round-off / discount) ─────────────────
  function requestAdjustment(actor, invoiceId, d) {
    need(actor, 'accounts');
    return tx(() => {
      const inv = invoiceOrFail(invoiceId);
      if (!RECEIVABLE.includes(inv.doc_type) || !['uploaded', 'verified'].includes(inv.status)) throw new AccError('Adjustments apply to active invoices only.');
      const amount = toPaise(d.amount, { field: 'Adjustment amount' });
      if (amount > invoiceAvailable(inv.id)) throw new AccError(`Only ${inr(invoiceAvailable(inv.id))} is open on this invoice.`);
      if (text(d.reason).length < 10) throw new AccError('Explain the adjustment (at least 10 characters).');
      const type = ['write_off', 'round_off', 'discount', 'tds', 'other'].includes(d.adjustment_type) ? d.adjustment_type : 'write_off';
      const r = db.prepare('INSERT INTO acc_adjustments (invoice_id, amount, adjustment_type, reason, requested_by) VALUES (?,?,?,?,?)')
        .run(inv.id, amount, type, text(d.reason), actor.id);
      audit(actor, 'adjustment_requested', 'acc_invoice', inv.id, { after: { adjustment_id: Number(r.lastInsertRowid), amount, type }, reason: text(d.reason) });
      return Number(r.lastInsertRowid);
    });
  }

  function decideAdjustment(actor, id, approve, remarks) {
    need(actor, 'accounts_approve');
    return tx(() => {
      const adj = db.prepare('SELECT * FROM acc_adjustments WHERE id=?').get(Number(id) || 0);
      if (!adj) throw new AccError('Adjustment not found.', 404);
      if (adj.status !== 'pending') throw new AccError(`Already ${adj.status}.`);
      if (adj.requested_by === actor.id && actor.role !== 'admin') throw new AccError('Another approver must approve your own adjustment request.', 403);
      if (approve) {
        const inv = invoiceOrFail(adj.invoice_id);
        if (!['uploaded', 'verified'].includes(inv.status)) throw new AccError('The invoice is no longer active.');
        if (adj.amount > invoiceAvailable(inv.id)) throw new AccError('The invoice no longer has that much open; reject and raise a new request.');
        insertAllocation(actor, { invoice_id: inv.id, adjustment_id: adj.id, amount: adj.amount, status: 'active', remarks: `${adj.adjustment_type}: ${adj.reason}` });
        recalcInvoice(inv.id);
      } else if (text(remarks).length < 3) throw new AccError('Say why it is rejected.');
      db.prepare('UPDATE acc_adjustments SET status=?, decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_remarks=? WHERE id=?')
        .run(approve ? 'approved' : 'rejected', actor.id, text(remarks), adj.id);
      audit(actor, approve ? 'adjustment_approved' : 'adjustment_rejected', 'acc_invoice', adj.invoice_id, { adjustment_id: adj.id, amount: adj.amount, remarks: text(remarks) });
    });
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────
  function resolveDiscrepancy(actor, { flag_type, entity_type, entity_id, remarks }) {
    need(actor, 'accounts');
    return tx(() => {
      if (text(remarks).length < 5) throw new AccError('Add remarks explaining the resolution.');
      if (!/^[a-z_]{3,40}$/.test(flag_type || '') || !/^[a-z_]{3,20}$/.test(entity_type || '')) throw new AccError('Unknown discrepancy.');
      db.prepare(`INSERT INTO acc_discrepancy_resolutions (flag_type, entity_type, entity_id, remarks, resolved_by) VALUES (?,?,?,?,?)
        ON CONFLICT(flag_type, entity_type, entity_id) DO UPDATE SET remarks=excluded.remarks, resolved_by=excluded.resolved_by, resolved_at=CURRENT_TIMESTAMP`)
        .run(flag_type, entity_type, Number(entity_id), text(remarks), actor.id);
      audit(actor, 'discrepancy_resolved', 'acc_' + entity_type, entity_id, { flag_type, remarks: text(remarks) });
    });
  }

  function saveSettings(actor, body) {
    if (actor?.role !== 'admin') throw new AccError('Only admin can change accounts settings.', 403);
    const fields = {
      acc_receipt_prefix: v => /^[A-Z0-9/\-]{1,20}$/i.test(v) ? v.toUpperCase() : null,
      acc_cancel_prefix: v => /^[A-Z0-9/\-]{1,20}$/i.test(v) ? v.toUpperCase() : null,
      acc_cancel_needs_approval: v => (v === '1' ? '1' : '0'),
      acc_challan_invoice_days: v => (/^\d{1,3}$/.test(v) ? v : null),
      acc_default_due_days: v => (/^\d{1,3}$/.test(v) ? v : null),
      acc_max_upload_mb: v => (/^\d{1,2}$/.test(v) && +v >= 1 && +v <= 15 ? v : null),
      acc_branches: v => v.split(',').map(x => x.trim()).filter(Boolean).slice(0, 30).join(', ') || null,
    };
    tx(() => {
      const cur = settings(), before = {}, after = {};
      for (const [k, norm] of Object.entries(fields)) {
        const raw = k === 'acc_cancel_needs_approval' ? (body[k] ? '1' : '0') : String(body[k] ?? '').trim();
        if (raw === '' && k !== 'acc_cancel_needs_approval') continue;
        const v = norm(raw);
        if (v == null) throw new AccError(`Invalid value for ${k.replace('acc_', '').replace(/_/g, ' ')}.`);
        if (cur[k] !== v) { before[k] = cur[k]; after[k] = v; db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(k, v); }
      }
      if (Object.keys(after).length) audit(actor, 'accounts_settings_changed', 'acc_settings', '', { before, after });
    });
  }

  return {
    db, tx, can, canSeeAll, canViewCustomer, need, audit, settings, invoiceAvailable,
    createChallan, cancelChallan,
    createInvoiceDraft, confirmInvoice, discardDraft, updateInvoice, replaceInvoiceFile, verifyInvoice, cancelInvoice,
    recordPayment, allocate, reverseAllocation, updatePaymentReference, updateCheque, verifyPayment,
    requestReceiptCancellation, decideCancellation, requestAdjustment, decideAdjustment,
    resolveDiscrepancy, saveSettings,
  };
}

module.exports = { createAccounts, AccError, toPaise, rupees, inr, fyOf, todayIST, isDate, MODES, PURPOSES, DOC_TYPES, RECEIVABLE };
