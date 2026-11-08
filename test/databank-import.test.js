// Databank import: Bull CRM enquiry fields + dated, source-tagged follow-up history,
// through the real /databank router. Re-import must not duplicate remarks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const express = require('express');
const XLSX = require('xlsx');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users } = T;

const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = sessions[uid] ||= { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role, databank_access FROM users WHERE id=?').get(uid);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: () => true, dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/databank', require('../routes/databank'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });

// A tiny two-sheet workbook in the format the importer expects
function workbookBase64() {
  const wb = XLSX.utils.book_new();
  const dbSheet = XLSX.utils.json_to_sheet([
    { Phone: '9876543210', Name: 'Ramesh Kumar', Location: 'Sardhana', 'Area (District)': 'Meerut',
      'Last Remark': 'asked for quote', 'Data Source': 'Bull CRM Enquiry', 'Last Activity': '2026-05-10',
      'Machine Interested': 'HD76 BACKHOE LOADER', 'Bull Stage': 'Open', 'Bull Status': 'Hot',
      'Lead Source': 'Field Visit', 'Enquiry Count': 2, 'First Seen': '2025-11-02' },
    { Phone: '+91 98111 22333', Name: 'Suresh', Location: 'Kithore', 'Area (District)': 'Meerut',
      'Last Remark': 'not interested', 'Data Source': 'Bull CRM Enquiry', 'Last Activity': '2026-02-01',
      'Machine Interested': 'BS60 LOADER', 'Bull Stage': 'Customer Not Interested', 'Bull Status': 'Cold',
      'Lead Source': 'Agent', 'Enquiry Count': 1, 'First Seen': '2026-01-15' },
  ]);
  const fuSheet = XLSX.utils.json_to_sheet([
    { Phone: '9876543210', Date: '2025-11-02', Source: 'Bull CRM Enquiry', Type: 'Enquiry raised', 'Stage / Outcome': 'Discussion', Remark: 'wants backhoe' },
    { Phone: '9876543210', Date: '2026-05-10', Source: 'Bull CRM Enquiry', Type: 'Follow-up', 'Stage / Outcome': 'enquiry', Remark: 'asked for quote' },
    { Phone: '98111 22333', Date: '2026-02-01', Source: 'Bull CRM Enquiry', Type: 'Follow-up', 'Stage / Outcome': 'courtesy', Remark: 'said not interested' },
  ]);
  XLSX.utils.book_append_sheet(wb, dbSheet, 'Databank');
  XLSX.utils.book_append_sheet(wb, fuSheet, 'Followups');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

const importAs = (who, data) => fetch(base + '/databank/import', { method: 'POST', redirect: 'manual',
  headers: { 'x-user': who.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }).then(r => r.json());

test('admin import: upserts phones, fills CRM fields, adds dated tagged history', async () => {
  const data = workbookBase64();
  const r = await importAs(users.admin, data);
  assert.equal(r.ok, true);
  assert.equal(r.inserted, 2);
  assert.equal(r.remarksAdded, 3);

  const row = db.prepare('SELECT * FROM databank WHERE phone=?').get('9876543210');
  assert.equal(row.name, 'Ramesh Kumar');
  assert.equal(row.district, 'Meerut');
  assert.equal(row.machine_interested, 'HD76 BACKHOE LOADER');
  assert.equal(row.bull_stage, 'Open');
  assert.equal(row.bull_status, 'Hot');
  assert.equal(row.enquiry_count, 2);
  assert.equal(row.first_seen, '2025-11-02');
  assert.match(row.data_source, /Bull CRM Enquiry/);

  const hist = db.prepare('SELECT * FROM databank_remarks WHERE databank_id=? ORDER BY activity_date').all(row.id);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].source, 'Bull CRM Enquiry');
  assert.equal(hist[0].activity_date, '2025-11-02');
  assert.match(hist[0].remark, /Enquiry raised/);

  // +91 / spaces in the phone still resolve to the same 10-digit record
  const suresh = db.prepare('SELECT * FROM databank WHERE phone=?').get('9811122333');
  assert.ok(suresh, 'phone normalised from "+91 98111 22333"');
  assert.equal(suresh.bull_stage, 'Customer Not Interested');
});

test('re-import is idempotent: no duplicate remarks, data_source not doubled', async () => {
  const data = workbookBase64();
  const r = await importAs(users.admin, data);
  assert.equal(r.ok, true);
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, 2);
  assert.equal(r.remarksAdded, 0);            // all three already present → skipped
  const row = db.prepare('SELECT * FROM databank WHERE phone=?').get('9876543210');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM databank_remarks WHERE databank_id=?').get(row.id).c, 2);
  assert.equal((row.data_source.match(/Bull CRM Enquiry/g) || []).length, 1);
});

test('a remark typed in the app is never overwritten by import', async () => {
  const row = db.prepare('SELECT * FROM databank WHERE phone=?').get('9876543210');
  db.prepare("UPDATE databank SET last_remark='TEAM NOTE', remark_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  await importAs(users.admin, workbookBase64());
  assert.equal(db.prepare('SELECT last_remark FROM databank WHERE id=?').get(row.id).last_remark, 'TEAM NOTE');
});

test('non-admin cannot import', async () => {
  const r = await fetch(base + '/databank/import', { method: 'POST', redirect: 'manual',
    headers: { 'x-user': users.sales.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x' }) });
  assert.equal(r.status, 302);                // adminOnly redirects to /databank
});

test('area list filters by Bull stage, and the customer card renders', async () => {
  const any = await fetch(base + '/databank?stage=any', { headers: { 'x-user': users.admin.id } });
  assert.equal(any.status, 200);
  const row = db.prepare('SELECT id FROM databank WHERE phone=?').get('9876543210');
  const card = await fetch(base + '/databank/' + row.id, { headers: { 'x-user': users.admin.id } });
  assert.equal(card.status, 200);
  const html = await card.text();
  assert.match(html, /HD76 BACKHOE LOADER/);
  assert.match(html, /Bull CRM Enquiry/);
});
