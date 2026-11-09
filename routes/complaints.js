const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { db, createNotification, auditLog, nextComplaintNumber, today } = require('../db');

const isManager = (res) => ['admin', 'manager'].includes(res.locals.user?.role);
// A coordinator/manager/admin sees everything; a service engineer sees only
// complaints assigned to them (their sites).
function scope(res) {
  return isManager(res) ? { sql: '1=1', params: [] } : { sql: '(c.assigned_to = ? OR c.reported_by = ?)', params: [res.locals.user.id, res.locals.user.id] };
}

function savePhoto(base64, uploadsDir) {
  if (!base64 || !base64.startsWith('data:image')) return '';
  const buf = Buffer.from(base64.split(',')[1], 'base64');
  const dir = path.join(uploadsDir, 'complaints');
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  fs.writeFileSync(path.join(dir, fname), buf);
  return `/uploads/complaints/${fname}`;
}

function load(id) {
  return db.prepare(`SELECT c.*, u.full_name AS engineer_name, r.full_name AS reporter_name
    FROM complaints c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN users r ON r.id=c.reported_by WHERE c.id=?`).get(id);
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const s = scope(res);
  const f = ['open', 'assigned', 'visited', 'closed'].includes(req.query.f) ? req.query.f : 'active';
  const where = f === 'active' ? "c.status IN ('open','assigned','visited')" : `c.status = '${f}'`;
  const rows = db.prepare(`SELECT c.*, u.full_name AS engineer_name FROM complaints c
    LEFT JOIN users u ON u.id=c.assigned_to WHERE ${s.sql} AND ${where}
    ORDER BY (c.status='open') DESC, c.updated_at DESC LIMIT 200`).all(...s.params);
  const counts = {};
  ['open', 'assigned', 'visited', 'closed'].forEach(st => {
    counts[st] = db.prepare(`SELECT COUNT(*) c FROM complaints c WHERE ${s.sql} AND c.status=?`).get(...s.params, st).c;
  });
  res.render('complaints/list', { title: 'Complaints', rows, f, counts, isManager: isManager(res) });
});

// ── Open a complaint (coordinator/manager) — look up the machine by serial ────
router.get('/new', (req, res) => {
  if (!isManager(res) && !res.locals.hasPerm('service_complaints')) { req.session.flash = { error: 'Not allowed.' }; return res.redirect('/complaints'); }
  res.render('complaints/new', { title: 'New Complaint' });
});

router.get('/lookup', (req, res) => {
  const m = db.prepare('SELECT machine_no, model, customer_name, customer_address, place_of_supply, mobile_1 FROM sold_machines WHERE machine_no = ? COLLATE NOCASE').get((req.query.machine_no || '').trim());
  res.json(m || { found: false });
});

