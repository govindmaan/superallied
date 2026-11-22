// Extra expenses: staff add a cost with a receipt (photo or PDF); the Head of
// Finance approves or rejects it with a reason; the person is notified.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getPositionPermissions } = dbmod;

const mk = (username, role, position = '') => Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,position_code) VALUES (?,'x',?,?,?)")
  .run(username, username, role, position).lastInsertRowid);
const sales = mk('xe_sales', 'sales');
const hof = mk('xe_hof', 'head_of_finance', 'head_finance');

const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.locals.UPLOADS_DIR = fs.mkdtempSync(require('os').tmpdir() + '/xe-');
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = sessions[uid] ||= { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role, position_code FROM users WHERE id=?').get(uid);
  const perms = getPositionPermissions(u.position_code, u.role);
  res.locals.flash = req.session.flash || {}; delete req.session.flash;
  Object.assign(res.locals, { user: u, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/extra-expenses', require('../routes/extra-expenses'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const send = (u, who, body, json = true) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
  body: json ? JSON.stringify(body) : new URLSearchParams(body) });
const get = (u, who) => fetch(base + u, { redirect: 'manual', headers: { 'x-user': who } });
const JPG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 receipt').toString('base64');
const good = { date: T.today, amount: '240', category: 'Food', description: 'Lunch at Baghpat site', receipt: JPG };

let id;
test('a receipt is required, and the date, category and amount are checked', async () => {
  for (const [bad, msg] of [[{ receipt: '' }, /receipt/], [{ receipt: 'data:text/plain;base64,aGk=' }, /receipt/],
    [{ amount: '0' }, /amount/], [{ category: 'Holiday' }, /for/], [{ date: '2099-01-01' }, /date/],
    [{ receipt: 'data:application/pdf;base64,' + Buffer.from('not a pdf').toString('base64') }, /PDF/]]) {
    const j = await (await send('/extra-expenses', sales, { ...good, ...bad })).json();
    assert.equal(j.ok, false); assert.match(j.error, msg);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM extra_expenses').get().c, 0);
});

test('submitting saves the receipt and notifies the Head of Finance', async () => {
  const j = await (await send('/extra-expenses', sales, good)).json();
  assert.equal(j.ok, true);
  id = j.id;
  const x = db.prepare('SELECT * FROM extra_expenses WHERE id=?').get(id);
  assert.match(x.expense_no, /^XE-\d{4}-00001$/);
  assert.equal(x.status, 'submitted');
  assert.equal(x.amount, 240);
  assert.ok(fs.existsSync(path.join(app.locals.UPLOADS_DIR, x.receipt_path.replace('/uploads/', ''))));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE 'Extra expense to approve%'").get(hof));
  // a PDF receipt works too
  assert.equal((await (await send('/extra-expenses', sales, { ...good, amount: '95', category: 'Toll / Parking', receipt: PDF })).json()).ok, true);
  assert.match(db.prepare('SELECT receipt_path FROM extra_expenses ORDER BY id DESC').get().receipt_path, /\.pdf$/);
});

test('only the Head of Finance / admin approve; rejecting needs a reason', async () => {
  assert.equal((await get('/extra-expenses/queue', sales)).status, 302);
  const q = await (await get('/extra-expenses/queue', hof)).text();
  assert.match(q, /Lunch at Baghpat site/);
  await send(`/extra-expenses/${id}/decide`, sales, { action: 'approve' }, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(id).status, 'submitted');
  await send(`/extra-expenses/${id}/decide`, hof, { action: 'reject' }, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(id).status, 'submitted');
  await send(`/extra-expenses/${id}/decide`, hof, { action: 'reject', note: 'No GST bill' }, false);
  const x = db.prepare('SELECT status, decision_note, decided_by FROM extra_expenses WHERE id=?').get(id);
  assert.deepEqual({ ...x }, { status: 'rejected', decision_note: 'No GST bill', decided_by: hof });
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE 'Expense rejected%'").get(sales));
  // decided once only
  await send(`/extra-expenses/${id}/decide`, hof, { action: 'approve' }, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(id).status, 'rejected');
});

test('approve, withdraw, and nobody approves their own expense', async () => {
  const other = db.prepare("SELECT id FROM extra_expenses WHERE status='submitted'").get().id;
  await send(`/extra-expenses/${other}/decide`, hof, { action: 'approve' }, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(other).status, 'approved');
  // the person withdraws a pending one
  const j = await (await send('/extra-expenses', sales, good)).json();
  await send(`/extra-expenses/${j.id}/withdraw`, sales, {}, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(j.id).status, 'withdrawn');
  // an admin's own expense cannot be approved by themself (the Head of Finance does it)
  const own = await (await send('/extra-expenses', users.admin.id, good)).json();
  await send(`/extra-expenses/${own.id}/decide`, users.admin.id, { action: 'approve' }, false);
  assert.equal(db.prepare('SELECT status FROM extra_expenses WHERE id=?').get(own.id).status, 'submitted');
  // someone else's expense is not visible to a non-approver
  assert.equal((await get(`/extra-expenses/${own.id}`, sales)).status, 302);
});
