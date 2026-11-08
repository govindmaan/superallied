// Telecaller module: entry → call log → qualify → district routing → forward,
// through the real /telecaller router. Covers HOT validation, unassigned fallback,
// idempotent-safe forwarding and access control.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;

// A telecaller user + a salesperson who owns the Baghpat district
const tcId = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES ('tc','x','Priya Telecaller','telecaller')").run().lastInsertRowid);
const spId = users.sales.id;                 // role 'sales'
const terrId = Number(db.prepare("INSERT INTO territories (name,primary_user_id) VALUES ('Baghpat Zone',?)").run(spId).lastInsertRowid);
db.prepare("INSERT INTO territory_districts (territory_id,district) VALUES (?,?)").run(terrId, 'Baghpat');

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
  const u = db.prepare('SELECT id, username, full_name, role, databank_access FROM users WHERE id=?').get(uid);
  const perms = getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
// Mirror the server's module permission gate
app.use('/telecaller', (req, res, next) => res.locals.hasPerm('telecaller') ? next() : res.redirect('/'), require('../routes/telecaller'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const tc = { id: tcId };
const post = (u, who, body, json) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
  body: json ? JSON.stringify(body) : new URLSearchParams(body) });
const get = (u, who) => fetch(base + u, { headers: { 'x-user': who.id }, redirect: 'manual' });

async function newLead(fields = {}) {
  const r = await post('/telecaller/new', tc, { customer_name: 'Rakesh Kumar', phone: '9876500011', district: 'Baghpat', machine_interested: 'SD76 AC Cabin', ...fields });
  const id = db.prepare("SELECT id FROM enquiries WHERE phone='9876500011' ORDER BY id DESC LIMIT 1").get().id;
  return id;
}

test('entry creates an enquiry owned by the telecaller', async () => {
  const id = await newLead();
  const e = db.prepare('SELECT * FROM enquiries WHERE id=?').get(id);
  assert.equal(e.customer_name, 'Rakesh Kumar');
  assert.equal(e.telecaller_id, tcId);
  assert.equal(e.assigned_to, null);
  assert.match(e.enquiry_number, /^ENQ-/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_activity WHERE enquiry_id=? AND activity_type='ENTERED'").get(id).c, 1);
});

test('call log records a timestamped attempt and sets first_call_at', async () => {
  const id = await newLead();
  await post(`/telecaller/call/${id}/log`, tc, { outcome: 'Connected', notes: 'spoke briefly' }, true);
  const logs = db.prepare('SELECT * FROM call_logs WHERE enquiry_id=?').all(id);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].called_at);
  assert.ok(db.prepare('SELECT first_call_at FROM enquiries WHERE id=?').get(id).first_call_at);
});

test('HOT disposition routes to the district salesperson and notifies', async () => {
  const id = await newLead();
  await post(`/telecaller/call/${id}/dispose`, tc, {
    interest_class: 'HOT', machine_interested: 'SD76 AC Cabin', purchase_timeline: 'Within 15 days',
    district: 'Baghpat', finance_mode: 'Finance required', remarks: 'Wants a demo this week',
  });
  const e = db.prepare('SELECT * FROM enquiries WHERE id=?').get(id);
  assert.equal(e.interest_class, 'HOT');
  assert.equal(e.assigned_to, spId);
  assert.ok(e.qualified_at);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_activity WHERE enquiry_id=? AND activity_type='FORWARDED'").get(id).c, 1);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=?").get(spId).c >= 1);
});

test('HOT without machine/timeline/location is rejected (no assignment)', async () => {
  const id = await newLead();
  await post(`/telecaller/call/${id}/dispose`, tc, { interest_class: 'HOT', remarks: 'answered', machine_interested: '', purchase_timeline: '', district: '' });
  const e = db.prepare('SELECT * FROM enquiries WHERE id=?').get(id);
  assert.equal(e.interest_class, '');       // unchanged
  assert.equal(e.assigned_to, null);
});

test('qualified lead in an unmapped district stays unassigned', async () => {
  const id = await newLead({ district: 'Nowhere' });
  await post(`/telecaller/call/${id}/dispose`, tc, {
    interest_class: 'HOT', machine_interested: 'Challenger 55', purchase_timeline: 'Immediately', district: 'Nowhere', remarks: 'ready',
  });
  const e = db.prepare('SELECT * FROM enquiries WHERE id=?').get(id);
  assert.equal(e.interest_class, 'HOT');
  assert.equal(e.assigned_to, null);        // no territory → UNASSIGNED
});

test('NOT_INTERESTED closes the lead as lost', async () => {
  const id = await newLead();
  await post(`/telecaller/call/${id}/dispose`, tc, { interest_class: 'NOT_INTERESTED', remarks: 'bought elsewhere' });
  assert.equal(db.prepare('SELECT status FROM enquiries WHERE id=?').get(id).status, 'lost');
});

test('an already-forwarded lead is not silently re-disposed by the telecaller', async () => {
  const id = await newLead();
  await post(`/telecaller/call/${id}/dispose`, tc, { interest_class: 'HOT', machine_interested: 'SD76 AC Cabin', purchase_timeline: 'Immediately', district: 'Baghpat', remarks: 'go' });
  const before = db.prepare('SELECT assigned_to FROM enquiries WHERE id=?').get(id).assigned_to;
  await post(`/telecaller/call/${id}/dispose`, tc, { interest_class: 'COLD', remarks: 'changed mind' });
  const after = db.prepare('SELECT assigned_to, interest_class FROM enquiries WHERE id=?').get(id);
  assert.equal(after.assigned_to, before);   // still assigned, unchanged
  assert.equal(after.interest_class, 'HOT');
});

test('share-to-group builds the message with 91 unneeded (group text) and logs the share', async () => {
  const id = await newLead();
  const r = await post(`/telecaller/call/${id}/share-group`, tc, { remarks: 'demo wanted' }, true).then(x => x.json());
  assert.equal(r.ok, true);
  assert.match(r.message, /SUPER ALLIED/);
  assert.match(r.message, /Lead ID:/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_shares WHERE enquiry_id=?").get(id).c, 1);
});

test('the calling screen renders with customer, script and pitch buttons', async () => {
  const id = await newLead();
  const html = await get(`/telecaller/call/${id}`, tc).then(r => r.text());
  assert.match(html, /Rakesh Kumar/);
  assert.match(html, /Filtering Pitch/);
  assert.match(html, /wa\.me\/919876500011/);
});

test('a non-telecaller is blocked from the module', async () => {
  const r = await get('/telecaller', users.accountant);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
});
