const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { db, createNotification, today } = require('../db');

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
      SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN check_in_time IS NOT NULL AND check_out_time IS NULL THEN 1 ELSE 0 END) as open
    FROM attendance WHERE user_id=? AND date >= date('now','+330 minutes','-30 days')
  `).get(uid);

  res.render('attendance', { title: 'My Attendance', todayRec, todayJourney, history, stats, todayStr: todayR,
    cal: monthCalendar(uid, req.query.m, todayR) });
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
    if (rec?.check_in_time)                                  status = rec.check_out_time || date === todayStr ? 'present' : 'no-checkout';
    else if (leaves.some(l => l.start_date <= date && date <= l.end_date)) status = 'leave';
    else if (date > todayStr || date < since)                 status = 'none';
    else if (dow === 0)                                       status = 'off';
    else if (date === todayStr)                               status = 'today';
    else                                                      status = 'absent';
    cells.push({ date, d, dow, status, km: km[date] || 0 });
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
  const att = db.prepare('SELECT check_in_time, check_in_photo, check_in_lat, check_in_lng, check_out_time, check_out_photo, check_out_lat, check_out_lng FROM attendance WHERE user_id=? AND date=?').get(uid, date);
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
  const { lat, lng, photo } = req.body;

  // photo is already uploaded via /api/upload — use path directly
  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const existing = db.prepare('SELECT id, check_in_time FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);

  if (existing?.check_in_time) {
    return res.json({ ok: false, message: 'Already checked in today.' });
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE attendance SET check_in_time=?, check_in_lat=?, check_in_lng=?, check_in_photo=? WHERE id=?`)
      .run(now, lat||null, lng||null, photoPath, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (user_id,date,check_in_time,check_in_lat,check_in_lng,check_in_photo)
                VALUES (?,?,?,?,?,?)`)
      .run(uid, todayR, now, lat||null, lng||null, photoPath);
  }
  res.json({ ok: true, time: now });
});

// ── API: check-out ────────────────────────────────────────────────────────────
router.post('/api/checkout', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();
  const { lat, lng, photo } = req.body;

  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const rec = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);

  if (!rec?.check_in_time) {
    return res.json({ ok: false, message: 'You have not checked in today.' });
  }
  if (rec.check_out_time) {
    return res.json({ ok: false, message: 'Already checked out today.' });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE attendance SET check_out_time=?, check_out_lat=?, check_out_lng=?, check_out_photo=? WHERE id=?`)
    .run(now, lat||null, lng||null, photoPath, rec.id);

  res.json({ ok: true, time: now });
});

// Shared with HR → Employee Attendance
router.monthCalendar = monthCalendar;
router.dayDetail = dayDetail;
module.exports = router;
