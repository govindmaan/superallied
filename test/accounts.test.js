// Accounts module acceptance scenarios A–I (see docs/ACCOUNTS.md).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, acc, qr, users, customer, quotation, invoice, today } = T;
const L = (n) => n * 100;            // rupees → paise
const inv = (id) => db.prepare('SELECT * FROM acc_invoices WHERE id=?').get(id);
const pay = (id) => db.prepare('SELECT * FROM acc_payments WHERE id=?').get(id);

test('A — advance against a quotation stays an advance', () => {
  const c = customer();
  const q = quotation(c);
  assert.equal(qr.quotationFinancials(q).value, L(500000));
  const { payment, receipt } = acc.recordPayment(users.accountant, {
    customer_id: c, purpose: 'quotation_advance', quotation_id: q, amount: '1,00,000', payment_date: today, mode: 'neft', reference: 'UTR123' });
  assert.match(receipt.receipt_number, /^SA\/RCT\/\d{2}-\d{2}\/\d{4}$/);
  const fin = qr.quotationFinancials(q);
  assert.equal(fin.advance, L(100000));
  assert.equal(fin.remaining, L(400000));
  // Not an invoice payment: no allocation, whole amount is unallocated advance
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_allocations WHERE payment_id=?').get(payment.id).n, 0);
  assert.equal(pay(payment.id).unallocated_amount, L(100000));
  assert.equal(qr.customerAccount(c).summary.outstanding, 0);
  // and it cannot be allocated to an invoice while recording the advance
  assert.throws(() => acc.recordPayment(users.accountant, { customer_id: c, purpose: 'quotation_advance', quotation_id: q,
    amount: '1000', payment_date: today, mode: 'cash', allocations: [{ invoice_id: 1, amount: '1000' }] }), /stays unallocated/);
});

test('B — invoice with partial payment', () => {
  const c = customer();
  const i = invoice(c, 1000000);
  const { payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '300000',
    payment_date: today, mode: 'rtgs', reference: 'R1', allocations: [{ invoice_id: i.id, amount: '300000' }] });
  assert.equal(inv(i.id).balance_amount, L(700000));
  assert.equal(inv(i.id).payment_status, 'partial');
  assert.equal(pay(payment.id).unallocated_amount, 0);
});

test('C — full payment in two instalments (₹4,00,000 + ₹6,00,000)', () => {
  // The brief lists ₹40,00,000 + ₹60,00,000 against a ₹10,00,000 invoice; that is a typo (it would overpay 10×).
  const c = customer();
  const i = invoice(c, 1000000);
  const r1 = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '400000', payment_date: today, mode: 'neft', reference: 'U1', allocations: [{ invoice_id: i.id, amount: '400000' }] });
  const r2 = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '600000', payment_date: today, mode: 'neft', reference: 'U2', allocations: [{ invoice_id: i.id, amount: '600000' }] });
  assert.equal(inv(i.id).balance_amount, 0);
  assert.equal(inv(i.id).payment_status, 'paid');
  assert.equal(qr.invoiceStatus(inv(i.id)).label, 'Paid');
  for (const r of [r1, r2]) assert.equal(db.prepare('SELECT status FROM acc_receipts WHERE id=?').get(r.receipt.id).status, 'issued');
  // and an extra rupee is refused
  assert.throws(() => acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '1', payment_date: today,
    mode: 'cash', allocations: [{ invoice_id: i.id, amount: '1' }] }), /Only ₹0.00 is open/);
});

test('D — advance allocated to a new invoice is not counted twice', () => {
  const c = customer();
  const { payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'on_account', amount: '200000', payment_date: today, mode: 'upi', reference: 'UPI9' });
  const i = invoice(c, 800000);
  assert.equal(qr.customerAccount(c).summary.unallocated, L(200000));
  acc.allocate(users.accountant, { payment_id: payment.id, lines: [{ invoice_id: i.id, amount: '200000' }] });
  assert.equal(inv(i.id).balance_amount, L(600000));
  const s = qr.customerAccount(c).summary;
  assert.equal(s.outstanding, L(600000));
  assert.equal(s.unallocated, 0);
  assert.equal(qr.ledger(c).closing, L(600000));       // ₹8L debit − ₹2L credit
  assert.throws(() => acc.allocate(users.accountant, { payment_id: payment.id, lines: [{ invoice_id: i.id, amount: '1' }] }), /unallocated/);
});

