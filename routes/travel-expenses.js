const express = require('express');
const path    = require('path');
const router  = express.Router();
const { db, auditLog, createNotification, nextExpenseNumber, numberToWords, today } = require('../db');
const { analyzeImage } = require('../services/expenseImageAnalyzer');

function isApprover(res) { return res.locals.user?.role === 'admin' || res.locals.hasPerm('expense_approval'); }
function canClaim(res) { return res.locals.user?.role === 'admin' || res.locals.hasPerm('expense_claim'); }

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
function recalc({ start_odo, end_odo, travel_type }) {
  const s = parseFloat(start_odo) || 0;
  const e = parseFloat(end_odo) || 0;
  const distance_km = Math.max(0, e - s);
  const rateRow = db.prepare('SELECT rate_per_km FROM expense_rates WHERE vehicle_type=?').get(travel_type);
  const rate_per_km = rateRow ? rateRow.rate_per_km : 0;
  const travel_amount = Math.round(distance_km * rate_per_km * 100) / 100;
  return { distance_km, rate_per_km, travel_amount, total_claim: travel_amount };
}

// ── Weekly lock & TA bill ─────────────────────────────────────────────────────
// A week runs Sunday–Saturday (a Sunday trip belongs to the Mon–Sat week after it).
// Trips can be added, edited and submitted until Saturday 8:00 pm India time.
// At that point the week locks: unsubmitted trips are submitted automatically and
// a Travelling Allowance bill is prepared. Trips are still approved one by one.
const TA_POLICY_START = process.env.TA_POLICY_START || '2026-10-18';   // first week the lock applies to

function weekOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'), dow = d.getUTCDay();
  const start = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
  const end   = new Date(d.getTime() + (6 - dow) * 86400000).toISOString().slice(0, 10);
  return { start, end, lockAt: new Date(`${end}T20:00:00+05:30`) };
}
function isLocked(dateStr) {
  return !!dateStr && dateStr >= TA_POLICY_START && Date.now() >= weekOf(dateStr).lockAt.getTime();
}
const fmtD = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const lockedMsg = d => `The week of ${fmtD(weekOf(d).start)}–${fmtD(weekOf(d).end)} closed on Saturday 8:00 pm and can no longer be changed.`;

function nextBillNo(year) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM ta_bills WHERE bill_no LIKE ?").get(`TA-${year}-%`).c;
  return `TA-${year}-${String(n + 1).padStart(4, '0')}`;
}

