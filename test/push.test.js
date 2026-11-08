// Push notifications: devices, event pushes in the user's language, dead devices removed,
// and the 9:00 / 19:00 attendance reminders (India time, once a day, right people only).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const push = require('../lib/push');
const reminders = require('../lib/reminders');

const sent = [];
let failWith = null;
push.setTransport(async (sub, payload) => {
  if (failWith) { const e = new Error('gone'); e.statusCode = failWith; throw e; }
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});
const device = (userId, n) => push.subscribe(userId, { endpoint: `https://push.example/${n}`, keys: { p256dh: 'p' + n, auth: 'a' + n } });
const flush = () => new Promise(r => setTimeout(r, 20));

const mk = (username, role) => Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'x', ?, ?)").run(username, username, role).lastInsertRowid);
const late = mk('late1', 'sales');        // not checked in → 9:00 reminder
const early = mk('early1', 'sales');      // checked in, not out → 19:00 reminder
const onLeave = mk('leave1', 'sales');    // approved leave today → nothing
const noDevice = mk('nodev1', 'sales');   // no device → nothing
const hindi = mk('hindi1', 'sales');
db.prepare("UPDATE users SET language='hi' WHERE id=?").run(hindi);
[late, early, onLeave, hindi].forEach((u, i) => device(u, 'r' + i));

// Wednesday 11 Nov 2026 in India
const DAY = '2026-11-11';
db.prepare("INSERT INTO attendance (user_id, date, check_in_time) VALUES (?, ?, '2026-11-11 03:30:00')").run(early, DAY);
db.prepare("INSERT INTO attendance (user_id, date, check_in_time) VALUES (?, ?, '2026-11-11 03:30:00')").run(hindi, DAY);
const lt = db.prepare('SELECT id FROM leave_types LIMIT 1').get().id;
db.prepare("INSERT INTO leaves (user_id, leave_type_id, start_date, end_date, days, status) VALUES (?,?,?,?,1,'approved')").run(onLeave, lt, DAY, DAY);
const ist = (hhmm, date = DAY) => new Date(`${date}T${hhmm}:00+05:30`);

test('an app notification is also pushed, in the user\'s language', async () => {
  sent.length = 0;
  device(users.sales.id, 's1');
  dbmod.createNotification(users.sales.id, 'Travel expense paid', '₹1,200 paid.', 'salary', '/salary');
  dbmod.createNotification(hindi, 'Quotation approved', 'SP-26-27/0001', 'success', '/spare-quotations/1');
  await flush();
  assert.deepEqual(sent.map(s => [s.title, s.url]), [['Travel expense paid', '/salary'], ['कोटेशन स्वीकृत', '/spare-quotations/1']]);
});

test('a device the browser has dropped (410) is removed', async () => {
  device(noDevice, 'gone');
  failWith = 410;
  await push.sendToUser(noDevice, { title: 'x' });
  failWith = null;
  assert.equal(push.hasDevices(noDevice), false);
});

test('9:00 check-in reminder goes once, only to staff not yet checked in and not on leave', async () => {
  sent.length = 0;
  assert.deepEqual(await reminders.runDue(ist('08:59')), []);
  const ran = await reminders.runDue(ist('09:00'));
  assert.deepEqual(ran.map(r => r.key), ['checkin']);
  const to = sent.map(s => s.endpoint).sort();
  assert.ok(to.includes('https://push.example/r0'));            // late
  assert.ok(!to.includes('https://push.example/r1'));           // already checked in
  assert.ok(!to.includes('https://push.example/r2'));           // on leave
  assert.equal(sent.find(s => s.endpoint.endsWith('/r0')).title, 'Time to check in');
  sent.length = 0;
  assert.deepEqual(await reminders.runDue(ist('09:01')), []);  // not again
  assert.equal(sent.length, 0);
});

test('19:00 check-out reminder goes to those checked in and not out, in their language', async () => {
  sent.length = 0;
  await reminders.runDue(ist('19:00'));
  const titles = Object.fromEntries(sent.map(s => [s.endpoint.split('/').pop(), s.title]));
  assert.deepEqual(titles, { r1: 'Time to check out', r3: 'चेक आउट का समय' });
});

test('no reminders on Sunday, or long after the time (server was down)', async () => {
  sent.length = 0;
  assert.deepEqual(await reminders.runDue(ist('09:00', '2026-11-15')), []);   // Sunday
  assert.deepEqual(await reminders.runDue(ist('11:30', '2026-11-12')), []);   // 2½ h late
  assert.equal(sent.length, 0);
});
