// Spare quotation → Head of Operations approval → delivery challan (locked,
// never deleted) → accountant invoice + store dispatch slip (no prices, stock out).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getPositionPermissions } = dbmod;

const place = (username, position, role) => Number(db.prepare(
  "INSERT INTO users (username,password_hash,full_name,role,position_code,department) VALUES (?,?,?,?,?,(SELECT section FROM org_positions WHERE code=?))")
  .run(username, 'x', username, role, position, position).lastInsertRowid);
const coord   = place('coord', 'service_coordinator', 'service_coordinator');
const headOps = place('gm', 'head_ops', 'manager');
const rsm     = place('rsm1', 'rsm', 'manager');                  // a manager, but not the spares approver
const store   = place('store1', 'store_parts_exec', 'office');
const acct    = place('acct1', 'accountant', 'accountant');

// Stock: part A tracked with 1 in stock, part B in the master but not tracked
const partA = Number(db.prepare("INSERT INTO spare_parts (sap_part_no, material_description) VALUES ('PA-100','Hydraulic Filter')").run().lastInsertRowid);
db.prepare("INSERT INTO spare_parts (sap_part_no, material_description) VALUES ('PB-200','Seal Kit')").run();
db.prepare('INSERT INTO stock_availability (part_id, stock_quantity) VALUES (?, 1)').run(partA);
const stockA = () => db.prepare('SELECT stock_quantity FROM stock_availability WHERE part_id=?').get(partA).stock_quantity;

