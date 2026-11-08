// Daily attendance reminders by push, India time:
//   09:00  "Check in"  — staff who mark attendance and have not checked in yet
//   19:00  "Check out" — staff who checked in today and have not checked out
// Not on Sundays, and not to anyone on approved leave that day. Each reminder goes
// out once a day (recorded in push_state), even across restarts; if the server was
// down at the time it still sends within the next two hours, never later.
const { db } = require('../db');
const push = require('./push');

const REMINDERS = [
  { key: 'checkin',  at: '09:00', title: 'Time to check in',  body: 'Mark your attendance for today.',     url: '/attendance' },
  { key: 'checkout', at: '19:00', title: 'Time to check out', body: 'Mark check-out before you finish for the day.', url: '/attendance' },
];
const LATE_LIMIT_MIN = 120;

// India date / time from a Date
function istParts(now) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return { date: ist.toISOString().slice(0, 10), hhmm: ist.toISOString().slice(11, 16), weekday: ist.getUTCDay() };
}
const minutes = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

// Who should get a reminder today (only people with a device to send to)
function recipients(key, date) {
  const base = `SELECT DISTINCT u.id FROM users u
    JOIN push_subscriptions s ON s.user_id = u.id
    JOIN role_permissions rp ON rp.role = u.role AND rp.permission = 'attendance'
    LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
    WHERE u.is_hr_active = 1
      AND NOT EXISTS (SELECT 1 FROM leaves l WHERE l.user_id = u.id AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date)`;
  const cond = key === 'checkin'
    ? ' AND a.check_in_time IS NULL'
    : ' AND a.check_in_time IS NOT NULL AND a.check_out_time IS NULL';
  return db.prepare(base + cond).all(date, date).map(r => r.id);
}

// Run whatever is due at `now`; returns [{ key, sent }] for what ran
async function runDue(now = new Date()) {
  const { date, hhmm, weekday } = istParts(now);
  if (weekday === 0) return [];  // Sunday
  const ran = [];
  for (const r of REMINDERS) {
    const late = minutes(hhmm) - minutes(r.at);
    if (late < 0 || late > LATE_LIMIT_MIN) continue;
    const stateKey = `reminder:${r.key}:${date}`;
    // Claim the slot first so a second tick or instance cannot send it twice
    const claimed = db.prepare("INSERT OR IGNORE INTO push_state (key, value) VALUES (?, ?)").run(stateKey, new Date().toISOString()).changes;
    if (!claimed) continue;
    let sent = 0;
    for (const uid of recipients(r.key, date)) sent += await push.sendToUser(uid, { title: r.title, body: r.body, url: r.url, tag: r.key });
    ran.push({ key: r.key, sent });
  }
  return ran;
}

function start() {
  const tick = () => runDue().catch(e => console.error('Reminder run failed:', e.message));
  setTimeout(tick, 15000);           // shortly after start-up
  return setInterval(tick, 60000);   // then every minute
}

module.exports = { start, runDue, recipients, REMINDERS };
