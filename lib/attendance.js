// Attendance rules for check-in / check-out (India time):
//   - location (GPS) is required for both
//   - check-out opens at 14:00
//   - sales and service people must give the odometer reading and a meter photo
// Also saves the day's journey (odometer) with the check-in / check-out.
const { db } = require('../db');

const CHECKOUT_FROM = '14:00';
const METER_ROLES = ['sales', 'staff', 'service'];   // 'staff' is the old name for sales

const istHHMM = (now = new Date()) => new Date(now.getTime() + 330 * 60000).toISOString().slice(11, 16);
const checkoutOpen = (now = new Date()) => istHHMM(now) >= CHECKOUT_FROM;
const needsMeter = (role) => METER_ROLES.includes(role);

function location(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: a, lng: b };
}

const isUpload = (p) => typeof p === 'string' && p.startsWith('/uploads/');

// Odometer entry from the request: { km, photo } or null when not given
function meter(body) {
  const km = parseFloat(body.km);
  const photo = isUpload(body.meter_photo) ? body.meter_photo : null;
  return { km: km > 0 ? km : null, photo };
}

function saveJourneyStart(uid, date, { km, photo, lat, lng }) {
  db.prepare(`INSERT OR REPLACE INTO expense_journeys
    (user_id, date, start_km, start_photo, start_lat, start_lng, start_time)
    VALUES (?,?,?,?,?,?,?)`)
    .run(uid, date, parseFloat(km) || 0, photo || null, lat || null, lng || null, new Date().toISOString());
}

function saveJourneyEnd(uid, date, { km, photo, lat, lng }) {
  const endKm = parseFloat(km) || 0;
  const now = new Date().toISOString();
  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);
  const totalKm = Math.max(0, endKm - (j?.start_km || 0));
  if (j) {
    db.prepare(`UPDATE expense_journeys SET end_km=?, end_photo=?, end_lat=?, end_lng=?, end_time=?, total_km=? WHERE id=?`)
      .run(endKm, photo || null, lat || null, lng || null, now, totalKm, j.id);
  } else {
    db.prepare(`INSERT INTO expense_journeys (user_id, date, end_km, end_photo, end_lat, end_lng, end_time, total_km)
      VALUES (?,?,?,?,?,?,?,?)`).run(uid, date, endKm, photo || null, lat || null, lng || null, now, totalKm);
  }
  return { totalKm: totalKm.toFixed(1), startKm: j?.start_km || 0, endKm };
}

module.exports = { CHECKOUT_FROM, METER_ROLES, checkoutOpen, needsMeter, location, meter, saveJourneyStart, saveJourneyEnd };

// ── Attendance corrections ────────────────────────────────────────────────────
// The Head of Finance and admins can set any staff member's day to present,
// absent or leave (attendance.marked), directly or by approving a request.
// A day set to leave also creates an approved one-day leave and uses its balance.
const { createNotification, auditLog, getPositionPermissions } = require('../db');

const STATUSES = ['present', 'absent', 'leave'];
const REQUEST_DAYS = 30;     // staff can ask about today and the 30 days before

const istDate = (now = new Date()) => new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d + 'T00:00:00Z'));

// The person can edit attendance and decide requests
const canEdit = (res) => !!(res.locals.hasPerm && (res.locals.hasPerm('*') || res.locals.hasPerm('attendance_edit')));
function editorIds() {
  return db.prepare('SELECT id, role, position_code FROM users WHERE COALESCE(is_hr_active,1)=1').all()
    .filter(u => { const p = getPositionPermissions(u.position_code, u.role); return p.includes('*') || p.includes('attendance_edit'); })
    .map(u => u.id);
}

// SQL: is this attendance row a present day? (alias = the attendance table alias)
const presentSql = (a = 'a') => `(${a}.marked='present' OR (COALESCE(${a}.marked,'')='' AND ${a}.check_in_time IS NOT NULL))`;

// Effective day status of one attendance row, or null when nothing set it
function statusOf(rec) {
  if (!rec) return null;
  if (rec.marked) return rec.marked;
  return rec.check_in_time ? 'present' : null;
}

