const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const QRCode  = require('qrcode');
const bcrypt  = require('bcryptjs');
const { db, getSettings, formatINR, numberToWords, createNotification, auditLog } = require('../db');
const { generatePDF } = require('../pdf');

// ── HR Dashboard ──────────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const today = new Date().toLocaleDateString('en-CA');

  const totalEmployees = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_hr_active=1").get().c;
  const presentToday   = db.prepare("SELECT COUNT(*) as c FROM attendance WHERE date=? AND check_in_time IS NOT NULL").get(today).c;
  const pendingLeaves  = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE status='pending'").get().c;
  const thisMonthSalaries = db.prepare(
    "SELECT COUNT(*) as c FROM salary_records WHERE month=?").get(new Date().toLocaleDateString('en-CA').slice(0, 7)).c;

  const recentAttendance = db.prepare(`
    SELECT a.*, u.full_name, u.employee_code, u.department
    FROM attendance a JOIN users u ON u.id=a.user_id
    WHERE a.date=? ORDER BY a.check_in_time DESC LIMIT 10`).all(today);

  const pendingLeaveList = db.prepare(`
    SELECT l.*, lt.name as lt_name, u.full_name
    FROM leaves l JOIN leave_types lt ON lt.id=l.leave_type_id JOIN users u ON u.id=l.user_id
    WHERE l.status='pending' ORDER BY l.created_at ASC LIMIT 5`).all();

  res.render('hr/dashboard', { title: 'HR Dashboard',
    totalEmployees, presentToday, pendingLeaves, thisMonthSalaries,
    recentAttendance, pendingLeaveList, today });
});

// ── Employee List ─────────────────────────────────────────────────────────────
const ALL_ROLES = ['admin','manager','hr','sales','office','service','staff','employee'];

