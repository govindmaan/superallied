// Site visit heatmap: admin only, GPS-only points, day/week/month/year ranges.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { setupDb } = require('./helpers');

const T = setupDb();
const { db, users, dbmod } = T;
const { getUserPermissions } = dbmod;
const spId = users.sales.id;

// visit_time is UTC; 2026-11-10 20:00 UTC is 11 Nov in India (Wednesday)
const visit = (name, time, lat, lng) => db.prepare('INSERT INTO field_visits (user_id, customer_name, visit_time, lat, lng) VALUES (?,?,?,?,?)').run(spId, name, time, lat, lng);
visit('Meerut Site', '2026-11-10 05:00:00', 28.98, 77.70);       // Tue 10 Nov
visit('Late Evening', '2026-11-10 20:00:00', 29.47, 77.70);      // Wed 11 Nov in India
visit('No GPS', '2026-11-10 06:00:00', null, null);
visit('Zero Island', '2026-11-10 07:00:00', 0, 0);               // not a real location
visit('October Site', '2026-10-05 05:00:00', 28.67, 77.44);
visit('Last Year', '2025-12-31 05:00:00', 28.60, 77.20);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
Object.assign(app.locals, require('../lib/i18n').defaultLocals);
app.use((req, res, next) => {
  const uid = Number(req.get('x-user'));
  req.session = { userId: uid };
  const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE id=?').get(uid);
  const perms = getUserPermissions(u.role);
  Object.assign(res.locals, { user: u, flash: {}, settings: {}, unreadCount: 0, currentPath: req.path,
    hasPerm: (p) => perms.includes('*') || perms.includes(p), dbTime: (v) => v ? new Date(v) : null });
  next();
});
app.use('/route-map', require('../routes/route-map'));

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.closeAllConnections(); server.close(); });
const get = (u, who) => fetch(base + u, { headers: { 'x-user': who.id }, redirect: 'manual' });
const pointsOf = (html) => JSON.parse(html.match(/const points = (\[.*?\]);/s)[1]);
const names = (html) => pointsOf(html).map(p => p.customer).sort();

test('day uses India dates and plots only visits with GPS', async () => {
  const html = await get('/route-map/heatmap?period=day&date=2026-11-10', users.admin).then(r => r.text());
  assert.deepEqual(names(html), ['Meerut Site']);
  assert.match(html, /Without GPS \(not shown\)[\s\S]*?>2</);  // No GPS + 0,0
});

test('week (Sunday–Saturday), month and year cover their whole period', async () => {
  const week = await get('/route-map/heatmap?period=week&date=2026-11-13', users.admin).then(r => r.text());
  assert.deepEqual(names(week), ['Late Evening', 'Meerut Site']);
  const month = await get('/route-map/heatmap?period=month&date=2026-11-01', users.admin).then(r => r.text());
  assert.deepEqual(names(month), ['Late Evening', 'Meerut Site']);
  const year = await get('/route-map/heatmap?period=year&date=2026-06-01', users.admin).then(r => r.text());
  assert.deepEqual(names(year), ['Late Evening', 'Meerut Site', 'October Site']);
});

test('only the admin can open the heatmap', async () => {
  const r = await get('/route-map/heatmap', users.sales);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/route-map');
});
