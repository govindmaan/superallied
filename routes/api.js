// JSON APIs for forms and search, photo uploads, uploaded files and the ID card.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, getSettings } = require('../db');
const { requireLogin } = require('../lib/auth');
const { generatePDF } = require('../pdf');
const { UPLOADS_DIR } = require('../lib/assets');

const router = express.Router();

// ── API ───────────────────────────────────────────────────────────────────────
router.get('/api/machines/:id', requireLogin, (req, res) => {
  const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  // Dealer purchase price (profit data) is admin-only
  if (m && !res.locals.hasPerm('*')) delete m.purchase_price;
  res.json(m || {});
});

// ── Spare parts machine lookup ─────────────────────────────────────────────────
router.get('/api/spare/machine-lookup', requireLogin, (req, res) => {
  const no = req.query.no || '';
  const m = db.prepare('SELECT * FROM sold_machines WHERE machine_no = ? COLLATE NOCASE').get(no.trim());
  res.json(m || {});
});

router.get('/api/customers/search', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const isAdmin = res.locals.hasPerm('*');
  let sql = "SELECT id, name, phone, gstin FROM customers WHERE deleted_at IS NULL AND (name LIKE ? OR phone LIKE ?)";
  const params = [`%${q}%`, `%${q}%`];
  if (!isAdmin) { sql += ' AND created_by=?'; params.push(req.session.userId); }
  sql += ' LIMIT 10';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// ── Universal Search API ──────────────────────────────────────────────────────
router.get('/api/search', requireLogin, (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  if (!query || query.length < 2) {
    return res.json({ results: [] });
  }

  const results = [];
  const limit = 15;
  // Each section only returns what this user may see elsewhere in the app
  const role    = res.locals.user?.role;
  const uid     = req.session.userId;
  const isAdmin = role === 'admin';
  const can     = (p) => isAdmin || res.locals.hasPerm(p);
  const none    = [];  // result for sections this user can't see

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
    const enquiries = !(can('enquiries') || role === 'manager') ? none : db.prepare(`
      SELECT id, enquiry_number, customer_name, phone, current_stage
      FROM enquiries
      WHERE (LOWER(enquiry_number) LIKE ? OR LOWER(customer_name) LIKE ? OR phone LIKE ?)
        ${['admin', 'manager'].includes(role) ? '' : `AND assigned_to = ${Number(uid)}`}
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
    const customers = !can('customers') ? none : db.prepare(`
      SELECT id, name, phone, gstin
      FROM customers
      WHERE deleted_at IS NULL AND (LOWER(name) LIKE ? OR phone LIKE ?)
        ${isAdmin ? '' : `AND created_by = ${Number(uid)}`}
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
    const quotations = !can('quotations') ? none : db.prepare(`
      SELECT q.id, q.quotation_number, c.name as customer_name, m.display_name as machine_name
      FROM quotations q
      JOIN customers c ON c.id = q.customer_id
      JOIN machines m ON m.id = q.machine_id
      WHERE (q.quotation_number LIKE ? OR LOWER(c.name) LIKE ?)
        ${isAdmin ? '' : `AND q.cancelled_at IS NULL AND q.user_id = ${Number(uid)}`}
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
    const spareParts = !can('spare_parts') ? none : db.prepare(`
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
    const soldMachines = !can('sold_machines') ? none : db.prepare(`
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
router.post('/api/upload', requireLogin, (req, res) => {
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
router.use('/uploads', requireLogin, express.static(UPLOADS_DIR));

// ── My ID Card ─────────────────────────────────────────────────────────────────
router.get('/id-card', requireLogin, async (req, res) => {
  const QRCode = require('qrcode');
  const emp    = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  const s      = getSettings();
  const qrData = `EMP:${emp.employee_code || emp.id}|${emp.full_name}`;
  const qrDataUrl = await QRCode.toDataURL(qrData, { width: 120, margin: 1 });
  res.render('id-card', { title: 'My ID Card', emp, settings: s, qrDataUrl, adminView: false });
});

router.get('/id-card/pdf', requireLogin, async (req, res) => {
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

// ── API: employee list (for HR dropdowns) ─────────────────────────────────────
router.get('/api/hr/employees', requireLogin, (req, res) => {
  const employees = db.prepare("SELECT id, full_name, employee_code, department FROM users WHERE is_hr_active=1 ORDER BY full_name").all();
  res.json(employees);
});

module.exports = router;