const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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
app.use('/spare-quotations', (req, res, next) => res.locals.hasPerm('spare_quotations') ? next() : res.redirect('/'), require('../routes/spare-quotations'));
app.use('/challans', require('../routes/challans'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const post = (u, who, body = {}) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const get = (u, who) => fetch(base + u, { redirect: 'manual', headers: { 'x-user': who } });
const notes = (uid) => db.prepare('SELECT title FROM notifications WHERE user_id=? ORDER BY id').all(uid).map(n => n.title);

let qid, cid;
test('Service Coordinator is in Operations and can make spare quotations', async () => {
  const pos = db.prepare("SELECT section, parent_code FROM org_positions WHERE code='service_coordinator'").get();
  assert.deepEqual({ ...pos }, { section: 'Operations', parent_code: 'logistics_parts_mgr' });
  const p = getPositionPermissions('service_coordinator');
  assert.ok(p.includes('spare_quotations') && p.includes('service_complaints'));

  const items = [
    { part_no: 'PA-100', description: 'Hydraulic Filter', qty: 2, basic_rate: 1000, line_basic: 2000, tax_rate: 18, tax_amount: 360, line_total: 2360 },
    { part_no: 'PB-200', description: 'Seal Kit', qty: 1, basic_rate: 500, line_basic: 500, tax_rate: 18, tax_amount: 90, line_total: 590 },
  ];
  await post('/spare-quotations', coord, { customer_name: 'Ram Singh', customer_address: 'Baghpat', items_json: JSON.stringify(items) });
  qid = db.prepare('SELECT id FROM spare_quotations ORDER BY id DESC LIMIT 1').get().id;
});

test('approval goes to the Head of Operations; another manager cannot approve', async () => {
  await post(`/spare-quotations/${qid}/submit-approval`, coord);
  assert.deepEqual(notes(headOps), ['Spare quotation to approve']);
  assert.equal((await post(`/spare-quotations/${qid}/approve`, rsm, { action: 'approve' })).status, 403);
  await post(`/spare-quotations/${qid}/approve`, headOps, { action: 'approve' });
  assert.equal(db.prepare('SELECT approval_status FROM spare_quotations WHERE id=?').get(qid).approval_status, 'approved');
});

test('an approved quotation cannot be edited or deleted', async () => {
  await post(`/spare-quotations/${qid}/update`, coord, { customer_name: 'Changed', items_json: '[]' });
  await post(`/spare-quotations/${qid}/delete`, coord);
  const q = db.prepare('SELECT customer_name FROM spare_quotations WHERE id=?').get(qid);
  assert.equal(q.customer_name, 'Ram Singh');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spare_quotation_items WHERE quotation_id=?').get(qid).c, 2);
});

test('converting needs the popup confirmation, then notifies accounts and store', async () => {
  await post(`/spare-quotations/${qid}/challan`, coord, {});
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spare_challans').get().c, 0);
  const r = await post(`/spare-quotations/${qid}/challan`, coord, { confirm: 'yes', remarks: 'Urgent' });
  const c = db.prepare('SELECT * FROM spare_challans').get();
  cid = c.id;
  assert.match(c.challan_no, /^DC-\d\d-\d\d\/0001$/);
  assert.equal(r.headers.get('location'), `/challans/${cid}`);
  assert.equal(db.prepare('SELECT status FROM spare_quotations WHERE id=?').get(qid).status, 'confirmed');
  assert.deepEqual(notes(acct), ['Delivery challan to invoice']);
  assert.deepEqual(notes(store), ['Dispatch slip: parts to send']);
  // only one live challan per quotation
  await post(`/spare-quotations/${qid}/challan`, coord, { confirm: 'yes' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spare_challans').get().c, 1);
});

test('dispatch slip shows quantities, never prices', async () => {
  const html = await (await get(`/challans/${cid}/slip`, store)).text();
  assert.match(html, /Hydraulic Filter/);
  assert.doesNotMatch(html, /₹|1,000|2,360|2,950/);
  // the accountant's challan has the agreed price
  const ch = await (await get(`/challans/${cid}`, acct)).text();
  assert.match(ch, /2,950/);
});

test('dispatch is blocked when tracked stock is short, then takes stock out', async () => {
  await post(`/challans/${cid}/dispatch`, store);
  assert.equal(db.prepare('SELECT dispatched_at FROM spare_challans WHERE id=?').get(cid).dispatched_at, null);
  db.prepare('UPDATE stock_availability SET stock_quantity=5 WHERE part_id=?').run(partA);
  assert.equal((await post(`/challans/${cid}/dispatch`, acct)).status, 403);   // accounts cannot dispatch
  await post(`/challans/${cid}/dispatch`, store, { dispatch_notes: 'UP15 AB 1234' });
  assert.ok(db.prepare('SELECT dispatched_at FROM spare_challans WHERE id=?').get(cid).dispatched_at);
  assert.equal(stockA(), 3);                                                  // 5 − 2; untracked PB-200 ignored
  assert.deepEqual(notes(coord).slice(-1), ['Parts dispatched']);
});

test('accountant enters the Tally invoice; store cannot', async () => {
  assert.equal((await post(`/challans/${cid}/invoice`, store, { invoice_no: 'X' })).status, 403);
  await post(`/challans/${cid}/invoice`, acct, { invoice_no: 'SA/1234', invoice_date: '2026-11-16' });
  assert.equal(db.prepare('SELECT invoice_no FROM spare_challans WHERE id=?').get(cid).invoice_no, 'SA/1234');
});

test('a challan is never deleted: only admin cancels, and stock comes back', async () => {
  assert.equal((await post(`/challans/${cid}/cancel`, headOps, { reason: 'x' })).status, 403);
  await post(`/challans/${cid}/cancel`, users.admin.id, { reason: 'Customer refused' });
  const c = db.prepare('SELECT status, cancel_reason FROM spare_challans WHERE id=?').get(cid);
  assert.deepEqual({ ...c }, { status: 'cancelled', cancel_reason: 'Customer refused' });
  assert.equal(stockA(), 5);
  await post(`/spare-quotations/${qid}/delete`, users.admin.id);
  assert.ok(db.prepare('SELECT id FROM spare_quotations WHERE id=?').get(qid));
  assert.ok(db.prepare('SELECT id FROM spare_challans WHERE id=?').get(cid));
});
