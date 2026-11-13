// Attendance requests and edits: staff ask for a day (today / last 30 days) to be
// present / absent / leave; Head of Finance or admin approve, deny or edit;
// everyone involved is notified; leave uses the leave balance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users } = T;
const rules = require('../lib/attendance');

const hof = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role,position_code) VALUES ('hof2','x','Finance Head','head_of_finance','head_finance')").run().lastInsertRowid);
const me = users.sales.id;
const today = rules.istDate();
const daysAgo = (n) => rules.addDays(today, -n);
const cl = db.prepare("SELECT id FROM leave_types WHERE code='CL'").get().id;
const notes = (uid) => db.prepare('SELECT title, body FROM notifications WHERE user_id=? ORDER BY id').all(uid);
const clear = () => db.prepare('DELETE FROM notifications').run();
const day = (uid, date) => db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, date);
const used = (uid) => db.prepare('SELECT used FROM leave_balances WHERE user_id=? AND leave_type_id=? AND year=?').get(uid, cl, +today.slice(0, 4))?.used || 0;

test('only the Head of Finance and admins can edit and decide', () => {
  const ids = rules.editorIds();
  assert.ok(ids.includes(hof));
  assert.ok(ids.includes(users.admin.id));
  assert.ok(!ids.includes(me));
  assert.ok(!ids.includes(users.manager.id));
});

test('a request must be for today or the last 30 days, with a reason', () => {
  assert.match(rules.createRequest(me, { date: daysAgo(31), requested: 'present', reason: 'x' }).message, /last 30 days/);
  assert.match(rules.createRequest(me, { date: rules.addDays(today, 1), requested: 'present', reason: 'x' }).message, /last 30 days/);
  assert.match(rules.createRequest(me, { date: daysAgo(2), requested: 'present', reason: ' ' }).message, /reason/);
  assert.match(rules.createRequest(me, { date: daysAgo(2), requested: 'holiday', reason: 'x' }).message, /present, absent or leave/);
  assert.match(rules.createRequest(me, { date: daysAgo(2), requested: 'leave', reason: 'x' }).message, /leave type/);
});

test('a request notifies the Head of Finance and admins; one pending per date', () => {
  clear();
  const r = rules.createRequest(me, { date: daysAgo(30), requested: 'present', reason: 'Phone battery died' });
  assert.equal(r.ok, true);
  assert.equal(notes(hof)[0].title, 'Attendance request');
  assert.match(notes(hof)[0].body, /Phone battery died/);
  assert.equal(notes(users.admin.id).length, 1);
  assert.equal(notes(me).length, 0);           // the requester did it themselves
  assert.match(rules.createRequest(me, { date: daysAgo(30), requested: 'absent', reason: 'again' }).message, /already have a pending/);
});

test('approving marks the day present and tells the person and the other approvers', () => {
  clear();
  const id = db.prepare("SELECT id FROM attendance_requests WHERE user_id=? AND status='pending'").get(me).id;
  const r = rules.decideRequest(id, hof, 'approve');
  assert.equal(r.ok, true);
  assert.equal(day(me, daysAgo(30)).marked, 'present');
  assert.equal(notes(me)[0].title, 'Attendance request approved');
  assert.equal(notes(users.admin.id)[0].title, 'Attendance request approved');
  assert.equal(notes(hof).length, 0);
  assert.match(rules.decideRequest(id, hof, 'deny', 'no').message, /already decided/);
  // counts as present even without a check-in
  const n = db.prepare(`SELECT COUNT(*) c FROM attendance a WHERE user_id=? AND ${rules.presentSql('a')}`).get(me).c;
  assert.equal(n, 1);
});

test('denying needs a note and leaves attendance as it was', () => {
  const { id } = rules.createRequest(me, { date: daysAgo(5), requested: 'present', reason: 'Was in the field' });
  assert.match(rules.decideRequest(id, users.admin.id, 'deny', '').message, /why/);
  clear();
  assert.equal(rules.decideRequest(id, users.admin.id, 'deny', 'No visit on record').status, 'denied');
  assert.equal(day(me, daysAgo(5)), undefined);
  assert.match(notes(me)[0].body, /No visit on record/);
  assert.equal(notes(hof)[0].title, 'Attendance request denied');
});

test('a leave request uses one day of balance; editing it back releases the day', () => {
  const before = used(me);
  const { id } = rules.createRequest(me, { date: daysAgo(3), requested: 'leave', leave_type_id: cl, reason: 'Family function' });
  assert.equal(rules.decideRequest(id, hof, 'approve').ok, true);
  assert.equal(day(me, daysAgo(3)).marked, 'leave');
  assert.equal(used(me), before + 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leaves WHERE user_id=? AND status='approved' AND start_date=?").get(me, daysAgo(3)).c, 1);

  assert.equal(rules.markDay(me, daysAgo(3), 'absent', { by: hof, note: 'Was not on leave' }).ok, true);
  assert.equal(used(me), before);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leaves WHERE user_id=? AND start_date=?").get(me, daysAgo(3)).c, 0);
});

test('an edit keeps the check-in record, overrides it, and cannot be in the future', () => {
  db.prepare("INSERT INTO attendance (user_id, date, check_in_time, check_in_photo) VALUES (?, ?, '2026-01-01T04:00:00Z', '/uploads/a/x.jpg')").run(me, daysAgo(7));
  assert.equal(rules.markDay(me, daysAgo(7), 'absent', { by: users.admin.id, note: 'Fake check-in' }).ok, true);
  const rec = day(me, daysAgo(7));
  assert.equal(rec.marked, 'absent');
  assert.equal(rec.check_in_photo, '/uploads/a/x.jpg');
  assert.equal(rules.statusOf(rec), 'absent');
  assert.match(rules.markDay(me, rules.addDays(today, 1), 'present', { by: hof }).message, /future/);
  const cal = require('../routes/attendance').monthCalendar(me, daysAgo(7).slice(0, 7), today);
  assert.equal(cal.cells.find(c => c.date === daysAgo(7)).status, 'absent');
});

test('only the requester can cancel, and only while pending', () => {
  const { id } = rules.createRequest(me, { date: daysAgo(1), requested: 'absent', reason: 'Sick' });
  assert.equal(rules.cancelRequest(id, users.manager.id).ok, false);
  assert.equal(rules.cancelRequest(id, me).ok, true);
  assert.equal(rules.cancelRequest(id, me).ok, false);
});