router.get('/employees', (req, res) => {
  const { q, dept, role, status } = req.query;
  let sql = "SELECT * FROM users WHERE 1=1";
  const params = [];
  if (q)      { sql += " AND (full_name LIKE ? OR employee_code LIKE ? OR mobile LIKE ?)"; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (dept)   { sql += " AND department=?"; params.push(dept); }
  if (role)   { sql += " AND role=?"; params.push(role); }
  if (status === 'active')   sql += " AND is_hr_active=1";
  if (status === 'inactive') sql += " AND is_hr_active=0";
  sql += " ORDER BY is_hr_active DESC, full_name";

  const employees = db.prepare(sql).all(...params);
  const departments = db.prepare("SELECT DISTINCT department FROM users WHERE department != ''").all().map(r => r.department);
  const managers  = db.prepare("SELECT id, full_name FROM users WHERE role IN ('admin','manager') ORDER BY full_name").all();

  res.render('hr/employees', { title: 'Employees', employees, departments, managers, allRoles: ALL_ROLES,
    q: q||'', dept: dept||'', role: role||'', status: status||'' });
});

// ── New employee form ─────────────────────────────────────────────────────────
router.get('/employees/new', (req, res) => {
  const managers = db.prepare("SELECT id, full_name FROM users WHERE role IN ('admin','manager') ORDER BY full_name").all();
  res.render('hr/employee-form', { title: 'Add Employee', emp: null, managers, allRoles: ALL_ROLES });
});

// ── Create employee ───────────────────────────────────────────────────────────
router.post('/employees', (req, res) => {
  const { username, password, full_name, role, employee_code, designation,
          department, mobile, emergency_contact, date_of_joining, manager_id,
          vehicle_type, vehicle_number } = req.body;

  if (!username?.trim() || !password) {
    req.session.flash = { error: 'Username and password are required.' };
    return res.redirect('/hr/employees/new');
  }
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username.trim())) {
    req.session.flash = { error: `Username "${username.trim()}" is already taken.` };
    return res.redirect('/hr/employees/new');
  }
  const safeRole = ALL_ROLES.includes(role) ? role : 'sales';

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`INSERT INTO users
    (username,password_hash,full_name,role,employee_code,designation,department,
     mobile,emergency_contact,date_of_joining,manager_id,vehicle_type,vehicle_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(username.trim(), hash, full_name||'', safeRole,
      employee_code||'', designation||'', department||'',
      mobile||'', emergency_contact||'', date_of_joining||null,
      manager_id ? +manager_id : null, vehicle_type||'', vehicle_number||'');

  auditLog(req.session.userId, 'user_created', 'user', result.lastInsertRowid, `Created "${full_name}" (${safeRole})`);
  req.session.flash = { success: `Employee "${full_name}" created.` };
  res.redirect('/hr/employees/' + result.lastInsertRowid);
});

// ── View employee profile ─────────────────────────────────────────────────────
router.get('/employees/:id', (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.redirect('/hr/employees');

  const manager  = emp.manager_id ? db.prepare('SELECT full_name FROM users WHERE id=?').get(emp.manager_id) : null;
  const today    = new Date().toLocaleDateString('en-CA');
  const thisMonth = new Date().toLocaleDateString('en-CA').slice(0, 7);

  const attStats = db.prepare(`
    SELECT COUNT(*) as days, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) as present
    FROM attendance WHERE user_id=? AND date >= date('now','+330 minutes','start of month')`).get(emp.id);
  const lastSalary = db.prepare('SELECT * FROM salary_records WHERE user_id=? ORDER BY month DESC LIMIT 1').get(emp.id);
  const pendingLeaves = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE user_id=? AND status='pending'").get(emp.id).c;

  res.render('hr/employee-profile', { title: emp.full_name, emp, manager,
    attStats, lastSalary, pendingLeaves, formatINR });
});

// ── Edit employee ─────────────────────────────────────────────────────────────
router.get('/employees/:id/edit', (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.redirect('/hr/employees');
  const managers = db.prepare("SELECT id, full_name FROM users WHERE role IN ('admin','manager') ORDER BY full_name").all();
  res.render('hr/employee-form', { title: 'Edit Employee', emp, managers, allRoles: ALL_ROLES });
});

router.post('/employees/:id', (req, res) => {
  const { full_name, role, employee_code, designation, department,
          mobile, emergency_contact, date_of_joining, manager_id, is_hr_active, photo_path,
          vehicle_type, vehicle_number } = req.body;
  const safeRole = ALL_ROLES.includes(role) ? role : 'sales';

  db.prepare(`UPDATE users SET full_name=?,role=?,employee_code=?,designation=?,department=?,
    mobile=?,emergency_contact=?,date_of_joining=?,manager_id=?,is_hr_active=?,photo_path=?,
    vehicle_type=?,vehicle_number=?
    WHERE id=?`)
    .run(full_name||'', safeRole, employee_code||'', designation||'', department||'',
      mobile||'', emergency_contact||'', date_of_joining||null,
      manager_id ? +manager_id : null,
      is_hr_active === '0' ? 0 : 1,
      photo_path||'', vehicle_type||'', vehicle_number||'',
      req.params.id);

  auditLog(req.session.userId, 'user_updated', 'user', req.params.id, `Updated "${full_name}"`);
  req.session.flash = { success: 'Employee updated.' };
  res.redirect('/hr/employees/' + req.params.id);
});

// ── Activate / Deactivate employee ────────────────────────────────────────────
router.post('/employees/:id/activate', (req, res) => {
  const emp = db.prepare('SELECT id, full_name FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.redirect('/hr/employees');
  db.prepare('UPDATE users SET is_hr_active=1 WHERE id=?').run(emp.id);
  auditLog(req.session.userId, 'user_activated', 'user', emp.id, `Activated "${emp.full_name}"`);
  req.session.flash = { success: `${emp.full_name} activated. They can now log in.` };
  res.redirect('back');
});

router.post('/employees/:id/deactivate', (req, res) => {
  const emp = db.prepare('SELECT id, full_name FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.redirect('/hr/employees');
  if (+req.params.id === req.session.userId) {
    req.session.flash = { error: 'You cannot deactivate your own account.' };
    return res.redirect('back');
  }
  db.prepare('UPDATE users SET is_hr_active=0 WHERE id=?').run(emp.id);
  auditLog(req.session.userId, 'user_deactivated', 'user', emp.id, `Deactivated "${emp.full_name}"`);
  req.session.flash = { success: `${emp.full_name} deactivated. Their records are preserved; they can no longer log in.` };
  res.redirect('back');
});

// ── Employee photo upload ─────────────────────────────────────────────────────
router.post('/employees/:id/photo', (req, res) => {
  const { photo } = req.body;
  if (!photo?.startsWith('data:image')) return res.json({ ok: false });

  const UPLOADS_DIR = res.app.locals.UPLOADS_DIR;
  const dir = path.join(UPLOADS_DIR, 'employees');
  fs.mkdirSync(dir, { recursive: true });
  const fname = `emp-${req.params.id}-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(dir, fname), Buffer.from(photo.split(',')[1], 'base64'));
  const photoPath = `/uploads/employees/${fname}`;

  db.prepare('UPDATE users SET photo_path=? WHERE id=?').run(photoPath, req.params.id);
  res.json({ ok: true, path: photoPath });
});

