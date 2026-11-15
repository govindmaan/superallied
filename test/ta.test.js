// Travelling allowance: rate by vehicle + department, yesterday's end km is today's
// start km, HoF / admin km corrections, and the Mon–Sat week that closes on Sunday
// 10:00 with automatic claims, a weekly report and a weekly approval.
process.env.TA_AUTO_START = '2026-11-01';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const ta = require('../lib/ta');
const att = require('../lib/attendance');
const te = require('../routes/travel-expenses');

const mk = (username, role, dept) => Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,department) VALUES (?,'x',?,?,?)").run(username, username, role, dept).lastInsertRowid);
const salesP = mk('ta_sales', 'sales', 'Sales');
const svcP = mk('ta_svc', 'service', 'Service');
const opsP = mk('ta_ops', 'employee', 'Operations');
const hof = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,position_code) VALUES ('ta_hof','x','TA HoF','head_of_finance','head_finance')").run().lastInsertRowid);
const day = (uid, date) => db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);

test('rate follows the vehicle and the department', () => {
  assert.equal(ta.rateOfUser(salesP), 3);
  assert.equal(ta.rateOfUser(svcP), 2.5);
  db.prepare("UPDATE users SET vehicle_type='Own Four Wheeler' WHERE id=?").run(svcP);
  assert.equal(ta.rateOfUser(svcP), 5);
  db.prepare("UPDATE users SET vehicle_type='' WHERE id=?").run(svcP);
  assert.equal(ta.vehicleOf(svcP), 'Own Two Wheeler');     // not set → two-wheeler
  assert.equal(ta.rateOfUser(opsP), 3);                     // other departments: by vehicle only
});

test('the week is Monday–Saturday and closes on Sunday 10:00 India time', () => {
  const w = te.weekOf('2026-11-18');                        // Wednesday
  assert.equal(w.end, '2026-11-21');
  assert.equal(w.lockAt.toISOString(), new Date('2026-11-22T10:00:00+05:30').toISOString());
  assert.equal(te.weekOf('2026-11-22').end, '2026-11-28'); // a Sunday belongs to the next week
});

test("yesterday's end km is today's start km; a day left open is closed by the next start", () => {
  att.saveJourneyStart(salesP, '2026-11-02', { km: 1000, photo: '/uploads/j/a.jpg' });
  att.saveJourneyEnd(salesP, '2026-11-02', { km: 1040, photo: '/uploads/j/b.jpg' });
  assert.deepEqual(ta.lastKm(salesP, '2026-11-03'), { date: '2026-11-02', km: 1040, closed: true });

  // 3 Nov: checked in, forgot to check out
  att.saveJourneyStart(salesP, '2026-11-03', { km: 1040, photo: '/uploads/j/c.jpg' });
  // 4 Nov: start reading closes 3 Nov
  att.saveJourneyStart(salesP, '2026-11-04', { km: 1100, photo: '/uploads/j/d.jpg' });
  const d3 = day(salesP, '2026-11-03');
  assert.equal(d3.end_km, 1100);
  assert.equal(d3.total_km, 60);
  assert.equal(d3.end_auto, 1);
});

test('a check-out with no start reading starts from the last reading, never from 0', () => {
  att.saveJourneyEnd(salesP, '2026-11-05', { km: 1180, photo: '/uploads/j/e.jpg' });   // 4 Nov never closed → it is the last reading
  const d5 = day(salesP, '2026-11-05');
  assert.equal(d5.start_km, 1100);
  assert.equal(d5.total_km, 80);
});

test('Head of Finance / admin correct km: needs a reason, updates the day', () => {
  assert.match(ta.editKm(salesP, '2026-11-04', { start_km: 1100, end_km: 1150, note: '' }, hof).message, /reason/);
  assert.match(ta.editKm(salesP, '2026-11-04', { start_km: 1100, end_km: 1090, note: 'x' }, hof).message, /less than/);
  assert.equal(ta.editKm(salesP, '2026-11-04', { start_km: 1100, end_km: 1150, note: 'Photo shows 1150' }, hof).ok, true);
  const d4 = day(salesP, '2026-11-04');
  assert.equal(d4.total_km, 50);
  assert.equal(d4.edited_by, hof);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Km corrected'").get(salesP));
});

