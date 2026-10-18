const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

function today() { return new Date().toLocaleDateString('en-CA'); }

// ── Save journey start (called immediately after check-in) ────────────────────
router.post('/journey/start', (req, res) => {
  const { km, photo, lat, lng } = req.body;
  const uid  = req.session.userId;
  const date = today();
  const now  = new Date().toISOString();

  db.prepare(`INSERT OR REPLACE INTO expense_journeys
    (user_id, date, start_km, start_photo, start_lat, start_lng, start_time)
    VALUES (?,?,?,?,?,?,?)`)
    .run(uid, date, parseFloat(km)||0, photo||null, lat||null, lng||null, now);

  res.json({ ok: true });
});

// ── Save journey end (called immediately after check-out) ─────────────────────
router.post('/journey/end', (req, res) => {
  const { km, photo, lat, lng } = req.body;
  const uid    = req.session.userId;
  const date   = today();
  const now    = new Date().toISOString();
  const endKm  = parseFloat(km) || 0;

  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);
  const totalKm = Math.max(0, endKm - (j?.start_km || 0));

  if (j) {
    db.prepare(`UPDATE expense_journeys
      SET end_km=?, end_photo=?, end_lat=?, end_lng=?, end_time=?, total_km=?
      WHERE id=?`)
      .run(endKm, photo||null, lat||null, lng||null, now, totalKm, j.id);
  } else {
    db.prepare(`INSERT INTO expense_journeys
      (user_id, date, end_km, end_photo, end_lat, end_lng, end_time, total_km)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid, date, endKm, photo||null, lat||null, lng||null, now, totalKm);
  }

  res.json({ ok: true, totalKm: totalKm.toFixed(1), startKm: j?.start_km || 0, endKm });
});

// ── Get today's journey (to show existing km on check-out) ────────────────────
router.get('/journey/today', (req, res) => {
  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?')
              .get(req.session.userId, today());
  res.json(j || {});
});

module.exports = router;
