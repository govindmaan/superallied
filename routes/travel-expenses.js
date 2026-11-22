const express = require('express');
const path    = require('path');
const router  = express.Router();
const { db, auditLog, createNotification, nextExpenseNumber, numberToWords, today } = require('../db');
const { financeApproverIds, sectionOf } = require('../lib/org');
const { analyzeImage } = require('../services/expenseImageAnalyzer');
const ta = require('../lib/ta');

// Every department's expenses are approved by the Head of Finance (and admin).
function isApprover(res) { return res.locals.hasPerm('*') || res.locals.hasPerm('expense_approval'); }
function canApproveClaim(res) { return isApprover(res); }

// Proof of a working day, already captured elsewhere: the check-in / check-out
// selfies (attendance) and the start / end odometer photos (expense_journeys).
// Sales claims are only payable on a complete day; other departments aren't gated.
function dayProof(userId, date) {
  const att = db.prepare('SELECT check_in_time, check_in_photo, check_in_lat, check_in_lng, check_out_time, check_out_photo, check_out_lat, check_out_lng FROM attendance WHERE user_id=? AND date=?').get(userId, date) || {};
  const j   = db.prepare('SELECT start_km, start_photo, start_lat, start_lng, end_km, end_photo, end_lat, end_lng, total_km FROM expense_journeys WHERE user_id=? AND date=?').get(userId, date) || {};
  const missing = [];
  if (!att.check_in_photo)  missing.push('check-in selfie');
  if (!j.start_photo)       missing.push('start-of-day odometer photo');
  if (!att.check_out_photo) missing.push('check-out selfie');
  if (!j.end_photo)         missing.push('end-of-day odometer photo');
  return { att, journey: j, missing, complete: missing.length === 0 };
}
function requireClaimApprover(req, res, next) {
  if (canApproveClaim(res)) return next();
  req.session.flash = { error: 'Only the Head of Finance can approve expenses.' };
  res.redirect('/travel-expenses/' + req.params.id);
}
function canClaim(res) { return res.locals.hasPerm('*') || res.locals.hasPerm('expense_claim'); }
// New claims only for people whose travel allowance is on (admin, Employee form)
const taOn = (uid) => (db.prepare('SELECT ta_allowed FROM users WHERE id=?').get(uid)?.ta_allowed ?? 1) !== 0;
function requireTaAllowed(req, res, next) {
  if (taOn(req.session.userId)) return next();
  req.session.flash = { error: 'Travel allowance is not on for you. Ask the admin if you travel for work.' };
  res.redirect('/');
}

function requireClaimAccess(req, res, next) {
  if (canClaim(res)) return next();
  req.session.flash = { error: `You don't have permission to access Travel Expenses.` };
  res.redirect('/');
}
function requireApprover(req, res, next) {
  if (isApprover(res)) return next();
  req.session.flash = { error: `You don't have permission to approve expenses.` };
  res.redirect('/');
}

// ── Recalculate distance / amount server-side — never trust the client ───────
// Fuel/toll/parking/other capture is deferred to a later phase; the claim is
// travel (distance × rate) only for now. The columns stay in the schema so
// re-enabling them later doesn't need a migration.
// Rate comes from the person's vehicle (profile) and department: two-wheeler
// sales ₹3, service ₹2.5; four-wheeler ₹5 (lib/ta.js).
function recalc({ start_odo, end_odo, travel_type, department }) {
  const s = parseFloat(start_odo) || 0;
  const e = parseFloat(end_odo) || 0;
  const distance_km = Math.max(0, e - s);
  const rate_per_km = ta.rateFor(travel_type, department);
  const travel_amount = Math.round(distance_km * rate_per_km * 100) / 100;
  return { distance_km, rate_per_km, travel_amount, total_claim: travel_amount };
}

// ── Weekly lock & TA bill ─────────────────────────────────────────────────────
// A week is Monday–Saturday (a Sunday trip belongs to the week after it).
// Trips can be added, edited and submitted until Sunday 10:00 am India time.
// Then the week closes: sales / service days with meter km but no claim get one
// automatically, unsubmitted trips are submitted, a Travelling Allowance bill is
// prepared per person, and the weekly report goes to the person, the Head of
// Finance and admins. The Head of Finance / admin approve or reject the week.
const TA_POLICY_START = process.env.TA_POLICY_START || '2026-10-18';   // first week the lock applies to

function weekOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'), dow = d.getUTCDay();
  const start = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
  const end   = new Date(d.getTime() + (6 - dow) * 86400000).toISOString().slice(0, 10);
  const sunday = new Date(d.getTime() + (7 - dow) * 86400000).toISOString().slice(0, 10);
  return { start, end, lockAt: new Date(`${sunday}T10:00:00+05:30`) };
}
function isLocked(dateStr) {
  return !!dateStr && dateStr >= TA_POLICY_START && Date.now() >= weekOf(dateStr).lockAt.getTime();
}
const fmtD = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const lockedMsg = d => `The week of ${fmtD(weekOf(d).start)}–${fmtD(weekOf(d).end)} closed on Sunday 10:00 am and can no longer be changed.`;
// Days with meter km become claims automatically from this week on (earlier weeks are left as they were)
const TA_AUTO_START = process.env.TA_AUTO_START || '2026-11-15';

function nextBillNo(year) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM ta_bills WHERE bill_no LIKE ?").get(`TA-${year}-%`).c;
  return `TA-${year}-${String(n + 1).padStart(4, '0')}`;
}

