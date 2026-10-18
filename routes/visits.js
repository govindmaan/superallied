const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');

// ── Log a field visit (JSON API) ──────────────────────────────────────────────
// Photo is mandatory. customer_name is mandatory.
router.post('/', (req, res) => {
  const { customer_name, contact_person, purpose, remarks, lat, lng, photo } = req.body;

  if (!customer_name?.trim()) return res.json({ ok: false, error: 'Customer name is required.' });
  if (!photo)                 return res.json({ ok: false, error: 'Photo is required.' });

  const result = db.prepare(`INSERT INTO field_visits (user_id, customer_name, contact_person, purpose, lat, lng, photo, remarks)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.session.userId, customer_name.trim(), contact_person||'', purpose||'', lat||null, lng||null, photo, remarks||'');

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
