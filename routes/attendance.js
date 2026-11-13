const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { db, createNotification, today } = require('../db');
const rules = require('../lib/attendance');

// ── Helpers ───────────────────────────────────────────────────────────────────
function savePhoto(base64, folder, uploadsDir) {
  if (!base64 || !base64.startsWith('data:image')) return null;
  const buf = Buffer.from(base64.split(',')[1], 'base64');
  const dir = path.join(uploadsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  fs.writeFileSync(path.join(dir, fname), buf);
  return `/uploads/${folder}/${fname}`;
}

// ── Employee: my attendance page ──────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();

  const todayRec  = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);
  const todayJourney = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, todayR);

  const history = db.prepare('SELECT * FROM attendance WHERE user_id=? ORDER BY date DESC LIMIT 30').all(uid);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN ${rules.presentSql('attendance')} THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN check_in_time IS NOT NULL AND check_out_time IS NULL THEN 1 ELSE 0 END) as open
    FROM attendance WHERE user_id=? AND date >= date('now','+330 minutes','-30 days')
  `).get(uid);

  // HoF and admin see all-staff attendance for the selected date
  let staffAttendance = null;
  const canSeeAll = res.locals.hasPerm && (res.locals.hasPerm('*') || res.locals.hasPerm('expense_approval') || res.locals.hasPerm('attendance_edit'));
  if (canSeeAll) {
    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayR;
    staffAttendance = {
      date: dateFilter,
      rows: db.prepare(`
        SELECT u.id, u.full_name, u.employee_code, p.title AS position_title, p.section,
               a.check_in_time, a.check_out_time, a.check_in_lat, a.check_in_lng, a.marked, a.marked_note
        FROM users u
        LEFT JOIN org_positions p ON p.code = u.position_code
        LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
        WHERE u.is_hr_active = 1 AND u.id != ?
        ORDER BY p.section, u.full_name
      `).all(dateFilter, uid),
    };
    staffAttendance.rows.forEach(r => { r.day = rules.statusOf(r) || 'absent'; });
    staffAttendance.summary = {
      total:   staffAttendance.rows.length,
      present: staffAttendance.rows.filter(r => r.day === 'present').length,
      out:     staffAttendance.rows.filter(r => r.check_out_time).length,
      absent:  staffAttendance.rows.filter(r => r.day !== 'present').length,
    };
  }

  res.render('attendance', { title: 'My Attendance', todayRec, todayJourney, history, stats, todayStr: todayR,
    cal: monthCalendar(uid, req.query.m, todayR), staffAttendance, canEdit: rules.canEdit(res),
    pendingRequests: rules.canEdit(res) ? db.prepare("SELECT COUNT(*) c FROM attendance_requests WHERE status='pending'").get().c : 0,
    checkoutOpen: rules.checkoutOpen(), meterRequired: rules.needsMeter(res.locals.user?.role) });
});

// Month calendar: present / absent / leave / off (Sunday) for one user
function monthCalendar(uid, m, todayStr) {
  const month = /^\d{4}-\d{2}$/.test(m || '') ? m : todayStr.slice(0, 7);
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const first = `${month}-01`, last = `${month}-${String(days).padStart(2, '0')}`;

  const user = db.prepare('SELECT date_of_joining, created_at FROM users WHERE id=?').get(uid) || {};
  const since = (user.date_of_joining || String(user.created_at || '').slice(0, 10) || first);
  const att = Object.fromEntries(db.prepare('SELECT * FROM attendance WHERE user_id=? AND date BETWEEN ? AND ?').all(uid, first, last).map(r => [r.date, r]));
  const km  = Object.fromEntries(db.prepare('SELECT date, total_km FROM expense_journeys WHERE user_id=? AND date BETWEEN ? AND ?').all(uid, first, last).map(r => [r.date, r.total_km]));
  const leaves = db.prepare("SELECT start_date, end_date FROM leaves WHERE user_id=? AND status='approved' AND start_date <= ? AND end_date >= ?").all(uid, last, first);

  const cells = [];
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const dow  = new Date(date + 'T00:00:00Z').getUTCDay();
    const rec  = att[date];
    let status;
    if (rec?.marked)                                         status = rec.marked;   // set by HoF / admin
    else if (rec?.check_in_time)                             status = rec.check_out_time || date === todayStr ? 'present' : 'no-checkout';
    else if (leaves.some(l => l.start_date <= date && date <= l.end_date)) status = 'leave';
    else if (date > todayStr || date < since)                 status = 'none';
    else if (dow === 0)                                       status = 'off';
    else if (date === todayStr)                               status = 'today';
    else                                                      status = 'absent';
    cells.push({ date, d, dow, status, km: km[date] || 0, marked: !!rec?.marked });
  }
  const count = s => cells.filter(c => c.status === s).length;
  const shift = (n) => { const t = new Date(Date.UTC(y, mo - 1 + n, 1)); return t.toISOString().slice(0, 7); };
  return {
    month, label: new Date(first + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    lead: new Date(first + 'T00:00:00Z').getUTCDay(), cells,
    prev: shift(-1), next: shift(1) <= todayStr.slice(0, 7) ? shift(1) : null,
    totals: { present: count('present') + count('no-checkout'), absent: count('absent'), leave: count('leave'),
              km: cells.reduce((t, c) => t + c.km, 0) },
  };
}

// One day's detail for the calendar: check-in/out photos and times, bike km
function dayDetail(uid, date) {
  const att = db.prepare(`SELECT a.check_in_time, a.check_in_photo, a.check_in_lat, a.check_in_lng, a.check_out_time, a.check_out_photo, a.check_out_lat, a.check_out_lng,
      a.marked, a.marked_note, a.marked_at, COALESCE(m.full_name, m.username) AS marked_by_name
    FROM attendance a LEFT JOIN users m ON m.id = a.marked_by WHERE a.user_id=? AND a.date=?`).get(uid, date);
  const journey = db.prepare('SELECT start_km, start_photo, end_km, end_photo, total_km FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);
  const visits = db.prepare("SELECT COUNT(*) AS c FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=?").get(uid, date).c;
  return { date, att: att || null, journey: journey || null, visits };
}

router.get('/api/day/:date', (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'Bad date' });
  res.json(dayDetail(req.session.userId, req.params.date));
});

// ── API: check-in ─────────────────────────────────────────────────────────────
router.post('/api/checkin', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();
  const { photo } = req.body;

  const existing = db.prepare('SELECT id, check_in_time FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);
  if (existing?.check_in_time) {
    return res.json({ ok: false, message: 'Already checked in today.' });
  }
  const loc = rules.location(req.body.lat, req.body.lng);
  if (!loc) return res.json({ ok: false, message: 'Location is required. Turn on GPS / location and try again.' });
  const m = rules.meter(req.body);
  if (rules.needsMeter(res.locals.user?.role) && (!m.km || !m.photo)) {
    return res.json({ ok: false, message: 'Odometer reading and meter photo are required.' });
  }
  const { lat, lng } = loc;

  // photo is already uploaded via /api/upload — use path directly
  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE attendance SET check_in_time=?, check_in_lat=?, check_in_lng=?, check_in_photo=? WHERE id=?`)
      .run(now, lat, lng, photoPath, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (user_id,date,check_in_time,check_in_lat,check_in_lng,check_in_photo)
                VALUES (?,?,?,?,?,?)`)
      .run(uid, todayR, now, lat, lng, photoPath);
  }
  if (m.km) rules.saveJourneyStart(uid, todayR, { km: m.km, photo: m.photo, lat, lng });
  res.json({ ok: true, time: now, km: m.km });
});

// ── API: check-out ────────────────────────────────────────────────────────────
router.post('/api/checkout', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();
  const { photo } = req.body;

  const rec = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);
  if (!rec?.check_in_time) {
    return res.json({ ok: false, message: 'You have not checked in today.' });
  }
  if (rec.check_out_time) {
    return res.json({ ok: false, message: 'Already checked out today.' });
  }
  if (!rules.checkoutOpen()) {
    return res.json({ ok: false, message: 'Check-out opens at 2:00 PM.' });
  }
  const loc = rules.location(req.body.lat, req.body.lng);
  if (!loc) return res.json({ ok: false, message: 'Location is required. Turn on GPS / location and try again.' });
  const m = rules.meter(req.body);
  if (rules.needsMeter(res.locals.user?.role) && (!m.km || !m.photo)) {
    return res.json({ ok: false, message: 'Odometer reading and meter photo are required.' });
  }
  const { lat, lng } = loc;

  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const now = new Date().toISOString();
  db.prepare(`UPDATE attendance SET check_out_time=?, check_out_lat=?, check_out_lng=?, check_out_photo=? WHERE id=?`)
    .run(now, lat, lng, photoPath, rec.id);

  const journey = m.km ? rules.saveJourneyEnd(uid, todayR, { km: m.km, photo: m.photo, lat, lng }) : null;
  res.json({ ok: true, time: now, journey });
});

// ── Attendance requests and corrections ───────────────────────────────────────
// Everyone: ask for a day (today or the last 30 days) to be marked present /
// absent / leave. Head of Finance and admins: approve or deny, and edit any day.
router.get('/requests', (req, res) => {
  const uid = req.session.userId;
  const canEdit = rules.canEdit(res);
  const todayR = rules.istDate();
  const reqSql = `SELECT r.*, lt.name AS leave_name, COALESCE(u.full_name, u.username) AS person, u.employee_code,
      COALESCE(rv.full_name, rv.username) AS reviewer, a.check_in_time, a.check_out_time, a.marked
    FROM attendance_requests r JOIN users u ON u.id = r.user_id
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN leave_types lt ON lt.id = r.leave_type_id
    LEFT JOIN attendance a ON a.user_id = r.user_id AND a.date = r.date`;
  const mine = db.prepare(reqSql + ' WHERE r.user_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT 30').all(uid);
  let pending = [], decided = [], employees = [];
  if (canEdit) {
    pending = db.prepare(reqSql + " WHERE r.status='pending' ORDER BY r.date, r.id").all();
    decided = db.prepare(reqSql + " WHERE r.status IN ('approved','denied') ORDER BY r.reviewed_at DESC LIMIT 30").all();
    employees = db.prepare("SELECT id, full_name, username, employee_code FROM users WHERE COALESCE(is_hr_active,1)=1 ORDER BY full_name").all();
  }
  const edit = { user: +req.query.user || '', date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : '' };
  res.render('attendance-requests', { title: 'Attendance Requests', mine, pending, decided, employees, canEdit, edit,
    leaveTypes: rules.leaveTypes(), todayStr: todayR, minDate: rules.addDays(todayR, -rules.REQUEST_DAYS) });
});

router.post('/requests', (req, res) => {
  const r = rules.createRequest(req.session.userId, req.body);
  req.session.flash = r.ok ? { success: 'Request sent to the Head of Finance and admin.' } : { error: r.message };
  res.redirect('/attendance/requests');
});

router.post('/requests/:id/cancel', (req, res) => {
  const r = rules.cancelRequest(+req.params.id, req.session.userId);
  req.session.flash = r.ok ? { success: 'Request cancelled.' } : { error: r.message };
  res.redirect('/attendance/requests');
});

router.post('/requests/:id/decide', (req, res) => {
  if (!rules.canEdit(res)) { req.session.flash = { error: 'Only the Head of Finance or an admin can decide attendance requests.' }; return res.redirect('/attendance/requests'); }
  const r = rules.decideRequest(+req.params.id, req.session.userId, req.body.action, req.body.note);
  req.session.flash = r.ok ? { success: r.status === 'approved' ? 'Request approved; attendance updated.' : 'Request denied.' } : { error: r.message };
  res.redirect('/attendance/requests#pending');
});

router.post('/edit', (req, res) => {
  if (!rules.canEdit(res)) { req.session.flash = { error: 'Only the Head of Finance or an admin can edit attendance.' }; return res.redirect('/attendance'); }
  const { user_id, date, status, leave_type_id, note } = req.body;
  if (!String(note || '').trim()) { req.session.flash = { error: 'Write the reason for the change.' }; return res.redirect(`/attendance/requests?user=${+user_id || ''}&date=${encodeURIComponent(date || '')}#edit`); }
  const r = rules.markDay(+user_id, date, status, { by: req.session.userId, note: String(note).trim(), leave_type_id });
  if (r.ok) {
    createNotification(+user_id, 'Attendance updated', `${date}: marked ${status} by ${res.locals.user.full_name || res.locals.user.username}. ${String(note).trim()}`, 'attendance', '/attendance');
    req.session.flash = { success: 'Attendance updated.' };
  } else req.session.flash = { error: r.message };
  res.redirect(r.ok ? '/attendance/requests#edit' : `/attendance/requests?user=${+user_id || ''}&date=${encodeURIComponent(date || '')}#edit`);
});

// Shared with HR → Employee Attendance
router.monthCalendar = monthCalendar;
router.dayDetail = dayDetail;
module.exports = router;