// Sales / service days with meter km and no claim get one at the weekly close
function autoClaims() {
  const days = db.prepare(`SELECT j.* FROM expense_journeys j
    WHERE j.date >= ? AND j.total_km > 0
      AND NOT EXISTS (SELECT 1 FROM travel_expenses te WHERE te.user_id=j.user_id AND te.date=j.date)
      AND COALESCE((SELECT ta_allowed FROM users u WHERE u.id=j.user_id), 1) <> 0`).all(TA_AUTO_START)
    .filter(j => isLocked(j.date) && ['Sales', 'Service'].includes(sectionOf(j.user_id)))
    .filter(j => !db.prepare('SELECT 1 FROM ta_bills WHERE user_id=? AND week_start=?').get(j.user_id, weekOf(j.date).start));
  days.forEach(addAutoClaim);
}
// After a km correction on a closed week: a sales / service day that now has km
// but no claim gets one, so it is counted in the weekly bill
function claimAfterCorrection(uid, date) {
  if (date < TA_AUTO_START || !isLocked(date) || !['Sales', 'Service'].includes(sectionOf(uid)) || !taOn(uid)) return;
  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=? AND total_km > 0').get(uid, date);
  if (!j || db.prepare('SELECT 1 FROM travel_expenses WHERE user_id=? AND date=?').get(uid, date)) return;
  addAutoClaim(j);
  ta.refreshBill(uid, date);
}
function addAutoClaim(j) {
  const department = sectionOf(j.user_id), vehicle = ta.vehicleOf(j.user_id);
  const c = recalc({ start_odo: j.start_km, end_odo: j.end_km, travel_type: vehicle, department });
  const vn = db.prepare('SELECT vehicle_number FROM users WHERE id=?').get(j.user_id)?.vehicle_number || '';
  const at = weekOf(j.date).lockAt.toISOString().replace('T', ' ').slice(0, 19);
  const r = db.prepare(`INSERT INTO travel_expenses (expense_number,user_id,date,travel_type,vehicle_number,purpose,start_odo,end_odo,
      distance_km,rate_per_km,travel_amount,total_claim,remarks,department,status,submitted_at,auto)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,1)`)
    .run(nextExpenseNumber(), j.user_id, j.date, vehicle, vn, 'Field travel', j.start_km, j.end_km,
      c.distance_km, c.rate_per_km, c.travel_amount, c.total_claim, 'Added from meter readings at the weekly close', department, at);
  auditLog(j.user_id, 'expense_auto_created', 'travel_expenses', r.lastInsertRowid, `${j.date}: ${c.distance_km} km`);
}

