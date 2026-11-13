// Attendance rules: location required, check-out from 2 PM (India time),
// sales and service must give the odometer reading and a meter photo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, today } = T;
const rules = require('../lib/attendance');
const router = require('../routes/attendance');

const mk = (username, role) => Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'x', ?, ?)").run(username, username, role).lastInsertRowid);
const service = mk('svc1', 'service');
const office = mk('office1', 'office');
const roleOf = (id) => db.prepare('SELECT role FROM users WHERE id=?').get(id).role;

// Call a POST handler of the attendance router directly
function post(path, uid, body) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods.post);
  return new Promise((resolve) => {
    const res = { locals: { user: { id: uid, role: roleOf(uid) } }, app: { locals: { UPLOADS_DIR: '/tmp' } }, json: resolve };
    layer.route.stack[0].handle({ session: { userId: uid }, body }, res, () => {});
  });
}
const GPS = { lat: 28.98, lng: 77.70 };
const METER = { km: '12450', meter_photo: '/uploads/expenses/m.jpg' };
const ist = (hhmm) => new Date(`2026-11-11T${hhmm}:00+05:30`);

test('check-out opens at 14:00 India time', () => {
  assert.equal(rules.checkoutOpen(ist('13:59')), false);
  assert.equal(rules.checkoutOpen(ist('14:00')), true);
  assert.equal(rules.checkoutOpen(ist('18:30')), true);
});

test('sales and service need the meter; office staff do not', () => {
  assert.equal(rules.needsMeter('sales'), true);
  assert.equal(rules.needsMeter('staff'), true);
  assert.equal(rules.needsMeter('service'), true);
  assert.equal(rules.needsMeter('office'), false);
  assert.equal(rules.needsMeter('admin'), false);
});

test('location must be real coordinates', () => {
  assert.equal(rules.location(null, null), null);
  assert.equal(rules.location('', ''), null);
  assert.equal(rules.location(0, 0), null);
  assert.equal(rules.location('abc', 77), null);
  assert.deepEqual(rules.location('28.98', '77.70'), { lat: 28.98, lng: 77.7 });
});

test('check-in without location is refused', async () => {
  const r = await post('/api/checkin', office, { photo: '/uploads/attendance/a.jpg' });
  assert.equal(r.ok, false);
  assert.match(r.message, /Location is required/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM attendance WHERE user_id=?').get(office).c, 0);
});

test('office staff check in with location; meter optional', async () => {
  const r = await post('/api/checkin', office, { ...GPS, photo: '/uploads/attendance/a.jpg' });
  assert.equal(r.ok, true);
  const a = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(office, today);
  assert.equal(a.check_in_lat, 28.98);
});

test('sales / service check-in needs km and meter photo, and saves the journey', async () => {
  for (const uid of [users.sales.id, service]) {
    let r = await post('/api/checkin', uid, { ...GPS, photo: '/uploads/attendance/a.jpg' });
    assert.equal(r.ok, false);
    assert.match(r.message, /meter photo/);
    r = await post('/api/checkin', uid, { ...GPS, photo: '/uploads/attendance/a.jpg', km: '12450' });
    assert.equal(r.ok, false);
    r = await post('/api/checkin', uid, { ...GPS, photo: '/uploads/attendance/a.jpg', ...METER });
    assert.equal(r.ok, true);
    const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, today);
    assert.equal(j.start_km, 12450);
    assert.equal(j.start_photo, '/uploads/expenses/m.jpg');
  }
});

test('check-out follows the same rules (and the 2 PM lock, by the clock)', async () => {
  const open = rules.checkoutOpen();
  let r = await post('/api/checkout', users.sales.id, { ...GPS, photo: '/uploads/attendance/b.jpg' });
  assert.equal(r.ok, false);
  assert.match(r.message, open ? /meter photo/ : /2:00 PM/);
  r = await post('/api/checkout', users.sales.id, { photo: '/uploads/attendance/b.jpg', km: '12530', meter_photo: '/uploads/expenses/n.jpg' });
  assert.equal(r.ok, false);
  assert.match(r.message, open ? /Location is required/ : /2:00 PM/);
  r = await post('/api/checkout', users.sales.id, { ...GPS, photo: '/uploads/attendance/b.jpg', km: '12530', meter_photo: '/uploads/expenses/n.jpg' });
  if (!open) { assert.match(r.message, /2:00 PM/); return; }
  assert.equal(r.ok, true);
  assert.equal(r.journey.totalKm, '80.0');
});