test('E — one payment across two invoices', () => {
  const c = customer();
  const i1 = invoice(c, 300000), i2 = invoice(c, 500000);
  const { payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '600000', payment_date: today,
    mode: 'neft', reference: 'U5', allocations: [{ invoice_id: i1.id, amount: '300000' }, { invoice_id: i2.id, amount: '250000' }] });
  assert.equal(inv(i1.id).balance_amount, 0);
  assert.equal(inv(i2.id).balance_amount, L(250000));
  const p = pay(payment.id);
  assert.equal(p.allocated_amount, L(550000));
  assert.equal(p.unallocated_amount, L(50000));
  assert.equal(db.prepare("SELECT SUM(amount) AS s FROM acc_allocations WHERE payment_id=? AND status='active'").get(p.id).s, L(550000));
  // Allocation over the payment amount is refused, and nothing is half-saved
  const c2 = customer(); const j = invoice(c2, 100000);
  assert.throws(() => acc.recordPayment(users.accountant, { customer_id: c2, purpose: 'invoice_payment', amount: '50000', payment_date: today,
    mode: 'cash', allocations: [{ invoice_id: j.id, amount: '60000' }] }), /unallocated/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_payments WHERE customer_id=?').get(c2).n, 0);
});

test('F — duplicate Tally invoice number is refused with a clear message', () => {
  const c = customer();
  invoice(c, 100000, { number: 'SA/26-27/0042' });
  assert.throws(() => invoice(c, 100000, { number: 'sa/26-27/0042' }), (e) => e.status === 409 && /already in the system/.test(e.message));
  // A different financial year, or a credit note with the same number, is a different document
  assert.ok(invoice(c, 100000, { number: 'SA/26-27/0042', date: '2026-03-15', due: '2026-04-15' }).id);
});

test('G — receipt cancellation reverses allocations and keeps history', () => {
  const c = customer();
  const i = invoice(c, 500000);
  const { receipt, payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '200000',
    payment_date: today, mode: 'cash', allocations: [{ invoice_id: i.id, amount: '200000' }] });
  assert.equal(inv(i.id).balance_amount, L(300000));
  assert.throws(() => acc.requestReceiptCancellation(users.accountant, receipt.id, 'no'), /reason/);
  const r = acc.requestReceiptCancellation(users.accountant, receipt.id, 'Entered against wrong customer');
  assert.equal(r.executed, false);                                   // accountant needs manager approval
  assert.equal(inv(i.id).balance_amount, L(300000));
  acc.decideCancellation(users.manager, r.request.id, true, 'ok');
  assert.equal(inv(i.id).balance_amount, L(500000));
  assert.equal(inv(i.id).payment_status, 'unpaid');
  assert.equal(pay(payment.id).status, 'cancelled');
  const rc = db.prepare('SELECT * FROM acc_receipts WHERE id=?').get(receipt.id);
  assert.equal(rc.status, 'cancelled');                              // still there, not deleted
  assert.match(db.prepare('SELECT cancellation_number FROM acc_cancellations WHERE id=?').get(r.request.id).cancellation_number, /^SA\/RCN\//);
  assert.equal(db.prepare("SELECT status FROM acc_allocations WHERE payment_id=?").get(payment.id).status, 'reversed');
  const actions = db.prepare("SELECT action FROM audit_log WHERE entity IN ('acc_receipt','acc_allocation')").all().map(a => a.action);
  ['receipt_created', 'receipt_cancel_requested', 'allocation_reversed', 'receipt_cancelled'].forEach(a => assert.ok(actions.includes(a), a));
  const led = qr.ledger(c);
  assert.equal(led.closing, L(500000));
  assert.deepEqual(led.rows.map(x => x.description.split(' —')[0]), ['Tally tax invoice', 'Receipt', 'Receipt cancelled']);
});

test('H — salesperson cannot edit a verified invoice or cancel a receipt', () => {
  const c = customer();
  const i = invoice(c, 100000);
  acc.verifyInvoice(users.manager, i.id);
  const { receipt } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'on_account', amount: '5000', payment_date: today, mode: 'cash' });
  const deny = (fn) => assert.throws(fn, (e) => e.status === 403);
  deny(() => acc.updateInvoice(users.sales, i.id, { total_amount: '1' }, 'trying'));
  deny(() => acc.requestReceiptCancellation(users.sales, receipt.id, 'trying it'));
  deny(() => acc.recordPayment(users.sales, { customer_id: c, purpose: 'on_account', amount: '1', payment_date: today, mode: 'cash' }));
  deny(() => acc.verifyInvoice(users.accountant, i.id));
  deny(() => acc.updateInvoice(users.accountant, i.id, { remarks: 'changed' }));   // verified → manager only
  assert.equal(inv(i.id).total_amount, L(100000));
});

