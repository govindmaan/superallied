// HTTP checks for /accounts: server-side permissions (scenario H) and CSRF, through the real router.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, customer, invoice, today, acc } = T;

// Minimal app around the router: the test picks the logged-in user with a header
const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = sessions[uid] ||= { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role, databank_access FROM users WHERE id=?').get(uid);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path, hasPerm: () => false, dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/accounts', require('../routes/accounts'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const get = (u, who) => fetch(base + u, { headers: { 'x-user': who.id }, redirect: 'manual' });
async function csrfFor(who) { await get('/accounts/customers', who); return sessions[who.id].accCsrf; }
const post = async (u, who, body, token) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token ?? await csrfFor(who), ...body }) });

test('H (HTTP) — salesperson cannot edit a verified invoice or cancel a receipt', async () => {
  const c = customer('Sales-owned', { created_by: users.sales.id });
  const i = invoice(c, 200000);
  acc.verifyInvoice(users.manager, i.id);
  const { receipt } = acc.recordPayment(users.accountant, { customer_id: c, purpose: 'on_account', amount: '1000', payment_date: today, mode: 'cash' });

  const edit = await post(`/accounts/invoices/${i.id}`, users.sales, { total_amount: '1', change_reason: 'attempted change' });
  const cancel = await post(`/accounts/receipts/${receipt.id}/cancel`, users.sales, { reason: 'attempted cancel' });
  const record = await post('/accounts/receipts', users.sales, { customer_id: c, purpose: 'on_account', amount: '5', payment_date: today, mode: 'cash' });
  for (const r of [edit, cancel, record]) assert.ok([302, 403].includes(r.status), String(r.status));
  assert.equal(db.prepare('SELECT total_amount FROM acc_invoices WHERE id=?').get(i.id).total_amount, 20000000);
  assert.equal(db.prepare('SELECT status FROM acc_receipts WHERE id=?').get(receipt.id).status, 'issued');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_payments WHERE customer_id=?').get(c).n, 1);

  // Read access is limited to their own customers
  assert.equal((await get(`/accounts/invoices/${i.id}`, users.sales)).status, 200);
  const other = invoice(customer('Not theirs'), 1000);
  assert.equal((await get(`/accounts/invoices/${other.id}`, users.sales)).status, 302);
  assert.equal((await get(`/accounts/invoices/${other.id}/file/1`, users.sales)).status, 404);
  assert.equal((await get('/accounts/reports/customer-outstanding?format=csv', users.sales)).status, 302);
});

test('POST without the CSRF token is refused', async () => {
  const c = customer();
  const r = await post('/accounts/receipts', users.accountant, { customer_id: c, purpose: 'on_account', amount: '5', payment_date: today, mode: 'cash' }, 'wrong-token');
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_payments WHERE customer_id=?').get(c).n, 0);
  const ok = await post('/accounts/receipts', users.accountant, { customer_id: c, purpose: 'on_account', amount: '5', payment_date: today, mode: 'cash' });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location'), /^\/accounts\/receipts\/\d+$/);
});

test('report export matches the on-screen rows', async () => {
  const c = customer('Export Co');
  invoice(c, 123456);
  const csv = await (await get(`/accounts/reports/invoice-outstanding?customer_id=${c}&format=csv`, users.accountant)).text();
  const html = await (await get(`/accounts/reports/invoice-outstanding?customer_id=${c}`, users.accountant)).text();
  assert.match(csv, /123456/);
  assert.equal(csv.trim().split('\r\n').length, 3);          // header, one invoice, total
  assert.match(html, /1,23,456\.00/);
});
