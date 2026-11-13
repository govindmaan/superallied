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