// ── ID Card page ──────────────────────────────────────────────────────────────
router.get('/employees/:id/id-card', async (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.redirect('/hr/employees');
  const settings = getSettings();
  const qrData   = `EMP:${emp.employee_code || emp.id}|${emp.full_name}`;
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 120, margin: 1 });
  res.render('id-card', { title: 'ID Card — ' + emp.full_name, emp, settings, qrDataUrl, adminView: true });
});

// ── ID Card PDF ───────────────────────────────────────────────────────────────
router.get('/employees/:id/id-card/pdf', async (req, res) => {
  const emp      = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).send('Not found');
  const settings  = getSettings();
  const UPLOADS_DIR = res.app.locals.UPLOADS_DIR;

  const qrData    = `EMP:${emp.employee_code || emp.id}|${emp.full_name}`;
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 140, margin: 1 });

  // Embed photo as base64 so Puppeteer can render it (no HTTP needed)
  let photoB64 = '';
  if (emp.photo_path && emp.photo_path.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, emp.photo_path.replace('/uploads/', ''));
    if (fs.existsSync(filePath)) {
      photoB64 = `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
    }
  }

  const html = await new Promise((resolve, reject) =>
    res.app.render('id-card-pdf', { emp, settings, qrDataUrl, photoB64 },
      (err, h) => err ? reject(err) : resolve(h)));

  const pdfBuffer = await generatePDF(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="IDCard-${emp.employee_code || emp.id}.pdf"`);
  res.send(pdfBuffer);
});

// ── Admin: Attendance view ────────────────────────────────────────────────────
router.get('/attendance', (req, res) => {
  const { date: dateQ, emp } = req.query;
  const dateFilter = dateQ || new Date().toLocaleDateString('en-CA');

  const employees = db.prepare("SELECT id, full_name, employee_code FROM users WHERE is_hr_active=1 ORDER BY full_name").all();

  let sql = `SELECT a.*, u.full_name, u.employee_code, u.department
             FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.date=?`;
  const params = [dateFilter];
  if (emp) { sql += ' AND a.user_id=?'; params.push(emp); }
  sql += ' ORDER BY u.full_name';
  const records = db.prepare(sql).all(...params);

  const present     = records.filter(r => r.check_in_time).length;
  const checked_out = records.filter(r => r.check_out_time).length;

  res.render('hr/attendance', { title: 'Attendance — ' + dateFilter,
    records, employees, dateFilter, empFilter: emp||'',
    total: employees.length, present, checked_out });
});

