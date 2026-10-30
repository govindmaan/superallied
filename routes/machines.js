const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// The Machine Master form: Name, Category, Basic Price, GST %, HSN Code, Engine,
// Transmission, Front Tyre, Rear Tyre, Battery, Weight, Bucket, Warranty.
// Older fields (rear axle, pump) are no longer on the form but keep their stored values.
function readMachineForm(body) {
  const t = (k) => String(body[k] ?? '').trim();
  const name = t('display_name');
  const price = Math.round(Number(body.basic_price));
  const gst = Number(body.gst_rate === '' || body.gst_rate == null ? 18 : body.gst_rate);
  const hsn = t('hsn_code').replace(/\s+/g, '');
  if (!name) return { error: 'Name is required.' };
  if (!(price > 0)) return { error: 'Basic Price must be greater than 0.' };
  if (!(gst > 0 && gst <= 100)) return { error: 'GST % must be more than 0 and at most 100.' };   // quotation totals treat a 0 rate as unset
  if (hsn && !/^\d{4,8}$/.test(hsn)) return { error: 'HSN Code must be 4 to 8 digits.' };
  return { name, category: t('model_series'), price, gst, hsn: hsn || '84295900',
    engine: t('engine'), transmission: t('transmission'), front_tyre: t('front_tyre'), rear_tyre: t('rear_tyre'),
    battery: t('battery'), weight: t('weight'), bucket: t('bucket'), warranty: t('warranty') };
}

// Model code is internal now: built from the name, kept unique
function newModelCode(name) {
  const base = 'BULL-' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^BULL-/, '').slice(0, 40);
  let code = base, n = 2;
  while (db.prepare('SELECT 1 FROM machines WHERE model_code=?').get(code)) code = `${base}-${n++}`;
  return code;
}

// ── GET /machines/price-update – Update selling prices table ────────────────
router.get('/price-update', (req, res) => {
  const machines = db.prepare(`
    SELECT id, display_name, model_series, basic_price
    FROM machines WHERE active=1 ORDER BY display_name
  `).all();

  res.render('machines/price-update', { title: 'Update Machine Selling Prices', machines });
});

// ── PUT /machines/:id/selling-price – Update selling price ───────────────────
router.put('/:id/selling-price', (req, res) => {
  const { basic_price } = req.body;

  if (basic_price === undefined || basic_price === null) {
    return res.json({ ok: false, error: 'basic_price required' });
  }

  const price = parseInt(basic_price) || 0;
  if (price <= 0) {
    return res.json({ ok: false, error: 'Price must be greater than 0' });
  }

  try {
    db.prepare('UPDATE machines SET basic_price=? WHERE id=?')
      .run(price, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

const machineCategories = () => db.prepare("SELECT DISTINCT model_series AS c FROM machines WHERE model_series <> '' ORDER BY c").all().map(r => r.c);

// ── GET /machines – Admin machine management console ─────────────────────────
router.get('/', (req, res) => {
  const machines = db.prepare(`
    SELECT m.*, COUNT(s.id) as spec_count
    FROM machines m
    LEFT JOIN machine_specs s ON m.id=s.machine_id
    GROUP BY m.id
    ORDER BY m.display_name
  `).all();

  res.render('machines/list', { title: 'Machine Master', machines, categories: machineCategories() });
});

// ── GET /machines/:id – View machine details ───────────────────────────────
router.get('/:id', (req, res) => {
  const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(req.params.id);
  if (!machine) return res.status(404).send('Machine not found');

  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(req.params.id);

  const used = db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE machine_id=?').get(machine.id).c;
  res.render('machines/detail', { title: machine.display_name, machine, specs, used, categories: machineCategories() });
});

// ── POST /machines – Create new machine ─────────────────────────────────────
router.post('/', (req, res) => {
  const f = readMachineForm(req.body);
  if (f.error) return res.json({ ok: false, error: f.error });
  if (db.prepare('SELECT 1 FROM machines WHERE display_name = ? COLLATE NOCASE').get(f.name)) return res.json({ ok: false, error: `A machine named "${f.name}" already exists.` });
  try {
    db.prepare(`
      INSERT INTO machines
      (model_code, display_name, model_series, basic_price, gst_rate, hsn_code, engine, transmission, front_tyre, rear_tyre, battery, weight, bucket, warranty)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(newModelCode(f.name), f.name, f.category, f.price, f.gst, f.hsn, f.engine, f.transmission, f.front_tyre, f.rear_tyre, f.battery, f.weight, f.bucket,
           f.warranty || '1 Year or 2000 Hours Warranty as per company policy');
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── PUT /machines/:id – Update machine ─────────────────────────────────────
router.put('/:id', (req, res) => {
  const f = readMachineForm(req.body);
  if (f.error) return res.json({ ok: false, error: f.error });
  if (db.prepare('SELECT 1 FROM machines WHERE display_name = ? COLLATE NOCASE AND id <> ?').get(f.name, req.params.id)) return res.json({ ok: false, error: `A machine named "${f.name}" already exists.` });
  try {
    db.prepare(`
      UPDATE machines
      SET display_name=?, model_series=?, basic_price=?, gst_rate=?, hsn_code=?, engine=?, transmission=?, front_tyre=?, rear_tyre=?, battery=?, weight=?, bucket=?, warranty=?
      WHERE id=?
    `).run(f.name, f.category, f.price, f.gst, f.hsn, f.engine, f.transmission, f.front_tyre, f.rear_tyre, f.battery, f.weight, f.bucket, f.warranty, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /machines/:id/active – Reactivate / deactivate ─────────────────────
router.post('/:id/active', (req, res) => {
  const active = req.body.active ? 1 : 0;
  const r = db.prepare('UPDATE machines SET active=? WHERE id=?').run(active, req.params.id);
  res.json(r.changes ? { ok: true, active } : { ok: false, error: 'Machine not found.' });
});

// ── DELETE /machines/:id – Delete machine ──────────────────────────────────
// A machine already used on quotations can't be erased: it is deactivated, so it
// disappears from new quotations while old quotations and PDFs stay intact.
router.delete('/:id', (req, res) => {
  try {
    const used = db.prepare('SELECT COUNT(*) AS c FROM quotations WHERE machine_id=?').get(req.params.id).c;
    if (used) {
      db.prepare('UPDATE machines SET active=0 WHERE id=?').run(req.params.id);
      return res.json({ ok: true, deactivated: true, used });
    }
    db.prepare('DELETE FROM machine_specs WHERE machine_id=?').run(req.params.id);
    db.prepare('DELETE FROM machines WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /machines/:id/specs – Add spec ────────────────────────────────────
router.post('/:id/specs', (req, res) => {
  const { spec_name, spec_value, display_order } = req.body;

  if (!spec_name || !spec_value) {
    return res.json({ ok: false, error: 'spec_name and spec_value required' });
  }

  try {
    db.prepare(`
      INSERT INTO machine_specs (machine_id, spec_name, spec_value, display_order)
      VALUES (?,?,?,?)
    `).run(req.params.id, spec_name, spec_value, display_order || 0);

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── DELETE /machines/:id/specs/:specId – Delete spec ───────────────────────
router.delete('/:id/specs/:specId', (req, res) => {
  try {
    db.prepare('DELETE FROM machine_specs WHERE id=? AND machine_id=?').run(req.params.specId, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
