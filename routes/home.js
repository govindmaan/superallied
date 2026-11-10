// Dashboard (admin, office and employee views) and My Profile.
const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { db, getSettings, calcQuotation, formatINR } = require('../db');
const { requireLogin } = require('../lib/auth');
const { UPLOADS_DIR } = require('../lib/assets');
const { todayIST } = require('../lib/dates');

const router = express.Router();

// ── Admin dashboard data ──────────────────────────────────────────────────────
// Business figures exclude cancelled quotations; months follow the quotation date (IST).
function adminDashboardData(locale = 'en-IN') {
  const s       = getSettings();
  const today   = todayIST();
  const month   = today.slice(0, 7);
  const prevMonth = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const qDate   = "COALESCE(q.quotation_date, date(q.created_at,'+330 minutes'))";

  // Machine quotations: last 6 months, valued with the same calculation as the PDF
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const recentQuotes = db.prepare(`
    SELECT q.*, strftime('%Y-%m', ${qDate}) AS ym, COALESCE(sp.name, q.salesperson_name, 'Unassigned') AS sp_name
    FROM quotations q LEFT JOIN salespersons sp ON sp.id = q.salesperson_id
    WHERE q.cancelled_at IS NULL AND ${qDate} >= ?`).all(months[0] + '-01');
  const trend = months.map(ym => {
    const rows = recentQuotes.filter(q => q.ym === ym);
    return { ym, count: rows.length, value: rows.reduce((t, q) => t + calcQuotation(q, s).total, 0),
             label: new Date(ym + '-01T00:00:00Z').toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' }) };
  });
  const cur  = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  const monthQuotes = recentQuotes.filter(q => q.ym === month);
  const accepted    = monthQuotes.filter(q => q.status === 'accepted').length;

  // Spares this month
  const spare = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(grand_total),0) AS v FROM spare_quotations
    WHERE strftime('%Y-%m', COALESCE(quotation_date, created_at)) = ?`).get(month);

  // Enquiry pipeline
  const STAGES = [['phone_followup','Phone Follow-up'],['sales_visit','Sales Visit'],['enquiry_generated','Enquiry Generated'],['sales_closed','Sales Closed']];
  const pipeline = STAGES.map(([key, label]) => ({ key, label,
    count: db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE status='active' AND current_stage=?").get(key).c }));
  const enq = {
    active:   db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE status='active'").get().c,
    newMonth: db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE strftime('%Y-%m', created_at,'+330 minutes')=?").get(month).c,
    sales:    db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(sale_amount),0) AS v FROM enquiry_sales WHERE strftime('%Y-%m', created_at,'+330 minutes')=?").get(month),
  };
  const overdueFollowups = db.prepare(`
    SELECT e.id, e.enquiry_number, e.customer_name, e.phone, u.full_name AS assignee_name, f.next_followup_date
    FROM enquiries e
    JOIN (SELECT enquiry_id, MAX(next_followup_date) AS next_followup_date FROM enquiry_followups
          WHERE next_followup_date IS NOT NULL GROUP BY enquiry_id) f ON f.enquiry_id = e.id
    LEFT JOIN users u ON u.id = e.assigned_to
    WHERE e.status='active' AND f.next_followup_date <= ? ORDER BY f.next_followup_date LIMIT 6`).all(today);
  const overdueCount = db.prepare(`
    SELECT COUNT(*) AS c FROM enquiries e
    JOIN (SELECT enquiry_id, MAX(next_followup_date) AS d FROM enquiry_followups WHERE next_followup_date IS NOT NULL GROUP BY enquiry_id) f
      ON f.enquiry_id = e.id WHERE e.status='active' AND f.d <= ?`).get(today).c;

  // Things waiting on someone
  const attention = [
    { label: 'Follow-ups due or overdue',      count: overdueCount, href: '/enquiries/dashboard',      icon: 'bi-telephone-forward' },
    { label: 'Spare quotations to approve',    count: db.prepare("SELECT COUNT(*) AS c FROM spare_quotations WHERE approval_status='pending'").get().c, href: '/spare-quotations', icon: 'bi-receipt-cutoff' },
    { label: 'Travel expenses to approve',     count: db.prepare("SELECT COUNT(*) AS c FROM travel_expenses WHERE status='submitted'").get().c, href: '/travel-expenses/queue', icon: 'bi-truck' },
    { label: 'Leave requests to approve',      count: db.prepare("SELECT COUNT(*) AS c FROM leaves WHERE status='pending'").get().c, href: '/hr/leaves', icon: 'bi-calendar-x' },
    { label: 'Spare part orders pending',      count: db.prepare("SELECT COUNT(*) AS c FROM part_orders WHERE status='pending'").get().c, href: '/part-orders', icon: 'bi-box-seam' },
    { label: 'Quotations cancelled this month', count: db.prepare("SELECT COUNT(*) AS c FROM quotations WHERE strftime('%Y-%m', cancelled_at)=?").get(month).c, href: '/quotations?status=cancelled', icon: 'bi-x-circle' },
  ];

  // Salesperson leaderboard (this month)
  const board = {};
  monthQuotes.forEach(q => {
    const b = board[q.sp_name] ||= { name: q.sp_name, quotes: 0, value: 0, accepted: 0, spares: 0, spareValue: 0 };
    b.quotes++; b.value += calcQuotation(q, s).total; if (q.status === 'accepted') b.accepted++;
  });
  db.prepare(`SELECT COALESCE(sp.name, sq.salesperson, 'Unassigned') AS name, COUNT(*) AS c, COALESCE(SUM(sq.grand_total),0) AS v
    FROM spare_quotations sq LEFT JOIN salespersons sp ON sp.id = sq.salesperson_id
    WHERE strftime('%Y-%m', COALESCE(sq.quotation_date, sq.created_at)) = ? GROUP BY 1`).all(month).forEach(r => {
    const b = board[r.name] ||= { name: r.name, quotes: 0, value: 0, accepted: 0, spares: 0, spareValue: 0 };
    b.spares = r.c; b.spareValue = r.v;
  });
  const leaderboard = Object.values(board).sort((a, b) => (b.value + b.spareValue) - (a.value + a.spareValue)).slice(0, 8);

  // Team today
  const staff = db.prepare("SELECT id, full_name, username FROM users WHERE is_hr_active=1 AND role!='admin' ORDER BY full_name").all();
  const present = new Set(db.prepare('SELECT user_id FROM attendance WHERE date=? AND check_in_time IS NOT NULL').all(today).map(r => r.user_id));
  const team = {
    total: staff.length,
    present: staff.filter(u => present.has(u.id)).length,
    notIn: staff.filter(u => !present.has(u.id)).map(u => u.full_name || u.username),
    visits: db.prepare('SELECT COUNT(*) AS c FROM field_visits WHERE date(visit_time,\'+330 minutes\')=?').get(today).c,
  };

  const recent = db.prepare(`SELECT q.*, c.name AS customer_name, m.display_name AS machine_name
    FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN machines m ON m.id=q.machine_id
    ORDER BY q.created_at DESC LIMIT 6`).all().map(q => ({ ...q, total: calcQuotation(q, s).total }));

  return {
    month: new Date(month + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    kpi: {
      quotes: cur.count, quotesPrev: prev.count, quoteValue: cur.value,
      accepted, conversion: cur.count ? Math.round(accepted / cur.count * 100) : 0,
      spares: spare.c, spareValue: spare.v,
      sales: enq.sales.c, salesValue: enq.sales.v,
      enqActive: enq.active, enqNew: enq.newMonth,
    },
    trend, pipeline, attention, overdueFollowups, leaderboard, team, recent,
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/', requireLogin, (req, res) => {
  const perm        = (p) => res.locals.hasPerm(p);
  const isAdmin     = perm('*');
  const isAdminLike = isAdmin || perm('hr_admin');
  if (perm('telecaller') && !isAdmin) return res.redirect('/telecaller');
  const uid     = req.session.userId;
  const today   = new Date().toLocaleDateString('en-CA');

  // ── Head of Finance: a focused oversight dashboard (approvals + attendance,
  // with route map / heatmap). No access to the rest of the app.
  if (perm('expense_approval') && !isAdmin) {
    const pendingExpenses = db.prepare("SELECT COUNT(*) c FROM travel_expenses WHERE status='submitted'").get().c;
    const pendingAmount   = db.prepare("SELECT COALESCE(SUM(total_claim),0) t FROM travel_expenses WHERE status='submitted'").get().t;
    const approvedToday   = db.prepare("SELECT COUNT(*) c FROM travel_expenses WHERE status='approved' AND date(approved_at,'+330 minutes')=?").get(today).c;
    const att = db.prepare(`SELECT
        SUM(CASE WHEN check_in_time IS NOT NULL THEN 1 ELSE 0 END) present,
        SUM(CASE WHEN check_in_time IS NOT NULL AND check_out_time IS NULL THEN 1 ELSE 0 END) still_out
      FROM attendance WHERE date=?`).get(today);
    const staff = db.prepare("SELECT COUNT(*) c FROM users WHERE COALESCE(is_hr_active,1)=1 AND role NOT IN ('admin')").get().c;
    const recent = db.prepare(`SELECT te.*, u.full_name FROM travel_expenses te JOIN users u ON u.id=te.user_id
      WHERE te.status='submitted' ORDER BY te.submitted_at ASC LIMIT 8`).all();
    return res.render('dashboard-finance', { title: 'Finance', pendingExpenses, pendingAmount, approvedToday,
      present: att?.present || 0, stillOut: att?.still_out || 0, staff, recent, formatINR });
  }

  if (!isAdminLike) {
    // ── Employee tile dashboard ──
    const todayAtt = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, today);
    const pendingLeaves = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE user_id=? AND status='pending'").get(uid).c;
    const emp = db.prepare(`SELECT u.*, p.section AS position_section, p.level AS position_level
      FROM users u LEFT JOIN org_positions p ON p.code = u.position_code WHERE u.id=?`).get(uid);
    const monthClaim = db.prepare("SELECT COALESCE(SUM(total_claim),0) as t FROM travel_expenses WHERE user_id=? AND date LIKE ?")
      .get(uid, new Date().toLocaleDateString('en-CA').slice(0, 7) + '%').t;

    // ── Sales department: leads-and-quotations dashboard ──
    if (emp.position_section === 'Sales') {
      const myQuotes = db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND cancelled_at IS NULL AND strftime('%Y-%m', created_at,'+330 minutes')=strftime('%Y-%m','now','+330 minutes')").get(uid).c;
      const myVisits = db.prepare("SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=?").get(uid, today).c;
      let myEnquiries = 0, followupsDue = [];
      if (res.locals.hasPerm('enquiries')) {
        myEnquiries = db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE status='active' AND assigned_to=?").get(uid).c;
        followupsDue = db.prepare(`
          SELECT e.id, e.customer_name, e.phone, e.machine_interested, f.d AS due
          FROM enquiries e
          JOIN (SELECT enquiry_id, MAX(next_followup_date) AS d FROM enquiry_followups WHERE next_followup_date IS NOT NULL GROUP BY enquiry_id) f
            ON f.enquiry_id = e.id
          WHERE e.status='active' AND e.assigned_to=? AND f.d <= ?
          ORDER BY f.d LIMIT 10`).all(uid, todayIST());
      }
      return res.render('dashboard-sales', { title: 'Home', todayAtt, pendingLeaves, emp, today, monthClaim,
        myQuotes, myVisits, myEnquiries, followupsDue, formatINR });
    }

    // ── Operations department: spares-focused dashboard ──
    if (emp.position_section === 'Operations') {
      const mySpareQuotes = db.prepare("SELECT COUNT(*) as c FROM spare_quotations WHERE created_by=? AND strftime('%Y-%m', COALESCE(quotation_date, created_at),'+330 minutes')=strftime('%Y-%m','now','+330 minutes')").get(uid).c;
      const zeroStockCount = db.prepare("SELECT COUNT(*) as c FROM spare_parts sp LEFT JOIN stock_availability sa ON sa.part_id=sp.id WHERE COALESCE(sa.stock_quantity,0)=0").get().c;
      const lowStockCount  = db.prepare("SELECT COUNT(*) as c FROM spare_parts sp LEFT JOIN stock_availability sa ON sa.part_id=sp.id WHERE COALESCE(sa.stock_quantity,0) BETWEEN 1 AND 3").get().c;
      const recentSpare    = db.prepare(`SELECT * FROM spare_quotations WHERE created_by=? ORDER BY created_at DESC LIMIT 5`).all(uid);
      return res.render('dashboard-operations', { title: 'Home', todayAtt, pendingLeaves, emp, today, monthClaim,
        mySpareQuotes, zeroStockCount, lowStockCount, recentSpare, formatINR });
    }

    const myQuotes = db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND cancelled_at IS NULL AND strftime('%Y-%m', created_at,'+330 minutes')=strftime('%Y-%m','now','+330 minutes')").get(uid).c;
    const myVisits = db.prepare("SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time,'+330 minutes')=?").get(uid, today).c;
    // Sales: my open enquiries and follow-ups due today or overdue
    let myEnquiries = 0, followupsDue = [];
    if (res.locals.hasPerm('enquiries')) {
      myEnquiries = db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE status='active' AND assigned_to=?").get(uid).c;
      followupsDue = db.prepare(`
        SELECT e.id, e.customer_name, e.phone, e.machine_interested, f.d AS due
        FROM enquiries e
        JOIN (SELECT enquiry_id, MAX(next_followup_date) AS d FROM enquiry_followups WHERE next_followup_date IS NOT NULL GROUP BY enquiry_id) f
          ON f.enquiry_id = e.id
        WHERE e.status='active' AND e.assigned_to=? AND f.d <= ?
        ORDER BY f.d LIMIT 10`).all(uid, todayIST());
    }
    return res.render('dashboard-employee', { title: 'Home', todayAtt, myQuotes, myVisits, pendingLeaves, emp, today, monthClaim,
      myEnquiries, followupsDue, openVisit: req.query.visit === '1' });
  }

  if (isAdmin) return res.render('dashboard-admin', { title: 'Dashboard', ...adminDashboardData(res.locals.locale), formatINR });

  // ── Manager / HR dashboard ──
  const stats = {
    customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    quotations: isAdmin
      ? db.prepare('SELECT COUNT(*) as c FROM quotations').get().c
      : db.prepare('SELECT COUNT(*) as c FROM quotations WHERE user_id=?').get(uid).c,
    thisMonth: isAdmin
      ? db.prepare("SELECT COUNT(*) as c FROM quotations WHERE strftime('%Y-%m', created_at,'+330 minutes')=strftime('%Y-%m','now','+330 minutes')").get().c
      : db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND strftime('%Y-%m', created_at,'+330 minutes')=strftime('%Y-%m','now','+330 minutes')").get(uid).c,
    machines: db.prepare('SELECT COUNT(*) as c FROM machines WHERE active=1').get().c,
    soldMachines: db.prepare('SELECT COUNT(*) as c FROM sold_machines').get().c,
    spareParts: db.prepare('SELECT COUNT(*) as c FROM spare_parts').get().c,
    spareQuotations: isAdmin
      ? db.prepare('SELECT COUNT(*) as c FROM spare_quotations').get().c
      : db.prepare('SELECT COUNT(*) as c FROM spare_quotations WHERE created_by=?').get(uid).c,
    spareToday: isAdmin
      ? db.prepare("SELECT COUNT(*) as c FROM spare_quotations WHERE date(created_at,'+330 minutes')=date('now','+330 minutes')").get().c
      : db.prepare("SELECT COUNT(*) as c FROM spare_quotations WHERE created_by=? AND date(created_at,'+330 minutes')=date('now','+330 minutes')").get(uid).c,
  };
  const recentSql = `SELECT q.*, c.name as customer_name, m.display_name as machine_name
    FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN machines m ON m.id=q.machine_id
    ${isAdmin ? '' : 'WHERE q.user_id=?'} ORDER BY q.created_at DESC LIMIT 8`;
  const recent = isAdmin ? db.prepare(recentSql).all() : db.prepare(recentSql).all(uid);
  const recentSpare = db.prepare(`SELECT sq.*, u.full_name as creator_name
    FROM spare_quotations sq LEFT JOIN users u ON u.id=sq.created_by
    ${isAdmin ? '' : 'WHERE sq.created_by=?'} ORDER BY sq.created_at DESC LIMIT 5`
  ).all(...(isAdmin ? [] : [uid]));
  res.render('dashboard', { title: 'Dashboard', stats, recent, recentSpare, formatINR, calcQuotation, settings: getSettings() });
});

// ── My Profile (self-service) ─────────────────────────────────────────────────
router.get('/profile', requireLogin, (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  res.render('profile', { title: 'My Profile', emp });
});

// Set / change / remove the 6-digit login PIN (password required)
function weakPin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;                       // 111111
  const asc = '0123456789012', desc = '9876543210987';
  return asc.includes(pin) || desc.includes(pin);                 // 123456, 654321
}

router.post('/profile/pin', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const { password, pin, confirm, remove } = req.body;
  const back = (flash) => { req.session.flash = flash; res.redirect('/profile'); };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return back({ error: 'Current password is wrong.' });
  if (remove) {
    db.prepare('UPDATE users SET pin_hash=NULL WHERE id=?').run(user.id);
    return back({ success: 'Login PIN removed.' });
  }
  if (!/^\d{6}$/.test(pin || '')) return back({ error: 'PIN must be exactly 6 digits.' });
  if (pin !== confirm)            return back({ error: 'The two PINs do not match.' });
  if (weakPin(pin))               return back({ error: 'That PIN is too easy to guess. Avoid repeated or sequential digits.' });
  db.prepare('UPDATE users SET pin_hash=? WHERE id=?').run(bcrypt.hashSync(pin, 10), user.id);
  back({ success: user.pin_hash ? 'Login PIN changed.' : 'Login PIN set. You can now log in with your PIN.' });
});

router.post('/profile/photo', requireLogin, (req, res) => {
  const { photo } = req.body;
  if (!photo?.startsWith('data:image')) return res.json({ ok: false, error: 'Invalid image' });
  const uid = req.session.userId;
  const dir = path.join(UPLOADS_DIR, 'employees');
  fs.mkdirSync(dir, { recursive: true });
  const fname = `emp-${uid}-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(dir, fname), Buffer.from(photo.split(',')[1], 'base64'));
  const photoPath = `/uploads/employees/${fname}`;
  db.prepare('UPDATE users SET photo_path=? WHERE id=?').run(photoPath, uid);
  res.json({ ok: true, path: photoPath });
});

module.exports = router;
