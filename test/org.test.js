// Organisation chart: positions from the growth plan, and approval routing to
// the nearest filled position above, falling back to Level 1 (owner).
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users } = T;
const org = require('../lib/org');

const person = (username, position, extra = {}) => {
  const id = Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role, position_code, manager_id) VALUES (?, 'x', ?, 'sales', ?, ?)")
    .run(username, username, position, extra.manager_id || null).lastInsertRowid);
  return id;
};
const names = (userId) => org.approverFor(userId).approvers.map(a => a.full_name);

test('the chart matches the growth plan: 98 seats + owner, by section', () => {
  const chart = org.chart();
  const seats = (s) => chart.filter(p => p.section === s).reduce((a, p) => a + p.planned, 0);
  assert.equal(seats('Sales'), 38);
  assert.equal(seats('Service'), 21);
  assert.equal(seats('Operations'), 25);
  assert.equal(seats('Support'), 14);
  assert.equal(seats('Leadership'), 1);
  // every position except the owner reports to a position that exists
  const codes = new Set(chart.map(p => p.code));
  chart.filter(p => p.code !== 'owner').forEach(p => assert.ok(codes.has(p.parent_code), p.code));
});

test('the admin of a new database is placed at Level 1', () => {
  assert.equal(db.prepare('SELECT position_code FROM users WHERE id=?').get(users.admin.id).position_code, 'owner');
});

test('while every position above is vacant, approvals go to Level 1', () => {
  const so = person('officer1', 'sales_officer');
  const r = org.approverFor(so);
  assert.deepEqual(r.approvers.map(a => a.id), [users.admin.id]);
  assert.deepEqual(r.vacant.map(v => v.code), ['area_sales_lead', 'rsm', 'head_sales']);
});

test('the nearest filled position above takes the approval', () => {
  const head = person('salesHead', 'head_sales');
  const so = person('officer2', 'sales_officer');
  assert.deepEqual(names(so), ['salesHead']);
  const lead = person('leadA', 'area_sales_lead');
  assert.deepEqual(names(so), ['leadA']);
  // the head's own approvals still go to Level 1
  assert.deepEqual(org.approverFor(head).approvers.map(a => a.id), [users.admin.id]);
});

test('with several people in the position above, Reports To picks one', () => {
  const leadB = person('leadB', 'area_sales_lead');
  const so = person('officer3', 'sales_officer', { manager_id: leadB });
  assert.deepEqual(names(so), ['leadB']);
});

test('people outside the chart, and inactive approvers, fall through', () => {
  const loose = person('loose', '');
  assert.deepEqual(org.approverFor(loose).approvers.map(a => a.id), [users.admin.id]);
  db.prepare("UPDATE users SET is_hr_active=0 WHERE username IN ('leadA','leadB')").run();
  const so = person('officer4', 'sales_officer');
  assert.deepEqual(names(so), ['salesHead']);
});

test('only the routed approver (or an admin) may approve', () => {
  const so = person('officer5', 'sales_officer');
  const head = db.prepare("SELECT id FROM users WHERE username='salesHead'").get().id;
  const stranger = person('stranger', 'driver');
  assert.equal(org.canApproveFor(head, so, 'manager'), true);
  assert.equal(org.canApproveFor(stranger, so, 'employee'), false);
  assert.equal(org.canApproveFor(users.admin.id, so, 'admin'), true);
});
