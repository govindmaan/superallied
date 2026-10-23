// ── Accounts module schema ────────────────────────────────────────────────────
// Tally stays the books of account and the only GST invoicing system. These
// tables hold uploaded Tally documents, money actually received, how that money
// is matched (allocated) to documents, and the approvals/reversals around it.
//
// Money is stored as INTEGER paise (₹1 = 100) — exact, never floating point.
// Every create/allocate/cancel runs inside one BEGIN IMMEDIATE transaction.

module.exports = function migrateAccounts(db) {
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
  -- Delivery challans (the app had no challan module; this is the register)
  CREATE TABLE IF NOT EXISTS acc_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challan_number TEXT NOT NULL UNIQUE,
    challan_date DATE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    quotation_id INTEGER REFERENCES quotations(id),
    machine_id INTEGER REFERENCES machines(id),
    machine_details TEXT DEFAULT '',
    chassis_number TEXT DEFAULT '',
    engine_number TEXT DEFAULT '',
    challan_value INTEGER,                       -- paise, optional
    invoice_expected INTEGER NOT NULL DEFAULT 1,
    branch TEXT DEFAULT '',
    salesperson_id INTEGER REFERENCES salespersons(id),
    remarks TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    cancelled_by INTEGER REFERENCES users(id),
    cancelled_at DATETIME,
    cancel_reason TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_accch_customer ON acc_challans(customer_id);
  CREATE INDEX IF NOT EXISTS idx_accch_quote    ON acc_challans(quotation_id);
  CREATE INDEX IF NOT EXISTS idx_accch_date     ON acc_challans(challan_date);

  -- Uploaded Tally documents: tax invoice, credit note, debit note, other
  CREATE TABLE IF NOT EXISTS acc_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_entity TEXT NOT NULL,               -- Super Allied GSTIN at upload time
    financial_year TEXT NOT NULL,                -- from invoice date, e.g. 26-27
    doc_type TEXT NOT NULL CHECK (doc_type IN ('tax_invoice','credit_note','debit_note','other')),
    invoice_number TEXT NOT NULL COLLATE NOCASE,  -- 'sa/101' and 'SA/101' are the same number
    invoice_date DATE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    quotation_id INTEGER REFERENCES quotations(id),
    against_invoice_id INTEGER REFERENCES acc_invoices(id),  -- credit/debit note → original invoice
    machine_details TEXT DEFAULT '',
    basic_value INTEGER NOT NULL CHECK (basic_value >= 0),
    gst_amount INTEGER NOT NULL CHECK (gst_amount >= 0),
    total_amount INTEGER NOT NULL CHECK (total_amount > 0),
    allocated_amount INTEGER NOT NULL DEFAULT 0,  -- receivables: settled by payments/credits/adjustments
                                                  -- credit notes: amount of the note used against invoices
    balance_amount INTEGER NOT NULL DEFAULT 0,    -- total − allocated (kept in the same transaction)
    due_date DATE,
    payment_terms TEXT DEFAULT '',
    customer_gstin TEXT DEFAULT '',               -- GSTIN printed on the invoice
    challan_expected INTEGER NOT NULL DEFAULT 1,
    branch TEXT DEFAULT '',
    salesperson_id INTEGER REFERENCES salespersons(id),
    remarks TEXT DEFAULT '',
    extracted_json TEXT DEFAULT '',               -- unverified PDF text suggestions
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','uploaded','verified','cancelled')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','credit_adjusted')),
    client_token TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    uploaded_at DATETIME,
    verified_by INTEGER REFERENCES users(id),
    verified_at DATETIME,
    cancelled_by INTEGER REFERENCES users(id),
    cancelled_at DATETIME,
    cancel_reason TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (business_entity, financial_year, doc_type, invoice_number),
    CHECK (allocated_amount >= 0 AND allocated_amount <= total_amount),
    CHECK (balance_amount = total_amount - allocated_amount)
  );
  CREATE INDEX IF NOT EXISTS idx_accinv_customer ON acc_invoices(customer_id);
  CREATE INDEX IF NOT EXISTS idx_accinv_date     ON acc_invoices(invoice_date);
  CREATE INDEX IF NOT EXISTS idx_accinv_status   ON acc_invoices(status, payment_status);
  CREATE INDEX IF NOT EXISTS idx_accinv_quote    ON acc_invoices(quotation_id);

  -- Many challans ↔ many invoices
  CREATE TABLE IF NOT EXISTS acc_invoice_challans (
    invoice_id INTEGER NOT NULL REFERENCES acc_invoices(id),
    challan_id INTEGER NOT NULL REFERENCES acc_challans(id),
    PRIMARY KEY (invoice_id, challan_id)
  );
  CREATE INDEX IF NOT EXISTS idx_accic_challan ON acc_invoice_challans(challan_id);

  -- Every file ever uploaded for an invoice; replacing adds a revision, nothing is overwritten
  CREATE TABLE IF NOT EXISTS acc_invoice_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES acc_invoices(id),
    revision INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    original_name TEXT DEFAULT '',
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1,
    replace_reason TEXT DEFAULT '',
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (invoice_id, revision)
  );

  -- Money actually received from a customer (one receipt each)
  CREATE TABLE IF NOT EXISTS acc_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    payment_date DATE NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    allocated_amount INTEGER NOT NULL DEFAULT 0,      -- active + pending allocations
    unallocated_amount INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('cash','upi','neft','rtgs','imps','cheque','bank_transfer','card','other')),
    reference TEXT DEFAULT '',                        -- UTR / transaction id / cheque number
    bank_name TEXT DEFAULT '',
    cheque_date DATE,
    purpose TEXT NOT NULL CHECK (purpose IN ('quotation_advance','challan_payment','invoice_payment','on_account','other')),
    quotation_id INTEGER REFERENCES quotations(id),
    challan_id INTEGER REFERENCES acc_challans(id),
    branch TEXT DEFAULT '',
    salesperson_id INTEGER REFERENCES salespersons(id),
    received_by INTEGER REFERENCES users(id),
    remarks TEXT DEFAULT '',
    clearance_status TEXT NOT NULL DEFAULT 'cleared' CHECK (clearance_status IN ('received','deposited','cleared','bounced')),
    clearance_date DATE,
    bank_reference TEXT DEFAULT '',
    verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
    verified_by INTEGER REFERENCES users(id),
    verified_at DATETIME,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    client_token TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (allocated_amount >= 0 AND allocated_amount <= amount),
    CHECK (unallocated_amount = amount - allocated_amount)
  );
  CREATE INDEX IF NOT EXISTS idx_accpay_customer ON acc_payments(customer_id);
  CREATE INDEX IF NOT EXISTS idx_accpay_date     ON acc_payments(payment_date);
  CREATE INDEX IF NOT EXISTS idx_accpay_quote    ON acc_payments(quotation_id);
  CREATE INDEX IF NOT EXISTS idx_accpay_challan  ON acc_payments(challan_id);

  -- Cheque life: received → deposited → cleared | bounced
  CREATE TABLE IF NOT EXISTS acc_cheque_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL REFERENCES acc_payments(id),
    status TEXT NOT NULL,
    event_date DATE NOT NULL,
    remarks TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS acc_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number TEXT NOT NULL UNIQUE,
    financial_year TEXT NOT NULL,
    serial_number INTEGER NOT NULL,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES acc_payments(id),
    receipt_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
    pdf_stored_name TEXT DEFAULT '',             -- original receipt PDF, kept after cancellation
    prepared_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (financial_year, serial_number)
  );

  -- Controlled write-off / round-off / discount so an invoice can be closed without fake money
  CREATE TABLE IF NOT EXISTS acc_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES acc_invoices(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    adjustment_type TEXT NOT NULL DEFAULT 'write_off',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    requested_by INTEGER REFERENCES users(id),
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER REFERENCES users(id),
    decided_at DATETIME,
    decision_remarks TEXT DEFAULT ''
  );

  -- Matching money (payment, credit note or approved adjustment) to a receivable
  CREATE TABLE IF NOT EXISTS acc_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES acc_invoices(id),
    payment_id INTEGER REFERENCES acc_payments(id),
    credit_note_id INTEGER REFERENCES acc_invoices(id),
    adjustment_id INTEGER REFERENCES acc_adjustments(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','reversed')),  -- pending = uncleared cheque
    remarks TEXT DEFAULT '',
    allocated_by INTEGER REFERENCES users(id),
    allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reversed_by INTEGER REFERENCES users(id),
    reversed_at DATETIME,
    reverse_reason TEXT DEFAULT '',
    CHECK ((payment_id IS NOT NULL) + (credit_note_id IS NOT NULL) + (adjustment_id IS NOT NULL) = 1)
  );
  CREATE INDEX IF NOT EXISTS idx_accalloc_invoice ON acc_allocations(invoice_id, status);
  CREATE INDEX IF NOT EXISTS idx_accalloc_payment ON acc_allocations(payment_id, status);
  CREATE INDEX IF NOT EXISTS idx_accalloc_cn      ON acc_allocations(credit_note_id, status);

  -- Requests to cancel a receipt (and, through it, the payment and its allocations)
  CREATE TABLE IF NOT EXISTS acc_cancellations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL REFERENCES acc_receipts(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    cancellation_number TEXT UNIQUE,             -- reversal document number, set when approved
    requested_by INTEGER REFERENCES users(id),
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER REFERENCES users(id),
    decided_at DATETIME,
    decision_remarks TEXT DEFAULT '',
    reversed_allocations TEXT DEFAULT ''         -- JSON snapshot of what was reversed
  );
  CREATE INDEX IF NOT EXISTS idx_acccancel_receipt ON acc_cancellations(receipt_id, status);

  -- Reconciliation flags an authorised user marked as resolved
  CREATE TABLE IF NOT EXISTS acc_discrepancy_resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    remarks TEXT NOT NULL,
    resolved_by INTEGER REFERENCES users(id),
    resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (flag_type, entity_type, entity_id)
  );

  -- Gap-free per-financial-year numbering (receipts, cancellation documents)
  CREATE TABLE IF NOT EXISTS acc_sequences (
    series TEXT NOT NULL,
    financial_year TEXT NOT NULL,
    last_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (series, financial_year)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
  `);

  // Roles: accountant and accounts manager, plus read access for sales/management
  const perm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)');
  [
    ['accountant', 'accounts'], ['accountant', 'accounts_view'], ['accountant', 'customers'], ['accountant', 'attendance'],
    ['accounts_manager', 'accounts'], ['accounts_manager', 'accounts_view'], ['accounts_manager', 'accounts_approve'],
    ['accounts_manager', 'customers'], ['accounts_manager', 'attendance'],
    ['manager', 'accounts_view'], ['manager', 'accounts_reports'],
    ['sales', 'accounts_view'], ['staff', 'accounts_view'], ['office', 'accounts_view'],
  ].forEach(([r, p]) => perm.run(r, p));

  // Module settings (admin-editable on Accounts → Settings)
  const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  [
    ['acc_receipt_prefix', 'SA/RCT'],
    ['acc_cancel_prefix', 'SA/RCN'],
    ['acc_cancel_needs_approval', '1'],
    ['acc_challan_invoice_days', '7'],
    ['acc_branches', 'Meerut'],
    ['acc_default_due_days', '0'],
    ['acc_max_upload_mb', '10'],
  ].forEach(([k, v]) => setting.run(k, v));
};