// Lock every week whose deadline has passed: add missing claims from the meter,
// auto-submit drafts, prepare one TA bill per person, then send the weekly report.
// Safe to run any number of times.
function closeLockedWeeks() {
  autoClaims();
  const drafts = db.prepare("SELECT * FROM travel_expenses WHERE status='draft' AND date >= ?").all(TA_POLICY_START).filter(x => isLocked(x.date));
  drafts.forEach(x => {
    const at = weekOf(x.date).lockAt.toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("UPDATE travel_expenses SET status='submitted', submitted_at=? WHERE id=? AND status='draft'").run(at, x.id);
    auditLog(x.user_id, 'expense_auto_submitted', 'travel_expenses', x.id, `${x.expense_number} submitted at weekly lock`);
  });

  const weeks = new Map();
  db.prepare('SELECT DISTINCT user_id, date FROM travel_expenses WHERE date >= ?').all(TA_POLICY_START).forEach(r => {
    if (!isLocked(r.date)) return;
    const w = weekOf(r.date);
    weeks.set(`${r.user_id}|${w.start}`, { user_id: r.user_id, ...w });
  });
  const fresh = new Map();   // week start → new bills, for the report
  for (const w of weeks.values()) {
    if (db.prepare('SELECT 1 FROM ta_bills WHERE user_id=? AND week_start=?').get(w.user_id, w.start)) continue;
    const t = db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS km, COALESCE(SUM(total_claim),0) AS amount
      FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ? AND status != 'rejected'`).get(w.user_id, w.start, w.end);
    const billNo = nextBillNo(w.end.slice(0, 4));
    const r = db.prepare("INSERT INTO ta_bills (bill_no, user_id, week_start, week_end, trips, total_km, total_amount, status) VALUES (?,?,?,?,?,?,?,'pending')")
      .run(billNo, w.user_id, w.start, w.end, t.trips, t.km, t.amount);
    createNotification(w.user_id, 'Weekly travel report',
      `${fmtD(weekMon(w.start))}–${fmtD(w.end)}: ${t.km.toFixed(0)} km, ₹${t.amount.toFixed(0)} (${billNo}). Waiting for Head of Finance approval.`,
      'expense', '/travel-expenses/bills/' + r.lastInsertRowid);
    if (!fresh.has(w.start)) fresh.set(w.start, { end: w.end, people: 0, km: 0, amount: 0 });
    const f = fresh.get(w.start); f.people++; f.km += t.km; f.amount += t.amount;
  }
  // One summary per week to the Head of Finance and admins
  for (const [start, f] of fresh) {
    require('../lib/attendance').editorIds().forEach(id => createNotification(id, 'Weekly travel report',
      `${fmtD(weekMon(start))}–${fmtD(f.end)}: ${f.people} people, ${f.km.toFixed(0)} km, ₹${f.amount.toFixed(0)}. Review and approve each week.`,
      'expense', '/travel-expenses/bills?week=' + start));
  }
}
const weekMon = (start) => new Date(Date.parse(start + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

router.closeLockedWeeks = closeLockedWeeks;   // for tests
router.weekOf = weekOf;
// Run on every travel-expense request and every minute, so the Sunday 10:00 report is on time
router.use((req, res, next) => { try { closeLockedWeeks(); } catch (e) { console.error('TA weekly lock:', e.message); } next(); });
setInterval(() => { try { closeLockedWeeks(); } catch (e) { console.error('TA weekly lock:', e.message); } }, 60000).unref();

router.get('/', (req, res) => res.redirect('/travel-expenses/my'));

// ── New expense form ──────────────────────────────────────────────────────────
// Start / end km filled in from the day's meter readings (start falls back to the last reading)
function prefillKm(uid, date) {
  const j = db.prepare('SELECT start_km, end_km FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date) || {};
  const p = { start: j.start_km > 0 ? j.start_km : '', end: j.end_km > 0 ? j.end_km : '', startFrom: '' };
  if (p.start) p.startFrom = 'From your check-in meter reading';
  else { const last = ta.lastKm(uid, date); if (last) { p.start = last.km; p.startFrom = `Your last reading (${fmtD(last.date)})`; } }
  return p;
}
const formLocals = (uid, date) => {
  const vehicle = ta.vehicleOf(uid);
  return { vehicle, rate: ta.rateFor(vehicle, sectionOf(uid)), today: today(),
    user: db.prepare('SELECT * FROM users WHERE id=?').get(uid),
    todaysVisits: db.prepare("SELECT * FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=? ORDER BY visit_time").all(uid, date) };
};

router.get('/new', requireClaimAccess, requireTaAllowed, (req, res) => {
  const uid = req.session.userId;
  let date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') && req.query.date <= today() ? req.query.date : today();
  if (isLocked(date)) { req.session.flash = { error: lockedMsg(date) }; date = today(); }
  const existing = db.prepare("SELECT id FROM travel_expenses WHERE user_id=? AND date=? AND status IN ('draft','rejected')").get(uid, date);
  if (existing) return res.redirect(`/travel-expenses/${existing.id}/edit`);
  res.render('travel-expenses/new', {
    title: 'New Travel Expense', expense: null, docs: [], linkedVisitIds: [],
    ...formLocals(uid, date), prefill: prefillKm(uid, date), todayStr: date,
  });
});

// ── Edit an existing draft/rejected expense ───────────────────────────────────
router.get('/:id/edit', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  if (!['draft','rejected'].includes(expense.status)) {
    req.session.flash = { error: `This expense is ${expense.status} and can no longer be edited.` };
    return res.redirect('/travel-expenses/' + expense.id);
  }
  if (isLocked(expense.date)) { req.session.flash = { error: lockedMsg(expense.date) }; return res.redirect('/travel-expenses/' + expense.id); }
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id);
  const linkedVisitIds = db.prepare('SELECT visit_id FROM expense_visit_links WHERE expense_id=?').all(expense.id).map(r => r.visit_id);

  res.render('travel-expenses/new', {
    title: 'Edit Travel Expense', expense, docs, linkedVisitIds,
    ...formLocals(uid, expense.date), prefill: {}, todayStr: expense.date,
  });
});

// ── Create / update (always saved as draft) ───────────────────────────────────
router.post('/', requireClaimAccess, requireTaAllowed, (req, res) => {
  const uid = req.session.userId;
  const { id, date, purpose, start_odo, end_odo, remarks, visit_ids } = req.body;
  const travel_type = ta.vehicleOf(uid);   // from the profile, never from the form
  const department = sectionOf(uid);

  const tripDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today();
  if (isLocked(tripDate)) {
    req.session.flash = { error: lockedMsg(tripDate) };
    return res.redirect(id ? `/travel-expenses/${id}` : '/travel-expenses/my');
  }
  const s = parseFloat(start_odo) || 0;
  const e = parseFloat(end_odo) || 0;
  if (e < s) {
    req.session.flash = { error: 'Ending odometer cannot be lower than starting odometer.' };
    return res.redirect(id ? `/travel-expenses/${id}/edit` : '/travel-expenses/new');
  }

  // Vehicle number is the employee's stationary vehicle number from their
  // profile — never taken from the submitted form, so it can't be spoofed
  // or drift trip-to-trip.
  const profileVehicleNumber = db.prepare('SELECT vehicle_number FROM users WHERE id=?').get(uid)?.vehicle_number || '';

  const { distance_km, rate_per_km, travel_amount, total_claim } = recalc({ start_odo: s, end_odo: e, travel_type, department });

  let expenseId = id ? +id : null;

  if (expenseId) {
    const existing = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(expenseId);
    if (!existing || existing.user_id !== uid || !['draft','rejected'].includes(existing.status) || isLocked(existing.date)) {
      req.session.flash = { error: existing && isLocked(existing.date) ? lockedMsg(existing.date) : 'This expense can no longer be edited.' };
      return res.redirect('/travel-expenses/my');
    }
    db.prepare(`UPDATE travel_expenses SET date=?,travel_type=?,vehicle_number=?,purpose=?,
      start_odo=?,end_odo=?,distance_km=?,rate_per_km=?,travel_amount=?,
      total_claim=?,remarks=?,status='draft' WHERE id=?`)
      .run(tripDate, travel_type||'Own Two Wheeler', profileVehicleNumber, purpose||'',
        s, e, distance_km, rate_per_km, travel_amount,
        total_claim, remarks||'', expenseId);
  } else {
    const result = db.prepare(`INSERT INTO travel_expenses
      (expense_number,user_id,date,travel_type,vehicle_number,purpose,start_odo,end_odo,distance_km,rate_per_km,
       travel_amount,total_claim,remarks,department,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`)
      .run(nextExpenseNumber(), uid, tripDate, travel_type||'Own Two Wheeler', profileVehicleNumber, purpose||'',
        s, e, distance_km, rate_per_km, travel_amount,
        total_claim, remarks||'', sectionOf(uid));
    expenseId = result.lastInsertRowid;
    auditLog(uid, 'expense_created', 'travel_expenses', expenseId, `Distance ${distance_km}km`);
  }

  // Re-link selected site visits
  db.prepare('DELETE FROM expense_visit_links WHERE expense_id=?').run(expenseId);
  const ids = Array.isArray(visit_ids) ? visit_ids : (visit_ids ? [visit_ids] : []);
  const linkStmt = db.prepare('INSERT OR IGNORE INTO expense_visit_links (expense_id, visit_id) VALUES (?,?)');
  ids.forEach(vid => { if (+vid) linkStmt.run(expenseId, +vid); });

  if (distance_km > 300) {
    req.session.flash = { success: `Draft saved. Note: ${distance_km}km is a large single-day distance — please double-check your odometer readings before submitting.` };
  } else {
    req.session.flash = { success: 'Draft saved.' };
  }
  res.redirect('/travel-expenses/' + expenseId);
});

// ── Upload a receipt/document for an expense ──────────────────────────────────
router.post('/:id/documents', requireClaimAccess, async (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) return res.json({ ok: false, error: 'Expense not found.' });
  if (!['draft','rejected'].includes(expense.status) || isLocked(expense.date)) return res.json({ ok: false, error: 'This expense can no longer be edited.' });

  const { doc_type, file_path } = req.body;
  if (!file_path) return res.json({ ok: false, error: 'No file uploaded.' });

  const result = db.prepare('INSERT INTO expense_documents (expense_id, doc_type, file_path) VALUES (?,?,?)')
    .run(expense.id, doc_type||'other', file_path);

  const UPLOADS_DIR = res.app.locals.UPLOADS_DIR;
  const localPath = path.join(UPLOADS_DIR, file_path.replace('/uploads/', ''));
  const extracted = await analyzeImage(localPath);
  db.prepare('UPDATE expense_documents SET ocr_json=? WHERE id=?').run(JSON.stringify(extracted), result.lastInsertRowid);

  res.json({ ok: true, docId: result.lastInsertRowid, extracted });
});

router.post('/documents/:docId/delete', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const doc = db.prepare('SELECT ed.*, te.user_id, te.status, te.date FROM expense_documents ed JOIN travel_expenses te ON te.id=ed.expense_id WHERE ed.id=?').get(req.params.docId);
  if (!doc || doc.user_id !== uid) return res.json({ ok: false });
  if (!['draft','rejected'].includes(doc.status) || isLocked(doc.date)) return res.json({ ok: false, error: 'Cannot modify a submitted or locked expense.' });
  db.prepare('DELETE FROM expense_documents WHERE id=?').run(doc.id);
  res.json({ ok: true });
});

// ── Submit for approval ───────────────────────────────────────────────────────
router.post('/:id/submit', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  if (!['draft','rejected'].includes(expense.status)) {
    req.session.flash = { error: `This expense is already ${expense.status}.` };
    return res.redirect('/travel-expenses/' + expense.id);
  }
  if (isLocked(expense.date)) { req.session.flash = { error: lockedMsg(expense.date) }; return res.redirect('/travel-expenses/' + expense.id); }

  // Sales & Service are mandatory-gated: the day must be complete (check-in/out
  // selfies + start/end odometer photos) with a purpose. Service additionally
  // needs a visited complaint that day — no site visit, no travel allowance.
  const dept = expense.department || sectionOf(uid);
  if (dept === 'Sales' || dept === 'Service') {
    if (!(expense.purpose || '').trim()) {
      req.session.flash = { error: 'A purpose is required on this expense.' };
      return res.redirect('/travel-expenses/' + expense.id + '/edit');
    }
    const proof = dayProof(uid, expense.date);
    if (!proof.complete) {
      req.session.flash = { error: `Complete your day first — missing: ${proof.missing.join(', ')}.` };
      return res.redirect('/travel-expenses/' + expense.id);
    }
    if (dept === 'Service') {
      const visited = db.prepare('SELECT COUNT(*) c FROM complaint_visits WHERE engineer_id=? AND visit_date=?').get(uid, expense.date).c;
      if (!visited) {
        req.session.flash = { error: 'Service travel allowance needs a complaint you visited on this date. Record the site visit (plate photo) on the complaint first.' };
        return res.redirect('/travel-expenses/' + expense.id);
      }
    }
  }

  db.prepare(`UPDATE travel_expenses SET status='submitted', submitted_at=CURRENT_TIMESTAMP,
    approved_by=NULL, approved_at=NULL, approval_remarks='' WHERE id=?`).run(expense.id);
  auditLog(uid, 'expense_submitted', 'travel_expenses', expense.id, expense.expense_number);

  // Route to the Head of Finance (Level 1 — owner/admins — while the seat is vacant)
  const user = db.prepare('SELECT full_name FROM users WHERE id=?').get(uid);
  financeApproverIds().forEach(id => createNotification(id, `Travel Expense Submitted — ${expense.expense_number}`,
    `${user.full_name} submitted a travel expense claim of ₹${expense.total_claim.toFixed(0)}.`, 'expense', '/travel-expenses/' + expense.id));

  req.session.flash = { success: `Expense ${expense.expense_number} submitted for approval.` };
  res.redirect('/travel-expenses/' + expense.id);
});

// ── My Expenses (tabs) ────────────────────────────────────────────────────────
router.get('/my', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const { status } = req.query;
  let sql = 'SELECT * FROM travel_expenses WHERE user_id=?';
  const params = [uid];
  if (status && status !== 'all') { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY date DESC, id DESC';
  const expenses = db.prepare(sql).all(...params);

  const counts = db.prepare(`SELECT status, COUNT(*) as c FROM travel_expenses WHERE user_id=? GROUP BY status`).all(uid)
    .reduce((a, r) => { a[r.status] = r.c; return a; }, {});

  const monthStart = new Date().toLocaleDateString('en-CA').slice(0, 7);
  const monthRows = db.prepare(`SELECT status, SUM(distance_km) as km, SUM(travel_amount) as travel, SUM(total_claim) as total
    FROM travel_expenses WHERE user_id=? AND date LIKE ? GROUP BY status`).all(uid, monthStart + '%');

  const monthSummary = { km: 0, travel: 0, total: 0, submitted: 0, approved: 0, pending: 0 };
  monthRows.forEach(r => {
    monthSummary.km += r.km || 0; monthSummary.travel += r.travel || 0; monthSummary.total += r.total || 0;
    if (r.status === 'submitted') monthSummary.submitted += r.total || 0;
    if (r.status === 'approved')  monthSummary.approved  += r.total || 0;
    if (r.status === 'submitted') monthSummary.pending    += r.total || 0;
  });

  const wk = weekOf(today());
  const week = { start: fmtD(weekMon(wk.start)), end: fmtD(wk.end), lockAt: wk.lockAt.toISOString(),
                 ...db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS km, COALESCE(SUM(total_claim),0) AS amount,
                   SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts
                   FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ?`).get(uid, wk.start, wk.end) };
  expenses.forEach(x => { x.locked = isLocked(x.date); });
  res.render('travel-expenses/list', { title: 'My Travel Expenses', expenses, counts, statusFilter: status||'all', monthSummary, week });
});