const leaveTypes = () => db.prepare('SELECT id, code, name FROM leave_types WHERE is_active=1 ORDER BY id').all();

function leaveAvailable(uid, leaveTypeId, year) {
  require('../routes/leaves').ensureBalance(uid, leaveTypeId, year);
  const b = db.prepare('SELECT allocated, used FROM leave_balances WHERE user_id=? AND leave_type_id=? AND year=?').get(uid, leaveTypeId, year);
  return (b?.allocated || 0) - (b?.used || 0);
}

// Undo the one-day leave a previous 'leave' mark created
function releaseLeave(rec) {
  if (!rec?.marked_leave_id) return;
  const l = db.prepare('SELECT * FROM leaves WHERE id=?').get(rec.marked_leave_id);
  if (l && l.status === 'approved') {
    db.prepare('UPDATE leave_balances SET used=MAX(0, used-?) WHERE user_id=? AND leave_type_id=? AND year=?')
      .run(l.days, l.user_id, l.leave_type_id, +l.start_date.slice(0, 4));
  }
  db.prepare('UPDATE attendance SET marked_leave_id=NULL WHERE marked_leave_id=?').run(rec.marked_leave_id);
  db.prepare('DELETE FROM leaves WHERE id=?').run(rec.marked_leave_id);
}

// Set one person's day. Returns { ok } or { ok:false, message }.
function markDay(uid, date, status, { by, note = '', leave_type_id = null } = {}) {
  if (!STATUSES.includes(status)) return { ok: false, message: 'Choose present, absent or leave.' };
  if (!isDate(date)) return { ok: false, message: 'Choose a valid date.' };
  if (date > istDate()) return { ok: false, message: 'Attendance cannot be set for a future date.' };
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid)) return { ok: false, message: 'Employee not found.' };

  db.prepare('INSERT OR IGNORE INTO attendance (user_id, date, status) VALUES (?, ?, ?)').run(uid, date, status);
  const rec = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, date);
  const year = +date.slice(0, 4);

  let leaveId = null;
  if (status === 'leave') {
    const lt = db.prepare('SELECT id FROM leave_types WHERE id=? AND is_active=1').get(+leave_type_id);
    if (!lt) return { ok: false, message: 'Choose the leave type.' };
    const reuse = rec.marked === 'leave' && rec.marked_leave_id
      && db.prepare('SELECT leave_type_id FROM leaves WHERE id=?').get(rec.marked_leave_id)?.leave_type_id === lt.id;
    if (reuse) leaveId = rec.marked_leave_id;
    else {
      const covered = db.prepare("SELECT 1 FROM leaves WHERE user_id=? AND status='approved' AND ? BETWEEN start_date AND end_date AND id IS NOT ?")
        .get(uid, date, rec.marked_leave_id || null);
      if (!covered && leaveAvailable(uid, lt.id, year) < 1) return { ok: false, message: 'Not enough leave balance for this leave type.' };
      releaseLeave(rec);
      if (!covered) {
        leaveId = Number(db.prepare(`INSERT INTO leaves (user_id, leave_type_id, start_date, end_date, days, reason, status, reviewed_by, reviewer_comment)
          VALUES (?,?,?,?,1,?, 'approved', ?, 'Attendance correction')`).run(uid, lt.id, date, date, note || 'Attendance correction', by || null).lastInsertRowid);
        db.prepare('UPDATE leave_balances SET used=used+1 WHERE user_id=? AND leave_type_id=? AND year=?').run(uid, lt.id, year);
      }
    }
  } else {
    releaseLeave(rec);
  }

  db.prepare(`UPDATE attendance SET marked=?, status=?, marked_by=?, marked_at=?, marked_note=?, marked_leave_id=? WHERE id=?`)
    .run(status, status, by || null, new Date().toISOString(), note || '', leaveId, rec.id);
  auditLog(by || null, 'attendance_mark', 'attendance', rec.id, `user ${uid} ${date} → ${status}${note ? ': ' + note : ''}`);
  return { ok: true };
}

