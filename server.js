require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const { db, getSettings, nextQuotationNumber, calcQuotation, formatINR, numberToWords, createNotification, getUserPermissions, checkFollowupNotifications, auditLog } = require('./db');
const { generatePDF, generatePDFWithLetterhead } = require('./pdf');
const LETTERHEAD_PATH = path.join(__dirname, 'Super Allied Letterhead.pdf');

// ── File storage setup ────────────────────────────────────────────────────────
const DATA_DIR    = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'quotation.db'));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── HR route modules ──────────────────────────────────────────────────────────
const attendanceRoutes = require('./routes/attendance');
const leavesRoutes     = require('./routes/leaves');
const salaryRoutes     = require('./routes/salary');
const hrRoutes         = require('./routes/hr');
const notifyRoutes     = require('./routes/notify');
const visitsRoutes     = require('./routes/visits');
const expensesRoutes   = require('./routes/expenses');
const travelExpensesRoutes = require('./routes/travel-expenses');
const machinesRoutes        = require('./routes/machines');
const enquiriesRoutes       = require('./routes/enquiries');
const soldMachinesRoutes    = require('./routes/sold-machines');
const sparePartsRoutes      = require('./routes/spare-parts');
const spareQuotationsRoutes = require('./routes/spare-quotations');
const salespersonsRoutes    = require('./routes/salespersons');
const stockRoutes           = require('./routes/stock');
const form22Routes          = require('./routes/form22');
const partOrdersRoutes      = require('./routes/part-orders');
const backupRoutes          = require('./routes/backup');

