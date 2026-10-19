const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');

// ── Log a field visit (JSON API) ──────────────────────────────────────────────
// Photo and customer name are mandatory. Location is the device GPS; if GPS is
// denied/unavailable the visit is saved without coordinates and a typed address
// is required instead — a location is never guessed.
const LOCATION_STATUSES = ['gps', 'denied', 'unavailable', 'timeout'];

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

router.post('/', (req, res) => {
  const { customer_name, contact_person, purpose, remarks, photo } = req.body;
  const phone   = String(req.body.phone || '').replace(/[^0-9+]/g, '');
  const address = String(req.body.address || '').trim().slice(0, 300);
  const lat = req.body.lat == null || req.body.lat === '' ? NaN : Number(req.body.lat);
  const lng = req.body.lng == null || req.body.lng === '' ? NaN : Number(req.body.lng);
  const accuracy = Number(req.body.accuracy);
  const hasGps = validCoords(lat, lng);
  const status = hasGps ? 'gps' : (LOCATION_STATUSES.includes(req.body.location_status) ? req.body.location_status : 'unavailable');

  if (!customer_name?.trim()) return res.json({ ok: false, error: 'Customer name is required.' });
  if (!photo)                 return res.json({ ok: false, error: 'Photo is required.' });
  if (phone && !/^(\+?91)?[6-9]\d{9}$/.test(phone)) return res.json({ ok: false, error: 'Enter a valid 10-digit mobile number (or leave it blank).' });
  if (!hasGps && !address)    return res.json({ ok: false, error: 'GPS location is not available. Please type the visit address.' });

  const result = db.prepare(`INSERT INTO field_visits
      (user_id, customer_name, contact_person, phone, purpose, lat, lng, gps_accuracy, location_status, address, photo, remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.session.userId, customer_name.trim(), contact_person || '', phone, purpose || '',
         hasGps ? lat : null, hasGps ? lng : null, hasGps && Number.isFinite(accuracy) ? Math.round(accuracy) : null,
         status, address, photo, remarks || '');

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

module.exports = router;
