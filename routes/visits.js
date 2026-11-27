const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');
const { requireManagerOrAdmin } = require('../lib/auth');

// ── Log a field visit (JSON API) ──────────────────────────────────────────────
// Photo and customer name are mandatory. Location is the device GPS; if GPS is
// denied/unavailable the visit is saved without coordinates and a typed address
// is required instead — a location is never guessed.
const LOCATION_STATUSES = ['gps', 'denied', 'unavailable', 'timeout'];

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

router.post('/', (req, res) => {
  const { customer_name, contact_person, purpose, photo, voice_note } = req.body;
  const phone   = String(req.body.phone || '').replace(/[^0-9+]/g, '');
  const address = String(req.body.address || '').trim().slice(0, 300);
  const lat = req.body.lat == null || req.body.lat === '' ? NaN : Number(req.body.lat);
  const lng = req.body.lng == null || req.body.lng === '' ? NaN : Number(req.body.lng);
  const accuracy = Number(req.body.accuracy);
  const hasGps = validCoords(lat, lng);
  const status = hasGps ? 'gps' : (LOCATION_STATUSES.includes(req.body.location_status) ? req.body.location_status : 'unavailable');

  if (!customer_name?.trim())                        return res.json({ ok: false, error: 'Customer name is required.' });
  if (!phone || !/^(\+?91)?[6-9]\d{9}$/.test(phone)) return res.json({ ok: false, error: 'Phone number is required (10-digit mobile).' });
  if (!voice_note?.trim())                           return res.json({ ok: false, error: 'Voice note is required.' });
  if (!hasGps && !address)                           return res.json({ ok: false, error: 'GPS location is not available. Please type the visit address.' });

  const result = db.prepare(`INSERT INTO field_visits
      (user_id, customer_name, contact_person, phone, purpose, lat, lng, gps_accuracy, location_status, address, photo, remarks, voice_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.session.userId, customer_name.trim(), contact_person || '', phone, purpose || '',
         hasGps ? lat : null, hasGps ? lng : null, hasGps && Number.isFinite(accuracy) ? Math.round(accuracy) : null,
         status, address, photo || '', '', voice_note);

  auditLog(req.session.userId, 'site_visit_created', 'field_visits', result.lastInsertRowid, customer_name.trim());

  const visit = db.prepare('SELECT * FROM field_visits WHERE id=?').get(result.lastInsertRowid);
  res.json({ ok: true, visitId: `VIS-${String(result.lastInsertRowid).padStart(5,'0')}`, visit });
});

// ── My visits list ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid    = req.session.userId;
  const today  = new Date().toLocaleDateString('en-CA');
  const visits = db.prepare('SELECT * FROM field_visits WHERE user_id=? ORDER BY visit_time DESC LIMIT 50').all(uid);
  const todayCount = db.prepare("SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=?").get(uid, today).c;
  res.render('visits', { title: 'My Field Visits', visits, todayCount });
});

// ── Admin: all visits (manager + admin) ──────────────────────────────────────
router.get('/admin', requireManagerOrAdmin, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;
  const dateFilter = req.query.date ? req.query.date : null;
  const empFilter  = req.query.emp  ? parseInt(req.query.emp) : null;

  let where = '1=1';
  const params = [];
  if (dateFilter) { where += " AND date(fv.visit_time,'+330 minutes')=?"; params.push(dateFilter); }
  if (empFilter)  { where += ' AND fv.user_id=?'; params.push(empFilter); }

  const total  = db.prepare(`SELECT COUNT(*) AS c FROM field_visits fv WHERE ${where}`).get(...params).c;
  const visits = db.prepare(`
    SELECT fv.*, u.full_name AS emp_name, u.username
    FROM field_visits fv JOIN users u ON u.id = fv.user_id
    WHERE ${where} ORDER BY fv.visit_time DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const employees = db.prepare(`
    SELECT id, full_name, username FROM users
    WHERE is_hr_active=1 AND EXISTS (SELECT 1 FROM field_visits v WHERE v.user_id=users.id)
    ORDER BY full_name
  `).all();

  res.render('visits-admin', { title: 'All Site Visits', visits, total, page, limit, employees, dateFilter, empFilter });
});

module.exports = router;
