// One-time clear of travel expenses (owner's request): claims, receipts, visit links,
// weekly bills and payments go; meter km and attendance stay; a full DB copy is saved first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users } = T;
const { migrate } = require('../db/migrations');
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

test('clears claims, bills and payments once; keeps km and attendance; backs up first', () => {
  const u = users.sales.id;
  ['approved', 'submitted', 'draft', 'rejected'].forEach((st, i) => db.prepare(`INSERT INTO travel_expenses (expense_number,user_id,date,travel_type,distance_km,total_claim,status)
    VALUES (?,?,?, 'Own Two Wheeler', 10, 30, ?)`).run('TE-X-' + i, u, '2026-11-0' + (i + 2), st));
  const e1 = db.prepare("SELECT id FROM travel_expenses WHERE expense_number='TE-X-0'").get().id;
  db.prepare("INSERT INTO expense_documents (expense_id, doc_type, file_path) VALUES (?, 'odometer', '/uploads/x.jpg')").run(e1);
  const bill = db.prepare("INSERT INTO ta_bills (bill_no,user_id,week_start,week_end,status) VALUES ('TA-2026-0001',?,'2026-11-01','2026-11-07','approved')").run(u).lastInsertRowid;
  db.prepare("INSERT INTO travel_payments (user_id, ta_bill_id, amount, paid_on) VALUES (?,?,120,'2026-11-09')").run(u, bill);
  db.prepare("INSERT INTO expense_journeys (user_id,date,start_km,end_km,total_km) VALUES (?,'2026-11-02',100,110,10)").run(u);
  db.prepare("INSERT INTO attendance (user_id,date,check_in_time) VALUES (?,'2026-11-02','2026-11-02T04:00:00Z')").run(u);

  db.prepare("DELETE FROM settings WHERE key='migr_clear_travel_v1'").run();   // a fresh DB already ran it (nothing to delete)
  migrate();

  ['travel_expenses', 'expense_documents', 'expense_visit_links', 'ta_bills', 'travel_payments'].forEach(t => assert.equal(count(t), 0, t));
  assert.equal(count('expense_journeys'), 1);
  assert.equal(count('attendance'), 1);
  const note = db.prepare("SELECT value FROM settings WHERE key='migr_clear_travel_v1'").get().value;
  assert.match(note, /Deleted: travel_payments 1, expense_visit_links 0, expense_documents 1, travel_expenses 4, ta_bills 1/);
  const file = note.match(/backup (\S+)/)[1];
  const copy = path.join(path.dirname(T.dbPath), 'backups', file);
  assert.ok(fs.existsSync(copy), 'backup saved');
  const { DatabaseSync } = require('node:sqlite');
  assert.equal(new DatabaseSync(copy).prepare('SELECT COUNT(*) c FROM travel_expenses').get().c, 4, 'backup has the old rows');

  // runs only once
  db.prepare("INSERT INTO travel_expenses (expense_number,user_id,date,travel_type,status) VALUES ('TE-NEW',?,'2026-11-16','Own Two Wheeler','draft')").run(u);
  migrate();
  assert.equal(count('travel_expenses'), 1);
});