// Pre-encode images once at startup
const LOGO_PATH = path.join(__dirname, 'public', 'bull-logo.jpg');
const BULL_LOGO_B64 = fs.existsSync(LOGO_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

const QR_PATH = path.join(__dirname, 'public', 'payment-qr.jpg');
const PAYMENT_QR_B64 = fs.existsSync(QR_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(QR_PATH).toString('base64')}` : '';

const app  = express();
const PORT = process.env.PORT || 3000;

// Make UPLOADS_DIR accessible to route modules via app.locals
app.locals.UPLOADS_DIR = UPLOADS_DIR;
app.locals.bullLogoB64 = BULL_LOGO_B64;

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // behind Railway's proxy: req.ip is the real client address
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));  // 20mb covers large Excel imports (~1MB file = ~1.4MB base64)
app.use(session({
  secret: process.env.SESSION_SECRET || 'superallied-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// Flash messages
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || {};
  delete req.session.flash;
  next();
});

// Auth guard
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  req.session.flash = { error: 'Please login to continue.' };
  res.redirect('/login');
}

// Admin-only guard
function requireAdmin(req, res, next) {
  const user = req.session.userId
    ? db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  if (user && user.role === 'admin') return next();
  req.session.flash = { error: 'Admin access required.' };
  res.redirect('/');
}

// Inject user, settings, permissions, notification count into all views
app.use((req, res, next) => {
  const u = req.session.userId
    ? db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  res.locals.user     = u;
  res.locals.currentPath = req.originalUrl.split('?')[0]; // sidebar highlights the matching link
  res.locals.settings = getSettings();
  res.locals.unreadCount = u
    ? (db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0').get(u.id)?.c || 0)
    : 0;

  // Permission helpers
  if (u) {
    const perms = getUserPermissions(u.role);
    res.locals.hasPerm = (p) => perms.includes('*') || perms.includes(p);
    res.locals._perms  = perms;
    if (perms.includes('*') || perms.includes('enquiries')) {
      try { checkFollowupNotifications(u.id); } catch (e) {}
    }
  } else {
    res.locals.hasPerm = () => false;
    res.locals._perms  = [];
  }
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
// ── Login (password or 6-digit PIN) ──────────────────────────────────────────
// Cloudflare Turnstile (free CAPTCHA) is on when both keys are set; otherwise skipped.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET   = process.env.TURNSTILE_SECRET_KEY || '';
const MAX_FAILED_LOGINS = 5;   // per account, then locked for LOCK_MINUTES
const LOCK_MINUTES      = 15;
const IP_MAX_ATTEMPTS   = 30;  // per network address per 15 minutes
const ipAttempts = new Map();  // ip -> { count, since }

function ipRateLimited(ip) {
  const now = Date.now(), win = 15 * 60000;
  const rec = ipAttempts.get(ip);
  if (!rec || now - rec.since > win) { ipAttempts.set(ip, { count: 1, since: now }); return false; }
  rec.count++;
  return rec.count > IP_MAX_ATTEMPTS;
}

async function verifyCaptcha(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }) });
    return !!(await r.json()).success;
  } catch (e) {
    console.error('Turnstile verify failed:', e.message);
    return false;
  }
}

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Login', turnstileSiteKey: TURNSTILE_SECRET ? TURNSTILE_SITE_KEY : '' });
});

app.post('/login', async (req, res) => {
  const mode     = req.body.mode === 'pin' ? 'pin' : 'password';
  const username = String(req.body.username || '').trim();
  const fail = (error) => { req.session.flash = { error, loginMode: mode, username }; res.redirect('/login'); };

  if (ipRateLimited(req.ip)) return fail('Too many login attempts. Please wait 15 minutes and try again.');
  if (!(await verifyCaptcha(req.body['cf-turnstile-response'], req.ip))) return fail('Please complete the security check.');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return fail(`Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }

  let ok = false;
  if (user && mode === 'pin') {
    if (!user.pin_hash) return fail('No PIN set for this account. Log in with your password, then set a PIN in My Profile.');
    ok = /^\d{6}$/.test(req.body.pin || '') && bcrypt.compareSync(req.body.pin, user.pin_hash);
  } else if (user) {
    ok = bcrypt.compareSync(String(req.body.password || ''), user.password_hash);
  }

  if (!ok) {
    if (user) {
      const fails = (user.failed_logins || 0) + 1;
      if (fails >= MAX_FAILED_LOGINS) {
        db.prepare('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?')
          .run(new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), user.id);
        return fail(`Too many wrong attempts. Account locked for ${LOCK_MINUTES} minutes.`);
      }
      db.prepare('UPDATE users SET failed_logins=? WHERE id=?').run(fails, user.id);
    }
    return fail(mode === 'pin' ? 'Invalid username or PIN.' : 'Invalid username or password.');
  }
  if (user.is_hr_active === 0) return fail('Your account has been deactivated. Contact HR/Admin.');

  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(user.id);
  // New session id on login (prevents session fixation)
  req.session.regenerate(err => {
    if (err) return fail('Login failed, please try again.');
    req.session.userId = user.id;
    res.redirect('/');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Permission middleware factory ─────────────────────────────────────────────
function requirePerm(perm) {
  return (req, res, next) => {
    if (res.locals.hasPerm && res.locals.hasPerm(perm)) return next();
    req.session.flash = { error: `You don't have permission to access this area.` };
    res.redirect('/');
  };
}

// ── Admin dashboard data ──────────────────────────────────────────────────────
// Business figures exclude cancelled quotations; months follow the quotation date (IST).
function adminDashboardData() {
  const s       = getSettings();
  const today   = todayIST();
  const month   = today.slice(0, 7);
  const prevMonth = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const qDate   = "COALESCE(q.quotation_date, date(q.created_at))";

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
             label: new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }) };
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
    newMonth: db.prepare("SELECT COUNT(*) AS c FROM enquiries WHERE strftime('%Y-%m', created_at)=?").get(month).c,
    sales:    db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(sale_amount),0) AS v FROM enquiry_sales WHERE strftime('%Y-%m', created_at)=?").get(month),
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
    visits: db.prepare('SELECT COUNT(*) AS c FROM field_visits WHERE date(visit_time)=?').get(today).c,
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
app.get('/', requireLogin, (req, res) => {
  const role    = res.locals.user?.role;
  const isAdminLike = ['admin','manager','hr'].includes(role);
  const uid     = req.session.userId;
  const today   = new Date().toISOString().slice(0, 10);

  if (!isAdminLike) {
    // ── Employee tile dashboard ──
    const todayAtt = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, today);
    const myQuotes = db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND cancelled_at IS NULL AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(uid).c;
    const myVisits = db.prepare("SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time)=?").get(uid, today).c;
    const pendingLeaves = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE user_id=? AND status='pending'").get(uid).c;
    const emp = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    const monthClaim = db.prepare("SELECT COALESCE(SUM(total_claim),0) as t FROM travel_expenses WHERE user_id=? AND date LIKE ?")
      .get(uid, new Date().toISOString().slice(0,7) + '%').t;
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

  if (role === 'admin') return res.render('dashboard-admin', { title: 'Dashboard', ...adminDashboardData(), formatINR });

  // ── Manager / HR dashboard ──
  const isAdmin = role === 'admin';
  const stats = {
    customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    quotations: isAdmin
      ? db.prepare('SELECT COUNT(*) as c FROM quotations').get().c
      : db.prepare('SELECT COUNT(*) as c FROM quotations WHERE user_id=?').get(uid).c,
    thisMonth: isAdmin
      ? db.prepare("SELECT COUNT(*) as c FROM quotations WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get().c
      : db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(uid).c,
    machines: db.prepare('SELECT COUNT(*) as c FROM machines WHERE active=1').get().c,
    soldMachines: db.prepare('SELECT COUNT(*) as c FROM sold_machines').get().c,
    spareParts: db.prepare('SELECT COUNT(*) as c FROM spare_parts').get().c,
    spareQuotations: isAdmin
      ? db.prepare('SELECT COUNT(*) as c FROM spare_quotations').get().c
      : db.prepare('SELECT COUNT(*) as c FROM spare_quotations WHERE created_by=?').get(uid).c,
    spareToday: isAdmin
      ? db.prepare("SELECT COUNT(*) as c FROM spare_quotations WHERE date(created_at)=date('now')").get().c
      : db.prepare("SELECT COUNT(*) as c FROM spare_quotations WHERE created_by=? AND date(created_at)=date('now')").get(uid).c,
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
app.get('/profile', requireLogin, (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  res.render('profile', { title: 'My Profile', emp });
});

// Set / change / remove the 6-digit login PIN (password required)
function weakPin(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;                       // 111111
  const asc = '0123456789012', desc = '9876543210987';
  return asc.includes(pin) || desc.includes(pin);                 // 123456, 654321
}

app.post('/profile/pin', requireLogin, (req, res) => {
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

app.post('/profile/photo', requireLogin, (req, res) => {
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

// ── Customers ─────────────────────────────────────────────────────────────────
// Non-admins only see/manage customers they created themselves (plus legacy
// customers created before ownership tracking existed, which have no owner).
function canAccessCustomer(res, customer) {
  if (res.locals.user?.role === 'admin') return true;
  if (customer.deleted_at) return false;
  return customer.created_by == null || customer.created_by === res.locals.user?.id;
}

// Normalise + validate GSTIN / PAN / Aadhaar from the customer form. Blank is allowed.
// PAN is characters 3–12 of a GSTIN, so it is filled in from the GSTIN when left empty.
function parseCustomerIds(body) {
  const gstin   = String(body.gstin   || '').toUpperCase().replace(/\s+/g, '');
  let   pan     = String(body.pan     || '').toUpperCase().replace(/\s+/g, '');
  const aadhaar = String(body.aadhaar || '').replace(/[\s-]+/g, '');
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return { error: 'GSTIN must be 15 characters, e.g. 09ABCDE1234F1Z5.' };
  if (!pan && gstin) pan = gstin.slice(2, 12);
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return { error: 'PAN must be 10 characters, e.g. ABCDE1234F.' };
  if (aadhaar && !/^[2-9]\d{11}$/.test(aadhaar)) return { error: 'Aadhaar must be 12 digits.' };
  return { gstin, pan, aadhaar };
}

// Customer ids printed on a machine quotation: GSTIN and/or PAN when present,
// otherwise Aadhaar (masked to the last 4 digits).
// ── Machine quotation helpers ─────────────────────────────────────────────────
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

// Date printed on the quotation: chosen date, or creation date for older quotations
function quotationDateOf(q) {
  return q.quotation_date || String(q.created_at || '').slice(0, 10) || todayIST();
}

// A quotation is valid till the last day (30th/31st, 28th/29th in Feb) of its month
function quotationValidTill(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function fmtLongDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Date, salesperson and additional items from the quotation form.
// The salesperson must be chosen; name/phone are copied from the salesperson record.
// An inactive salesperson is only accepted if already on the quotation being edited.
function parseQuotationExtras(body, existing) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.quotation_date || '') ? body.quotation_date : todayIST();

  const spId = parseInt(body.salesperson_id) || 0;
  const sp = spId ? db.prepare('SELECT id, name, phone, active FROM salespersons WHERE id=?').get(spId) : null;
  if (!sp || (!sp.active && existing?.salesperson_id !== sp.id)) return { error: 'Please choose the salesperson for this quotation.' };

  const descs   = [].concat(body.extra_desc   ?? []);
  const amounts = [].concat(body.extra_amount ?? []);
  const items = Array.from({ length: Math.max(descs.length, amounts.length) }, (_, i) =>
                       ({ description: String(descs[i] ?? '').trim(), amount: Math.max(0, parseFloat(amounts[i]) || 0) }))
                     .filter(it => it.description || it.amount);
  if (items.some(it => !it.description)) return { error: 'Each additional item needs a description.' };

  return { date, salesperson: sp, extraItems: JSON.stringify(items) };
}

function quotationCustomerIds(q) {
  const ids = [];
  if (q.customer_gstin) ids.push({ label: 'GSTIN', value: q.customer_gstin });
  if (q.customer_pan)   ids.push({ label: 'PAN',   value: q.customer_pan });
  if (!ids.length && q.customer_aadhaar)
    ids.push({ label: 'Aadhaar', value: 'XXXX XXXX ' + q.customer_aadhaar.slice(-4) });
  return ids;
}

app.get('/customers', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const isAdmin = res.locals.user?.role === 'admin';
  // Admin can switch to the deleted customers (?deleted=1) to see or restore them
  const showDeleted = isAdmin && req.query.deleted === '1';
  let sql = `SELECT c.*, u.full_name AS deleted_by_name,
               (SELECT COUNT(*) FROM quotations WHERE customer_id=c.id) AS quote_count
             FROM customers c LEFT JOIN users u ON u.id=c.deleted_by
             WHERE c.deleted_at IS ${showDeleted ? 'NOT ' : ''}NULL`;
  const params = [];
  if (q) { sql += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.gstin LIKE ? OR c.pan LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (!isAdmin) { sql += ' AND (c.created_by=? OR c.created_by IS NULL)'; params.push(req.session.userId); }
  sql += ' ORDER BY c.name';
  const customers = db.prepare(sql).all(...params);
  const deletedCount = isAdmin ? db.prepare('SELECT COUNT(*) AS c FROM customers WHERE deleted_at IS NOT NULL').get().c : 0;
  res.render('customers', { title: 'Customers', customers, q, showDeleted, deletedCount, isAdmin });
});

app.get('/customers/new', requireLogin, (req, res) => {
  res.render('customer-form', { title: 'New Customer', customer: null });
});

app.post('/customers', requireLogin, (req, res) => {
  const { name, phone, address, city, state, hp_with, notes } = req.body;
  if (!name?.trim()) {
    req.session.flash = { error: 'Customer name is required.' };
    return res.redirect('/customers/new');
  }
  const ids = parseCustomerIds(req.body);
  if (ids.error) {
    res.locals.flash = { error: ids.error };
    return res.render('customer-form', { title: 'New Customer', customer: req.body });
  }
  db.prepare(`INSERT INTO customers (name,phone,address,city,state,gstin,pan,aadhaar,hp_with,notes,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name.trim(), phone||'', address||'', city||'', state||'', ids.gstin, ids.pan, ids.aadhaar, hp_with||'', notes||'', req.session.userId);
  req.session.flash = { success: `Customer "${name}" created.` };
  res.redirect('/customers');
});

app.get('/customers/:id/edit', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer || !canAccessCustomer(res, customer)) {
    req.session.flash = { error: customer ? `You don't have permission to edit this customer.` : 'Customer not found.' };
    return res.redirect('/customers');
  }
  res.render('customer-form', { title: 'Edit Customer', customer });
});

app.post('/customers/:id', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer || !canAccessCustomer(res, customer)) {
    req.session.flash = { error: customer ? `You don't have permission to edit this customer.` : 'Customer not found.' };
    return res.redirect('/customers');
  }
  const { name, phone, address, city, state, hp_with, notes } = req.body;
  const ids = parseCustomerIds(req.body);
  if (ids.error) {
    res.locals.flash = { error: ids.error };
    return res.render('customer-form', { title: 'Edit Customer', customer: { ...req.body, id: customer.id } });
  }
  db.prepare(`UPDATE customers SET name=?,phone=?,address=?,city=?,state=?,gstin=?,pan=?,aadhaar=?,hp_with=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, phone||'', address||'', city||'', state||'', ids.gstin, ids.pan, ids.aadhaar, hp_with||'', notes||'', req.params.id);
  req.session.flash = { success: 'Customer updated.' };
  res.redirect('/customers');
});

app.post('/customers/:id/delete', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer || !canAccessCustomer(res, customer)) {
    req.session.flash = { error: customer ? `You don't have permission to delete this customer.` : 'Customer not found.' };
    return res.redirect('/customers');
  }
  // Soft delete: quotations keep pointing at the customer, so the row stays.
  db.prepare('UPDATE customers SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=?').run(req.session.userId, req.params.id);
  req.session.flash = { success: `Customer "${customer.name}" deleted.` };
  res.redirect('/customers');
});

app.post('/customers/:id/restore', requireLogin, requireAdmin, (req, res) => {
  db.prepare('UPDATE customers SET deleted_at=NULL, deleted_by=NULL WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Customer restored.' };
  res.redirect('/customers?deleted=1');
});

// ── Quotations ────────────────────────────────────────────────────────────────
app.get('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const { status, q } = req.query;
  let sql = `SELECT qo.*, c.name as customer_name, m.display_name as machine_name, cu.full_name as cancelled_by_name
             FROM quotations qo
             JOIN customers c ON c.id = qo.customer_id
             JOIN machines m  ON m.id = qo.machine_id
             LEFT JOIN users cu ON cu.id = qo.cancelled_by`;
  const params = [];
  const conds = [];
  if (!isAdmin) { conds.push('qo.user_id = ?'); params.push(req.session.userId); }
  // Cancelled quotations: never shown to users; admin sees them (or only them via the filter)
  if (!isAdmin || (status && status !== 'cancelled')) conds.push('qo.cancelled_at IS NULL');
  if (status === 'cancelled') conds.push('qo.cancelled_at IS NOT NULL');
  else if (status) { conds.push('qo.status = ?'); params.push(status); }
  if (q)        { conds.push('(c.name LIKE ? OR qo.quotation_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY qo.created_at DESC';
  const quotations = db.prepare(sql).all(...params);
  const s = getSettings();
  res.render('quotations', { title: 'Quotations', quotations, status: status||'', q: q||'', formatINR, calcQuotation, settings: s });
});

app.get('/quotations/new', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin      = res.locals.user?.role === 'admin';
  const machines     = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers    = isAdmin
    ? db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY name').all()
    : db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL AND (created_by=? OR created_by IS NULL) ORDER BY name').all(req.session.userId);
  const salespersons = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name').all();
  const prefill      = req.query.customer_id || '';
  const s            = getSettings();
  res.render('quotation-form', { title: 'New Quotation', quotation: null, machines, customers, salespersons, prefill, formatINR, settings: s,
    quotationDate: todayIST(), quotationValidTill });
});

app.post('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes,
  } = req.body;

  if (!customer_id || !machine_id || !basic_price) {
    req.session.flash = { error: 'Customer, machine and price are required.' };
    return res.redirect('/quotations/new');
  }
  const extras = parseQuotationExtras(req.body, null);
  if (extras.error) {
    req.session.flash = { error: extras.error };
    return res.redirect('/quotations/new');
  }

  const { quotationNumber, financialYear, serialNumber } = nextQuotationNumber();
  db.prepare(`INSERT INTO quotations
    (quotation_number,financial_year,serial_number,customer_id,machine_id,user_id,
     quantity,basic_price,transit_insurance,tax_mode,cgst_rate,sgst_rate,igst_rate,
     has_tcs,tcs_rate,insurance_amount,trc,handling_charges,transport_charges,hp_with,notes,salesperson_name,salesperson_phone,tyre_option,salesperson_id,
     quotation_date,extra_items)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      quotationNumber, financialYear, serialNumber,
      +customer_id, +machine_id, req.session.userId,
      +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'',
      extras.salesperson.name, extras.salesperson.phone||'',
      req.body.tyre_option||'IT', extras.salesperson.id,
      extras.date, extras.extraItems
    );
  req.session.flash = { success: `Quotation ${quotationNumber} created.` };
  res.redirect('/quotations');
});

app.get('/quotations/:id', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           c.pan as customer_pan, c.aadhaar as customer_aadhaar,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series, cu.full_name as cancelled_by_name
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    LEFT JOIN users cu ON cu.id = qo.cancelled_by
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.redirect('/quotations');
  if (!isAdmin && (q.user_id !== req.session.userId || q.cancelled_at)) return res.redirect('/quotations');
  const s = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  const qDate = quotationDateOf(q);
  res.render('quotation-view', { title: `Quotation ${q.quotation_number}`, q, calc, specs, formatINR, customerIds: quotationCustomerIds(q),
    quotationDate: fmtLongDate(qDate), validTill: fmtLongDate(quotationValidTill(qDate)) });
});

app.get('/quotations/:id/edit', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin   = res.locals.user?.role === 'admin';
  const quotation = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!quotation) return res.redirect('/quotations');
  if (!isAdmin && (quotation.user_id !== req.session.userId || quotation.cancelled_at)) return res.redirect('/quotations');
  if (quotation.cancelled_at) {
    req.session.flash = { error: 'This quotation is cancelled. Restore it before editing.' };
    return res.redirect(`/quotations/${quotation.id}`);
  }
  const machines  = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers = isAdmin
    ? db.prepare('SELECT * FROM customers WHERE deleted_at IS NULL OR id=? ORDER BY name').all(quotation.customer_id)
    : db.prepare('SELECT * FROM customers WHERE (deleted_at IS NULL OR id=?) AND (created_by=? OR created_by IS NULL) ORDER BY name').all(quotation.customer_id, req.session.userId);
  const s         = getSettings();
  // Active salespersons, plus the one already on this quotation even if since deactivated
  const salespersons2 = db.prepare('SELECT id,name FROM salespersons WHERE active=1 OR id=? ORDER BY name').all(quotation.salesperson_id || 0);
  res.render('quotation-form', { title: 'Edit Quotation', quotation, machines, customers, salespersons: salespersons2, prefill: '', formatINR, settings: s,
    quotationDate: quotationDateOf(quotation), quotationValidTill });
});

app.post('/quotations/:id', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id, salesperson_id, cancelled_at FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || existing.cancelled_at || (!isAdmin && existing.user_id !== req.session.userId)) {
    req.session.flash = { error: existing?.cancelled_at ? 'This quotation is cancelled.' : `You don't have permission to edit this quotation.` };
    return res.redirect('/quotations');
  }
  const extras = parseQuotationExtras(req.body, existing);
  if (extras.error) {
    req.session.flash = { error: extras.error };
    return res.redirect(`/quotations/${req.params.id}/edit`);
  }
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes, status,
    tyre_option,
  } = req.body;
  db.prepare(`UPDATE quotations SET
    customer_id=?,machine_id=?,quantity=?,basic_price=?,transit_insurance=?,
    tax_mode=?,cgst_rate=?,sgst_rate=?,igst_rate=?,has_tcs=?,tcs_rate=?,
    insurance_amount=?,trc=?,handling_charges=?,transport_charges=?,hp_with=?,notes=?,status=?,
    salesperson_name=?,salesperson_phone=?,salesperson_id=?,tyre_option=?,quotation_date=?,extra_items=?
    WHERE id=?`)
    .run(
      +customer_id, +machine_id, +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'', status||'draft',
      extras.salesperson.name, extras.salesperson.phone||'', extras.salesperson.id,
      tyre_option||'IT', extras.date, extras.extraItems,
      req.params.id
    );
  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/quotations/${req.params.id}`);
});

app.post('/quotations/:id/delete', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id, cancelled_at FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || (!isAdmin && (existing.user_id !== req.session.userId || existing.cancelled_at))) {
    req.session.flash = { error: `You don't have permission to cancel this quotation.` };
    return res.redirect('/quotations');
  }
  // Soft delete: hidden from users, admin still sees it marked Cancelled.
  db.prepare('UPDATE quotations SET cancelled_at=CURRENT_TIMESTAMP, cancelled_by=? WHERE id=? AND cancelled_at IS NULL').run(req.session.userId, req.params.id);
  req.session.flash = { success: 'Quotation cancelled.' };
  res.redirect('/quotations');
});

app.post('/quotations/:id/restore', requireLogin, requireAdmin, (req, res) => {
  db.prepare('UPDATE quotations SET cancelled_at=NULL, cancelled_by=NULL WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Quotation restored.' };
  res.redirect(`/quotations/${req.params.id}`);
});

app.get('/quotations/:id/pdf', requireLogin, requirePerm('quotations'), async (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           c.pan as customer_pan, c.aadhaar as customer_aadhaar,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q || q.cancelled_at) return res.status(404).send('Not found');
  if (!isAdmin && q.user_id !== req.session.userId) return res.status(403).send('Forbidden');

  const s    = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  const html = await new Promise((resolve, reject) => {
    const qDate = quotationDateOf(q);
    res.app.render('quotation-pdf', { q, calc, specs, settings: s, formatINR, customerIds: quotationCustomerIds(q),
      quotationDate: fmtLongDate(qDate).toUpperCase(), validTill: fmtLongDate(quotationValidTill(qDate)), numberToWords, bullLogoB64: BULL_LOGO_B64, paymentQrB64: PAYMENT_QR_B64 }, (err, html) => {
      if (err) reject(err); else resolve(html);
    });
  });

  try {
    const pdfBuffer = await generatePDFWithLetterhead(html, LETTERHEAD_PATH);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quotation-${q.quotation_number.replace('/', '-')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    req.session.flash = { error: 'PDF generation failed. Is Puppeteer installed?' };
    res.redirect(`/quotations/${req.params.id}`);
  }
});

// ── Machines ──────────────────────────────────────────────────────────────────
app.get('/machines', requireLogin, (req, res) => {
  const machines = db.prepare('SELECT * FROM machines ORDER BY model_series, display_name').all();
  res.render('machines', { title: 'Machine Catalog', machines, formatINR });
});

app.post('/machines/:id', requireLogin, requireAdmin, (req, res) => {
  const { basic_price, display_name, engine, transmission, front_tyre, rear_tyre,
          battery, weight, bucket, warranty, active } = req.body;
  db.prepare(`UPDATE machines SET basic_price=?,display_name=?,engine=?,transmission=?,
              front_tyre=?,rear_tyre=?,battery=?,weight=?,bucket=?,warranty=?,active=? WHERE id=?`)
    .run(+basic_price, display_name, engine||'', transmission||'', front_tyre||'',
         rear_tyre||'', battery||'', weight||'', bucket||'', warranty||'',
         active === 'on' ? 1 : 0, req.params.id);
  req.session.flash = { success: 'Machine updated.' };
  res.redirect('/machines');
});

// ── Calculator (admin only) ───────────────────────────────────────────────────
app.get('/calculator', requireLogin, requireAdmin, (req, res) => {
  const machines = db.prepare('SELECT id, display_name, model_series, basic_price FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  res.render('calculator', { title: 'Profit Calculator', machines, formatINR });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/settings', requireLogin, (req, res) => {
  res.render('settings', { title: 'Settings', s: getSettings() });
});

app.post('/settings', requireLogin, (req, res) => {
  const fields = [
    'company_name','company_gstin','company_address','dealer_of',
    'contact_name','contact_phone','company_phone_sales','company_phone_service',
    'company_email','company_udyam','company_state','company_state_code',
    'bank_beneficiary','bank_account','bank_ifsc','bank_branch',
    'rto_default_rate','price_lock_enabled','roundoff_enabled','roundoff_amount',
    'company_upi'
  ];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  fields.forEach(k => { if (req.body[k] != null) upsert.run(k, req.body[k]); });
  req.session.flash = { success: 'Settings saved.' };
  res.redirect('/settings');
});

// Change password
app.post('/settings/password', requireLogin, (req, res) => {
  const { current, newpwd, confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    req.session.flash = { error: 'Current password is wrong.' };
    return res.redirect('/settings');
  }
  if (newpwd !== confirm || newpwd.length < 6) {
    req.session.flash = { error: 'Passwords do not match or too short (min 6).' };
    return res.redirect('/settings');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newpwd, 10), user.id);
  req.session.flash = { success: 'Password changed.' };
  res.redirect('/settings');
});

// ── Users (admin only) ────────────────────────────────────────────────────────
app.get('/users', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, is_hr_active, created_at FROM users ORDER BY created_at').all();
  res.render('users', { title: 'Users', users });
});

app.get('/users/new', requireLogin, requireAdmin, (req, res) => {
  res.render('user-form', { title: 'New User' });
});

app.post('/users', requireLogin, requireAdmin, (req, res) => {
  const { username, full_name, role, password, confirm } = req.body;
  if (!username?.trim() || !password) {
    req.session.flash = { error: 'Username and password are required.' };
    return res.redirect('/users/new');
  }
  if (password !== confirm) {
    req.session.flash = { error: 'Passwords do not match.' };
    return res.redirect('/users/new');
  }
  if (password.length < 6) {
    req.session.flash = { error: 'Password must be at least 6 characters.' };
    return res.redirect('/users/new');
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())) {
    req.session.flash = { error: `Username "${username.trim()}" is already taken.` };
    return res.redirect('/users/new');
  }
  const hash = bcrypt.hashSync(password, 10);
  const allowedRoles = ['admin','sales','office','manager','hr','service','staff','employee'];
  const safeRole = allowedRoles.includes(role) ? role : 'sales';
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run(username.trim(), hash, full_name?.trim() || '', safeRole);
  req.session.flash = { success: `User "${username.trim()}" created successfully.` };
  res.redirect('/users');
});