test('I — two threads allocating the same payment balance at once', async () => {
  const c = customer();
  const i1 = invoice(c, 500000), i2 = invoice(c, 500000);
  const { payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'on_account', amount: '300000', payment_date: today, mode: 'neft', reference: 'U9' });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const run = (invoiceId) => new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'alloc-worker.js'), { workerData: { dbPath: T.dbPath, gate: gate.buffer, actor: users.accountant,
      payment_id: payment.id, invoice_id: invoiceId, amount: '300000' } });
    w.once('message', resolve); w.once('error', reject);
  });
  const both = Promise.all([run(i1.id), run(i2.id)]);
  await new Promise(r => setTimeout(r, 300));          // let both workers reach the gate
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
  const results = await both;
  assert.equal(results.filter(r => r.ok).length, 1, JSON.stringify(results));
  assert.match(results.find(r => !r.ok).error, /unallocated/);
  const p = pay(payment.id);
  assert.equal(p.allocated_amount, L(300000));
  assert.equal(p.unallocated_amount, 0);
  assert.equal(inv(i1.id).balance_amount + inv(i2.id).balance_amount, L(700000));
});

test('double submission returns the same receipt', () => {
  const c = customer();
  const d = { customer_id: c, purpose: 'on_account', amount: '1000', payment_date: today, mode: 'cash', client_token: 'tok-1' };
  const a = acc.recordPayment(users.accountant, d), b = acc.recordPayment(users.accountant, d);
  assert.equal(a.receipt.receipt_number, b.receipt.receipt_number);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_payments WHERE customer_id=?').get(c).n, 1);
});

test('cheque: allocation waits for clearance; bounce releases it', () => {
  const c = customer();
  const i = invoice(c, 100000);
  const { payment } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'invoice_payment', amount: '100000', payment_date: today,
    mode: 'cheque', reference: '000123', allocations: [{ invoice_id: i.id, amount: '100000' }] });
  assert.equal(inv(i.id).balance_amount, L(100000));               // not treated as cash yet
  assert.equal(acc.invoiceAvailable(i.id), 0);                     // but reserved
  acc.updateCheque(users.accountant, payment.id, { status: 'deposited', event_date: today });
  acc.updateCheque(users.accountant, payment.id, { status: 'bounced', event_date: today, remarks: 'Insufficient funds' });
  assert.equal(inv(i.id).balance_amount, L(100000));
  assert.equal(acc.invoiceAvailable(i.id), L(100000));
  assert.equal(qr.customerAccount(c).summary.unallocated, 0);      // bounced money is not an advance
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acc_cancellations c JOIN acc_receipts r ON r.id=c.receipt_id WHERE r.payment_id=? AND c.status='pending'").get(payment.id).n, 1);

  const c2 = customer(); const j = invoice(c2, 50000);
  const p2 = acc.recordPayment(users.accountant, { customer_id: c2, purpose: 'invoice_payment', amount: '50000', payment_date: today,
    mode: 'cheque', reference: '000124', allocations: [{ invoice_id: j.id, amount: '50000' }] }).payment;
  acc.updateCheque(users.accountant, p2.id, { status: 'cleared', event_date: today });
  assert.equal(inv(j.id).balance_amount, 0);
});

test('credit note settles its invoice; adjustments need a second approver', () => {
  const c = customer();
  const i = invoice(c, 100000);
  const cn = acc.createInvoiceDraft(users.accountant, { doc_type: 'credit_note', invoice_number: 'CN/1', invoice_date: '2026-10-02', customer_id: c,
    against_invoice_id: i.id, basic_value: '10000', gst_amount: '1800', total_amount: '11800' }, T.file());
  acc.confirmInvoice(users.accountant, cn.id);
  assert.equal(inv(i.id).balance_amount, L(88200));
  assert.equal(inv(cn.id).payment_status, 'paid');
  const adj = acc.requestAdjustment(users.accountant, i.id, { amount: '200', adjustment_type: 'round_off', reason: 'Round-off agreed with customer' });
  assert.equal(inv(i.id).balance_amount, L(88200));
  acc.decideAdjustment(users.manager, adj, true, 'ok');
  assert.equal(inv(i.id).balance_amount, L(88000));
  const own = acc.requestAdjustment(users.manager, i.id, { amount: '1', reason: 'Testing own approval rule' });
  assert.throws(() => acc.decideAdjustment(users.manager, own, true, 'ok'), (e) => e.status === 403);
});

test('dashboard keeps quotation, challan and invoice values separate', () => {
  const d = qr.dashboard(users.admin, {});
  for (const k of ['quotationsInPeriod', 'awaitingAdvance', 'advances', 'challanValue', 'invoiceValue', 'paidAgainstInvoices', 'outstanding', 'unallocated'])
    assert.ok(k in d.k, k);
  const sum = db.prepare("SELECT SUM(balance_amount) AS s FROM acc_invoices WHERE status IN ('uploaded','verified') AND doc_type<>'credit_note'").get().s;
  assert.equal(d.k.outstanding.value, sum);
});

test('money parsing rejects floats and junk', () => {
  const { toPaise } = require('../services/accounts/engine');
  assert.equal(toPaise('1,00,000.5'), 10000050);
  assert.equal(toPaise('0.1') + toPaise('0.2'), toPaise('0.3'));
  for (const bad of ['-5', '1.234', 'abc', '', '0']) assert.throws(() => toPaise(bad));
});