// ── Approval queue (must be registered before the generic /:id route below) ──
// Head of Finance / admin: every claim, by status (pending first), employee and month
const QUEUE_TABS = ['submitted', 'approved', 'rejected', 'all'];
router.get('/queue', requireApprover, (req, res) => {
  const status = QUEUE_TABS.includes(req.query.status) ? req.query.status : 'submitted';
  const user = +req.query.user || 0;
  const month = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : '';
  const where = ["te.status != 'draft'"], params = [];
  if (status !== 'all') { where.push('te.status=?'); params.push(status); }
  if (user) { where.push('te.user_id=?'); params.push(user); }
  if (month) { where.push('te.date LIKE ?'); params.push(month + '%'); }
  const rows = db.prepare(`SELECT te.*, u.full_name, u.employee_code, COALESCE(a.full_name, a.username) AS approver_name
    FROM travel_expenses te JOIN users u ON u.id=te.user_id LEFT JOIN users a ON a.id=te.approved_by
    WHERE ${where.join(' AND ')}
    ORDER BY ${status === 'submitted' ? 'te.submitted_at ASC' : 'te.date DESC, te.id DESC'} LIMIT 500`).all(...params);
  // tab counts follow the employee / month filters
  const cw = ["status != 'draft'"], cp = [];
  if (user) { cw.push('user_id=?'); cp.push(user); }
  if (month) { cw.push('date LIKE ?'); cp.push(month + '%'); }
  const counts = { all: 0 };
  db.prepare(`SELECT status, COUNT(*) c FROM travel_expenses WHERE ${cw.join(' AND ')} GROUP BY status`).all(...cp)
    .forEach(r => { counts[r.status] = r.c; counts.all += r.c; });
  const totals = { km: rows.reduce((a, r) => a + (r.distance_km || 0), 0), amount: rows.reduce((a, r) => a + (r.total_claim || 0), 0) };
  const employees = db.prepare(`SELECT DISTINCT u.id, u.full_name, u.username FROM users u JOIN travel_expenses te ON te.user_id=u.id
    WHERE te.status != 'draft' ORDER BY u.full_name`).all();
  res.render('travel-expenses/queue', { title: 'Expense Approvals', rows, counts, totals, employees,
    filter: { status, user, month }, back: req.originalUrl });
});
// After approve / reject from the list, go back to the same filtered list
const backTo = (req, fallback) => (typeof req.body.back === 'string' && req.body.back.startsWith('/travel-expenses/queue')) ? req.body.back : fallback;