// Hard-deleting a user cascades across attendance, salary, quotations, travel
// expenses, and other financial/HR records — the FOREIGN KEY failures that
// used to surface here are exactly why the app deactivates instead of
// deleting everywhere else (see /hr/employees). These two routes replace the
// old destructive delete.
app.post('/users/:id/deactivate', requireLogin, requireAdmin, (req, res) => {
  const uid = +req.params.id;
  if (uid === req.session.userId) {
    req.session.flash = { error: 'You cannot deactivate your own account.' };
    return res.redirect('/users');
  }
  const u = db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(uid);
  if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/users'); }

  db.prepare('UPDATE users SET is_hr_active=0 WHERE id=?').run(uid);
  auditLog(req.session.userId, 'user_deactivated', 'user', uid, `Deactivated "${u.full_name || u.username}"`);
  req.session.flash = { success: `${u.full_name || u.username} deactivated. Their records are preserved; they can no longer log in.` };
  res.redirect('/users');
});

app.post('/users/:id/activate', requireLogin, requireAdmin, (req, res) => {
  const uid = +req.params.id;
  const u = db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(uid);
  if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/users'); }

  db.prepare('UPDATE users SET is_hr_active=1 WHERE id=?').run(uid);
  auditLog(req.session.userId, 'user_activated', 'user', uid, `Activated "${u.full_name || u.username}"`);
  req.session.flash = { success: `${u.full_name || u.username} activated. They can log in again.` };
  res.redirect('/users');
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/machines/:id', requireLogin, (req, res) => {
  const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  // Dealer purchase price (profit data) is admin-only
  if (m && res.locals.user?.role !== 'admin') delete m.purchase_price;
  res.json(m || {});
});

