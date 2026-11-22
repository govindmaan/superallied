// Extra expenses: costs beyond the km travel allowance (food, stay, toll, fares,
// courier, small purchases…). The km allowance is calculated automatically from
// the meter photos, so staff no longer enter travel claims by hand; anything
// else they spend goes here, with a receipt photo or PDF, and the Head of
// Finance (or admin) approves or rejects it.
const express = require('express');
const router  = express.Router();
const fs = require('fs');
const path = require('path');
const { db, auditLog, createNotification, formatINR } = require('../db');
const { financeApproverIds } = require('../lib/org');

const CATEGORIES = ['Food', 'Lodging / Stay', 'Toll / Parking', 'Bus / Train / Taxi fare', 'Fuel (company vehicle)',
  'Courier / Transport', 'Parts / Material purchase', 'Mobile / Internet', 'Other'];
const MAX_AMOUNT = 100000;
const MAX_FILE_MB = 8;

const canClaim   = (res) => res.locals.hasPerm('*') || res.locals.hasPerm('expense_claim');
const canApprove = (res) => res.locals.hasPerm('*') || res.locals.hasPerm('expense_approval');
const deny = (req, res, msg) => { req.session.flash = { error: msg }; res.redirect('/'); };
const requireClaim   = (req, res, next) => canClaim(res) ? next() : deny(req, res, "You don't have permission to access Extra Expenses.");
const requireApprove = (req, res, next) => canApprove(res) ? next() : deny(req, res, 'Only the Head of Finance can approve expenses.');

const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
function nextNo() {
  const y = today().slice(0, 4);
  const n = db.prepare("SELECT COUNT(*) c FROM extra_expenses WHERE expense_no LIKE ?").get(`XE-${y}-%`).c + 1;
  return `XE-${y}-${String(n).padStart(5, '0')}`;
}

