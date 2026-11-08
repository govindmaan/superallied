// Management reporting: funnel + telecaller/salesperson performance, access control.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;

const tcId = Number(db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES ('tcr','x','Tele R','telecaller')").run().lastInsertRowid);
const spId = users.sales.id;

// One lead that goes the whole way: entered → connected → qualified HOT → assigned →
// salesperson contacted → demo → won.
const leadId = Number(db.prepare(`INSERT INTO enquiries (enquiry_number,customer_name,phone,district,machine_interested,
  interest_class,telecaller_id,assigned_to,first_call_at,qualified_at,current_stage,status,quotation_sent)
  VALUES ('ENQ-R-1','Full Journey','9876522233','Baghpat','SD76','HOT',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'sales_closed','won',1)`)
  .run(tcId, spId).lastInsertRowid);
// A second lead that stalls at qualified-but-unassigned
db.prepare(`INSERT INTO enquiries (enquiry_number,customer_name,phone,district,interest_class,telecaller_id,first_call_at,current_stage,status)
  VALUES ('ENQ-R-2','Stalled','9876522244','Nowhere','WARM',?,CURRENT_TIMESTAMP,'phone_followup','active')`).run(tcId);
db.prepare("INSERT INTO call_logs (enquiry_id,user_id,call_role,outcome) VALUES (?,?,'telecaller','Connected')").run(leadId, tcId);
db.prepare("INSERT INTO call_logs (enquiry_id,user_id,call_role,outcome) VALUES (?,?,'salesperson','Connected')").run(leadId, spId);
db.prepare("INSERT INTO enquiry_visits (enquiry_id,visit_date,demo_given,created_by) VALUES (?,?,1,?)").run(leadId, '2026-11-20', spId);

const sessions = {};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = sessions[uid] ||= { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(uid);
  const perms = getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/telecaller', (req, res, next) => res.locals.hasPerm('telecaller') ? next() : res.redirect('/'), require('../routes/telecaller'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });
const get = (u, who) => fetch(base + u, { headers: { 'x-user': who.id || who }, redirect: 'manual' });

test('reports render the funnel and both performance tables for admin', async () => {
  const html = await get('/telecaller/reports?from=2026-01-01&to=2026-12-31', users.admin).then(r => r.text());
  assert.match(html, /Conversion Funnel/);
  assert.match(html, /Telecaller Performance/);
  assert.match(html, /Salesperson Performance/);
  assert.match(html, /Tele R/);           // telecaller row
  assert.match(html, /Full Journey|Booking/);
});

test('a telecaller (non-admin) cannot open the reports', async () => {
  const r = await get('/telecaller/reports', { id: tcId });
  assert.equal(r.status, 302);            // adminOnly → redirect to /telecaller
  assert.equal(r.headers.get('location'), '/telecaller');
});

test('a plain salesperson is blocked from the whole module', async () => {
  const r = await get('/telecaller/reports', users.sales);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
});
