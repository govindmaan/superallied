// Columns added to tables after they first shipped. On an existing database
// each is added once; on a new one they are added right after the tables are
// created. Grouped by table; order within a table is the order they shipped.
const db = require('./connection');

const COLUMNS = {
  customers: [
    ["created_by", "INTEGER REFERENCES users(id)"],
    ["pan", "TEXT DEFAULT ''"],
    ["aadhaar", "TEXT DEFAULT ''"],
    ["deleted_at", "DATETIME"],
    ["deleted_by", "INTEGER REFERENCES users(id)"],
  ],
  quotations: [
    ["cancelled_at", "DATETIME"],
    ["cancelled_by", "INTEGER REFERENCES users(id)"],
    ["salesperson_name", "TEXT DEFAULT ''"],
    ["salesperson_phone", "TEXT DEFAULT ''"],
    ["quotation_date", "DATE"],
    ["extra_items", "TEXT DEFAULT '[]'"],
    ["tyre_option", "TEXT DEFAULT 'IT'"],
    ["salesperson_id", "INTEGER REFERENCES salespersons(id)"],
    ["insurance_amount", "REAL DEFAULT 0"],
    ["handling_charges", "REAL DEFAULT 0"],
    ["transport_charges", "REAL DEFAULT 0"],
  ],
  users: [
    ["pin_hash", "TEXT"],
    ["failed_logins", "INTEGER DEFAULT 0"],
    ["locked_until", "DATETIME"],
    ["employee_code", "TEXT DEFAULT ''"],
    ["designation", "TEXT DEFAULT ''"],
    ["department", "TEXT DEFAULT ''"],
    ["mobile", "TEXT DEFAULT ''"],
    ["emergency_contact", "TEXT DEFAULT ''"],
    ["date_of_joining", "DATE"],
    ["photo_path", "TEXT DEFAULT ''"],
    ["manager_id", "INTEGER"],
    ["is_hr_active", "INTEGER DEFAULT 1"],
    ["vehicle_type", "TEXT DEFAULT ''"],
    ["vehicle_number", "TEXT DEFAULT ''"],
    ["databank_access", "INTEGER DEFAULT 0"],
    ["must_change_password", "INTEGER DEFAULT 0"],
    ["sessions_valid_after", "INTEGER"],
    ["old_employee_code", "TEXT DEFAULT ''"],
    ["language", "TEXT DEFAULT ''"],
  ],
  machines: [
    ["purchase_price", "INTEGER DEFAULT 0"],
    ["gst_rate", "REAL DEFAULT 18"],
  ],
  spare_quotations: [
    ["show_discount", "INTEGER DEFAULT 0"],
    ["quotation_date", "DATE"],
    ["salesperson_id", "INTEGER REFERENCES salespersons(id)"],
    ["approval_status", "TEXT DEFAULT 'draft'"],
    ["approval_notes", "TEXT DEFAULT ''"],
    ["approved_by", "INTEGER REFERENCES users(id)"],
    ["approved_at", "DATETIME"],
    ["roundoff_amount", "REAL DEFAULT 0"],
    ["share_token", "TEXT"],
    ["share_token_at", "DATETIME"],
  ],
  sold_machines: [
    ["is_active", "INTEGER DEFAULT 1"],
  ],
  spare_parts: [
    ["category", "TEXT DEFAULT ''"],
    ["price_date", "DATE"],
  ],
  field_visits: [
    ["contact_person", "TEXT DEFAULT ''"],
    ["purpose", "TEXT DEFAULT ''"],
    ["phone", "TEXT DEFAULT ''"],
    ["address", "TEXT DEFAULT ''"],
    ["gps_accuracy", "REAL"],
    ["location_status", "TEXT DEFAULT ''"],
  ],
  leave_types: [
    ["is_active", "INTEGER DEFAULT 1"],
  ],
  databank: [
    ["machine_interested", "TEXT DEFAULT ''"],
    ["bull_stage", "TEXT DEFAULT ''"],
    ["bull_status", "TEXT DEFAULT ''"],
    ["lead_source", "TEXT DEFAULT ''"],
    ["enquiry_count", "INTEGER DEFAULT 0"],
    ["first_seen", "DATE"],
  ],
  databank_remarks: [
    ["source", "TEXT DEFAULT ''"],
    ["activity_date", "DATE"],
  ],
  enquiries: [
    ["alt_phone", "TEXT DEFAULT ''"],
    ["state", "TEXT DEFAULT ''"],
    ["interest_class", "TEXT DEFAULT ''"],
    ["purchase_timeline", "TEXT DEFAULT ''"],
    ["finance_mode", "TEXT DEFAULT ''"],
    ["existing_machine", "TEXT DEFAULT ''"],
    ["meeting_requirement", "TEXT DEFAULT ''"],
    ["preferred_contact_time", "TEXT DEFAULT ''"],
    ["telecaller_id", "INTEGER REFERENCES users(id)"],
    ["first_call_at", "DATETIME"],
    ["qualified_at", "DATETIME"],
  ],
  enquiry_visits: [
    ["gps_accuracy", "REAL"],
  ],
};

function addColumns() {
  for (const [table, list] of Object.entries(COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    if (!existing.size) throw new Error(`Cannot add columns: table "${table}" does not exist`);
    for (const [name, def] of list) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
}

module.exports = { addColumns, COLUMNS };
