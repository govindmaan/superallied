// Customers: list, add, edit, soft delete and restore.
const express = require('express');
const { db } = require('../db');
const { requireLogin, requireAdmin } = require('../lib/auth');

const router = express.Router();

// ── Customers ─────────────────────────────────────────────────────────────────
// Non-admins only see/manage customers they created themselves. Older customers
// with no recorded creator are visible to admin only.
function canAccessCustomer(res, customer) {
  if (res.locals.user?.role === 'admin') return true;
  if (customer.deleted_at) return false;
  return customer.created_by != null && customer.created_by === res.locals.user?.id;
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

router.get('/customers', requireLogin, (req, res) => {
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
  if (!isAdmin) { sql += ' AND c.created_by=?'; params.push(req.session.userId); }
  sql += ' ORDER BY c.name';
  const customers = db.prepare(sql).all(...params);
  const deletedCount = isAdmin ? db.prepare('SELECT COUNT(*) AS c FROM customers WHERE deleted_at IS NOT NULL').get().c : 0;
  res.render('customers', { title: 'Customers', customers, q, showDeleted, deletedCount, isAdmin });
});

router.get('/customers/new', requireLogin, (req, res) => {
  res.render('customer-form', { title: 'New Customer', customer: null });
});

router.post('/customers', requireLogin, (req, res) => {
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

router.get('/customers/:id/edit', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer || !canAccessCustomer(res, customer)) {
    req.session.flash = { error: customer ? `You don't have permission to edit this customer.` : 'Customer not found.' };
    return res.redirect('/customers');
  }
  res.render('customer-form', { title: 'Edit Customer', customer });
});

router.post('/customers/:id', requireLogin, (req, res) => {
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

router.post('/customers/:id/delete', requireLogin, (req, res) => {
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

router.post('/customers/:id/restore', requireLogin, requireAdmin, (req, res) => {
  db.prepare('UPDATE customers SET deleted_at=NULL, deleted_by=NULL WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Customer restored.' };
  res.redirect('/customers?deleted=1');
});

module.exports = router;