// Lock every week whose deadline has passed: auto-submit its drafts, then
// prepare one TA bill per person for that week. Safe to run any number of times.
function closeLockedWeeks() {
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
  for (const w of weeks.values()) {
    if (db.prepare('SELECT 1 FROM ta_bills WHERE user_id=? AND week_start=?').get(w.user_id, w.start)) continue;
    const t = db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS km, COALESCE(SUM(total_claim),0) AS amount
      FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ? AND status != 'rejected'`).get(w.user_id, w.start, w.end);
    const billNo = nextBillNo(w.end.slice(0, 4));
    const r = db.prepare('INSERT INTO ta_bills (bill_no, user_id, week_start, week_end, trips, total_km, total_amount) VALUES (?,?,?,?,?,?,?)')
      .run(billNo, w.user_id, w.start, w.end, t.trips, t.km, t.amount);
    createNotification(w.user_id, `TA Bill ready — ${billNo}`,
      `Week ${fmtD(w.start)}–${fmtD(w.end)}: ${t.km.toFixed(0)} km, ₹${t.amount.toFixed(0)}.`, 'expense', '/travel-expenses/bills/' + r.lastInsertRowid);
  }
}
// Run on every travel-expense request and every 10 minutes, so bills appear on time
router.use((req, res, next) => { try { closeLockedWeeks(); } catch (e) { console.error('TA weekly lock:', e.message); } next(); });
setInterval(() => { try { closeLockedWeeks(); } catch (e) { console.error('TA weekly lock:', e.message); } }, 10 * 60000).unref();

router.get('/', (req, res) => res.redirect('/travel-expenses/my'));

// ── New expense form ──────────────────────────────────────────────────────────
router.get('/new', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const journey = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, today());
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  const todaysVisits = db.prepare("SELECT * FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=? ORDER BY visit_time").all(uid, today());

  res.render('travel-expenses/new', {
    title: 'New Travel Expense', expense: null, docs: [], linkedVisitIds: [],
    user, journey, rates, todaysVisits, todayStr: today(),
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
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const journey = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, expense.date);
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  const todaysVisits = db.prepare("SELECT * FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=? ORDER BY visit_time").all(uid, expense.date);
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id);
  const linkedVisitIds = db.prepare('SELECT visit_id FROM expense_visit_links WHERE expense_id=?').all(expense.id).map(r => r.visit_id);

  res.render('travel-expenses/new', {
    title: 'Edit Travel Expense', expense, docs, linkedVisitIds,
    user, journey, rates, todaysVisits, todayStr: expense.date,
  });
});

// ── Create / update (always saved as draft) ───────────────────────────────────
router.post('/', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const { id, date, travel_type, purpose, start_odo, end_odo, remarks, visit_ids } = req.body;

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

  const { distance_km, rate_per_km, travel_amount, total_claim } = recalc({ start_odo: s, end_odo: e, travel_type });

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
       travel_amount,total_claim,remarks,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`)
      .run(nextExpenseNumber(), uid, tripDate, travel_type||'Own Two Wheeler', profileVehicleNumber, purpose||'',
        s, e, distance_km, rate_per_km, travel_amount,
        total_claim, remarks||'');
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

  db.prepare(`UPDATE travel_expenses SET status='submitted', submitted_at=CURRENT_TIMESTAMP,
    approved_by=NULL, approved_at=NULL, approval_remarks='' WHERE id=?`).run(expense.id);
  auditLog(uid, 'expense_submitted', 'travel_expenses', expense.id, expense.expense_number);

  const user = db.prepare('SELECT full_name, manager_id FROM users WHERE id=?').get(uid);
  if (user?.manager_id) {
    createNotification(user.manager_id, `Travel Expense Submitted — ${expense.expense_number}`,
      `${user.full_name} submitted a travel expense claim of ₹${expense.total_claim.toFixed(0)}.`, 'expense', '/travel-expenses/queue');
  }

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
  const week = { start: fmtD(wk.start), end: fmtD(wk.end), lockAt: wk.lockAt.toISOString(),
                 ...db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS km, COALESCE(SUM(total_claim),0) AS amount,
                   SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts
                   FROM travel_expenses WHERE user_id=? AND date BETWEEN ? AND ?`).get(uid, wk.start, wk.end) };
  expenses.forEach(x => { x.locked = isLocked(x.date); });
  res.render('travel-expenses/list', { title: 'My Travel Expenses', expenses, counts, statusFilter: status||'all', monthSummary, week });
});

// ── Approval queue (must be registered before the generic /:id route below) ──
router.get('/queue', requireApprover, (req, res) => {
  const rows = db.prepare(`SELECT te.*, u.full_name, u.employee_code
    FROM travel_expenses te JOIN users u ON u.id=te.user_id
    WHERE te.status='submitted' ORDER BY te.submitted_at ASC`).all();
  res.render('travel-expenses/queue', { title: 'Expense Approvals', rows });
});

// ── Rate configuration — also registered before /:id (two segments is safe,
// but keeping it here for readability alongside /queue) ──────────────────────
router.get('/admin/rates', (req, res) => {
  const role = res.locals.user?.role;
  if (role !== 'admin' && role !== 'manager') { req.session.flash = { error: 'Admin or Manager access required.' }; return res.redirect('/'); }
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  res.render('travel-expenses/rates', { title: 'Expense Rate Configuration', rates });
});

router.post('/admin/rates', (req, res) => {
  const role = res.locals.user?.role;
  if (role !== 'admin' && role !== 'manager') { req.session.flash = { error: 'Admin or Manager access required.' }; return res.redirect('/'); }
  const { vehicle_type, rate_per_km } = req.body;
  const types = Array.isArray(vehicle_type) ? vehicle_type : [vehicle_type];
  const rateVals = Array.isArray(rate_per_km) ? rate_per_km : [rate_per_km];
  types.forEach((vt, i) => {
    db.prepare('UPDATE expense_rates SET rate_per_km=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE vehicle_type=?')
      .run(parseFloat(rateVals[i])||0, req.session.userId, vt);
  });
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
  return {
    bill, trips, payments,
    totals: {
      paid: payments.reduce((a, p) => a + p.amount, 0),
      km: counted.reduce((a, t) => a + t.distance_km, 0), amount: counted.reduce((a, t) => a + t.total_claim, 0),
      approved: approved.reduce((a, t) => a + t.total_claim, 0),
      pending: trips.filter(t => t.status === 'submitted').length, rejected: trips.length - counted.length,
    },
    period: `${fmtD(bill.week_start)} – ${fmtD(bill.week_end)} ${bill.week_end.slice(0, 4)}`,
  };
}

router.get('/bills', (req, res) => {
  if (!canClaim(res) && !isApprover(res)) { req.session.flash = { error: `You don't have permission to view TA bills.` }; return res.redirect('/'); }
  const all = isApprover(res);
  const bills = db.prepare(`SELECT b.*, u.full_name FROM ta_bills b JOIN users u ON u.id = b.user_id
    ${all ? '' : 'WHERE b.user_id = ?'} ORDER BY b.week_start DESC, u.full_name`).all(...(all ? [] : [req.session.userId]));
  const wk = weekOf(today());
  res.render('travel-expenses/bills', { title: 'TA Bills', bills, all, fmtD,
    current: { start: fmtD(wk.start), end: fmtD(wk.end), lockAt: wk.lockAt.toISOString() } });
});