// Receipt from the form: a data URL (photo or PDF) → saved under /uploads/expenses
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
function saveReceipt(dataUrl, uid, uploadsDir) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m || !TYPES[m[1]]) return { error: 'Attach a photo or PDF of the receipt.' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { error: 'Attach a photo or PDF of the receipt.' };
  if (buf.length > MAX_FILE_MB * 1024 * 1024) return { error: `The receipt file is too large (more than ${MAX_FILE_MB} MB).` };
  if (m[1] === 'application/pdf' && buf.subarray(0, 4).toString() !== '%PDF') return { error: 'The receipt file is not a valid PDF.' };
  const dir = path.join(uploadsDir, 'expenses');
  fs.mkdirSync(dir, { recursive: true });
  const name = `xe-${Date.now()}-${uid}-${Math.random().toString(36).slice(2)}.${TYPES[m[1]]}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { path: `/uploads/expenses/${name}` };
}

const withNames = `SELECT x.*, u.full_name, u.username, u.employee_code, u.department, COALESCE(d.full_name, d.username) AS decided_by_name
  FROM extra_expenses x JOIN users u ON u.id = x.user_id LEFT JOIN users d ON d.id = x.decided_by`;

// ── My extra expenses ─────────────────────────────────────────────────────────
router.get('/', requireClaim, (req, res) => {
  const uid = req.session.userId;
  const rows = db.prepare(`${withNames} WHERE x.user_id=? ORDER BY x.date DESC, x.id DESC LIMIT 300`).all(uid);
  const month = today().slice(0, 7);
  const sum = (st) => rows.filter(r => r.date.startsWith(month) && r.status === st).reduce((a, r) => a + r.amount, 0);
  res.render('extra-expenses/list', { title: 'My Extra Expenses', rows, formatINR,
    summary: { pending: sum('submitted'), approved: sum('approved') }, canApprove: canApprove(res) });
});

// ── New ───────────────────────────────────────────────────────────────────────
router.get('/new', requireClaim, (req, res) => {
  res.render('extra-expenses/new', { title: 'New Extra Expense', categories: CATEGORIES, today: today(), maxMb: MAX_FILE_MB });
});

router.post('/', requireClaim, (req, res) => {
  const uid = req.session.userId;
  const f = req.body;
  const fail = (msg) => res.status(400).json({ ok: false, error: msg });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : '';
  if (!date || date > today()) return fail('Choose the date of the expense (not a future date).');
  if (!CATEGORIES.includes(f.category)) return fail('Choose what the expense was for.');
  const amount = Math.round((parseFloat(f.amount) || 0) * 100) / 100;
  if (!(amount > 0) || amount > MAX_AMOUNT) return fail('Enter the amount paid.');
  const description = String(f.description || '').trim().slice(0, 500);
  if (!description) return fail('Write what the expense was for (customer, place, reason).');
  const saved = saveReceipt(f.receipt, uid, res.app.locals.UPLOADS_DIR);
  if (saved.error) return fail(saved.error);

  const no = nextNo();
  const id = Number(db.prepare(`INSERT INTO extra_expenses (expense_no, user_id, date, category, amount, description, receipt_path)
    VALUES (?,?,?,?,?,?,?)`).run(no, uid, date, f.category, amount, description, saved.path).lastInsertRowid);
  auditLog(uid, 'extra_expense_submitted', 'extra_expenses', id, `${no} ${f.category} ₹${amount}`);
  const who = res.locals.user?.full_name || 'Staff';
  financeApproverIds().forEach(a => createNotification(a, `Extra expense to approve — ${no}`,
    `${who}: ${f.category}, ₹${formatINR(amount)} on ${date}.`, 'expense', `/extra-expenses/${id}`));
  req.session.flash = { success: `Expense ${no} submitted to the Head of Finance.` };
  res.json({ ok: true, id, redirect: `/extra-expenses/${id}` });
});

// ── Head of Finance / admin: approvals ────────────────────────────────────────
const TABS = ['submitted', 'approved', 'rejected', 'all'];
router.get('/queue', requireApprove, (req, res) => {
  const status = TABS.includes(req.query.status) ? req.query.status : 'submitted';
  const user = +req.query.user || 0;
  const month = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : '';
  const where = ["x.status <> 'withdrawn'"], params = [];
  if (status !== 'all') { where.push('x.status=?'); params.push(status); }
  if (user) { where.push('x.user_id=?'); params.push(user); }
  if (month) { where.push('x.date LIKE ?'); params.push(month + '%'); }
  const rows = db.prepare(`${withNames} WHERE ${where.join(' AND ')}
    ORDER BY ${status === 'submitted' ? 'x.created_at ASC' : 'x.date DESC, x.id DESC'} LIMIT 500`).all(...params);
  const counts = { all: 0 };
  const cw = ["status <> 'withdrawn'"], cp = [];
  if (user) { cw.push('user_id=?'); cp.push(user); }
  if (month) { cw.push('date LIKE ?'); cp.push(month + '%'); }
  db.prepare(`SELECT status, COUNT(*) c FROM extra_expenses WHERE ${cw.join(' AND ')} GROUP BY status`).all(...cp)
    .forEach(r => { counts[r.status] = r.c; counts.all += r.c; });
  const employees = db.prepare(`SELECT DISTINCT u.id, COALESCE(u.full_name, u.username) AS name FROM users u
    JOIN extra_expenses x ON x.user_id = u.id ORDER BY name`).all();
  res.render('extra-expenses/queue', { title: 'Extra Expense Approvals', rows, counts, employees, formatINR,
    total: rows.reduce((a, r) => a + r.amount, 0), filter: { status, user, month }, back: req.originalUrl });
});

// ── One expense ───────────────────────────────────────────────────────────────
router.get('/:id', requireClaim, (req, res) => {
  const x = db.prepare(`${withNames} WHERE x.id=?`).get(+req.params.id);
  if (!x || (x.user_id !== req.session.userId && !canApprove(res))) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/extra-expenses'); }
  res.render('extra-expenses/view', { title: `Extra Expense ${x.expense_no}`, x, formatINR,
    canDecide: canApprove(res) && x.status === 'submitted' && x.user_id !== req.session.userId,
    canWithdraw: x.user_id === req.session.userId && x.status === 'submitted' });
});

// Approve / reject (rejecting needs a reason). Nobody decides their own expense.
const backTo = (req, id) => (typeof req.body.back === 'string' && req.body.back.startsWith('/extra-expenses/queue')) ? req.body.back : `/extra-expenses/${id}`;
router.post('/:id/decide', requireApprove, (req, res) => {
  const x = db.prepare('SELECT * FROM extra_expenses WHERE id=?').get(+req.params.id);
  if (!x) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/extra-expenses/queue'); }
  const back = backTo(req, x.id);
  if (x.user_id === req.session.userId) { req.session.flash = { error: 'You cannot approve your own expense.' }; return res.redirect(back); }
  if (x.status !== 'submitted') { req.session.flash = { error: `This expense is already ${x.status}.` }; return res.redirect(back); }
  const approve = req.body.action === 'approve';
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (!approve && !note) { req.session.flash = { error: 'Give a reason for rejecting.' }; return res.redirect(back); }
  db.prepare('UPDATE extra_expenses SET status=?, decided_by=?, decided_at=CURRENT_TIMESTAMP, decision_note=? WHERE id=?')
    .run(approve ? 'approved' : 'rejected', req.session.userId, note, x.id);
  auditLog(req.session.userId, approve ? 'extra_expense_approved' : 'extra_expense_rejected', 'extra_expenses', x.id, `${x.expense_no}${note ? ': ' + note : ''}`);
  createNotification(x.user_id, approve ? `Expense approved — ${x.expense_no}` : `Expense rejected — ${x.expense_no}`,
    `${x.category}, ₹${formatINR(x.amount)}${note ? ' — ' + note : ''}`, approve ? 'success' : 'warning', `/extra-expenses/${x.id}`);
  req.session.flash = { success: `${x.expense_no} ${approve ? 'approved' : 'rejected'}.` };
  res.redirect(back);
});

// The person can withdraw their own expense until it is decided
router.post('/:id/withdraw', requireClaim, (req, res) => {
  const x = db.prepare('SELECT * FROM extra_expenses WHERE id=?').get(+req.params.id);
  if (!x || x.user_id !== req.session.userId) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/extra-expenses'); }
  if (x.status !== 'submitted') { req.session.flash = { error: `This expense is already ${x.status}.` }; return res.redirect(`/extra-expenses/${x.id}`); }
  db.prepare("UPDATE extra_expenses SET status='withdrawn' WHERE id=?").run(x.id);
  auditLog(req.session.userId, 'extra_expense_withdrawn', 'extra_expenses', x.id, x.expense_no);
  req.session.flash = { success: `${x.expense_no} withdrawn.` };
  res.redirect('/extra-expenses');
});

router.CATEGORIES = CATEGORIES;
module.exports = router;
