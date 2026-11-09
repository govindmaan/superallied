// Phase 3: machine-complaint lifecycle (open → assign → visit → close) and the
// service TA gate — service travel allowance needs a visited complaint that day.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;

const coord = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('coord','x','Service Coord','service','Service')").run().lastInsertRowid);
const eng = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('eng','x','Engineer','service','Service')").run().lastInsertRowid);
db.prepare("INSERT INTO sold_machines (machine_no, model, customer_name, mobile_1, place_of_supply, created_by) VALUES ('BE123456','SD76','Ram Singh','9876500099','Baghpat',?)").run(users.admin.id);
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.locals.UPLOADS_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/up-');
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = sessions[uid] ||= { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(uid);
  const perms = getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/complaints', (req, res, next) => res.locals.hasPerm('service_complaints') ? next() : res.redirect('/'), require('../routes/complaints'));
app.use('/travel-expenses', require('../routes/travel-expenses'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

const post = (u, who, body, json) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id || who, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
  body: json ? JSON.stringify(body) : new URLSearchParams(body) });
const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let cid;
test('a coordinator opens a complaint from a machine serial (prefilled)', async () => {
  await post('/complaints', { id: coord }, { machine_no: 'BE123456', problem: 'Hydraulic leak' });
  const c = db.prepare("SELECT * FROM complaints ORDER BY id DESC LIMIT 1").get();
  cid = c.id;
  assert.equal(c.customer_name, 'Ram Singh');   // pulled from sold_machines
  assert.equal(c.model, 'SD76');
  assert.equal(c.status, 'open');
  assert.match(c.complaint_number, /^CMP-/);
});

test('assigning notifies the engineer', async () => {
  await post(`/complaints/${cid}/assign`, { id: coord }, { assigned_to: String(eng) });
  const c = db.prepare('SELECT status, assigned_to FROM complaints WHERE id=?').get(cid);
  assert.equal(c.status, 'assigned');
  assert.equal(c.assigned_to, eng);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(eng).c >= 1);
});

test('only the assigned engineer records a visit, and a plate photo is required', async () => {
  // coordinator cannot record the engineer's visit
  await post(`/complaints/${cid}/visit`, { id: coord }, { plate_photo: px, outcome: 'x' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM complaint_visits WHERE complaint_id=?').get(cid).c, 0);
  // engineer without a photo is rejected
  await post(`/complaints/${cid}/visit`, { id: eng }, { outcome: 'no photo' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM complaint_visits WHERE complaint_id=?').get(cid).c, 0);
  // engineer with a photo succeeds → status visited
  await post(`/complaints/${cid}/visit`, { id: eng }, { plate_photo: px, outcome: 'Fixed hose' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM complaint_visits WHERE complaint_id=?').get(cid).c, 1);
  assert.equal(db.prepare('SELECT status FROM complaints WHERE id=?').get(cid).status, 'visited');
});

const completeDay = (uid) => {
  db.prepare(`INSERT OR REPLACE INTO attendance (user_id,date,check_in_time,check_in_photo,check_out_time,check_out_photo)
    VALUES (?,?, '09:00','/u/in.jpg','18:00','/u/out.jpg')`).run(uid, today);
  db.prepare(`INSERT OR REPLACE INTO expense_journeys (user_id,date,start_km,start_photo,end_km,end_photo,total_km)
    VALUES (?,?, 10,'/u/s.jpg', 60,'/u/e.jpg', 50)`).run(uid, today);
};

test('service TA is blocked without a complaint visit that day', async () => {
  // A second engineer with a complete day but NO complaint visit today
  const eng2 = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES ('eng2','x','Engineer Two','service','Service')").run().lastInsertRowid);
  completeDay(eng2);
  await post('/travel-expenses/', { id: eng2 }, { date: today, travel_type: 'Own Two Wheeler', purpose: 'service', start_odo: '10', end_odo: '60' });
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? ORDER BY id DESC LIMIT 1").get(eng2);
  await post(`/travel-expenses/${e.id}/submit`, { id: eng2 }, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'draft'); // no visit → blocked
});

test('service TA is allowed when the engineer visited a complaint that day', async () => {
  completeDay(eng);   // eng recorded a plate-photo visit on `today` in the earlier test
  await post('/travel-expenses/', { id: eng }, { date: today, travel_type: 'Own Two Wheeler', purpose: 'service call', start_odo: '10', end_odo: '60' });
  const e = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? AND date=? ORDER BY id DESC LIMIT 1").get(eng, today);
  await post(`/travel-expenses/${e.id}/submit`, { id: eng }, {});
  assert.equal(db.prepare('SELECT status FROM travel_expenses WHERE id=?').get(e.id).status, 'submitted');
});

test('closing the complaint sets it closed', async () => {
  await post(`/complaints/${cid}/close`, { id: eng }, { close_notes: 'Resolved' });
  assert.equal(db.prepare('SELECT status FROM complaints WHERE id=?').get(cid).status, 'closed');
});