// ── Admin: All leaves ─────────────────────────────────────────────────────────
router.get('/leaves', (req, res) => {
  const { status: st, emp } = req.query;
  let sql = `SELECT l.*, lt.code, lt.name as lt_name, u.full_name, u.employee_code
             FROM leaves l
             JOIN leave_types lt ON lt.id=l.leave_type_id
             JOIN users u ON u.id=l.user_id`;
  const params = [], conds = [];
  if (st)  { conds.push('l.status=?'); params.push(st); }
  if (emp) { conds.push('l.user_id=?'); params.push(emp); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY l.created_at DESC';

  const leaves    = db.prepare(sql).all(...params);
  const employees = db.prepare("SELECT id, full_name, employee_code FROM users WHERE is_hr_active=1 ORDER BY full_name").all();
  const pending   = db.prepare("SELECT COUNT(*) as c FROM leaves WHERE status='pending'").get().c;

  res.render('hr/leaves', { title: 'Leave Requests', leaves, employees,
    stFilter: st||'', empFilter: emp||'', pending });
});

// ── Admin: Review leave ───────────────────────────────────────────────────────
router.post('/leaves/:id/review', (req, res) => {
  const { status, comment } = req.body;
  const leave = db.prepare('SELECT * FROM leaves WHERE id=?').get(req.params.id);
  if (!leave) return res.redirect('/hr/leaves');

  db.prepare('UPDATE leaves SET status=?, reviewed_by=?, reviewer_comment=? WHERE id=?')
    .run(status, req.session.userId, comment||'', leave.id);

  if (status === 'approved') {
    db.prepare(`UPDATE leave_balances SET used=used+?
      WHERE user_id=? AND leave_type_id=? AND year=?`)
      .run(leave.days, leave.user_id, leave.leave_type_id, new Date(leave.start_date).getFullYear());
  }

  const label = status === 'approved' ? '✅ Approved' : '❌ Rejected';
  createNotification(leave.user_id, `Leave ${label}`,
    comment || `Your leave request has been ${status}.`, 'leave', '/leaves');

  req.session.flash = { success: `Leave ${status}.` };
  res.redirect('/hr/leaves');
});

// ── Admin: Salary management ──────────────────────────────────────────────────
router.get('/salary', (req, res) => {
  const { month: mq, emp } = req.query;
  const month = mq || new Date().toLocaleDateString('en-CA').slice(0, 7);

  let sql = `SELECT sr.*, u.full_name, u.employee_code, u.department,
               ir.amount as incentive
             FROM salary_records sr
             JOIN users u ON u.id=sr.user_id
             LEFT JOIN incentive_records ir ON ir.user_id=sr.user_id AND ir.month=sr.month
             WHERE sr.month=?`;
  const params = [month];
  if (emp) { sql += ' AND sr.user_id=?'; params.push(emp); }
  sql += ' ORDER BY u.full_name';

  const records   = db.prepare(sql).all(...params);
  const employees = db.prepare("SELECT id, full_name, employee_code, department FROM users WHERE is_hr_active=1 ORDER BY full_name").all();
  const totals    = { gross: 0, net: 0, pf: 0 };
  records.forEach(r => { totals.gross += r.gross; totals.net += r.net_salary; totals.pf += r.pf; });

  res.render('hr/salary', { title: 'Salary Management', records, employees,
    month, empFilter: emp||'', totals, formatINR });
});

router.post('/salary', (req, res) => {
  const { user_id, month, basic, hra, allowances, pf, esic, tds, other_ded, paid_on, remarks } = req.body;
  const b = parseFloat(basic)||0, h = parseFloat(hra)||0, a = parseFloat(allowances)||0;
  const gross = b + h + a;
  const p = parseFloat(pf)||0, es = parseFloat(esic)||0, t = parseFloat(tds)||0, od = parseFloat(other_ded)||0;
  const net = gross - p - es - t - od;

  db.prepare(`INSERT OR REPLACE INTO salary_records
    (user_id,month,basic,hra,allowances,gross,pf,esic,tds,other_ded,net_salary,paid_on,remarks,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(+user_id, month, b, h, a, gross, p, es, t, od, net, paid_on||null, remarks||'', req.session.userId);

  createNotification(+user_id, `Salary Slip Ready — ${month}`,
    `Your salary slip for ${month} is now available.`, 'salary', '/salary');

  req.session.flash = { success: `Salary saved for ${month}.` };
  res.redirect('/hr/salary?month=' + month);
});

router.post('/salary/incentive', (req, res) => {
  const { user_id, month, amount, reason } = req.body;
  db.prepare('INSERT INTO incentive_records (user_id,month,amount,reason,created_by) VALUES (?,?,?,?,?)')
    .run(+user_id, month, parseFloat(amount)||0, reason||'', req.session.userId);
  createNotification(+user_id, `Incentive Added — ${month}`,
    `₹${amount} incentive added. Reason: ${reason||'—'}`, 'salary', '/salary');
  req.session.flash = { success: 'Incentive added.' };
  res.redirect('/hr/salary?month=' + month);
});

router.get('/salary/:id/pdf', async (req, res) => {
  const record   = db.prepare('SELECT * FROM salary_records WHERE id=?').get(req.params.id);
  if (!record) return res.status(404).send('Not found');
  const employee  = db.prepare('SELECT * FROM users WHERE id=?').get(record.user_id);
  const incentive = db.prepare('SELECT * FROM incentive_records WHERE user_id=? AND month=?').get(record.user_id, record.month);
  const settings  = getSettings();
  const html = await new Promise((resolve, reject) =>
    res.app.render('salary-pdf', { record, employee, incentive, settings, formatINR, numberToWords },
      (err, h) => err ? reject(err) : resolve(h)));
  const pdfBuffer = await generatePDF(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Salary-${record.month}-${employee.full_name}.pdf"`);
  res.send(pdfBuffer);
});

module.exports = router;