// ── Spare parts machine lookup ─────────────────────────────────────────────────
app.get('/api/spare/machine-lookup', requireLogin, (req, res) => {
  const no = req.query.no || '';
  const m = db.prepare('SELECT * FROM sold_machines WHERE machine_no = ? COLLATE NOCASE').get(no.trim());
  res.json(m || {});
});

app.get('/api/customers/search', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const isAdmin = res.locals.user?.role === 'admin';
  let sql = "SELECT id, name, phone, gstin FROM customers WHERE deleted_at IS NULL AND (name LIKE ? OR phone LIKE ?)";
  const params = [`%${q}%`, `%${q}%`];
  if (!isAdmin) { sql += ' AND (created_by=? OR created_by IS NULL)'; params.push(req.session.userId); }
  sql += ' LIMIT 10';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// ── Universal Search API ──────────────────────────────────────────────────────
app.get('/api/search', requireLogin, (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  if (!query || query.length < 2) {
    return res.json({ results: [] });
  }

  const results = [];
  const limit = 15;

  try {
    // Search machines by model_code and display_name
    const machines = db.prepare(`
      SELECT id, display_name, model_code, basic_price
      FROM machines
      WHERE active=1 AND (
        LOWER(display_name) LIKE ?
        OR LOWER(model_code) LIKE ?
      )
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);

    machines.forEach(m => {
      results.push({
        category: 'Machines',
        title: m.display_name,
        meta: `${m.model_code} • ₹${m.basic_price.toLocaleString('en-IN')}`,
        link: `/machines/${m.id}`
      });
    });

    // Search enquiries by number, customer name, or phone
    const enquiries = db.prepare(`
      SELECT id, enquiry_number, customer_name, phone, current_stage
      FROM enquiries
      WHERE LOWER(enquiry_number) LIKE ? OR LOWER(customer_name) LIKE ? OR phone LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);

    enquiries.forEach(e => {
      results.push({
        category: 'Enquiries',
        title: `${e.enquiry_number} — ${e.customer_name}`,
        meta: e.phone || '',
        link: `/enquiries/${e.id}`
      });
    });

    // Search customers by name or phone
    const customers = db.prepare(`
      SELECT id, name, phone, gstin
      FROM customers
      WHERE deleted_at IS NULL AND (LOWER(name) LIKE ? OR phone LIKE ?)
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);

    customers.forEach(c => {
      results.push({
        category: 'Customers',
        title: c.name,
        meta: c.phone ? `📞 ${c.phone}` : '',
        link: `/customers`
      });
    });

    // Search quotations by quotation_number or customer name
    const quotations = db.prepare(`
      SELECT q.id, q.quotation_number, c.name as customer_name, m.display_name as machine_name
      FROM quotations q
      JOIN customers c ON c.id = q.customer_id
      JOIN machines m ON m.id = q.machine_id
      WHERE (q.quotation_number LIKE ? OR LOWER(c.name) LIKE ?)
        ${res.locals.user?.role === 'admin' ? '' : 'AND q.cancelled_at IS NULL'}
      ORDER BY q.created_at DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);

    quotations.forEach(q => {
      results.push({
        category: 'Quotations',
        title: `#${q.quotation_number} - ${q.customer_name}`,
        meta: q.machine_name,
        link: `/quotations/${q.id}`
      });
    });

    // Search spare parts by part number or description
    const spareParts = db.prepare(`
      SELECT id, sap_part_no, rnd_part_no, material_description, mrp_price
      FROM spare_parts
      WHERE LOWER(sap_part_no) LIKE ?
        OR LOWER(rnd_part_no) LIKE ?
        OR LOWER(material_description) LIKE ?
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);

    spareParts.forEach(p => {
      results.push({
        category: 'Spare Parts',
        title: `${p.sap_part_no || p.rnd_part_no} - ${p.material_description}`,
        meta: p.mrp_price ? `₹${p.mrp_price.toLocaleString('en-IN')}` : '',
        link: `/spare-parts`
      });
    });

    // Search sold machines by machine_no or chassis_number
    const soldMachines = db.prepare(`
      SELECT id, machine_no, chassis_number, customer_name, engine_number
      FROM sold_machines
      WHERE LOWER(machine_no) LIKE ? OR LOWER(chassis_number) LIKE ? OR LOWER(engine_number) LIKE ?
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);

    soldMachines.forEach(s => {
      results.push({
        category: 'Sold Machines',
        title: s.machine_no || s.chassis_number,
        meta: `${s.customer_name} • ${s.engine_number || ''}`.trim(),
        link: `/sold-machines/${s.id}`
      });
    });

    // Search employees by name or employee_code
    const employees = db.prepare(`
      SELECT id, full_name, employee_code, designation
      FROM users
      WHERE is_hr_active=1 AND (
        LOWER(full_name) LIKE ?
        OR LOWER(employee_code) LIKE ?
      )
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);

    employees.forEach(e => {
      results.push({
        category: 'Employees',
        title: e.full_name,
        meta: `${e.employee_code} • ${e.designation || ''}`.trim(),
        link: `/hr/employees/${e.id}`
      });
    });

    // Limit total results to 15
    res.json({ results: results.slice(0, 15) });
  } catch(e) {
    console.error('Search error:', e);
    res.json({ results: [] });
  }
});

// ── Photo upload API ──────────────────────────────────────────────────────────
app.post('/api/upload', requireLogin, (req, res) => {
  const { data, folder } = req.body;
  if (!data?.startsWith('data:image')) return res.status(400).json({ error: 'Invalid image data' });
  const allowedFolders = ['attendance', 'employees', 'visits', 'expenses', 'enquiries'];
  const safe = allowedFolders.includes(folder) ? folder : 'misc';
  const dir  = path.join(UPLOADS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${Date.now()}-${req.session.userId}-${Math.random().toString(36).slice(2)}.jpg`;
  fs.writeFileSync(path.join(dir, fname), Buffer.from(data.split(',')[1], 'base64'));
  res.json({ ok: true, path: `/uploads/${safe}/${fname}` });
});

// Serve uploaded files (auth-gated)
app.use('/uploads', requireLogin, express.static(UPLOADS_DIR));

// ── My ID Card ─────────────────────────────────────────────────────────────────
app.get('/id-card', requireLogin, async (req, res) => {
  const QRCode = require('qrcode');
  const emp    = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const s      = getSettings();
  const qrData = `EMP:${emp.employee_code || emp.id}|${emp.full_name}`;
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 120, margin: 1 });
  res.render('id-card', { title: 'My ID Card', emp, settings: s, qrDataUrl, adminView: false });
});

app.get('/id-card/pdf', requireLogin, async (req, res) => {
  const QRCode = require('qrcode');
  const emp    = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const s      = getSettings();
  const qrData = `EMP:${emp.employee_code || emp.id}|${emp.full_name}`;
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 140, margin: 1 });
  const html = await new Promise((resolve, reject) =>
    res.app.render('id-card-pdf', { emp, settings: s, qrDataUrl },
      (err, h) => err ? reject(err) : resolve(h)));
  const pdfBuffer = await generatePDF(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="IDCard-${emp.employee_code || emp.id}.pdf"`);
  res.send(pdfBuffer);
});

// ── Role guards ───────────────────────────────────────────────────────────────
function requireManagerOrAdmin(req, res, next) {
  const role = res.locals.user?.role;
  if (['admin','manager'].includes(role)) return next();
  req.session.flash = { error: 'Manager or Admin access required.' };
  res.redirect('/');
}

// ── Mount HR modules ──────────────────────────────────────────────────────────
app.use('/attendance',    requireLogin, attendanceRoutes);
app.use('/leaves',        requireLogin, leavesRoutes);
app.use('/salary',        requireLogin, salaryRoutes);
app.use('/notifications', requireLogin, notifyRoutes);
app.use('/hr',            requireLogin, requireManagerOrAdmin, hrRoutes);
app.use('/visits',        requireLogin, visitsRoutes);
app.use('/expenses',      requireLogin, requirePerm('expense_claim'), expensesRoutes);
app.use('/travel-expenses', requireLogin, travelExpensesRoutes);
app.use('/machines',          requireLogin, requireManagerOrAdmin, machinesRoutes);
app.use('/enquiries',         requireLogin, requirePerm('enquiries'),        enquiriesRoutes);
app.use('/sold-machines',     requireLogin, requirePerm('sold_machines'),    soldMachinesRoutes);
app.use('/spare-parts',       requireLogin, requirePerm('spare_parts'),       sparePartsRoutes);
app.use('/spare-quotations',  requireLogin, requirePerm('spare_quotations'),  spareQuotationsRoutes);
app.use('/salespersons',      requireLogin, requirePerm('salespersons_admin'), salespersonsRoutes);
app.use('/stock',             requireLogin, requirePerm('stock'),             stockRoutes);
app.use('/form-22',           requireLogin, requirePerm('quotations'),        form22Routes);
app.use('/part-orders',       requireLogin, requirePerm('spare_parts'),       partOrdersRoutes);
app.use('/backup',            requireLogin, requireAdmin,                     backupRoutes);

// Today's route: attendance check-in/out + site visits as GPS anchors
app.get('/my-route', requireLogin, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const att = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(req.session.userId, today);
  const visits = db.prepare("SELECT id, lat, lng, customer_name, purpose, visit_time FROM field_visits WHERE user_id=? AND date(visit_time)=? ORDER BY visit_time").all(req.session.userId, today);
  res.render('my-route', { title: 'My Route Today', att, visits, today });
});

// Help: datewise list of app improvements (see changelog.js)
app.get('/help', requireLogin, (req, res) => {
  res.render('help', { title: 'Help & Updates', changelog: require('./changelog') });
});

// ── HR redirect ────────────────────────────────────────────────────────────────
app.get('/hr', requireLogin, (req, res) => {
  const role = res.locals.user?.role;
  if (['admin','manager'].includes(role)) return res.redirect('/hr/dashboard');
  res.redirect('/attendance');
});

// ── API: employee list (for HR dropdowns) ─────────────────────────────────────
app.get('/api/hr/employees', requireLogin, (req, res) => {
  const employees = db.prepare("SELECT id, full_name, employee_code, department FROM users WHERE is_hr_active=1 ORDER BY full_name").all();
  res.json(employees);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   SUPER ALLIED — Quotation & CRM App             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Open: http://localhost:${PORT}                     ║`);
  console.log('║   Login: admin / admin123                        ║');
  console.log('║   (Change password in Settings after login)      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});
