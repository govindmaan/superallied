require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const { db, getSettings, nextQuotationNumber, calcQuotation, formatINR, numberToWords, createNotification, getUserPermissions, checkFollowupNotifications, auditLog } = require('./db');
const { generatePDF } = require('./pdf');

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
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Login' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.session.flash = { error: 'Invalid username or password.' };
    return res.redirect('/login');
  }
  if (user.is_hr_active === 0) {
    req.session.flash = { error: 'Your account has been deactivated. Contact HR/Admin.' };
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect('/');
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

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', requireLogin, (req, res) => {
  const role    = res.locals.user?.role;
  const isAdminLike = ['admin','manager','hr'].includes(role);
  const uid     = req.session.userId;
  const today   = new Date().toISOString().slice(0, 10);

  if (!isAdminLike) {
    // ── Employee tile dashboard ──
    const todayAtt = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, today);
    const myQuotes = db.prepare("SELECT COUNT(*) as c FROM quotations WHERE user_id=? AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(uid).c;
    const myVisits = db.prepare("SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time)=?").get(uid, today).c;
    const pendingLeaves = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE user_id=? AND status='pending'").get(uid).c;
    const emp = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    const monthClaim = db.prepare("SELECT COALESCE(SUM(total_claim),0) as t FROM travel_expenses WHERE user_id=? AND date LIKE ?")
      .get(uid, new Date().toISOString().slice(0,7) + '%').t;
    return res.render('dashboard-employee', { title: 'Home', todayAtt, myQuotes, myVisits, pendingLeaves, emp, today, monthClaim });
  }

  // ── Admin / HR dashboard ──
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
  return res.locals.user?.role === 'admin' || customer.created_by == null || customer.created_by === res.locals.user?.id;
}

app.get('/customers', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const isAdmin = res.locals.user?.role === 'admin';
  let sql = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ? OR gstin LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (!isAdmin) { sql += ' AND (created_by=? OR created_by IS NULL)'; params.push(req.session.userId); }
  sql += ' ORDER BY name';
  const customers = db.prepare(sql).all(...params);
  res.render('customers', { title: 'Customers', customers, q });
});

app.get('/customers/new', requireLogin, (req, res) => {
  res.render('customer-form', { title: 'New Customer', customer: null });
});

app.post('/customers', requireLogin, (req, res) => {
  const { name, phone, address, city, state, gstin, hp_with, notes } = req.body;
  if (!name?.trim()) {
    req.session.flash = { error: 'Customer name is required.' };
    return res.redirect('/customers/new');
  }
  db.prepare(`INSERT INTO customers (name,phone,address,city,state,gstin,hp_with,notes,created_by)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(name.trim(), phone||'', address||'', city||'', state||'', gstin||'', hp_with||'', notes||'', req.session.userId);
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
  const { name, phone, address, city, state, gstin, hp_with, notes } = req.body;
  db.prepare(`UPDATE customers SET name=?,phone=?,address=?,city=?,state=?,gstin=?,hp_with=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, phone||'', address||'', city||'', state||'', gstin||'', hp_with||'', notes||'', req.params.id);
  req.session.flash = { success: 'Customer updated.' };
  res.redirect('/customers');
});

app.post('/customers/:id/delete', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer || !canAccessCustomer(res, customer)) {
    req.session.flash = { error: customer ? `You don't have permission to delete this customer.` : 'Customer not found.' };
    return res.redirect('/customers');
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  req.session.flash = { success: 'Customer deleted.' };
  res.redirect('/customers');
});

// ── Quotations ────────────────────────────────────────────────────────────────
app.get('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const { status, q } = req.query;
  let sql = `SELECT qo.*, c.name as customer_name, m.display_name as machine_name
             FROM quotations qo
             JOIN customers c ON c.id = qo.customer_id
             JOIN machines m  ON m.id = qo.machine_id`;
  const params = [];
  const conds = [];
  if (!isAdmin) { conds.push('qo.user_id = ?'); params.push(req.session.userId); }
  if (status)   { conds.push('qo.status = ?'); params.push(status); }
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
    ? db.prepare('SELECT * FROM customers ORDER BY name').all()
    : db.prepare('SELECT * FROM customers WHERE created_by=? OR created_by IS NULL ORDER BY name').all(req.session.userId);
  const salespersons = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name').all();
  const prefill      = req.query.customer_id || '';
  const s            = getSettings();
  res.render('quotation-form', { title: 'New Quotation', quotation: null, machines, customers, salespersons, prefill, formatINR, settings: s,
    defaultSalesperson: s.contact_name || '', defaultSalespersonPhone: s.contact_phone || '' });
});

