// Default data for a new database. Every insert is INSERT OR IGNORE (or checks
// first), so re-running on an existing database never overwrites admin edits.
const bcrypt = require('bcryptjs');
const db = require('./connection');
const MACHINES = require('./seed-machines');

function seed() {
  // Seed default reimbursement rates (admin/manager-editable via /travel-expenses/rates)
  const insertRate = db.prepare('INSERT OR IGNORE INTO expense_rates (vehicle_type, rate_per_km) VALUES (?,?)');
  [['Own Two Wheeler', 3], ['Own Four Wheeler', 5], ['Company Vehicle', 0]]
    .forEach(r => insertRate.run(...r));

  // Seed leave types (only CL and SL active by default)
  const insertLT = db.prepare('INSERT OR IGNORE INTO leave_types (code, name, days_per_year, carry_forward, is_active) VALUES (?,?,?,?,?)');
  [['CL','Casual Leave',12,0,1],['EL','Earned Leave',15,1,0],['HD','Half Day',24,0,0]]
    .forEach(r => insertLT.run(...r));

  // Seed default role permissions
  const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)');
  const defaultPerms = [
    // ── admin gets '*' dynamically in getUserPermissions, no rows needed ──

    // manager
    ['manager','attendance'],['manager','hr_admin'],['manager','leave_approval'],
    ['manager','attendance_admin'],['manager','quotations'],['manager','customers'],
    ['manager','salary_admin'],['manager','reports'],['manager','enquiries'],
    ['manager','spare_quotations'],['manager','sold_machines'],['manager','spare_parts'],['manager','spare_reports'],['manager','stock'],
    ['manager','salespersons_admin'],

    // sales — enquiries, visits, HR self-service (no machine quotations/Form 22 — removed 2026)
    ['sales','enquiries'],['sales','field_visit'],['sales','route_map'],
    ['sales','attendance'],['sales','expense_claim'],['sales','customers'],

    // office — machine + spare quotations, sold machines, parts, enquiries, HR self-service
    ['office','quotations'],['office','spare_quotations'],['office','sold_machines'],
    ['office','spare_parts'],['office','spare_reports'],['office','stock'],
    ['office','enquiries'],['office','attendance'],['office','expense_claim'],['office','customers'],

    // service
    ['service','attendance'],['service','field_visit'],['service','route_map'],['service','expense_claim'],

    // hr
    ['hr','attendance'],['hr','hr_admin'],['hr','leave_approval'],['hr','attendance_admin'],['hr','reports'],
    ['hr','expense_approval'],

    // manager — travel expense approvals
    ['manager','expense_approval'],

    // staff (legacy alias for sales — no machine quotations/Form 22, matches sales)
    ['staff','attendance'],['staff','field_visit'],['staff','customers'],['staff','enquiries'],
    ['staff','expense_claim'],

    // employee (attendance only)
    ['employee','attendance'],
  ];

  defaultPerms.forEach(([r,p]) => insertPerm.run(r,p));

  // Telecaller role: module access ('telecaller') for the telecaller; admin/manager
  // also manage scripts, pitches and territories ('telecaller_admin').
  insertPerm.run('telecaller', 'telecaller');
  insertPerm.run('manager', 'telecaller');
  insertPerm.run('manager', 'telecaller_admin');

  // Seed admin user
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Administrator', 'admin');
  }

  // Company settings. The company block holds this dealership's details; the
  // rest are app defaults. Only keys that are missing get written.
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const defaults = [
    ['company_name', 'SUPER ALLIED'],
    ['company_gstin', '09ACYFS8408G1ZC'],
    ['company_address', 'Aman Vihar Mawana Road, Meerut 250001'],
    ['dealer_of', 'Bull Construction Equipment Pvt. Ltd.'],
    ['contact_name', 'Haroon Rasheed'],
    ['contact_phone', '9810100522'],
    ['bank_beneficiary', 'Super Allied'],
    ['bank_account', '125001369444'],
    ['bank_ifsc', 'CNRB0018573'],
    ['bank_branch', 'DEFENCE COLONY, Mawana Road, Meerut'],
    ['salesperson_name', 'Govind Maan'],
    ['salesperson_phone', '+919690014010'],
    ['rto_default_rate', '6'],
    ['price_lock_enabled', '1'],
    ['roundoff_enabled', '1'],
    ['roundoff_amount', '500'],
    ['company_email', ''],
    ['company_udyam', ''],
    ['company_phone_sales', ''],
    ['company_phone_service', ''],
    ['company_state', 'Uttar Pradesh'],
    ['company_state_code', '09'],
    ['company_upi', ''],
  ];
  defaults.forEach(([k, v]) => insertSetting.run(k, v));

  const insertMachine = db.prepare(`
    INSERT OR IGNORE INTO machines
      (model_code, display_name, model_series, basic_price, hsn_code,
       engine, transmission, rear_axle, pump, front_tyre, rear_tyre,
       battery, weight, bucket, warranty)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  MACHINES.forEach(m => insertMachine.run(
    m.model_code, m.display_name, m.model_series, m.basic_price, m.hsn_code,
    m.engine, m.transmission, m.rear_axle, m.pump, m.front_tyre, m.rear_tyre,
    m.battery, m.weight, m.bucket, m.warranty
  ));

  // Telecaller settings (admin-editable). The 3 pitch texts are pasted later, so
  // they seed empty; the calling script and WhatsApp templates seed with defaults.
  const tcDefaults = [
    ['tc_script', JSON.stringify([
      { q: 'Purchase requirement', opts: ['Planning to purchase', 'Already purchased', 'Just collecting information'] },
      { q: 'Machine model', opts: ['SD76 AC Cabin', 'SD76 Supersmart', 'Challenger 55', 'Challenger Turbo', 'Other / Not decided'] },
      { q: 'Purchase timeline', opts: ['Immediately', 'Within 7 days', 'Within 15 days', 'Within 30 days', 'Within 3 months', 'Later / Not decided'] },
      { q: 'Location', opts: ['Village', 'Town', 'District', 'State'] },
      { q: 'Existing machine', opts: ['First machine', 'Replacement', 'Additional machine', 'Already owns another brand'] },
      { q: 'Finance requirement', opts: ['Cash purchase', 'Finance required', 'Not decided'] },
      { q: 'Customer meeting', opts: ['Showroom visit', 'Site visit', 'Machine demonstration', 'Salesperson to call', 'Not required currently'] },
    ])],
    ['tc_pitch_filtering', ''],
    ['tc_pitch_closing', ''],
    ['tc_pitch_bull_promise', ''],
    ['tc_wa_customer_template', 'Namaste ji,\n\nThank you for your enquiry regarding Bull Machines.\n\nWe are from Super Allied, authorised Bull Machines dealership, Meerut.\n\nOur sales team will contact you shortly to assist with your requirement.\n\nRegards,\nSuper Allied\nSales: 9917444488'],
    ['tc_wa_group_default', ''],
    ['tc_sales_phone', '9917444488'],
  ];
  const tcInsertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  tcDefaults.forEach(([k, v]) => tcInsertSetting.run(k, v));
}

module.exports = { seed };