router.get('/bills/:id', (req, res) => {
  const data = billData(req, res);
  if (!data) { req.session.flash = { error: 'TA bill not found.' }; return res.redirect('/travel-expenses/bills'); }
  res.render('travel-expenses/bill', { title: data.bill.bill_no, ...data, fmtD });
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
router.get('/:id', requireClaimAccess, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  const isOwner = expense.user_id === req.session.userId;
  if (!isOwner && !isApprover(res)) {
    req.session.flash = { error: `You don't have permission to view this expense.` };
    return res.redirect('/travel-expenses/my');
  }

  const owner = db.prepare('SELECT full_name, employee_code, mobile FROM users WHERE id=?').get(expense.user_id);
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id)
    .map(d => ({ ...d, ocr: d.ocr_json ? JSON.parse(d.ocr_json) : null }));
  const visits = db.prepare(`SELECT fv.* FROM field_visits fv
    JOIN expense_visit_links l ON l.visit_id=fv.id WHERE l.expense_id=?`).all(expense.id);
  const approver = expense.approved_by ? db.prepare('SELECT full_name FROM users WHERE id=?').get(expense.approved_by) : null;

  const locked = isLocked(expense.date);
  const bill = locked ? db.prepare('SELECT id, bill_no FROM ta_bills WHERE user_id=? AND week_start=?').get(expense.user_id, weekOf(expense.date).start) : null;
  res.render('travel-expenses/detail', { title: expense.expense_number, expense, owner, docs, visits, approver, isOwner, isApprover: isApprover(res), locked, bill });
});

router.post('/:id/approve', requireApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect('/travel-expenses/queue'); }

  db.prepare(`UPDATE travel_expenses SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_approved', 'travel_expenses', expense.id, expense.expense_number);
  createNotification(expense.user_id, `Expense Approved — ${expense.expense_number}`,
    `Your travel expense claim of ₹${expense.total_claim.toFixed(0)} has been approved.`, 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} approved.` };
  res.redirect('/travel-expenses/queue');
});

router.post('/:id/reject', requireApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect('/travel-expenses/queue'); }

  db.prepare(`UPDATE travel_expenses SET status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_rejected', 'travel_expenses', expense.id, req.body.comment||'');
  createNotification(expense.user_id, `Expense Rejected — ${expense.expense_number}`,
    req.body.comment || 'Your travel expense claim was rejected.', 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} rejected.` };
  res.redirect('/travel-expenses/queue');
});

module.exports = router;