router.post('/', (req, res) => {
  if (!isManager(res) && !res.locals.hasPerm('service_complaints')) { req.session.flash = { error: 'Not allowed.' }; return res.redirect('/complaints'); }
  const b = req.body;
  const machineNo = (b.machine_no || '').trim();
  if (!machineNo) { req.session.flash = { error: 'Machine serial number is required.' }; return res.redirect('/complaints/new'); }
  const m = db.prepare('SELECT * FROM sold_machines WHERE machine_no = ? COLLATE NOCASE').get(machineNo);
  const engineer = parseInt(b.assigned_to) || null;
  const num = nextComplaintNumber();
  const info = db.prepare(`INSERT INTO complaints
    (complaint_number, machine_no, model, customer_name, customer_mobile, location, district, problem,
     status, reported_by, assigned_to, assigned_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    num, machineNo, (m?.model || b.model || ''), (m?.customer_name || b.customer_name || ''),
    (m?.mobile_1 || b.customer_mobile || ''), (b.location || m?.customer_address || '').trim(),
    (b.district || m?.place_of_supply || '').trim(), (b.problem || '').trim(),
    engineer ? 'assigned' : 'open', res.locals.user.id, engineer, engineer ? new Date().toISOString() : null);
  const id = Number(info.lastInsertRowid);
  auditLog(res.locals.user.id, 'complaint_opened', 'complaints', id, num);
  if (engineer) createNotification(engineer, `Complaint assigned — ${num}`, `${m?.customer_name || ''} · ${machineNo}`, 'info', `/complaints/${id}`);
  req.session.flash = { success: `Complaint ${num} created.` };
  res.redirect(`/complaints/${id}`);
});

// ── Detail ────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const c = load(req.params.id);
  if (!c) { req.session.flash = { error: 'Complaint not found.' }; return res.redirect('/complaints'); }
  if (!isManager(res) && c.assigned_to !== res.locals.user.id && c.reported_by !== res.locals.user.id) {
    req.session.flash = { error: 'This complaint is not assigned to you.' }; return res.redirect('/complaints');
  }
  const visits = db.prepare('SELECT cv.*, u.full_name FROM complaint_visits cv LEFT JOIN users u ON u.id=cv.engineer_id WHERE cv.complaint_id=? ORDER BY cv.created_at DESC').all(c.id);
  const engineers = isManager(res) || res.locals.hasPerm('service_complaints')
    ? db.prepare("SELECT id, full_name, username FROM users WHERE role='service' AND COALESCE(is_hr_active,1)=1 ORDER BY full_name").all() : [];
  res.render('complaints/detail', { title: c.complaint_number, c, visits, engineers, isManager: isManager(res), me: res.locals.user.id });
});

// ── Assign / reassign an engineer ─────────────────────────────────────────────
router.post('/:id/assign', (req, res) => {
  const c = load(req.params.id);
  if (!c || (!isManager(res) && !res.locals.hasPerm('service_complaints'))) { req.session.flash = { error: 'Not allowed.' }; return res.redirect('/complaints'); }
  const eng = parseInt(req.body.assigned_to) || null;
  if (!eng) { req.session.flash = { error: 'Pick an engineer.' }; return res.redirect(`/complaints/${c.id}`); }
  db.prepare("UPDATE complaints SET assigned_to=?, assigned_at=CURRENT_TIMESTAMP, status=CASE WHEN status='open' THEN 'assigned' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(eng, c.id);
  createNotification(eng, `Complaint assigned — ${c.complaint_number}`, `${c.customer_name} · ${c.machine_no}`, 'info', `/complaints/${c.id}`);
  auditLog(res.locals.user.id, 'complaint_assigned', 'complaints', c.id, `→ ${eng}`);
  req.session.flash = { success: 'Engineer assigned.' };
  res.redirect(`/complaints/${c.id}`);
});

// ── Record a site visit (engineer) — plate photo required ─────────────────────
router.post('/:id/visit', (req, res) => {
  const c = load(req.params.id);
  if (!c) { req.session.flash = { error: 'Not found.' }; return res.redirect('/complaints'); }
  if (!isManager(res) && c.assigned_to !== res.locals.user.id) { req.session.flash = { error: 'Only the assigned engineer can record a visit.' }; return res.redirect(`/complaints/${c.id}`); }
  const platePhoto = savePhoto(req.body.plate_photo, res.app.locals.UPLOADS_DIR);
  if (!platePhoto) { req.session.flash = { error: 'A photo of the machine plate is required.' }; return res.redirect(`/complaints/${c.id}`); }
  db.prepare(`INSERT INTO complaint_visits (complaint_id, engineer_id, visit_date, plate_photo, lat, lng, outcome)
    VALUES (?,?,?,?,?,?,?)`).run(c.id, res.locals.user.id, today(), platePhoto,
    parseFloat(req.body.lat) || null, parseFloat(req.body.lng) || null, (req.body.outcome || '').trim());
  db.prepare("UPDATE complaints SET status=CASE WHEN status IN ('open','assigned') THEN 'visited' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(c.id);
  auditLog(res.locals.user.id, 'complaint_visited', 'complaints', c.id, c.complaint_number);
  req.session.flash = { success: 'Visit recorded. Travel allowance for today is now eligible.' };
  res.redirect(`/complaints/${c.id}`);
});

// ── Close ─────────────────────────────────────────────────────────────────────
router.post('/:id/close', (req, res) => {
  const c = load(req.params.id);
  if (!c) { req.session.flash = { error: 'Not found.' }; return res.redirect('/complaints'); }
  if (!isManager(res) && c.assigned_to !== res.locals.user.id) { req.session.flash = { error: 'Only the assigned engineer or a manager can close this.' }; return res.redirect(`/complaints/${c.id}`); }
  db.prepare("UPDATE complaints SET status='closed', closed_at=CURRENT_TIMESTAMP, close_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run((req.body.close_notes || '').trim(), c.id);
  auditLog(res.locals.user.id, 'complaint_closed', 'complaints', c.id, c.complaint_number);
  req.session.flash = { success: `Complaint ${c.complaint_number} closed.` };
  res.redirect(`/complaints/${c.id}`);
});

module.exports = router;
