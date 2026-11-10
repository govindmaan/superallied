// All dates/times are India time (+5:30), whatever timezone the host runs in
process.env.TZ = 'Asia/Kolkata';
require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const { db, getSettings, getUserPermissions, getPositionPermissions, checkFollowupNotifications } = require('./db');
const { UPLOADS_DIR, BULL_LOGO_B64 } = require('./lib/assets');
const { requireLogin, requireAdmin, requirePerm, requireManagerOrAdmin } = require('./lib/auth');
const i18n = require('./lib/i18n');

// ── Route modules ─────────────────────────────────────────────────────────────
const authRoutes       = require('./routes/auth');
const homeRoutes       = require('./routes/home');
const customersRoutes  = require('./routes/customers');
const quotationsRoutes = require('./routes/quotations');
const accountRoutes    = require('./routes/account');
const usersRoutes      = require('./routes/users');
const apiRoutes        = require('./routes/api');
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
const routeMapRoutes        = require('./routes/route-map');
const backupRoutes          = require('./routes/backup');
const databankRoutes        = require('./routes/databank');
const telecallerRoutes      = require('./routes/telecaller');
const myleadsRoutes         = require('./routes/myleads');
const orgRoutes             = require('./routes/org');
const complaintsRoutes      = require('./routes/complaints');
const pushRoutes            = require('./routes/push');

const app  = express();
const PORT = process.env.PORT || 3000;

// Make UPLOADS_DIR accessible to route modules via app.locals
app.locals.UPLOADS_DIR = UPLOADS_DIR;
app.locals.bullLogoB64 = BULL_LOGO_B64;
// Templates rendered outside a request (PDFs) stay English
Object.assign(app.locals, i18n.defaultLocals);

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // behind Railway's proxy: req.ip is the real client address
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));  // 20mb covers large Excel imports (~1MB file = ~1.4MB base64)

// Client-side strings (alerts, text set by page scripts) for the chosen language
app.get('/i18n/:lang.js', (req, res) => {
  const lang = i18n.LANGS[req.params.lang] ? req.params.lang : 'en';
  res.type('application/javascript').set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(i18n.clientScript(lang));
});
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


// Inject user, settings, permissions, notification count into all views
app.use((req, res, next) => {
  let u = req.session.userId
    ? db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.position_code, u.databank_access,
        u.must_change_password, u.sessions_valid_after, u.language,
        p.title AS position_title, p.level AS position_level, p.section AS position_section
      FROM users u LEFT JOIN org_positions p ON p.code = u.position_code
      WHERE u.id = ?`).get(req.session.userId)
    : null;
  // Password was reset after this session began: end it
  if (u?.sessions_valid_after && (req.session.authAt || 0) < u.sessions_valid_after) {
    return req.session.regenerate(() => {
      req.session.flash = { error: 'Your password was reset by the admin. Please log in again.' };
      res.redirect('/login');
    });
  }
  // A reset password must be replaced before anything else can be used
  if (u?.must_change_password && !['/change-password', '/logout'].includes(req.path)) {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect('/change-password');
    return res.status(403).json({ error: 'Please choose a new password first.' });
  }
  // Language: interface text, flash messages and JSON messages (see lib/i18n.js)
  const lang = i18n.pickLang(req, u);
  const t = i18n.translator(lang);
  req.lang = lang; req.t = t;
  Object.assign(res.locals, { lang, t, tjs: i18n.jsEscape, locale: i18n.LANGS[lang].locale, LANGS: i18n.LANGS, i18nVersion: i18n.VERSION });
  for (const k of ['success', 'error', 'info', 'warning']) if (typeof res.locals.flash[k] === 'string') res.locals.flash[k] = t(res.locals.flash[k]);
  if (lang !== 'en') {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && !Array.isArray(body))
        for (const k of ['error', 'message', 'msg', 'warning']) if (typeof body[k] === 'string') body = { ...body, [k]: t(body[k]) };
      return json(body);
    };
  }
  res.locals.user     = u;
  res.locals.currentPath = req.originalUrl.split('?')[0]; // sidebar highlights the matching link
  // SQLite CURRENT_TIMESTAMP values are UTC without a zone ('2026-10-18 09:30:00'); read them as UTC
  res.locals.dbTime = (v) => v ? new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v) : null;
  res.locals.settings = getSettings();
  res.locals.unreadCount = u
    ? (db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0').get(u.id)?.c || 0)
    : 0;

  // Permission helpers
  if (u) {
    const perms = getPositionPermissions(u.position_code, u.role);
    if (u.databank_access) perms.push('databank');
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

// Language switch: remembered on this device (cookie) and on the user's profile
app.post('/lang', (req, res) => {
  const lang = i18n.LANGS[req.body.lang] ? req.body.lang : i18n.DEFAULT_LANG;
  res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: false });
  if (req.session.userId) db.prepare('UPDATE users SET language=? WHERE id=?').run(lang, req.session.userId);
  if (req.accepts(['html', 'json']) === 'json' || req.xhr || req.is('json')) return res.json({ ok: true, lang });
  res.redirect(req.get('Referer') || '/');
});

// ── Core pages (each module keeps its full paths) ─────────────────────────────
app.use(authRoutes);
app.use(homeRoutes);
app.use(customersRoutes);
app.use(quotationsRoutes);
app.use(accountRoutes);
app.use(usersRoutes);
app.use(apiRoutes);

// ── Mount HR modules ──────────────────────────────────────────────────────────
app.use('/attendance',    requireLogin, attendanceRoutes);
app.use('/leaves',        requireLogin, leavesRoutes);
app.use('/salary',        requireLogin, salaryRoutes);
app.use('/notifications', requireLogin, notifyRoutes);
app.use('/push',          requireLogin, pushRoutes);
app.use('/hr',            requireLogin, requireManagerOrAdmin, hrRoutes);
app.use('/org-chart',     requireLogin, orgRoutes);
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
app.use('/route-map',         requireLogin,                                   routeMapRoutes);
app.use('/backup',            requireLogin, requireAdmin,                     backupRoutes);
app.use('/databank',          requireLogin, requirePerm('databank'),          databankRoutes);
app.use('/telecaller',        requireLogin, requirePerm('telecaller'),        telecallerRoutes);
app.use('/complaints',        requireLogin, requirePerm('service_complaints'), complaintsRoutes);
app.use('/my-leads',          requireLogin, requirePerm('enquiries'),         myleadsRoutes);

// Old "My Route" page now lives in the route map
app.get('/my-route', requireLogin, (req, res) => res.redirect('/route-map'));

// Help: datewise list of app improvements (see changelog.js)
app.get('/help', requireLogin, (req, res) => {
  res.render('help', { title: 'Help & Updates', changelog: require('./changelog'), changelogHi: require('./i18n/changelog-hi') });
});

// ── HR redirect ────────────────────────────────────────────────────────────────
app.get('/hr', requireLogin, (req, res) => {
  const role = res.locals.user?.role;
  if (['admin','manager'].includes(role)) return res.redirect('/hr/dashboard');
  res.redirect('/attendance');
});

// ── Start ──────────────────────────────────────────────────────────────────────
// 9:00 check-in and 19:00 check-out push reminders (lib/reminders.js)
require('./lib/reminders').start();

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   SUPER ALLIED — Quotation & CRM App             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Open: http://localhost:${PORT}                     ║`);
  console.log('║   Login: admin / admin123                        ║');
  console.log('║   (Change password in Settings after login)      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});