// ── Requests ──────────────────────────────────────────────────────────────────
const nameOf = (id) => { const u = db.prepare('SELECT full_name, username FROM users WHERE id=?').get(id); return u ? (u.full_name || u.username) : 'Someone'; };
const LABEL = { present: 'Present', absent: 'Absent', leave: 'Leave' };

// Tell the person, every admin and the Head of Finance (not the one who acted)
function notifyAll(reqRow, title, body, actorId) {
  const ids = new Set([reqRow.user_id, ...editorIds()]);
  ids.delete(actorId);
  ids.forEach(id => createNotification(id, title, body, 'attendance', id === reqRow.user_id ? '/attendance/requests' : '/attendance/requests#pending'));
}

function createRequest(uid, { date, requested, leave_type_id, reason }) {
  const today = istDate();
  if (!isDate(date)) return { ok: false, message: 'Choose a valid date.' };
  if (date > today || date < addDays(today, -REQUEST_DAYS)) return { ok: false, message: 'You can request only for today or the last 30 days.' };
  if (!STATUSES.includes(requested)) return { ok: false, message: 'Choose present, absent or leave.' };
  reason = String(reason || '').trim();
  if (!reason) return { ok: false, message: 'Write the reason for the request.' };
  let lt = null;
  if (requested === 'leave') {
    lt = db.prepare('SELECT id FROM leave_types WHERE id=? AND is_active=1').get(+leave_type_id);
    if (!lt) return { ok: false, message: 'Choose the leave type.' };
    if (leaveAvailable(uid, lt.id, +date.slice(0, 4)) < 1) return { ok: false, message: 'Not enough leave balance for this leave type.' };
  }
  if (db.prepare("SELECT 1 FROM attendance_requests WHERE user_id=? AND date=? AND status='pending'").get(uid, date))
    return { ok: false, message: 'You already have a pending request for this date.' };

  const id = Number(db.prepare('INSERT INTO attendance_requests (user_id, date, requested, leave_type_id, reason) VALUES (?,?,?,?,?)')
    .run(uid, date, requested, lt?.id || null, reason).lastInsertRowid);
  const row = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(id);
  notifyAll(row, 'Attendance request', `${nameOf(uid)} asked to mark ${date} as ${LABEL[requested]}: ${reason}`, uid);
  return { ok: true, id };
}

function decideRequest(id, approverId, action, note = '') {
  const row = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(id);
  if (!row) return { ok: false, message: 'Request not found.' };
  if (row.status !== 'pending') return { ok: false, message: 'This request was already decided.' };
  if (!['approve', 'deny'].includes(action)) return { ok: false, message: 'Choose approve or deny.' };
  note = String(note || '').trim();
  if (action === 'approve') {
    const r = markDay(row.user_id, row.date, row.requested, { by: approverId, note: `Request #${row.id}: ${row.reason}`, leave_type_id: row.leave_type_id });
    if (!r.ok) return r;
  } else if (!note) {
    return { ok: false, message: 'Write why the request is denied.' };
  }
  const status = action === 'approve' ? 'approved' : 'denied';
  db.prepare('UPDATE attendance_requests SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?')
    .run(status, approverId, new Date().toISOString(), note, row.id);
  auditLog(approverId, 'attendance_request_' + status, 'attendance_requests', row.id, note);
  notifyAll(row, status === 'approved' ? 'Attendance request approved' : 'Attendance request denied',
    `${nameOf(row.user_id)} · ${row.date} · ${LABEL[row.requested]} — ${status === 'approved' ? 'approved' : 'denied'} by ${nameOf(approverId)}${note ? ': ' + note : ''}`, approverId);
  return { ok: true, status };
}

function cancelRequest(id, uid) {
  const row = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(id);
  if (!row || row.user_id !== uid) return { ok: false, message: 'Request not found.' };
  if (row.status !== 'pending') return { ok: false, message: 'This request was already decided.' };
  db.prepare("UPDATE attendance_requests SET status='cancelled', reviewed_at=? WHERE id=?").run(new Date().toISOString(), id);
  return { ok: true };
}

Object.assign(module.exports, { STATUSES, REQUEST_DAYS, istDate, addDays, canEdit, editorIds, presentSql, statusOf, leaveTypes,
  markDay, createRequest, decideRequest, cancelRequest });
