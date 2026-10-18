const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const {
  db, formatINR, createNotification, auditLog,
  nextEnquiryNumber, nextEnquiryQuotationNumber, getEnquiryTimeline,
} = require('../db');
const { generatePDF } = require('../pdf');

const STAGES = {
  phone_followup:    { label: 'Phone Follow-up',    order: 1, color: 'primary' },
  sales_visit:        { label: 'Sales Visit',         order: 2, color: 'info' },
  enquiry_generated:  { label: 'Enquiry Generated',   order: 3, color: 'warning' },
  sales_closed:       { label: 'Sales Closed',        order: 4, color: 'success' },
};
const STAGE_KEYS = Object.keys(STAGES);
const CALL_STATUSES = ['Interested', 'Not Interested', 'Busy', 'Switch Off', 'Call Back Later', 'No Response'];
const LEAD_SOURCES = ['Walk-in', 'Reference', 'Call', 'Field Visit', 'Advertisement', 'Exhibition', 'Other'];

function canSeeAll(user) {
  return user && ['admin', 'manager'].includes(user.role);
}

function stageAtLeast(stage, target) {
  return STAGES[stage]?.order >= STAGES[target]?.order;
}

function bumpStage(enquiryId, targetStage) {
  const enq = db.prepare('SELECT current_stage FROM enquiries WHERE id=?').get(enquiryId);
  if (enq && !stageAtLeast(enq.current_stage, targetStage)) {
    db.prepare('UPDATE enquiries SET current_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(targetStage, enquiryId);
  }
}

function getEnquiries(user, filters = {}) {
  const allAccess = canSeeAll(user);
  let sql = `SELECT e.*, u.full_name as assignee_name, cu.full_name as creator_name
    FROM enquiries e
    LEFT JOIN users u ON u.id = e.assigned_to
    LEFT JOIN users cu ON cu.id = e.created_by
    WHERE 1=1`;
  const params = [];

  if (!allAccess) { sql += ' AND e.assigned_to = ?'; params.push(user.id); }
  if (filters.stage)  { sql += ' AND e.current_stage = ?'; params.push(filters.stage); }
  if (filters.status) { sql += ' AND e.status = ?'; params.push(filters.status); }
  if (filters.assigned_to) { sql += ' AND e.assigned_to = ?'; params.push(filters.assigned_to); }
  if (filters.district) { sql += ' AND e.district LIKE ?'; params.push(`%${filters.district}%`); }
  if (filters.machine)  { sql += ' AND (e.machine_interested LIKE ? OR e.machine_model LIKE ?)'; params.push(`%${filters.machine}%`, `%${filters.machine}%`); }
  if (filters.lead_source) { sql += ' AND e.lead_source = ?'; params.push(filters.lead_source); }
  if (filters.from) { sql += ' AND date(e.created_at,\'+330 minutes\') >= ?'; params.push(filters.from); }
  if (filters.to)   { sql += ' AND date(e.created_at,\'+330 minutes\') <= ?'; params.push(filters.to); }
  if (filters.q) {
    sql += ' AND (e.customer_name LIKE ? OR e.phone LIKE ? OR e.village_city LIKE ? OR e.district LIKE ? OR e.enquiry_number LIKE ? OR e.machine_interested LIKE ?)';
    const like = `%${filters.q}%`;
    params.push(like, like, like, like, like, like);
  }
  return { sql, params };
}

// ── List (table view) ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const user = res.locals.user;
  const { q = '', stage = '', status = 'active', assigned_to = '', district = '', machine = '', lead_source = '', from = '', to = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;

  const { sql, params } = getEnquiries(user, { q, stage, status: status || undefined, assigned_to, district, machine, lead_source, from, to });
  const total = db.prepare(`SELECT COUNT(*) as c FROM (${sql})`).get(...params).c;
  const enquiries = db.prepare(`${sql} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage);

  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('enquiries/list', {
    title: 'Enquiries', enquiries, STAGES, staff, LEAD_SOURCES,
    q, stage, status, assigned_to, district, machine, lead_source, from, to,
    allAccess: canSeeAll(user), page, perPage, total, totalPages: Math.ceil(total / perPage) || 1,
  });
});

// ── Pipeline (Kanban) ─────────────────────────────────────────────────────────
router.get('/pipeline', (req, res) => {
  const user = res.locals.user;
  const allAccess = canSeeAll(user);
  const uid = user.id;
  const where = allAccess ? "status='active'" : `status='active' AND assigned_to=${uid}`;

  const pipeline = {};
  STAGE_KEYS.forEach(s => {
    pipeline[s] = db.prepare(`SELECT e.*, u.full_name as assignee_name FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to
      WHERE current_stage=? AND ${where} ORDER BY updated_at DESC LIMIT 50`).all(s);
  });
  pipeline.won  = db.prepare(`SELECT e.*, u.full_name as assignee_name FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to WHERE ${where.replace("status='active'", "status='won'")} ORDER BY updated_at DESC LIMIT 20`).all();
  pipeline.lost = db.prepare(`SELECT e.*, u.full_name as assignee_name FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to WHERE ${where.replace("status='active'", "status='lost'")} ORDER BY updated_at DESC LIMIT 20`).all();

  res.render('enquiries/pipeline', { title: 'Enquiry Pipeline', pipeline, STAGES, STAGE_KEYS, allAccess });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const user = res.locals.user;
  const allAccess = canSeeAll(user);
  const uid = user.id;
  const scope = allAccess ? '' : `AND e.assigned_to = ${uid}`;
  const today = new Date().toLocaleDateString('en-CA');
  const thisMonth = today.slice(0, 7);

  const todayCalls = db.prepare(`SELECT COUNT(*) as c FROM enquiry_followups f JOIN enquiries e ON e.id=f.enquiry_id WHERE date(f.created_at,'+330 minutes')=? ${scope}`).get(today).c;
  const todayVisits = db.prepare(`SELECT COUNT(*) as c FROM enquiry_visits v JOIN enquiries e ON e.id=v.enquiry_id WHERE date(v.created_at,'+330 minutes')=? ${scope}`).get(today).c;
  const newToday = db.prepare(`SELECT COUNT(*) as c FROM enquiries e WHERE date(e.created_at,'+330 minutes')=? ${scope}`).get(today).c;
  const salesClosedMonth = db.prepare(`SELECT COUNT(*) as c FROM enquiry_sales s JOIN enquiries e ON e.id=s.enquiry_id WHERE strftime('%Y-%m', s.created_at,'+330 minutes')=? ${scope}`).get(thisMonth).c;
  const monthlyRevenue = db.prepare(`SELECT COALESCE(SUM(s.sale_amount),0) as t FROM enquiry_sales s JOIN enquiries e ON e.id=s.enquiry_id WHERE strftime('%Y-%m', s.created_at,'+330 minutes')=? ${scope}`).get(thisMonth).t;

  const pendingFollowups = db.prepare(`
    SELECT e.id, e.enquiry_number, e.customer_name, e.phone, u.full_name as assignee_name, f.next_followup_date
    FROM enquiries e
    JOIN (SELECT enquiry_id, MAX(next_followup_date) as next_followup_date FROM enquiry_followups WHERE next_followup_date IS NOT NULL GROUP BY enquiry_id) f ON f.enquiry_id=e.id
    LEFT JOIN users u ON u.id=e.assigned_to
    WHERE e.status='active' AND f.next_followup_date <= date('now','+330 minutes') ${scope}
    ORDER BY f.next_followup_date ASC LIMIT 15
  `).all();

  const byStage = {};
  STAGE_KEYS.forEach(s => {
    byStage[s] = db.prepare(`SELECT COUNT(*) as c FROM enquiries e WHERE status='active' AND current_stage=? ${scope}`).get(s).c;
  });

  const wonCount  = db.prepare(`SELECT COUNT(*) as c FROM enquiries e WHERE status='won' ${scope}`).get().c;
  const lostCount = db.prepare(`SELECT COUNT(*) as c FROM enquiries e WHERE status='lost' ${scope}`).get().c;
  const activeCount = db.prepare(`SELECT COUNT(*) as c FROM enquiries e WHERE status='active' ${scope}`).get().c;
  const totalCount = wonCount + lostCount + activeCount;
  const conversionRate = totalCount ? Math.round((wonCount / totalCount) * 1000) / 10 : 0;

  let leaderboard = [];
  if (allAccess) {
    leaderboard = db.prepare(`
      SELECT u.full_name, e.assigned_to,
        COUNT(DISTINCT CASE WHEN s.id IS NOT NULL AND strftime('%Y-%m', s.created_at,'+330 minutes')=? THEN e.id END) as sales_this_month,
        SUM(CASE WHEN s.id IS NOT NULL AND strftime('%Y-%m', s.created_at,'+330 minutes')=? THEN s.sale_amount ELSE 0 END) as revenue_this_month
      FROM enquiries e
      LEFT JOIN enquiry_sales s ON s.enquiry_id=e.id
      LEFT JOIN users u ON u.id=e.assigned_to
      WHERE e.assigned_to IS NOT NULL
      GROUP BY e.assigned_to ORDER BY sales_this_month DESC, revenue_this_month DESC LIMIT 5
    `).all(thisMonth, thisMonth);
  }

  const recentlyUpdated = db.prepare(`SELECT e.*, u.full_name as assignee_name FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to WHERE 1=1 ${scope} ORDER BY e.updated_at DESC LIMIT 10`).all();

  res.render('enquiries/dashboard', {
    title: 'Enquiries Dashboard', STAGES, STAGE_KEYS, allAccess, formatINR,
    todayCalls, todayVisits, newToday, salesClosedMonth, monthlyRevenue,
    pendingFollowups, byStage, wonCount, lostCount, activeCount, totalCount, conversionRate,
    leaderboard, recentlyUpdated,
  });
});

// ── Excel export ──────────────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const user = res.locals.user;
  const { q = '', stage = '', status = '', assigned_to = '', district = '', machine = '', lead_source = '', from = '', to = '' } = req.query;
  const { sql, params } = getEnquiries(user, { q, stage, status: status || undefined, assigned_to, district, machine, lead_source, from, to });
  const rows = db.prepare(`${sql} ORDER BY e.updated_at DESC LIMIT 5000`).all(...params);

  const data = [
    ['Enquiry #', 'Customer', 'Phone', 'Location', 'District', 'Machine Interested', 'Lead Source', 'Assigned To', 'Stage', 'Status', 'Created'],
    ...rows.map(e => [e.enquiry_number, e.customer_name, e.phone, e.location, e.district, e.machine_interested, e.lead_source, e.assignee_name || '', STAGES[e.current_stage]?.label || e.current_stage, e.status, e.created_at]),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Enquiries');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="enquiries-export.xlsx"');
  res.send(buf);
});

// ── Duplicate phone check (AJAX) ──────────────────────────────────────────────
router.get('/api/check-duplicate', (req, res) => {
  const phone = (req.query.phone || '').trim();
  if (!phone || phone.length < 6) return res.json({ found: [] });
  const found = db.prepare(`SELECT id, enquiry_number, customer_name, current_stage, status FROM enquiries WHERE phone=? ORDER BY created_at DESC LIMIT 5`).all(phone);
  res.json({ found });
});

// ── New enquiry form ───────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('enquiries/form', { title: 'New Enquiry', enquiry: null, machines, staff, LEAD_SOURCES, errors: {} });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const user = res.locals.user;
  const b = req.body;

  if (!b.customer_name?.trim()) {
    const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
    const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
    return res.render('enquiries/form', { title: 'New Enquiry', enquiry: b, machines, staff, LEAD_SOURCES, errors: { customer_name: 'Customer name is required' } });
  }

  const enquiryNumber = nextEnquiryNumber();
  const assignedTo = canSeeAll(user) && b.assigned_to ? parseInt(b.assigned_to) : user.id;

  const info = db.prepare(`INSERT INTO enquiries
    (enquiry_number, customer_name, phone, location, district, village_city, machine_interested, lead_source, assigned_to, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(enquiryNumber, b.customer_name.trim(), b.phone || '', b.location || '', b.district || '', b.village_city || '',
         b.machine_interested || '', b.lead_source || '', assignedTo, user.id);

  const enquiryId = info.lastInsertRowid;
  auditLog(user.id, 'ENQUIRY_CREATED', 'enquiries', enquiryId, `${enquiryNumber} — ${b.customer_name.trim()}`);
  if (assignedTo !== user.id) createNotification(assignedTo, 'New Enquiry Assigned', `${b.customer_name.trim()} (${enquiryNumber}) has been assigned to you.`, 'info', `/enquiries/${enquiryId}`);

  req.session.flash = { success: `Enquiry ${enquiryNumber} created successfully.` };
  res.redirect(`/enquiries/${enquiryId}`);
});

// ── Quotation PDF (must precede /:id) ─────────────────────────────────────────
router.get('/quotations/:qid/pdf', async (req, res) => {
  const q = db.prepare('SELECT * FROM enquiry_quotations WHERE id=?').get(req.params.qid);
  if (!q) return res.status(404).send('Not found');
  const enquiry = db.prepare('SELECT * FROM enquiries WHERE id=?').get(q.enquiry_id);
  const items = db.prepare('SELECT * FROM enquiry_quotation_items WHERE quotation_id=? ORDER BY id').all(req.params.qid);
  const settings = db.prepare('SELECT key,value FROM settings').all().reduce((o, r) => (o[r.key] = r.value, o), {});

  const LOGO_PATH = path.join(__dirname, '..', 'public', 'bull-logo.jpg');
  const logoB64 = fs.existsSync(LOGO_PATH) ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

  const html = await new Promise((resolve, reject) =>
    res.app.render('enquiries/quotation-pdf', { q, enquiry, items, settings, formatINR, logoB64 }, (err, h) => err ? reject(err) : resolve(h)));

  try {
    const pdfBuffer = await generatePDF(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${q.quotation_number.replace(/\//g, '-')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    req.session.flash = { error: 'PDF generation failed.' };
    res.redirect(`/enquiries/${q.enquiry_id}`);
  }
});

// ── Access guard helper ────────────────────────────────────────────────────────
function loadEnquiryOrDeny(req, res) {
  const user = res.locals.user;
  const enquiry = db.prepare(`SELECT e.*, u.full_name as assignee_name, cu.full_name as creator_name
    FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to LEFT JOIN users cu ON cu.id=e.created_by WHERE e.id=?`).get(req.params.id);
  if (!enquiry) { req.session.flash = { error: 'Enquiry not found.' }; res.redirect('/enquiries'); return null; }
  if (!canSeeAll(user) && enquiry.assigned_to !== user.id) { req.session.flash = { error: 'Access denied.' }; res.redirect('/enquiries'); return null; }
  return enquiry;
}

// ── Detail (timeline) ─────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const timeline = getEnquiryTimeline(enquiry.id);
  const sale = db.prepare('SELECT * FROM enquiry_sales WHERE enquiry_id=? ORDER BY id DESC LIMIT 1').get(enquiry.id);
  const quotations = db.prepare('SELECT * FROM enquiry_quotations WHERE enquiry_id=? ORDER BY id DESC').all(enquiry.id);
  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('enquiries/detail', {
    title: `Enquiry ${enquiry.enquiry_number}`, enquiry, timeline, sale, quotations, staff,
    STAGES, STAGE_KEYS, CALL_STATUSES, allAccess: canSeeAll(res.locals.user),
  });
});

// ── Edit basic fields ──────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('enquiries/form', { title: `Edit ${enquiry.enquiry_number}`, enquiry, machines, staff, LEAD_SOURCES, errors: {} });
});

router.post('/:id', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const b = req.body;
  db.prepare(`UPDATE enquiries SET customer_name=?, phone=?, location=?, district=?, village_city=?, machine_interested=?, lead_source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.customer_name?.trim() || enquiry.customer_name, b.phone || '', b.location || '', b.district || '', b.village_city || '', b.machine_interested || '', b.lead_source || '', enquiry.id);
  req.session.flash = { success: 'Enquiry updated successfully.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Add remark ─────────────────────────────────────────────────────────────────
router.post('/:id/remark', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const user = res.locals.user;
  const body = (req.body.body || '').trim();
  if (!body) { req.session.flash = { error: 'Remark cannot be empty.' }; return res.redirect(`/enquiries/${enquiry.id}`); }

  const info = db.prepare('INSERT INTO enquiry_remarks (enquiry_id, body, created_by) VALUES (?,?,?)').run(enquiry.id, body, user.id);
  db.prepare('UPDATE enquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(enquiry.id);

  if (req.body.photo && req.body.photo.startsWith('data:image')) {
    const dir = path.join(req.app.locals.UPLOADS_DIR, 'enquiries');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `remark-${enquiry.id}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(dir, fname), Buffer.from(req.body.photo.split(',')[1], 'base64'));
    db.prepare('INSERT INTO enquiry_attachments (enquiry_id, activity_type, activity_id, file_path, file_type, uploaded_by) VALUES (?,?,?,?,?,?)')
      .run(enquiry.id, 'remark', info.lastInsertRowid, `/uploads/enquiries/${fname}`, 'image', user.id);
  }

  if (enquiry.assigned_to && enquiry.assigned_to !== user.id) {
    createNotification(enquiry.assigned_to, 'New Remark', `${user.full_name || user.username} commented on ${enquiry.enquiry_number}.`, 'info', `/enquiries/${enquiry.id}`);
  }
  req.session.flash = { success: 'Remark added.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Add phone follow-up ────────────────────────────────────────────────────────
router.post('/:id/followup', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const user = res.locals.user;
  const { next_followup_date, call_status, notes } = req.body;

  db.prepare('INSERT INTO enquiry_followups (enquiry_id, next_followup_date, call_status, notes, created_by) VALUES (?,?,?,?,?)')
    .run(enquiry.id, next_followup_date || null, CALL_STATUSES.includes(call_status) ? call_status : 'Interested', notes || '', user.id);
  bumpStage(enquiry.id, 'phone_followup');
  db.prepare('UPDATE enquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(enquiry.id);

  req.session.flash = { success: 'Follow-up recorded.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Add sales visit ────────────────────────────────────────────────────────────
router.post('/:id/visit', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const user = res.locals.user;
  const { visit_date, visit_location, purpose, demo_given, competitor_machine, outcome, lat, lng } = req.body;

  let photoPath = '';
  if (req.body.photo && req.body.photo.startsWith('data:image')) {
    const dir = path.join(req.app.locals.UPLOADS_DIR, 'enquiries');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `visit-${enquiry.id}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(dir, fname), Buffer.from(req.body.photo.split(',')[1], 'base64'));
    photoPath = `/uploads/enquiries/${fname}`;
  }

  db.prepare(`INSERT INTO enquiry_visits (enquiry_id, visit_date, visit_location, purpose, demo_given, competitor_machine, outcome, lat, lng, photo, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(enquiry.id, visit_date || null, visit_location || '', purpose || '', demo_given ? 1 : 0, competitor_machine || '', outcome || '',
         lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null, photoPath, user.id);
  bumpStage(enquiry.id, 'sales_visit');
  db.prepare('UPDATE enquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(enquiry.id);

  req.session.flash = { success: 'Sales visit recorded.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Mark Enquiry Generated ─────────────────────────────────────────────────────
router.post('/:id/generate', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const { machine_model, expected_purchase_date, quotation_sent, finance_required, budget, probability_percent } = req.body;

  db.prepare(`UPDATE enquiries SET machine_model=?, expected_purchase_date=?, quotation_sent=?, finance_required=?, budget=?, probability_percent=?, current_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(machine_model || '', expected_purchase_date || null, quotation_sent ? 1 : 0, finance_required ? 1 : 0,
         parseFloat(budget) || 0, parseInt(probability_percent) || 0,
         stageAtLeast(enquiry.current_stage, 'enquiry_generated') ? enquiry.current_stage : 'enquiry_generated', enquiry.id);

  auditLog(res.locals.user.id, 'ENQUIRY_GENERATED', 'enquiries', enquiry.id, `Machine: ${machine_model || '—'}`);
  req.session.flash = { success: 'Enquiry marked as Generated.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Close sale ─────────────────────────────────────────────────────────────────
router.post('/:id/close', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const user = res.locals.user;
  const { invoice_number, machine_number, delivery_date, finance_company, sale_amount } = req.body;

  db.prepare(`INSERT INTO enquiry_sales (enquiry_id, invoice_number, machine_number, delivery_date, finance_company, sale_amount, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(enquiry.id, invoice_number || '', machine_number || '', delivery_date || null, finance_company || '', parseFloat(sale_amount) || 0, user.id);
  db.prepare(`UPDATE enquiries SET status='won', current_stage='sales_closed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(enquiry.id);

  auditLog(user.id, 'ENQUIRY_SALE_CLOSED', 'enquiries', enquiry.id, `Invoice ${invoice_number || '—'} — ₹${sale_amount || 0}`);
  if (enquiry.assigned_to && enquiry.assigned_to !== user.id) {
    createNotification(enquiry.assigned_to, 'Sale Completed', `Sale closed for ${enquiry.customer_name} (${enquiry.enquiry_number}).`, 'success', `/enquiries/${enquiry.id}`);
  }
  const managers = db.prepare("SELECT id FROM users WHERE role IN ('admin','manager')").all();
  managers.forEach(m => { if (m.id !== user.id) createNotification(m.id, 'Sale Completed', `${enquiry.customer_name} (${enquiry.enquiry_number}) — ₹${sale_amount || 0}`, 'success', `/enquiries/${enquiry.id}`); });

  req.session.flash = { success: 'Sale closed. Enquiry marked as Won.' };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Reassign ───────────────────────────────────────────────────────────────────
router.post('/:id/assign', (req, res) => {
  const user = res.locals.user;
  if (!canSeeAll(user)) { req.session.flash = { error: 'Manager or Admin access required.' }; return res.redirect(`/enquiries/${req.params.id}`); }
  const enquiry = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!enquiry) { req.session.flash = { error: 'Enquiry not found.' }; return res.redirect('/enquiries'); }

  const newAssignee = parseInt(req.body.assigned_to);
  if (!newAssignee) { req.session.flash = { error: 'Select a salesperson.' }; return res.redirect(`/enquiries/${enquiry.id}`); }

  db.prepare('UPDATE enquiries SET assigned_to=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newAssignee, enquiry.id);
  const newUser = db.prepare('SELECT full_name FROM users WHERE id=?').get(newAssignee);
  auditLog(user.id, 'ENQUIRY_REASSIGNED', 'enquiries', enquiry.id, `Reassigned to ${newUser?.full_name || newAssignee}`);
  createNotification(newAssignee, 'Enquiry Assigned to You', `${enquiry.customer_name} (${enquiry.enquiry_number}) has been assigned to you.`, 'info', `/enquiries/${enquiry.id}`);

  req.session.flash = { success: `Reassigned to ${newUser?.full_name || 'salesperson'}.` };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Change status (won/lost/reopen) — JSON endpoint ───────────────────────────
router.post('/:id/status', (req, res) => {
  const user = res.locals.user;
  const enquiry = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!enquiry) return res.json({ ok: false, error: 'Not found' });
  if (!canSeeAll(user) && enquiry.assigned_to !== user.id) return res.json({ ok: false, error: 'Access denied' });

  const { status } = req.body;
  if (!['active', 'won', 'lost'].includes(status)) return res.json({ ok: false, error: 'Invalid status' });

  db.prepare('UPDATE enquiries SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, enquiry.id);
  auditLog(user.id, 'ENQUIRY_STATUS_CHANGED', 'enquiries', enquiry.id, `Status → ${status}`);
  res.json({ ok: true });
});

// ── Quotation sub-feature ──────────────────────────────────────────────────────
router.get('/:id/quotations/new', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  res.render('enquiries/quotation-form', { title: `New Quotation — ${enquiry.enquiry_number}`, enquiry, formatINR });
});

router.post('/:id/quotations', (req, res) => {
  const enquiry = loadEnquiryOrDeny(req, res);
  if (!enquiry) return;
  const user = res.locals.user;
  const f = req.body;

  let items = [];
  try { items = JSON.parse(f.items_json || '[]'); } catch (e) {}
  if (!items.length) { req.session.flash = { error: 'Add at least one line item to the quotation.' }; return res.redirect(`/enquiries/${enquiry.id}/quotations/new`); }

  const totalAmount = items.reduce((s, it) => s + (parseFloat(it.line_total) || 0), 0);
  const { quotationNumber, financialYear, serialNumber } = nextEnquiryQuotationNumber();

  const info = db.prepare(`INSERT INTO enquiry_quotations (quotation_number, financial_year, serial_number, enquiry_id, machine_model, validity_days, remarks, total_amount, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(quotationNumber, financialYear, serialNumber, enquiry.id, f.machine_model || enquiry.machine_interested || '', parseInt(f.validity_days) || 15, f.remarks || '', totalAmount, user.id);

  const qid = info.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO enquiry_quotation_items (quotation_id, description, qty, rate, line_total) VALUES (?,?,?,?,?)');
  items.forEach(it => insertItem.run(qid, it.description || '', parseFloat(it.qty) || 1, parseFloat(it.rate) || 0, parseFloat(it.line_total) || 0));

  db.prepare(`UPDATE enquiries SET quotation_sent=1, current_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(stageAtLeast(enquiry.current_stage, 'enquiry_generated') ? enquiry.current_stage : 'enquiry_generated', enquiry.id);
  auditLog(user.id, 'ENQUIRY_QUOTATION_CREATED', 'enquiries', enquiry.id, quotationNumber);

  req.session.flash = { success: `Quotation ${quotationNumber} created.` };
  res.redirect(`/enquiries/${enquiry.id}`);
});

// ── Delete (admin only) ────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const user = res.locals.user;
  if (user.role !== 'admin') { req.session.flash = { error: 'Admin only.' }; return res.redirect('/enquiries'); }
  db.prepare('DELETE FROM enquiries WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Enquiry deleted.' };
  res.redirect('/enquiries');
});

module.exports = router;
