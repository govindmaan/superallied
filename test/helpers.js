// Fresh scratch database per test file. DB_PATH must be set before db.js loads.
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupDb() {
  process.env.TZ = 'Asia/Kolkata';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-acc-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.ACC_FILES_DIR = path.join(dir, 'private');
  process.env.ACC_RECEIPT_PDF = 'off';   // no Chromium in tests; the PDF is made on first download instead
  const dbmod = require('../db');
  const { createAccounts } = require('../services/accounts/engine');
  const { createQueries } = require('../services/accounts/queries');
  const acc = createAccounts(dbmod.db);
  const qr = createQueries(acc);
  const db = dbmod.db;

  const mkUser = (username, role) => {
    const r = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'x', ?, ?)").run(username, username, role);
    return { id: Number(r.lastInsertRowid), role };
  };
  const admin = { id: db.prepare("SELECT id FROM users WHERE username='admin'").get().id, role: 'admin' };
  const users = {
    admin,
    accountant: mkUser('acct', 'accountant'),
    manager: mkUser('accmgr', 'accounts_manager'),
    sales: mkUser('sales1', 'sales'),
  };
  let n = 0;
  const customer = (name = 'Customer ' + (++n), extra = {}) => Number(db.prepare(
    'INSERT INTO customers (name, phone, gstin, created_by) VALUES (?,?,?,?)').run(name, '9999999999', extra.gstin || '', extra.created_by || admin.id).lastInsertRowid);
  const machineId = db.prepare('SELECT id FROM machines LIMIT 1').get().id;
  // basic 4,23,728 + 18% GST = 4,99,999.04, rounded up to the next ₹500 → ₹5,00,000 quotation
  const quotation = (customerId, { basic = 423728, userId = admin.id } = {}) => {
    const { nextQuotationNumber } = dbmod;
    const { quotationNumber, financialYear, serialNumber } = nextQuotationNumber();
    return Number(db.prepare(`INSERT INTO quotations (quotation_number, financial_year, serial_number, customer_id, machine_id, user_id,
      quantity, basic_price, has_tcs, status, quotation_date) VALUES (?,?,?,?,?,?,1,?,0,'accepted',date('now'))`)
      .run(quotationNumber, financialYear, serialNumber, customerId, machineId, userId, basic).lastInsertRowid);
  };
  const file = (tag = Math.random().toString(36).slice(2)) => ({ storedName: `t-${tag}.pdf`, originalName: 'inv.pdf', mime: 'application/pdf', size: 100, sha256: tag });
  let invNo = 0;
  const invoice = (customerId, total, extra = {}) => {
    const d = acc.createInvoiceDraft(users.accountant, {
      doc_type: 'tax_invoice', invoice_number: extra.number || `SA/T/${++invNo}`, invoice_date: extra.date || '2026-10-01',
      customer_id: customerId, basic_value: String(total / 1.18 | 0), gst_amount: '0', total_amount: String(total),
      due_date: extra.due || '2026-10-31', challan_expected: '0', ...extra.fields,
    }, file());
    return acc.confirmInvoice(users.accountant, d.id);
  };
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  return { db, dbmod, acc, qr, users, customer, quotation, invoice, file, today, dbPath: process.env.DB_PATH };
}

module.exports = { setupDb };
