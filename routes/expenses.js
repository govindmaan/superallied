const express = require('express');
const router  = express.Router();
const { db, today }  = require('../db');
const { saveJourneyStart, saveJourneyEnd } = require('../lib/attendance');

// Journey start / end are normally saved with check-in / check-out
// (routes/attendance.js); these stay for older pages still open on phones.
router.post('/journey/start', (req, res) => {
  saveJourneyStart(req.session.userId, today(), req.body);
  res.json({ ok: true });
});

router.post('/journey/end', (req, res) => {
  res.json({ ok: true, ...saveJourneyEnd(req.session.userId, today(), req.body) });
});

// ── Get today's journey (to show existing km on check-out) ────────────────────
router.get('/journey/today', (req, res) => {
  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?')
              .get(req.session.userId, today());
  res.json(j || {});
});

module.exports = router;
