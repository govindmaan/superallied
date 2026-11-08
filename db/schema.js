// Table definitions. Columns added after a table first shipped live in
// columns.js, and indexes in indexes.js, so a brand-new database ends up with
// exactly the same schema as the long-running production one.
const db = require('./connection');

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT '',
      gstin TEXT DEFAULT '',
      hp_with TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_code TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      model_series TEXT DEFAULT '',
      basic_price INTEGER NOT NULL,
      purchase_price INTEGER DEFAULT 0,
      hsn_code TEXT DEFAULT '84295900',
      engine TEXT DEFAULT '',
      transmission TEXT DEFAULT '',
      rear_axle TEXT DEFAULT '',
      pump TEXT DEFAULT '',
      front_tyre TEXT DEFAULT '',
      rear_tyre TEXT DEFAULT '',
      battery TEXT DEFAULT '',
      weight TEXT DEFAULT '',
      bucket TEXT DEFAULT '',
      warranty TEXT DEFAULT '1 Year or 2000 Hours Warranty as per company policy',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS machine_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      spec_name TEXT NOT NULL,
      spec_value TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_number TEXT UNIQUE NOT NULL,
      financial_year TEXT NOT NULL,
      serial_number INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      machine_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      basic_price INTEGER NOT NULL,
      transit_insurance INTEGER DEFAULT 2000,
      freight_label TEXT DEFAULT 'Freight Extra as Actual',
      tax_mode TEXT DEFAULT 'CGST_SGST',
      cgst_rate REAL DEFAULT 9,
      sgst_rate REAL DEFAULT 9,
      igst_rate REAL DEFAULT 0,
      has_tcs INTEGER DEFAULT 1,
      tcs_rate REAL DEFAULT 1,
      insurance TEXT DEFAULT 'INCLUSIVE',
      trc TEXT DEFAULT 'INCLUSIVE',
      hp_with TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      notes TEXT DEFAULT '',
      salesperson_name TEXT DEFAULT '',
      salesperson_phone TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS travel_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    ta_bill_id INTEGER REFERENCES ta_bills(id),
    amount REAL NOT NULL,
    paid_on DATE NOT NULL,
    mode TEXT DEFAULT '',
    reference TEXT DEFAULT '',
    remarks TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ta_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    trips INTEGER DEFAULT 0,
    total_km REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, week_start)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS stock_availability (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id          INTEGER UNIQUE REFERENCES spare_parts(id) ON DELETE CASCADE,
    stock_quantity   INTEGER DEFAULT 0,
    category         TEXT DEFAULT '',
    remarks          TEXT DEFAULT '',
    updated_by       INTEGER REFERENCES users(id),
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date DATE NOT NULL,
      check_in_time  DATETIME,
      check_in_lat   REAL,
      check_in_lng   REAL,
      check_in_photo TEXT,
      check_out_time DATETIME,
      check_out_lat  REAL,
      check_out_lng  REAL,
      check_out_photo TEXT,
      status TEXT DEFAULT 'present',
      notes TEXT DEFAULT '',
      UNIQUE(user_id, date)
    );

    CREATE TABLE IF NOT EXISTS leave_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      days_per_year INTEGER DEFAULT 12,
      carry_forward INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS leave_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
      year INTEGER NOT NULL,
      allocated REAL DEFAULT 0,
      used      REAL DEFAULT 0,
      UNIQUE(user_id, leave_type_id, year)
    );

    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
      start_date DATE NOT NULL,
      end_date   DATE NOT NULL,
      days       REAL NOT NULL,
      reason     TEXT DEFAULT '',
      status     TEXT DEFAULT 'pending',
      reviewed_by      INTEGER REFERENCES users(id),
      reviewer_comment TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS salary_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      month      TEXT NOT NULL,
      basic      REAL DEFAULT 0,
      hra        REAL DEFAULT 0,
      allowances REAL DEFAULT 0,
      gross      REAL DEFAULT 0,
      pf         REAL DEFAULT 0,
      esic       REAL DEFAULT 0,
      tds        REAL DEFAULT 0,
      other_ded  REAL DEFAULT 0,
      net_salary REAL DEFAULT 0,
      paid_on    DATE,
      remarks    TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, month)
    );

    CREATE TABLE IF NOT EXISTS incentive_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      month      TEXT NOT NULL,
      amount     REAL DEFAULT 0,
      reason     TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      title     TEXT NOT NULL,
      body      TEXT DEFAULT '',
      type      TEXT DEFAULT 'info',
      is_read   INTEGER DEFAULT 0,
      link      TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS field_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      customer_name TEXT NOT NULL,
      visit_time    DATETIME DEFAULT CURRENT_TIMESTAMP,
      lat  REAL,
      lng  REAL,
      photo   TEXT,
      remarks TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS expense_journeys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      date       DATE NOT NULL,
      start_km   REAL,
      start_photo TEXT,
      start_lat  REAL,
      start_lng  REAL,
      start_time DATETIME,
      end_km     REAL,
      end_photo  TEXT,
      end_lat    REAL,
      end_lng    REAL,
      end_time   DATETIME,
      total_km   REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, date)
    );
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS route_legs (
    leg_key    TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL,
    distance_m REAL,
    duration_s REAL,
    geometry   TEXT,
    provider   TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_type TEXT UNIQUE NOT NULL,
      rate_per_km  REAL NOT NULL DEFAULT 0,
      updated_by   INTEGER REFERENCES users(id),
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS travel_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_number TEXT UNIQUE NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      date         DATE NOT NULL,
      travel_type  TEXT NOT NULL DEFAULT 'Own Two Wheeler',
      vehicle_number TEXT DEFAULT '',
      purpose      TEXT DEFAULT '',
      start_odo    REAL,
      end_odo      REAL,
      distance_km  REAL DEFAULT 0,
      rate_per_km  REAL DEFAULT 0,
      travel_amount REAL DEFAULT 0,
      fuel_type    TEXT DEFAULT '',
      fuel_qty     REAL DEFAULT 0,
      fuel_amount  REAL DEFAULT 0,
      toll_amount    REAL DEFAULT 0,
      parking_amount REAL DEFAULT 0,
      other_amount   REAL DEFAULT 0,
      other_desc     TEXT DEFAULT '',
      total_claim  REAL DEFAULT 0,
      gps_distance_km REAL,
      status       TEXT DEFAULT 'draft',
      remarks      TEXT DEFAULT '',
      submitted_at DATETIME,
      approved_by  INTEGER REFERENCES users(id),
      approved_at  DATETIME,
      approval_remarks TEXT DEFAULT '',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expense_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      doc_type   TEXT NOT NULL DEFAULT 'other',
      file_path  TEXT NOT NULL,
      ocr_json   TEXT DEFAULT '',
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expense_visit_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL REFERENCES travel_expenses(id) ON DELETE CASCADE,
      visit_id   INTEGER NOT NULL REFERENCES field_visits(id),
      UNIQUE(expense_id, visit_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      permission TEXT NOT NULL,
      UNIQUE(role, permission)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sold_machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_no TEXT UNIQUE NOT NULL,
      chassis_number TEXT DEFAULT '',
      engine_number TEXT DEFAULT '',
      model TEXT DEFAULT '',
      customer_name TEXT NOT NULL,
      customer_address TEXT DEFAULT '',
      place_of_supply TEXT DEFAULT '',
      contact_person TEXT DEFAULT '',
      mobile_1 TEXT DEFAULT '',
      mobile_2 TEXT DEFAULT '',
      finance_type TEXT DEFAULT 'Cash',
      financier TEXT DEFAULT '',
      registration_no TEXT DEFAULT '',
      gst_number TEXT DEFAULT '',
      pan_number TEXT DEFAULT '',
      dealer TEXT DEFAULT '',
      date_of_sale DATE,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spare_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sap_part_no TEXT DEFAULT '',
      rnd_part_no TEXT DEFAULT '',
      material_description TEXT NOT NULL,
      hsn_code TEXT DEFAULT '',
      tax_rate REAL DEFAULT 18,
      ndp_basic REAL DEFAULT 0,
      ndp_gst REAL DEFAULT 0,
      ndp_price REAL DEFAULT 0,
      mrp_basic REAL DEFAULT 0,
      mrp_gst REAL DEFAULT 0,
      mrp_price REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spare_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_no TEXT UNIQUE NOT NULL,
      serial_number INTEGER NOT NULL,
      financial_year TEXT NOT NULL,
      sold_machine_id INTEGER REFERENCES sold_machines(id),
      machine_no TEXT DEFAULT '',
      customer_name TEXT NOT NULL,
      customer_address TEXT DEFAULT '',
      customer_gstin TEXT DEFAULT '',
      contact_person TEXT DEFAULT '',
      mobile TEXT DEFAULT '',
      place_of_supply TEXT DEFAULT '',
      tax_mode TEXT DEFAULT 'CGST_SGST',
      salesperson TEXT DEFAULT '',
      validity_days INTEGER DEFAULT 30,
      remarks TEXT DEFAULT '',
      terms TEXT DEFAULT 'Prices are subject to change without notice.\nGoods once sold will not be taken back.\nAll disputes subject to Meerut jurisdiction.',
      status TEXT DEFAULT 'draft',
      total_basic REAL DEFAULT 0,
      total_gst REAL DEFAULT 0,
      grand_total REAL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spare_quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL REFERENCES spare_quotations(id) ON DELETE CASCADE,
      part_no TEXT DEFAULT '',
      description TEXT NOT NULL,
      hsn TEXT DEFAULT '',
      qty REAL DEFAULT 1,
      basic_rate REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      tax_rate REAL DEFAULT 18,
      tax_amount REAL DEFAULT 0,
      net_rate REAL DEFAULT 0,
      line_total REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS part_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      machine_no TEXT DEFAULT '',
      customer_name TEXT DEFAULT '',
      customer_address TEXT DEFAULT '',
      mobile TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_by INTEGER REFERENCES users(id),
      confirmed_by INTEGER REFERENCES users(id),
      confirmed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS part_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES part_orders(id) ON DELETE CASCADE,
      part_id INTEGER,
      sap_part_no TEXT DEFAULT '',
      rnd_part_no TEXT DEFAULT '',
      description TEXT NOT NULL,
      qty INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT DEFAULT '',
      entity_id TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS salespersons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      territory TEXT DEFAULT '',
      target_monthly REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_number TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      location TEXT DEFAULT '',
      district TEXT DEFAULT '',
      village_city TEXT DEFAULT '',
      machine_interested TEXT DEFAULT '',
      lead_source TEXT DEFAULT '',
      assigned_to INTEGER REFERENCES users(id),
      current_stage TEXT DEFAULT 'phone_followup',
      status TEXT DEFAULT 'active',

      machine_model TEXT DEFAULT '',
      expected_purchase_date DATE,
      quotation_sent INTEGER DEFAULT 0,
      finance_required INTEGER DEFAULT 0,
      budget REAL DEFAULT 0,
      probability_percent INTEGER DEFAULT 0,

      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      next_followup_date DATE,
      call_status TEXT DEFAULT 'Interested',
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      visit_date DATE,
      visit_location TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      demo_given INTEGER DEFAULT 0,
      competitor_machine TEXT DEFAULT '',
      outcome TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      photo TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_number TEXT UNIQUE NOT NULL,
      financial_year TEXT NOT NULL,
      serial_number INTEGER NOT NULL,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      machine_model TEXT DEFAULT '',
      validity_days INTEGER DEFAULT 15,
      status TEXT DEFAULT 'draft',
      remarks TEXT DEFAULT '',
      total_amount REAL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL REFERENCES enquiry_quotations(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      qty REAL DEFAULT 1,
      rate REAL DEFAULT 0,
      line_total REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS enquiry_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      invoice_number TEXT DEFAULT '',
      machine_number TEXT DEFAULT '',
      delivery_date DATE,
      finance_company TEXT DEFAULT '',
      sale_amount REAL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_remarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiry_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      activity_type TEXT DEFAULT 'enquiry',
      activity_id INTEGER,
      file_path TEXT NOT NULL,
      file_type TEXT DEFAULT '',
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS databank (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      location TEXT DEFAULT '',
      village TEXT DEFAULT '',
      district TEXT DEFAULT '',
      last_remark TEXT DEFAULT '',
      data_source TEXT DEFAULT '',
      last_activity DATE,
      remark_by INTEGER REFERENCES users(id),
      remark_at DATETIME,
      search_text TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS databank_remarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      databank_id INTEGER NOT NULL REFERENCES databank(id) ON DELETE CASCADE,
      remark TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      call_role  TEXT DEFAULT 'telecaller',
      outcome    TEXT DEFAULT '',
      interest_class TEXT DEFAULT '',
      notes      TEXT DEFAULT '',
      called_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS territories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      primary_user_id INTEGER REFERENCES users(id),
      whatsapp_group_link TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS territory_districts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      territory_id INTEGER NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
      district TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS lead_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      channel    TEXT DEFAULT 'group',
      destination TEXT DEFAULT '',
      message    TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lead_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      activity_type TEXT NOT NULL,
      prev_status   TEXT DEFAULT '',
      new_status    TEXT DEFAULT '',
      remarks       TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Web push: one row per browser/phone a user turned notifications on in
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh   TEXT NOT NULL,
      auth     TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_sent_at DATETIME
    );

    -- Web push server keys and which daily reminders have gone out (kept apart
    -- from settings, which every page reads)
    CREATE TABLE IF NOT EXISTS push_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

module.exports = { createTables };