// ── Rate configuration — also registered before /:id (two segments is safe,
// but keeping it here for readability alongside /queue) ──────────────────────
const canSetRates = (res) => isApprover(res) || ['admin', 'manager'].includes(res.locals.user?.role);
router.get('/admin/rates', (req, res) => {
  if (!canSetRates(res)) { req.session.flash = { error: 'Admin, Manager or Head of Finance access required.' }; return res.redirect('/'); }
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  const taRates = db.prepare("SELECT * FROM ta_rates ORDER BY department, CASE vehicle_type WHEN 'Own Two Wheeler' THEN 1 WHEN 'Own Four Wheeler' THEN 2 ELSE 3 END").all();
  res.render('travel-expenses/rates', { title: 'Expense Rate Configuration', rates, taRates });
});

router.post('/admin/rates', (req, res) => {
  if (!canSetRates(res)) { req.session.flash = { error: 'Admin, Manager or Head of Finance access required.' }; return res.redirect('/'); }
  const { vehicle_type, rate_per_km, ta_id, ta_rate } = req.body;
  const types = Array.isArray(vehicle_type) ? vehicle_type : (vehicle_type ? [vehicle_type] : []);
  const rateVals = Array.isArray(rate_per_km) ? rate_per_km : [rate_per_km];
  types.forEach((vt, i) => {
    db.prepare('UPDATE expense_rates SET rate_per_km=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE vehicle_type=?')
      .run(parseFloat(rateVals[i])||0, req.session.userId, vt);
  });
  const taIds = Array.isArray(ta_id) ? ta_id : (ta_id ? [ta_id] : []);
  const taVals = Array.isArray(ta_rate) ? ta_rate : [ta_rate];
  taIds.forEach((id, i) => db.prepare('UPDATE ta_rates SET rate_per_km=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(parseFloat(taVals[i]) || 0, req.session.userId, +id));
  auditLog(req.session.userId, 'expense_rates_updated', 'expense_rates', '', JSON.stringify(req.body));
  req.session.flash = { success: 'Reimbursement rates updated.' };
  res.redirect('/travel-expenses/admin/rates');
});

// ── TA bills ──────────────────────────────────────────────────────────────────
// Owners see their own bills; approvers see everyone's.
function billData(req, res) {
  const bill = db.prepare(`SELECT b.*, u.full_name, u.employee_code, u.designation, u.vehicle_number, u.mobile
    FROM ta_bills b JOIN users u ON u.id = b.user_id WHERE b.id=?`).get(req.params.id);
  if (!bill || (bill.user_id !== req.session.userId && !isApprover(res))) return null;
  const trips = db.prepare(`SELECT * FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date, id`)
    .all(bill.user_id, bill.week_start, bill.week_end);
  const counted  = trips.filter(t => t.status !== 'rejected');
  const approved = trips.filter(t => t.status === 'approved');
  const payments = db.prepare('SELECT * FROM travel_payments WHERE ta_bill_id=? ORDER BY paid_on').all(bill.id);
  // Day by day: meter readings and photos next to the claims, with anything worth a look
  const service = sectionOf(bill.user_id) === 'Service';
  const days = [];
  for (let d = bill.week_start; d <= bill.week_end; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(bill.user_id, d);
    const dayTrips = trips.filter(t => t.date === d);
    if (!j && !dayTrips.length && new Date(d + 'T00:00:00Z').getUTCDay() === 0) continue;   // quiet Sunday
    const flags = [];
    if (j && !j.start_photo) flags.push('No start meter photo');
    if (j && j.end_km > 0 && !j.end_photo && !j.end_auto) flags.push('No end meter photo');
    if (j?.end_auto) flags.push('End km from next day\'s start');
    if (j?.edited_by) flags.push('Km corrected');
    if (dayTrips.some(t => t.auto)) flags.push('Added from meter');
    if (j && j.start_km > 0 && !(j.end_km > 0)) flags.push('No end km');
    if (service && dayTrips.length && !db.prepare('SELECT 1 FROM complaint_visits WHERE engineer_id=? AND visit_date=?').get(bill.user_id, d)) flags.push('No complaint visit');
    const meterKm = j && j.start_km > 0 && j.end_km > 0 ? j.end_km - j.start_km : null;
    if (meterKm !== null && dayTrips.length && Math.abs(dayTrips.reduce((a, t) => a + (t.status === 'rejected' ? 0 : t.distance_km), 0) - meterKm) > 0.5) flags.push('Claim km differs from meter');
    days.push({ date: d, j, trips: dayTrips, flags, meterKm });
  }
  const decider = bill.decided_by ? db.prepare('SELECT full_name, username FROM users WHERE id=?').get(bill.decided_by) : null;
  return {
    bill, trips, payments, days, decider,
    totals: {
      paid: payments.reduce((a, p) => a + p.amount, 0),
      km: counted.reduce((a, t) => a + t.distance_km, 0), amount: counted.reduce((a, t) => a + t.total_claim, 0),
      approved: approved.reduce((a, t) => a + t.total_claim, 0),
      pending: trips.filter(t => t.status === 'submitted').length, rejected: trips.length - counted.length,
    },
    period: `${fmtD(weekMon(bill.week_start))} – ${fmtD(bill.week_end)} ${bill.week_end.slice(0, 4)}`,
  };
}

router.get('/bills', (req, res) => {
  if (!canClaim(res) && !isApprover(res)) { req.session.flash = { error: `You don't have permission to view TA bills.` }; return res.redirect('/'); }
  const all = isApprover(res);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : '';
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const where = [], params = [];
  if (!all) { where.push('b.user_id = ?'); params.push(req.session.userId); }
  if (week) { where.push('b.week_start = ?'); params.push(week); }
  if (status) { where.push('b.status = ?'); params.push(status); }
  const bills = db.prepare(`SELECT b.*, u.full_name FROM ta_bills b JOIN users u ON u.id = b.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.week_start DESC, u.full_name`).all(...params);
  const weeks = db.prepare(`SELECT week_start, week_end, COUNT(*) n, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
    FROM ta_bills ${all ? '' : 'WHERE user_id = ?'} GROUP BY week_start ORDER BY week_start DESC LIMIT 12`).all(...(all ? [] : [req.session.userId]));
  const wk = weekOf(today());
  res.render('travel-expenses/bills', { title: 'TA Bills', bills, all, fmtD, weekMon, weeks, filter: { week, status },
    current: { start: fmtD(weekMon(wk.start)), end: fmtD(wk.end), lockAt: wk.lockAt.toISOString() } });
});

// Head of Finance / admin: approve or reject a person's whole week
router.post('/bills/:id/decide', (req, res) => {
  if (!isApprover(res)) { req.session.flash = { error: 'Only the Head of Finance or an admin can approve a week.' }; return res.redirect('/travel-expenses/bills'); }
  const bill = db.prepare('SELECT * FROM ta_bills WHERE id=?').get(req.params.id);
  if (!bill) { req.session.flash = { error: 'TA bill not found.' }; return res.redirect('/travel-expenses/bills'); }
  const action = req.body.action, note = String(req.body.note || '').trim(), uid = req.session.userId;
  if (bill.status === 'approved') { req.session.flash = { error: 'This week is already approved.' }; return res.redirect('/travel-expenses/bills/' + bill.id); }
  if (action === 'reject' && !note) { req.session.flash = { error: 'Write why the week is rejected.' }; return res.redirect('/travel-expenses/bills/' + bill.id); }
  if (!['approve', 'reject'].includes(action)) return res.redirect('/travel-expenses/bills/' + bill.id);
  if (action === 'approve') {
    db.prepare(`UPDATE travel_expenses SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=?
      WHERE user_id=? AND date BETWEEN ? AND ? AND status IN ('draft','submitted')`).run(uid, note || 'Week approved', bill.user_id, bill.week_start, bill.week_end);
  } else {
    db.prepare(`UPDATE travel_expenses SET status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=?
      WHERE user_id=? AND date BETWEEN ? AND ? AND status IN ('draft','submitted')`).run(uid, note, bill.user_id, bill.week_start, bill.week_end);
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE ta_bills SET status=?, decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_note=? WHERE id=?').run(status, uid, note, bill.id);
  ta.refreshBill(bill.user_id, bill.week_start);
  const b = db.prepare('SELECT * FROM ta_bills WHERE id=?').get(bill.id);
  auditLog(uid, 'ta_week_' + status, 'ta_bills', bill.id, note);
  createNotification(bill.user_id, status === 'approved' ? 'Weekly travel approved' : 'Weekly travel rejected',
    `${fmtD(weekMon(bill.week_start))}–${fmtD(bill.week_end)}: ${b.total_km.toFixed(0)} km, ₹${b.total_amount.toFixed(0)}${note ? '. ' + note : ''}`,
    'expense', '/travel-expenses/bills/' + bill.id);
  req.session.flash = { success: status === 'approved' ? 'Week approved.' : 'Week rejected.' };
  res.redirect(typeof req.body.back === 'string' && req.body.back.startsWith('/travel-expenses/bills') ? req.body.back : '/travel-expenses/bills/' + bill.id);
});

// Head of Finance / admin: correct a person's start / end km for a day
router.get('/km/:uid/:date', requireApprover, (req, res) => {
  const emp = db.prepare('SELECT id, full_name, username, employee_code, vehicle_type FROM users WHERE id=?').get(+req.params.uid);
  if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) { req.session.flash = { error: 'Employee not found.' }; return res.redirect('/travel-expenses/bills'); }
  const date = req.params.date;
  const j = db.prepare('SELECT j.*, COALESCE(e.full_name, e.username) AS edited_by_name FROM expense_journeys j LEFT JOIN users e ON e.id=j.edited_by WHERE j.user_id=? AND j.date=?').get(emp.id, date);
  const prev = db.prepare('SELECT date, end_km, start_km FROM expense_journeys WHERE user_id=? AND date<? ORDER BY date DESC LIMIT 1').get(emp.id, date);
  const next = db.prepare('SELECT date, start_km FROM expense_journeys WHERE user_id=? AND date>? ORDER BY date LIMIT 1').get(emp.id, date);
  const claim = db.prepare('SELECT * FROM travel_expenses WHERE user_id=? AND date=? ORDER BY id LIMIT 1').get(emp.id, date);
  const bill = db.prepare('SELECT * FROM ta_bills WHERE user_id=? AND ? BETWEEN week_start AND week_end').get(emp.id, date);
  res.render('travel-expenses/km-edit', { title: 'Correct km', emp, date, j, prev, next, claim, bill, fmtD,
    rate: ta.rateOfUser(emp.id), vehicle: ta.vehicleOf(emp.id), back: typeof req.query.back === 'string' && req.query.back.startsWith('/') ? req.query.back : '' });
});
router.post('/km/:uid/:date', requireApprover, (req, res) => {
  const r = ta.editKm(+req.params.uid, req.params.date, req.body, req.session.userId);
  if (r.ok) claimAfterCorrection(+req.params.uid, req.params.date);
  req.session.flash = r.ok ? { success: 'Km updated. The claim and the weekly bill are recalculated.' } : { error: r.message };
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') ? req.body.back : '';
  res.redirect(r.ok && back ? back : `/travel-expenses/km/${+req.params.uid}/${req.params.date}${back ? '?back=' + encodeURIComponent(back) : ''}`);
});

// ── Correct KM: many days at once ─────────────────────────────────────────────
// Head of Finance / admin fix wrong readings either for one employee across a week
// (Mon–Sat) or for everyone on one date. Approved days are shown but locked.
const addDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function kmRow(uid, date) {
  const j = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, date) || {};
  const claims = db.prepare('SELECT id, expense_number, status, distance_km, total_claim FROM travel_expenses WHERE user_id=? AND date=? ORDER BY id').all(uid, date);
  const bill = db.prepare('SELECT status FROM ta_bills WHERE user_id=? AND ? BETWEEN week_start AND week_end').get(uid, date);
  const locked = bill?.status === 'approved' || claims.some(c => c.status === 'approved');
  const km = j.start_km > 0 && j.end_km > 0 ? j.end_km - j.start_km : null;
  return { date, j, claims, locked, km, claimKm: claims.filter(c => c.status !== 'rejected').reduce((a, c) => a + c.distance_km, 0) };
}

router.get('/km-grid', requireApprover, (req, res) => {
  const mode = req.query.mode === 'day' ? 'day' : 'employee';
  const isD = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const people = db.prepare(`SELECT u.id, u.full_name, u.username, u.employee_code, p.section
    FROM users u LEFT JOIN org_positions p ON p.code=u.position_code
    WHERE COALESCE(u.is_hr_active,1)=1 ORDER BY CASE WHEN p.section IN ('Sales','Service') THEN 0 ELSE 1 END, u.full_name`).all();
  let rows = [], emp = null, week = null, date = null;
  if (mode === 'employee') {
    emp = people.find(p => p.id === +req.query.user) || null;
    week = weekOf(isD(req.query.week) ? req.query.week : today());
    if (emp) {
      for (let d = week.start; d <= week.end; d = addDay(d, 1)) {
        const r = kmRow(emp.id, d);
        if (new Date(d + 'T00:00:00Z').getUTCDay() === 0 && !r.j.start_km && !r.j.end_km && !r.claims.length) continue;   // quiet Sunday
        rows.push({ ...r, uid: emp.id, label: d });
      }
    }
  } else {
    date = isD(req.query.date) && req.query.date <= today() ? req.query.date : today();
    people.forEach(p => {
      const r = kmRow(p.id, date);
      if (r.j.start_km || r.j.end_km || r.claims.length || ['Sales', 'Service'].includes(p.section)) rows.push({ ...r, uid: p.id, label: p.full_name || p.username });
    });
  }
  res.render('travel-expenses/km-grid', { title: 'Correct KM', mode, people, emp, week, date, rows, fmtD, weekMon, addDay, todayStr: today(),
    rate: emp ? ta.rateOfUser(emp.id) : null, back: req.originalUrl });
});

router.post('/km-grid', requireApprover, (req, res) => {
  const arr = (v) => Array.isArray(v) ? v : (v === undefined ? [] : [v]);
  const uids = arr(req.body.uid), dates = arr(req.body.date), starts = arr(req.body.start_km), ends = arr(req.body.end_km);
  const oStarts = arr(req.body.orig_start), oEnds = arr(req.body.orig_end);
  const note = String(req.body.note || '').trim();
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/travel-expenses/km-grid') ? req.body.back : '/travel-expenses/km-grid';
  const changed = uids.map((u, i) => ({ uid: +u, date: dates[i], start_km: starts[i], end_km: ends[i] }))
    .filter((r, i) => String(r.start_km).trim() !== String(oStarts[i]).trim() || String(r.end_km).trim() !== String(oEnds[i]).trim());
  if (!changed.length) { req.session.flash = { info: 'Nothing was changed.' }; return res.redirect(back); }
  if (!note) { req.session.flash = { error: 'Write the reason for the change.' }; return res.redirect(back); }
  const errors = [];
  let saved = 0;
  changed.forEach(r => {
    const out = ta.editKm(r.uid, r.date, { start_km: r.start_km, end_km: r.end_km, note }, req.session.userId);
    if (out.ok) { saved++; claimAfterCorrection(r.uid, r.date); }
    else { const u = db.prepare('SELECT full_name, username FROM users WHERE id=?').get(r.uid); errors.push(`${u?.full_name || u?.username} ${fmtD(r.date)}: ${req.t ? req.t(out.message) : out.message}`); }
  });
  req.session.flash = errors.length
    ? { error: (saved ? `${saved} saved. ` : '') + 'Not saved — ' + errors.join('; ') }
    : { success: saved === 1 ? '1 day updated. Claims and weekly bills are recalculated.' : `${saved} days updated. Claims and weekly bills are recalculated.` };
  res.redirect(back);
});

router.get('/bills/:id', (req, res) => {
  const data = billData(req, res);
  if (!data) { req.session.flash = { error: 'TA bill not found.' }; return res.redirect('/travel-expenses/bills'); }
  res.render('travel-expenses/bill', { title: data.bill.bill_no, ...data, fmtD, weekMon, isApprover: isApprover(res), back: req.originalUrl });
});

router.get('/bills/:id/pdf', async (req, res) => {
  const data = billData(req, res);
  if (!data) return res.status(404).send('Not found');
  const { generatePDFWithLetterhead } = require('../pdf');
  const html = await new Promise((resolve, reject) =>
    res.app.render('travel-expenses/bill-pdf', { ...data, fmtD, numberToWords, settings: res.locals.settings }, (err, h) => err ? reject(err) : resolve(h)));
  try {
    const pdf = await generatePDFWithLetterhead(html, path.join(__dirname, '..', 'Super Allied Letterhead.pdf'), { fitOnePage: true, minScale: 0.8 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${data.bill.bill_no}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('TA bill PDF error:', e);
    req.session.flash = { error: 'PDF generation failed.' };
    res.redirect('/travel-expenses/bills/' + data.bill.id);
  }
});

// ── Detail (generic :id — must stay below every literal-segment route above) ─
router.get('/:id', (req, res) => {
  // claimants open their own; the Head of Finance / admin open anyone's
  if (!canClaim(res) && !isApprover(res)) { req.session.flash = { error: `You don't have permission to access Travel Expenses.` }; return res.redirect('/'); }
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense) { req.session.flash = { error: 'Expense not found.' }; return res.redirect(isApprover(res) ? '/travel-expenses/queue' : '/travel-expenses/my'); }
  const isOwner = expense.user_id === req.session.userId;
  if (!isOwner && !isApprover(res)) {
    req.session.flash = { error: `You don't have permission to view this expense.` };
    return res.redirect(canClaim(res) ? '/travel-expenses/my' : '/');
  }

  const owner = db.prepare('SELECT full_name, employee_code, mobile FROM users WHERE id=?').get(expense.user_id);
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id)
    .map(d => ({ ...d, ocr: d.ocr_json ? JSON.parse(d.ocr_json) : null }));
  const visits = db.prepare(`SELECT fv.* FROM field_visits fv
    JOIN expense_visit_links l ON l.visit_id=fv.id WHERE l.expense_id=?`).all(expense.id);
  const approver = expense.approved_by ? db.prepare('SELECT full_name FROM users WHERE id=?').get(expense.approved_by) : null;

  const locked = isLocked(expense.date);
  const bill = locked ? db.prepare('SELECT id, bill_no FROM ta_bills WHERE user_id=? AND week_start=?').get(expense.user_id, weekOf(expense.date).start) : null;
  const day = dayProof(expense.user_id, expense.date);
  res.render('travel-expenses/detail', { title: expense.expense_number, expense, owner, docs, visits, approver, isOwner, isApprover: canApproveClaim(res), locked, bill, day });
});

router.post('/:id/approve', requireClaimApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect(backTo(req, '/travel-expenses/queue')); }

  db.prepare(`UPDATE travel_expenses SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_approved', 'travel_expenses', expense.id, expense.expense_number);
  createNotification(expense.user_id, `Expense Approved — ${expense.expense_number}`,
    `Your travel expense claim of ₹${expense.total_claim.toFixed(0)} has been approved.`, 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} approved.` };
  res.redirect(backTo(req, '/travel-expenses/queue'));
});

router.post('/:id/reject', requireClaimApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect(backTo(req, '/travel-expenses/queue')); }

  db.prepare(`UPDATE travel_expenses SET status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_rejected', 'travel_expenses', expense.id, req.body.comment||'');
  createNotification(expense.user_id, `Expense Rejected — ${expense.expense_number}`,
    req.body.comment || 'Your travel expense claim was rejected.', 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} rejected.` };
  res.redirect(backTo(req, '/travel-expenses/queue'));
});

module.exports = router;
