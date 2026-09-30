const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');

// ── Generate order number ─────────────────────────────────────────────────────
function nextOrderNo() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const last = db.prepare(
    "SELECT order_no FROM part_orders ORDER BY id DESC LIMIT 1"
  ).get();
  let seq = 1;
  if (last) {
    const m = last.order_no.match(/(\d+)$/);
    if (m) seq = parseInt(m[1]) + 1;
  }
  return `PO${yy}${mm}-${String(seq).padStart(4, '0')}`;
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { status, q, page = 1 } = req.query;
  const limit  = 30;
  const offset = (parseInt(page) - 1) * limit;
  const conds  = [];
  const params = [];

  if (status) { conds.push('po.status=?'); params.push(status); }
  if (q) {
    conds.push('(po.order_no LIKE ? OR po.machine_no LIKE ? OR po.customer_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT po.*, u.full_name AS created_by_name,
      COUNT(poi.id) AS item_count
    FROM part_orders po
    LEFT JOIN users u ON u.id = po.created_by
    LEFT JOIN part_order_items poi ON poi.order_id = po.id
    ${where}
    GROUP BY po.id
    ORDER BY po.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM part_orders po ${where}`).get(...params).cnt;

  res.render('part-orders/list', {
    title: 'Spare Part Orders',
    rows, total,
    filters: { status: status || '', q: q || '' },
    page: parseInt(page), limit, pages: Math.ceil(total / limit)
  });
});

// ── New order form ────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('part-orders/form', { title: 'New Part Order', order: null, items: [] });
});

// ── Machine lookup API ────────────────────────────────────────────────────────
router.get('/api/machine/:no', (req, res) => {
  const no = req.params.no.trim();
  const m = db.prepare(
    "SELECT machine_no, customer_name, customer_address, mobile_1 AS mobile FROM sold_machines WHERE machine_no=? COLLATE NOCASE"
  ).get(no);
  if (!m) return res.json({ found: false });
  res.json({ found: true, ...m });
});

// ── Create order ──────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { machine_no, customer_name, customer_address, mobile, remarks, items: itemsJson } = req.body;
  let items = [];
  try { items = JSON.parse(itemsJson || '[]'); } catch(e) {}
  items = (Array.isArray(items) ? items : []).filter(it => it && String(it.description || '').trim());

  if (!items.length) {
    req.session.flash = { error: 'Add at least one part before placing the order.' };
    return res.redirect('/part-orders/new');
  }

  const order_no = nextOrderNo();
  const info = db.prepare(`
    INSERT INTO part_orders (order_no, machine_no, customer_name, customer_address, mobile, remarks, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(order_no, machine_no || '', customer_name || '', customer_address || '', mobile || '', remarks || '', req.session.userId);

  const orderId = info.lastInsertRowid;
  const stmt = db.prepare(`
    INSERT INTO part_order_items (order_id, part_id, sap_part_no, rnd_part_no, description, qty)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const it of items) {
    stmt.run(orderId, it.part_id || null, it.sap_part_no || '', it.rnd_part_no || '', it.description, parseInt(it.qty) || 1);
  }

  auditLog(req.session.userId, 'ORDER_CREATED', 'part_orders', orderId, order_no);
  req.session.flash = { success: `Order ${order_no} placed successfully.` };
  res.redirect(`/part-orders/${orderId}`);
});

// ── View order ────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const order = db.prepare(`
    SELECT po.*, u.full_name AS created_by_name, c.full_name AS confirmed_by_name
    FROM part_orders po
    LEFT JOIN users u ON u.id = po.created_by
    LEFT JOIN users c ON c.id = po.confirmed_by
    WHERE po.id = ?
  `).get(req.params.id);
  if (!order) return res.redirect('/part-orders');

  const items = db.prepare('SELECT * FROM part_order_items WHERE order_id=? ORDER BY id').all(order.id);
  const isAdmin   = res.locals.user?.role === 'admin';
  const canCancel = order.status === 'pending' && (isAdmin || order.created_by === req.session.userId);

  res.render('part-orders/view', { title: order.order_no, order, items, isAdmin, canCancel });
});

function adminOnly(req, res, next) {
  if (res.locals.user?.role === 'admin') return next();
  req.session.flash = { error: 'Admin access required.' };
  res.redirect(`/part-orders/${req.params.id}`);
}

// ── Confirm order (admin) ─────────────────────────────────────────────────────
router.post('/:id/confirm', adminOnly, (req, res) => {
  db.prepare(`
    UPDATE part_orders SET status='confirmed', confirmed_by=?, confirmed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending'
  `).run(req.session.userId, req.params.id);
  auditLog(req.session.userId, 'ORDER_CONFIRMED', 'part_orders', req.params.id, '');
  req.session.flash = { success: 'Order confirmed.' };
  res.redirect(`/part-orders/${req.params.id}`);
});

// ── Cancel order ──────────────────────────────────────────────────────────────
router.post('/:id/cancel', (req, res) => {
  const order = db.prepare('SELECT status, created_by FROM part_orders WHERE id=?').get(req.params.id);
  if (!order) return res.redirect('/part-orders');
  if (order.status !== 'pending' || (res.locals.user?.role !== 'admin' && order.created_by !== req.session.userId)) {
    req.session.flash = { error: 'Only a pending order can be cancelled, by its creator or an admin.' };
    return res.redirect(`/part-orders/${req.params.id}`);
  }
  db.prepare(`UPDATE part_orders SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
  auditLog(req.session.userId, 'ORDER_CANCELLED', 'part_orders', req.params.id, '');
  req.session.flash = { success: 'Order cancelled.' };
  res.redirect(`/part-orders/${req.params.id}`);
});

// ── Delete order ──────────────────────────────────────────────────────────────
router.post('/:id/delete', adminOnly, (req, res) => {
  db.prepare('DELETE FROM part_orders WHERE id=?').run(req.params.id);
  auditLog(req.session.userId, 'ORDER_DELETED', 'part_orders', req.params.id, '');
  req.session.flash = { success: 'Order deleted.' };
  res.redirect('/part-orders');
});

module.exports = router;
