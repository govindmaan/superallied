// Phase 1: every department can submit a travel expense; approvals route only to
// the Head of Finance (and admin); the claim is stamped with its department.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;

// Place a Head of Finance in the org position so approvals route to them.
const hof = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,position_code,department) VALUES ('hof','x','Finance Head','head_of_finance','head_finance','Support')").run().lastInsertRowid);
// A sales person with a department (org section)
db.prepare("UPDATE users SET department='Sales' WHERE id=?").run(users.sales.id);
// Complete today's day for the sales user (selfies + odometer) so the routing
// tests below aren't blocked by the sales day-gate.
const _today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
db.prepare(`INSERT OR REPLACE INTO attendance (user_id,date,check_in_time,check_in_photo,check_out_time,check_out_photo)
  VALUES (?,?, '09:00','/uploads/a/in.jpg', '18:00','/uploads/a/out.jpg')`).run(users.sales.id, _today);
db.prepare(`INSERT OR REPLACE INTO expense_journeys (user_id,date,start_km,start_photo,end_km,end_photo,total_km)
  VALUES (?,?, 1000,'/uploads/j/s.jpg', 1100,'/uploads/j/e.jpg', 100)`).run(users.sales.id, _today);

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
app.use('/travel-expenses', require('../routes/travel-expenses'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const post = (u, who, body) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id || who, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

test('a sales user can submit a claim; it is stamped with the department', async () => {
  await post('/travel-expenses/', users.sales, { date: today, travel_type: 'Own Two Wheeler', purpose: 'Field visit', start_odo: '1000', end_odo: '1040' });
  const e = db.prepare("SELECT * FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(users.sales.id);
  assert.ok(e, 'claim created');
  assert.equal(e.department, 'Sales');
  assert.equal(e.status, 'draft');
});

test('submitting routes the claim to the Head of Finance', async () => {
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(users.sales.id);
  await post(`/travel-expenses/${e.id}/submit`, users.sales, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'submitted');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=?").get(hof).c >= 1, 'HoF notified');
});

test('the Head of Finance can approve it', async () => {
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? AND status='submitted' ORDER BY id DESC LIMIT 1").get(users.sales.id);
  await post(`/travel-expenses/${e.id}/approve`, { id: hof }, { comment: 'ok' });
  const row = db.prepare('SELECT status, approved_by FROM travel_expenses WHERE id=?').get(e.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_by, hof);
});

test('a manager no longer approves expenses (routes to HoF only)', async () => {
  assert.ok(!getUserPermissions('manager').includes('expense_approval'));
  await post('/travel-expenses/', users.sales, { date: today, travel_type: 'Own Two Wheeler', purpose: 'x', start_odo: '1', end_odo: '5' });
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(users.sales.id);
  await post(`/travel-expenses/${e.id}/submit`, users.sales, {});
  const r = await post(`/travel-expenses/${e.id}/approve`, users.manager, { comment: 'nope' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'submitted');  // unchanged
});

test('an employee (operations/support) can also submit', async () => {
  const emp = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('drv','x','Driver','employee','Operations')").run().lastInsertRowid);
  assert.ok(getUserPermissions('employee').includes('expense_claim'));
  await post('/travel-expenses/', { id: emp }, { date: today, travel_type: 'Own Two Wheeler', purpose: 'delivery', start_odo: '10', end_odo: '30' });
  const e = db.prepare("SELECT department FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(emp);
  assert.equal(e.department, 'Operations');
});

test('a sales claim cannot be submitted without a complete day (selfies + odometer)', async () => {
  const s2 = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('sales2','x','Sales Two','sales','Sales')").run().lastInsertRowid);
  await post('/travel-expenses/', { id: s2 }, { date: today, travel_type: 'Own Two Wheeler', purpose: 'Field work', start_odo: '100', end_odo: '150' });
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(s2);
  await post(`/travel-expenses/${e.id}/submit`, { id: s2 }, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'draft'); // blocked, no day

  // complete today's day for this user → it submits
  db.prepare(`INSERT OR REPLACE INTO attendance (user_id,date,check_in_time,check_in_photo,check_out_time,check_out_photo)
    VALUES (?,?, '09:00','/uploads/a/in.jpg','18:00','/uploads/a/out.jpg')`).run(s2, today);
  db.prepare(`INSERT OR REPLACE INTO expense_journeys (user_id,date,start_km,start_photo,end_km,end_photo,total_km)
    VALUES (?,?, 100,'/uploads/j/s.jpg', 150,'/uploads/j/e.jpg', 50)`).run(s2, today);
  await post(`/travel-expenses/${e.id}/submit`, { id: s2 }, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'submitted');
});

test('operations claims are not day-gated (paid on every expense)', async () => {
  const ops = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('ops1','x','Runner','employee','Operations')").run().lastInsertRowid);
  await post('/travel-expenses/', { id: ops }, { date: today, travel_type: 'Own Two Wheeler', purpose: 'parts run', start_odo: '5', end_odo: '25' });
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(ops);
  await post(`/travel-expenses/${e.id}/submit`, { id: ops }, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'submitted'); // no gate
});

test('head_of_finance has a focused permission set (approval, attendance + editing it, route map)', () => {
  const p = getUserPermissions('head_of_finance').sort();
  assert.deepEqual(p, ['attendance', 'attendance_edit', 'expense_approval', 'route_map']);
  // and NOT the broad ones
  ['enquiries','quotations','customers','sold_machines','reports','expense_claim','hr_admin'].forEach(x =>
    assert.ok(!p.includes(x), 'should not have ' + x));
});
