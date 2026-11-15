// Travelling allowance (TA): odometer km × rate.
//   - Rate by vehicle and department: two-wheeler sales ₹3, service ₹2.5;
//     four-wheeler ₹5 (ta_rates). Other departments use expense_rates (vehicle only).
//   - Each person's vehicle is set once in their profile (users.vehicle_type).
//   - Yesterday's end km is today's start km: check-in is prefilled with it, and a
//     day left without an end reading is closed with the next day's start reading.
//   - The Head of Finance / admin can correct any day's start / end km.
const { db, auditLog, createNotification } = require('../db');
const { sectionOf } = require('./org');

const VEHICLES = ['Own Two Wheeler', 'Own Four Wheeler', 'Company Vehicle'];
const DEFAULT_VEHICLE = 'Own Two Wheeler';

const vehicleOf = (uid) => {
  const v = db.prepare('SELECT vehicle_type FROM users WHERE id=?').get(uid)?.vehicle_type;
  return VEHICLES.includes(v) ? v : DEFAULT_VEHICLE;
};

function rateFor(vehicle, department) {
  const dept = db.prepare('SELECT rate_per_km FROM ta_rates WHERE vehicle_type=? AND department=?').get(vehicle, department || '');
  if (dept) return dept.rate_per_km;
  return db.prepare('SELECT rate_per_km FROM expense_rates WHERE vehicle_type=?').get(vehicle)?.rate_per_km || 0;
}
const rateOfUser = (uid) => rateFor(vehicleOf(uid), sectionOf(uid));

// The last odometer reading before `date`: that day's end km, or its start km if it never closed
function lastKm(uid, date) {
  const j = db.prepare(`SELECT date, start_km, end_km FROM expense_journeys
    WHERE user_id=? AND date < ? AND (end_km > 0 OR start_km > 0) ORDER BY date DESC LIMIT 1`).get(uid, date);
  if (!j) return null;
  return { date: j.date, km: j.end_km > 0 ? j.end_km : j.start_km, closed: j.end_km > 0 };
}

// Today's start reading closes the last day that has no end reading
function carryOver(uid, date, startKm) {
  const prev = db.prepare(`SELECT * FROM expense_journeys WHERE user_id=? AND date < ? AND start_km > 0
    ORDER BY date DESC LIMIT 1`).get(uid, date);
  if (!prev || prev.end_km > 0 || !(startKm >= prev.start_km)) return null;
  const total = startKm - prev.start_km;
  db.prepare('UPDATE expense_journeys SET end_km=?, total_km=?, end_auto=1 WHERE id=?').run(startKm, total, prev.id);
  syncClaim(uid, prev.date);
  return { date: prev.date, end_km: startKm, total_km: total };
}

// Bring a day's claim (if any, and not yet approved) in line with the odometer
function syncClaim(uid, date) {
  const j = db.prepare('SELECT start_km, end_km FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);
  const c = db.prepare("SELECT * FROM travel_expenses WHERE user_id=? AND date=? AND status IN ('draft','submitted') ORDER BY id LIMIT 1").get(uid, date);
  if (!j || !c || !(j.start_km > 0) || !(j.end_km > 0)) return;
  const km = Math.max(0, j.end_km - j.start_km);
  const amount = Math.round(km * c.rate_per_km * 100) / 100;
  db.prepare('UPDATE travel_expenses SET start_odo=?, end_odo=?, distance_km=?, travel_amount=?, total_claim=? WHERE id=?')
    .run(j.start_km, j.end_km, km, amount, amount, c.id);
  refreshBill(uid, date);
}

// Keep a week's TA bill totals current after a change
function refreshBill(uid, date) {
  const b = db.prepare('SELECT * FROM ta_bills WHERE user_id=? AND ? BETWEEN week_start AND week_end').get(uid, date);
  if (!b) return;
  const t = db.prepare(`SELECT COUNT(*) trips, COALESCE(SUM(distance_km),0) km, COALESCE(SUM(total_claim),0) amount
    FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ? AND status != 'rejected'`).get(uid, b.week_start, b.week_end);
  db.prepare('UPDATE ta_bills SET trips=?, total_km=?, total_amount=? WHERE id=?').run(t.trips, t.km, t.amount, b.id);
}

// HoF / admin: correct a person's start / end km for a day
function editKm(uid, date, { start_km, end_km, note }, by) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { ok: false, message: 'Choose a valid date.' };
  const s = start_km === '' || start_km == null ? null : Number(start_km);
  const e = end_km === '' || end_km == null ? null : Number(end_km);
  if ((s !== null && !(s >= 0)) || (e !== null && !(e >= 0))) return { ok: false, message: 'Km must be a number.' };
  if (s !== null && e !== null && e < s) return { ok: false, message: 'Ending km cannot be less than starting km.' };
  if (!String(note || '').trim()) return { ok: false, message: 'Write the reason for the change.' };
  const bill = db.prepare('SELECT status FROM ta_bills WHERE user_id=? AND ? BETWEEN week_start AND week_end').get(uid, date);
  if (bill?.status === 'approved') return { ok: false, message: 'This week is already approved. Km can no longer be changed.' };
  if (db.prepare("SELECT 1 FROM travel_expenses WHERE user_id=? AND date=? AND status='approved'").get(uid, date))
    return { ok: false, message: 'The claim for this day is already approved. Km can no longer be changed.' };

  const before = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date);
  if (!before) db.prepare('INSERT INTO expense_journeys (user_id, date) VALUES (?, ?)').run(uid, date);
  const total = s !== null && e !== null ? e - s : null;
  db.prepare(`UPDATE expense_journeys SET start_km=?, end_km=?, total_km=?, end_auto=0, edited_by=?, edited_at=?, edit_note=?
    WHERE user_id=? AND date=?`).run(s, e, total, by, new Date().toISOString(), String(note).trim(), uid, date);
  syncClaim(uid, date);
  auditLog(by, 'km_edited', 'expense_journeys', `${uid}:${date}`,
    `${before?.start_km ?? '—'}→${s ?? '—'} / ${before?.end_km ?? '—'}→${e ?? '—'}: ${String(note).trim()}`);
  createNotification(uid, 'Km corrected', `${date}: start ${s ?? '—'} km, end ${e ?? '—'} km. ${String(note).trim()}`, 'expense', '/travel-expenses/my');
  return { ok: true, total_km: total };
}

module.exports = { VEHICLES, DEFAULT_VEHICLE, vehicleOf, rateFor, rateOfUser, lastKm, carryOver, syncClaim, refreshBill, editKm };
