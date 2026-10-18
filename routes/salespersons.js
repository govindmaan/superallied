const express = require('express');
const router  = express.Router();
const { db, getSettings } = require('../db');

// ── GET /salespersons – List all salespersons ────────────────────────────────
router.get('/', (req, res) => {
  const salespersons = db.prepare(`
    SELECT * FROM salespersons ORDER BY name
  `).all();

  res.render('salespersons/list', {
    title: 'Salespersons',
    salespersons
  });
});

// ── GET /salespersons/new – Add new salesperson form ────────────────────────
router.get('/new', (req, res) => {
  res.render('salespersons/form', {
    title: 'Add Salesperson',
    salesperson: null
  });
});

// ── POST /salespersons – Create new salesperson ───────────────────────────────
router.post('/', (req, res) => {
  const { name, phone, email, territory, target_monthly, notes } = req.body;

  if (!name?.trim()) {
    req.session.flash = { error: 'Salesperson name is required.' };
    return res.redirect('/salespersons/new');
  }

  try {
    db.prepare(`
      INSERT INTO salespersons (name, phone, email, territory, target_monthly, notes, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      name.trim(),
      phone || '',
      email || '',
      territory || '',
      parseFloat(target_monthly) || 0,
      notes || ''
    );

    req.session.flash = { success: `Salesperson "${name}" added successfully.` };
    res.redirect('/salespersons');
  } catch(e) {
    req.session.flash = { error: 'Error adding salesperson: ' + e.message };
    res.redirect('/salespersons/new');
  }
});

// ── GET /salespersons/reports/summary ── MUST be before /:id ─────────────────
router.get('/reports/summary', (req, res) => {
  const { from, to } = req.query;
  const dp = [];
  let dCond = '';
  if (from) { dCond += ' AND date(sq.created_at)>=?'; dp.push(from); }
  if (to)   { dCond += ' AND date(sq.created_at)<=?'; dp.push(to); }

  const spareStats = db.prepare(`
    SELECT
      COALESCE(sp.name, sq.salesperson, 'Unassigned') AS sp_name,
      sp.id AS sp_id,
      COUNT(sq.id)                            AS total_count,
      COALESCE(SUM(sq.grand_total),0)         AS total_value,
      SUM(CASE WHEN sq.status='draft'     THEN 1 ELSE 0 END) AS draft_count,
      SUM(CASE WHEN sq.status='sent'      THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN sq.status='confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
      SUM(CASE WHEN sq.status='cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
      COALESCE(SUM(CASE WHEN sq.status='confirmed' THEN sq.grand_total ELSE 0 END),0) AS confirmed_value
    FROM spare_quotations sq
    LEFT JOIN salespersons sp ON sp.id = sq.salesperson_id
    WHERE 1=1 ${dCond}
    GROUP BY COALESCE(sp.id, sq.salesperson)
    ORDER BY total_value DESC
  `).all(...dp);

  const machineStats = db.prepare(`
    SELECT
      COALESCE(sp.name, q.salesperson_name, 'Unassigned') AS sp_name,
      sp.id AS sp_id,
      COUNT(q.id)                         AS total_count,
      COALESCE(SUM(q.basic_price),0)      AS total_value,
      SUM(CASE WHEN q.status='draft'     THEN 1 ELSE 0 END) AS draft_count,
      SUM(CASE WHEN q.status='sent'      THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN q.status='confirmed' THEN 1 ELSE 0 END) AS confirmed_count
    FROM quotations q
    LEFT JOIN salespersons sp ON sp.id = q.salesperson_id
    WHERE q.cancelled_at IS NULL
    GROUP BY COALESCE(sp.id, q.salesperson_name)
    ORDER BY total_value DESC
  `).all();

  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', sq.created_at)                        AS month,
      COALESCE(sp.name, sq.salesperson, 'Unassigned')         AS sp_name,
      COUNT(*)                                                 AS count,
      COALESCE(SUM(sq.grand_total),0)                         AS value
    FROM spare_quotations sq
    LEFT JOIN salespersons sp ON sp.id = sq.salesperson_id
    WHERE sq.created_at >= date('now','-6 months') ${dCond}
    GROUP BY month, COALESCE(sp.id, sq.salesperson)
    ORDER BY month ASC
  `).all(...dp);

  const formatINR = n => '₹' + Number(n||0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  res.render('salespersons/report', {
    title: 'Salesperson Reports',
    spareStats, machineStats, monthlyTrend,
    from: from||'', to: to||'', formatINR
  });
});

// ── GET /salespersons/:id/edit – Edit salesperson form ───────────────────────
router.get('/:id/edit', (req, res) => {
  const salesperson = db.prepare('SELECT * FROM salespersons WHERE id = ?').get(req.params.id);
  if (!salesperson) return res.redirect('/salespersons');

  res.render('salespersons/form', {
    title: 'Edit Salesperson',
    salesperson
  });
});

// ── POST /salespersons/:id – Update salesperson ──────────────────────────────
router.post('/:id', (req, res) => {
  const { name, phone, email, territory, target_monthly, notes, active } = req.body;

  if (!name?.trim()) {
    req.session.flash = { error: 'Salesperson name is required.' };
    return res.redirect(`/salespersons/${req.params.id}/edit`);
  }

  try {
    db.prepare(`
      UPDATE salespersons
      SET name=?, phone=?, email=?, territory=?, target_monthly=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      name.trim(),
      phone || '',
      email || '',
      territory || '',
      parseFloat(target_monthly) || 0,
      notes || '',
      active === 'on' ? 1 : 0,
      req.params.id
    );

    req.session.flash = { success: 'Salesperson updated successfully.' };
    res.redirect('/salespersons');
  } catch(e) {
    req.session.flash = { error: 'Error updating salesperson: ' + e.message };
    res.redirect(`/salespersons/${req.params.id}/edit`);
  }
});

// ── POST /salespersons/:id/delete – Toggle active status (deactivate/reactivate) ──────
router.post('/:id/delete', (req, res) => {
  try {
    const sp = db.prepare('SELECT name, active FROM salespersons WHERE id = ?').get(req.params.id);
    if (!sp) {
      req.session.flash = { error: 'Salesperson not found.' };
      return res.redirect('/salespersons');
    }

    // Toggle: deactivate if active, reactivate if inactive
    const newStatus = sp.active ? 0 : 1;
    const action = sp.active ? 'deactivated' : 'reactivated';
    db.prepare('UPDATE salespersons SET active=?, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);

    if (newStatus === 0) {
      req.session.flash = { success: `Salesperson "${sp.name}" deactivated. (Data preserved for existing quotations)` };
    } else {
      req.session.flash = { success: `Salesperson "${sp.name}" reactivated.` };
    }
  } catch(e) {
    req.session.flash = { error: 'Error updating salesperson status: ' + e.message };
  }
  res.redirect('/salespersons');
});

module.exports = router;
