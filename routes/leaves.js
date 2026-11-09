const express = require('express');
const router  = express.Router();
const { db, createNotification } = require('../db');
const { approverIdsFor } = require('../lib/org');

function workingDays(start, end) {
  let d = new Date(start), e = new Date(end), count = 0;
  while (d <= e) {
    if (d.getDay() !== 0) count++; // exclude Sunday
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function ensureBalance(userId, leaveTypeId, year) {
  db.prepare(`INSERT OR IGNORE INTO leave_balances (user_id, leave_type_id, year, allocated, used)
    SELECT ?, ?, ?, days_per_year, 0 FROM leave_types WHERE id=?`)
    .run(userId, leaveTypeId, year, leaveTypeId);
}

// ── Employee: my leaves ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid  = req.session.userId;
  const year = new Date().getFullYear();

  const leaveTypes = db.prepare('SELECT * FROM leave_types WHERE is_active=1 ORDER BY id').all();

  // Ensure balance rows exist
  leaveTypes.forEach(lt => ensureBalance(uid, lt.id, year));

  const balances = db.prepare(`
    SELECT lb.*, lt.code, lt.name, lt.days_per_year
    FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id
    WHERE lb.user_id=? AND lb.year=? AND lt.is_active=1`).all(uid, year);

  const history = db.prepare(`
    SELECT l.*, lt.code, lt.name
    FROM leaves l JOIN leave_types lt ON lt.id=l.leave_type_id
    WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 20`).all(uid);

  res.render('leaves', { title: 'My Leaves', leaveTypes, balances, history, year });
});

// ── Employee: apply leave ─────────────────────────────────────────────────────
router.post('/apply', (req, res) => {
  const uid = req.session.userId;
  const { leave_type_id, start_date, end_date, reason, is_half_day } = req.body;
  const year = new Date(start_date).getFullYear();

  ensureBalance(uid, leave_type_id, year);

  const days  = is_half_day ? 0.5 : workingDays(start_date, end_date);
  const bal   = db.prepare('SELECT * FROM leave_balances WHERE user_id=? AND leave_type_id=? AND year=?')
                  .get(uid, leave_type_id, year);
  const avail = (bal?.allocated || 0) - (bal?.used || 0);

  if (days > avail && days > 0) {
    req.session.flash = { error: `Insufficient leave balance. Available: ${avail} day(s).` };
    return res.redirect('/leaves');
  }

  db.prepare(`INSERT INTO leaves (user_id,leave_type_id,start_date,end_date,days,reason)
              VALUES (?,?,?,?,?,?)`)
    .run(uid, leave_type_id, start_date, end_date, days, reason||'');

  // Notify the approver from the organisation chart (Level 1 while positions above are vacant)
  const uname  = db.prepare('SELECT full_name FROM users WHERE id=?').get(uid)?.full_name || 'Someone';
  approverIdsFor(uid).forEach(id => createNotification(id, 'New Leave Request',
    `${uname} applied for ${days} day(s) leave.`, 'leave', '/hr/leaves'));

  req.session.flash = { success: `Leave applied for ${days} day(s). Pending approval.` };
  res.redirect('/leaves');
});

module.exports = router;

// Export helpers for use in hr.js
module.exports.ensureBalance = ensureBalance;
