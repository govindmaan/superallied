// Salesperson "My Leads": scope, mark-contacted, meeting/demo, status, remark,
// reassignment request, through the real /my-leads router. Append-only history.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;

const sp = users.sales;                      // role 'sales'
const sp2 = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES ('ravi2','x','Ravi Two','sales')").run().lastInsertRowid);

function mkLead(assignedTo, fields = {}) {
  const num = 'ENQ-T-' + Math.random().toString(36).slice(2, 7);
  const id = Number(db.prepare(`INSERT INTO enquiries (enquiry_number,customer_name,phone,district,machine_interested,
    interest_class,purchase_timeline,telecaller_id,assigned_to,current_stage,status,qualified_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'phone_followup','active',CURRENT_TIMESTAMP)`)
    .run(num, fields.name || 'Sita Devi', '9876511122', 'Baghpat', 'SD76 AC Cabin', fields.ic || 'HOT', 'Within 15 days',
      users.admin.id, assignedTo).lastInsertRowid);
  return id;
}

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
  const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(uid);
  const perms = getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/my-leads', (req, res, next) => res.locals.hasPerm('enquiries') ? next() : res.redirect('/'), require('../routes/myleads'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const get = (u, who) => fetch(base + u, { headers: { 'x-user': who.id || who }, redirect: 'manual' });
const post = (u, who, body) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id || who, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('dashboard shows only the salesperson’s own leads', async () => {
  const mine = mkLead(sp.id, { name: 'My Lead' });
  mkLead(sp2, { name: 'Other Lead' });
  const html = await get('/my-leads?f=hot', sp).then(r => r.text());
  assert.match(html, /My Lead/);
  assert.doesNotMatch(html, /Other Lead/);
});

test('a salesperson cannot open a lead that is not theirs', async () => {
  const other = mkLead(sp2);
  const r = await get('/my-leads/' + other, sp);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/my-leads');
});

test('mark contacted logs a salesperson call and activity', async () => {
  const id = mkLead(sp.id);
  await post(`/my-leads/${id}/contacted`, sp, { outcome: 'Connected', notes: 'spoke, keen' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM call_logs WHERE enquiry_id=? AND call_role='salesperson'").get(id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_activity WHERE enquiry_id=? AND activity_type='CONTACTED'").get(id).c, 1);
});

test('recording a demo creates a visit and advances the stage', async () => {
  const id = mkLead(sp.id);
  await post(`/my-leads/${id}/meeting`, sp, { visit_date: '2026-11-20', visit_location: 'Baraut', demo_given: '1', outcome: 'Liked the machine', next_followup_date: '2026-11-25' });
  const v = db.prepare('SELECT * FROM enquiry_visits WHERE enquiry_id=?').get(id);
  assert.ok(v); assert.equal(v.demo_given, 1);
  assert.equal(db.prepare('SELECT current_stage FROM enquiries WHERE id=?').get(id).current_stage, 'sales_visit');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_activity WHERE enquiry_id=? AND activity_type='DEMO'").get(id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM enquiry_followups WHERE enquiry_id=?').get(id).c, 1);
});

test('marking won sets status won and closes the stage', async () => {
  const id = mkLead(sp.id);
  await post(`/my-leads/${id}/status`, sp, { status: 'won', notes: 'booked' });
  const e = db.prepare('SELECT status, current_stage FROM enquiries WHERE id=?').get(id);
  assert.equal(e.status, 'won');
  assert.equal(e.current_stage, 'sales_closed');
});

test('a remark is appended (telecaller follow-ups remain untouched)', async () => {
  const id = mkLead(sp.id);
  db.prepare("INSERT INTO enquiry_followups (enquiry_id,call_status,notes,created_by) VALUES (?,?,?,?)").run(id, 'HOT', 'telecaller note', users.admin.id);
  await post(`/my-leads/${id}/remark`, sp, { body: 'salesperson note' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM enquiry_remarks WHERE enquiry_id=?').get(id).c, 1);
  assert.equal(db.prepare("SELECT notes FROM enquiry_followups WHERE enquiry_id=?").get(id).notes, 'telecaller note');
});

test('reassignment request notifies admins and keeps the owner', async () => {
  const id = mkLead(sp.id);
  await post(`/my-leads/${id}/reassign-request`, sp, { reason: 'wrong area' });
  assert.equal(db.prepare('SELECT assigned_to FROM enquiries WHERE id=?').get(id).assigned_to, sp.id);  // unchanged
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_activity WHERE enquiry_id=? AND activity_type='REASSIGN_REQUEST'").get(id).c, 1);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=?").get(users.admin.id).c >= 1);
});

test('admin/manager can see all leads', async () => {
  const other = mkLead(sp2, { name: 'Zed Lead' });
  const r = await get('/my-leads/' + other, users.admin);
  assert.equal(r.status, 200);
});
