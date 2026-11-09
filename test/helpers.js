// Fresh scratch database per test file. DB_PATH must be set before db loads.
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupDb() {
  process.env.TZ = 'Asia/Kolkata';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  const dbmod = require('../db');
  const db = dbmod.db;

  const mkUser = (username, role) => {
    const r = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'x', ?, ?)").run(username, username, role);
    return { id: Number(r.lastInsertRowid), role };
  };
  const admin = { id: db.prepare("SELECT id FROM users WHERE username='admin'").get().id, role: 'admin' };
  const users = {
    admin,
    accountant: mkUser('acct', 'accountant'),
    manager: mkUser('mgr', 'manager'),
    sales: mkUser('sales1', 'sales'),
  };
  let n = 0;
  const customer = (name = 'Customer ' + (++n), extra = {}) => Number(db.prepare(
    'INSERT INTO customers (name, phone, gstin, created_by) VALUES (?,?,?,?)').run(name, '9999999999', extra.gstin || '', extra.created_by || admin.id).lastInsertRowid);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  return { db, dbmod, users, customer, today, dbPath: process.env.DB_PATH };
}

module.exports = { setupDb };