test('Sunday 10:00: days with meter km become claims, one bill per person, report to all', () => {
  db.prepare('DELETE FROM notifications').run();
  te.closeLockedWeeks();
  const claims = db.prepare("SELECT date, distance_km, rate_per_km, total_claim, status, auto FROM travel_expenses WHERE user_id=? ORDER BY date").all(salesP);
  assert.deepEqual(claims.map(c => [c.date, c.distance_km, c.total_claim, c.status, c.auto]), [
    ['2026-11-02', 40, 120, 'submitted', 1],
    ['2026-11-03', 60, 180, 'submitted', 1],
    ['2026-11-04', 50, 150, 'submitted', 1],
    ['2026-11-05', 80, 240, 'submitted', 1],
  ]);
  const bill = db.prepare('SELECT * FROM ta_bills WHERE user_id=?').get(salesP);
  assert.equal(bill.status, 'pending');
  assert.equal(bill.total_km, 230);
  assert.equal(bill.total_amount, 690);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Weekly travel report'").get(salesP));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Weekly travel report' AND body LIKE '%1 people%'").get(hof));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Weekly travel report'").get(users.admin.id));
  // running again changes nothing
  te.closeLockedWeeks();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM travel_expenses WHERE user_id=?').get(salesP).c, 4);
});

test('a km correction after the close recalculates the claim and the weekly bill', () => {
  assert.equal(ta.editKm(salesP, '2026-11-05', { start_km: 1150, end_km: 1180, note: 'Start is the corrected 4 Nov end' }, hof).ok, true);
  const c = db.prepare("SELECT distance_km, total_claim FROM travel_expenses WHERE user_id=? AND date='2026-11-05'").get(salesP);
  assert.deepEqual({ ...c }, { distance_km: 30, total_claim: 90 });
  assert.equal(db.prepare('SELECT total_amount FROM ta_bills WHERE user_id=?').get(salesP).total_amount, 540);
});

// ── Weekly approval through the route ─────────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(uid);
  const perms = dbmod.getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/travel-expenses', te);