app.post('/quotations', requireLogin, requirePerm('quotations'), (req, res) => {
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes,
    salesperson_name, salesperson_phone,
  } = req.body;

  if (!customer_id || !machine_id || !basic_price) {
    req.session.flash = { error: 'Customer, machine and price are required.' };
    return res.redirect('/quotations/new');
  }

  const spId3 = req.body.salesperson_id ? parseInt(req.body.salesperson_id) : null;
  let spName3 = salesperson_name || '';
  if (spId3) { const spR3 = db.prepare('SELECT name,phone FROM salespersons WHERE id=?').get(spId3); if (spR3) { spName3 = spR3.name; } }

  const { quotationNumber, financialYear, serialNumber } = nextQuotationNumber();
  db.prepare(`INSERT INTO quotations
    (quotation_number,financial_year,serial_number,customer_id,machine_id,user_id,
     quantity,basic_price,transit_insurance,tax_mode,cgst_rate,sgst_rate,igst_rate,
     has_tcs,tcs_rate,insurance_amount,trc,handling_charges,transport_charges,hp_with,notes,salesperson_name,salesperson_phone,tyre_option,salesperson_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      quotationNumber, financialYear, serialNumber,
      +customer_id, +machine_id, req.session.userId,
      +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'',
      spName3, salesperson_phone||'',
      req.body.tyre_option||'IT', spId3
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
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.redirect('/quotations');
  if (!isAdmin && q.user_id !== req.session.userId) return res.redirect('/quotations');
  const s = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  res.render('quotation-view', { title: `Quotation ${q.quotation_number}`, q, calc, specs, formatINR });
});

app.get('/quotations/:id/edit', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin   = res.locals.user?.role === 'admin';
  const quotation = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!quotation) return res.redirect('/quotations');
  if (!isAdmin && quotation.user_id !== req.session.userId) return res.redirect('/quotations');
  const machines  = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers = isAdmin
    ? db.prepare('SELECT * FROM customers ORDER BY name').all()
    : db.prepare('SELECT * FROM customers WHERE created_by=? OR created_by IS NULL ORDER BY name').all(req.session.userId);
  const s         = getSettings();
  const salespersons2 = db.prepare('SELECT id,name FROM salespersons WHERE active=1 ORDER BY name').all();
  res.render('quotation-form', { title: 'Edit Quotation', quotation, machines, customers, salespersons: salespersons2, prefill: '', formatINR, settings: s,
    defaultSalesperson: s.contact_name || '', defaultSalespersonPhone: s.contact_phone || '' });
});

app.post('/quotations/:id', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || (!isAdmin && existing.user_id !== req.session.userId)) {
    req.session.flash = { error: `You don't have permission to edit this quotation.` };
    return res.redirect('/quotations');
  }
  const {
    customer_id, machine_id, quantity, basic_price,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance_amount, trc, handling_charges, transport_charges, hp_with, notes, status,
    salesperson_name, salesperson_phone, tyre_option,
  } = req.body;
  db.prepare(`UPDATE quotations SET
    customer_id=?,machine_id=?,quantity=?,basic_price=?,transit_insurance=?,
    tax_mode=?,cgst_rate=?,sgst_rate=?,igst_rate=?,has_tcs=?,tcs_rate=?,
    insurance_amount=?,trc=?,handling_charges=?,transport_charges=?,hp_with=?,notes=?,status=?,
    salesperson_name=?,salesperson_phone=?,tyre_option=?
    WHERE id=?`)
    .run(
      +customer_id, +machine_id, +quantity||1, +basic_price, 0,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      +insurance_amount||0, String(+trc||0), +handling_charges||0, +transport_charges||0,
      hp_with||'', notes||'', status||'draft',
      salesperson_name||'', salesperson_phone||'',
      tyre_option||'IT',
      req.params.id
    );
  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/quotations/${req.params.id}`);
});

app.post('/quotations/:id/delete', requireLogin, requirePerm('quotations'), (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const existing = db.prepare('SELECT user_id FROM quotations WHERE id=?').get(req.params.id);
  if (!existing || (!isAdmin && existing.user_id !== req.session.userId)) {
    req.session.flash = { error: `You don't have permission to delete this quotation.` };
    return res.redirect('/quotations');
  }
  db.prepare('DELETE FROM quotations WHERE id = ?').run(req.params.id);
  req.session.flash = { success: 'Quotation deleted.' };
  res.redirect('/quotations');
});

app.get('/quotations/:id/pdf', requireLogin, requirePerm('quotations'), async (req, res) => {
  const isAdmin = res.locals.user?.role === 'admin';
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.status(404).send('Not found');
  if (!isAdmin && q.user_id !== req.session.userId) return res.status(403).send('Forbidden');

  const s    = getSettings();
  const calc = calcQuotation(q, s);
  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(q.machine_id);
  const html = await new Promise((resolve, reject) => {
    res.app.render('quotation-pdf', { q, calc, specs, settings: s, formatINR, numberToWords, bullLogoB64: BULL_LOGO_B64, paymentQrB64: PAYMENT_QR_B64 }, (err, html) => {
      if (err) reject(err); else resolve(html);
    });
  });

  try {
    const pdfBuffer = await generatePDF(html);
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
    'salesperson_name','salesperson_phone',
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
  res.json(m || {});
});

// ── Spare parts machine lookup ─────────────────────────────────────────────────
app.get('/api/spare/machine-lookup', requireLogin, (req, res) => {
  const no = req.query.no || '';
  const m = db.prepare('SELECT * FROM sold_machines WHERE machine_no = ?').get(no.trim());
  res.json(m || {});
});

app.get('/api/customers/search', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const isAdmin = res.locals.user?.role === 'admin';
  let sql = "SELECT id, name, phone, gstin FROM customers WHERE (name LIKE ? OR phone LIKE ?)";
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
      WHERE LOWER(name) LIKE ? OR phone LIKE ?
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
      WHERE q.quotation_number LIKE ? OR LOWER(c.name) LIKE ?
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