let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });
const post = (u, who, body) => fetch(base + u, { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const get = (u, who) => fetch(base + u, { redirect: 'manual', headers: { 'x-user': who } });

test('the weekly report page shows each day, with flags for the Head of Finance', async () => {
  const bill = db.prepare('SELECT id FROM ta_bills WHERE user_id=?').get(salesP);
  const html = await (await get(`/travel-expenses/bills/${bill.id}`, hof)).text();
  assert.match(html, /Approve week/);
  assert.match(html, /End km from next day/);
  assert.match(html, /Km corrected/);
  assert.match(html, /Added from meter/);
  // the employee sees their report but cannot approve it
  const own = await (await get(`/travel-expenses/bills/${bill.id}`, salesP)).text();
  assert.ok(!own.includes('Approve week'));
});

test('only HoF / admin decide the week; rejecting needs a reason; approving approves every day', async () => {
  const bill = db.prepare('SELECT id FROM ta_bills WHERE user_id=?').get(salesP);
  await post(`/travel-expenses/bills/${bill.id}/decide`, salesP, { action: 'approve' });
  assert.equal(db.prepare('SELECT status FROM ta_bills WHERE id=?').get(bill.id).status, 'pending');
  await post(`/travel-expenses/bills/${bill.id}/decide`, hof, { action: 'reject', note: '' });
  assert.equal(db.prepare('SELECT status FROM ta_bills WHERE id=?').get(bill.id).status, 'pending');
  await post(`/travel-expenses/bills/${bill.id}/decide`, hof, { action: 'approve', note: 'OK' });
  assert.equal(db.prepare('SELECT status FROM ta_bills WHERE id=?').get(bill.id).status, 'approved');
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM travel_expenses WHERE user_id=?').all(salesP).map(r => r.status), ['approved']);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Weekly travel approved'").get(salesP));
  // an approved week's km can no longer be changed
  assert.match(ta.editKm(salesP, '2026-11-05', { start_km: 1150, end_km: 1200, note: 'late fix' }, hof).message, /already approved/);
});

test('the claim form is filled in from the meter and the profile vehicle', async () => {
  att.saveJourneyStart(svcP, T.today, { km: 500, photo: '/uploads/j/s.jpg' });
  att.saveJourneyEnd(svcP, T.today, { km: 535, photo: '/uploads/j/t.jpg' });
  const html = await (await get('/travel-expenses/new?date=' + T.today, svcP)).text();
  assert.match(html, /name="start_odo"[^>]*value="500"/);
  assert.match(html, /name="end_odo"[^>]*value="535"/);
  assert.match(html, /data-rate="2.5"/);
});

// ── Correct KM page: many days, by employee or by day ─────────────────────────
test('Correct KM: one employee\'s week and everyone on a day; approved days are locked', async () => {
  // week of 8–14 Nov for the service person (not approved)
  att.saveJourneyStart(svcP, '2026-11-09', { km: 300, photo: '/uploads/j/1.jpg' });
  att.saveJourneyEnd(svcP, '2026-11-09', { km: 330, photo: '/uploads/j/2.jpg' });
  att.saveJourneyStart(svcP, '2026-11-10', { km: 330, photo: '/uploads/j/3.jpg' });
  att.saveJourneyEnd(svcP, '2026-11-10', { km: 3600, photo: '/uploads/j/4.jpg' });   // typo: 3600 for 360
  let html = await (await get(`/travel-expenses/km-grid?mode=employee&user=${svcP}&week=2026-11-10`, hof)).text();
  assert.match(html, /name="end_km"[^>]*value="3600"/);
  html = await (await get('/travel-expenses/km-grid?mode=day&date=2026-11-04', hof)).text();
  assert.match(html, /ta_sales/);
  assert.match(html, /bi-lock-fill/);                  // the sales week (1–7 Nov) is approved
  assert.equal((await get('/travel-expenses/km-grid', salesP)).status, 302);
});

test('Correct KM: saves only changed rows, needs a reason, reports rows it could not save', async () => {
  const row = (date, s, e, os, oe) => ({ uid: svcP, date, start_km: s, end_km: e, orig_start: os, orig_end: oe });
  const form = (rows, note) => {
    const p = new URLSearchParams();
    rows.forEach(r => Object.entries(r).forEach(([k, v]) => p.append(k, v)));
    p.append('note', note); p.append('back', '/travel-expenses/km-grid?mode=employee');
    return fetch(base + '/travel-expenses/km-grid', { method: 'POST', redirect: 'manual', headers: { 'x-user': hof, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p });
  };
  // no reason → nothing saved
  await form([row('2026-11-10', '330', '360', '330', '3600')], '');
  assert.equal(day(svcP, '2026-11-10').end_km, 3600);
  // with a reason: the changed row is saved, the unchanged one is left alone
  const before9 = day(svcP, '2026-11-09');
  const r = await form([row('2026-11-09', '300', '330', '300', '330'), row('2026-11-10', '330', '360', '330', '3600')], 'Typed an extra zero');
  assert.equal(r.status, 302);
  assert.equal(day(svcP, '2026-11-10').total_km, 30);
  assert.equal(day(svcP, '2026-11-10').edit_note, 'Typed an extra zero');
  assert.equal(day(svcP, '2026-11-09').edited_by, before9.edited_by);
  // end below start is refused for that row only
  await form([row('2026-11-09', '300', '250', '300', '330')], 'oops');
  assert.equal(day(svcP, '2026-11-09').end_km, 330);
});

test('a correction on a closed week adds the missing claim to the weekly bill', async () => {
  // service person: 9 and 10 Nov are in the closed week of 8–14 Nov (from TA_AUTO_START); the close already ran
  te.closeLockedWeeks();
  const bill = () => db.prepare("SELECT * FROM ta_bills WHERE user_id=? AND week_start='2026-11-08'").get(svcP);
  const before = bill();
  assert.ok(before, 'bill exists');
  // 12 Nov had nothing: HoF enters the readings
  const p = new URLSearchParams({ uid: svcP, date: '2026-11-12', start_km: '360', end_km: '400', orig_start: '', orig_end: '', note: 'Readings from photo on WhatsApp' });
  await fetch(base + '/travel-expenses/km-grid', { method: 'POST', redirect: 'manual', headers: { 'x-user': hof, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p });
  const c = db.prepare("SELECT distance_km, rate_per_km, total_claim, auto FROM travel_expenses WHERE user_id=? AND date='2026-11-12'").get(svcP);
  assert.deepEqual({ ...c }, { distance_km: 40, rate_per_km: 2.5, total_claim: 100, auto: 1 });
  assert.equal(bill().total_amount, before.total_amount + 100);
});
