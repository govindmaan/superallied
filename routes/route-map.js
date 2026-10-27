const express = require('express');
const router  = express.Router();
const { db } = require('../db');

// ── DSE daily route map ───────────────────────────────────────────────────────
// Plots one DSE's visits for one day — site punch-ins (field_visits) and enquiry
// visits (enquiry_visits) together — in the order they were recorded (time, then
// site before enquiry, then id) and joins consecutive visits with road routes.
// An enquiry visit is placed by when it was saved, since that is when its GPS was taken.
// Road routing comes from OSRM (free public server by default; set OSRM_URL to
// use your own). Every leg is cached in route_legs, so a pair is routed once.
// The route is the road path *between recorded visit points*: it is not a GPS
// track of what was actually driven.

const OSRM_URL     = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const BATCH_POINTS = 25;          // waypoints per OSRM request (keeps URLs and responses small)
const MIN_GAP_MS   = 1100;        // public OSRM fair use: about 1 request per second
const FAIL_RETRY_H = 6;           // a failed leg is retried after this many hours
const SAME_SPOT_M  = 20;          // consecutive visits closer than this are "same place" (0 km, no request)
const MAX_RANGE_DAYS = 31;

// Each person sees the route of the visits they recorded; only admin can look at anyone's
const canViewAll = (res) => res.locals.user?.role === 'admin';
const canUse = (res) => canViewAll(res) || ['route_map', 'field_visit', 'enquiries'].some(p => res.locals.hasPerm(p));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d + 'T00:00:00Z'));
const todayIST = () => new Date().toLocaleDateString('en-CA');
const validCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// visit_time is UTC ('YYYY-MM-DD HH:MM:SS'); report it as an ISO instant
const isoTime = (v) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v || '') ? v.replace(' ', 'T') + 'Z' : v;

function haversineM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Which DSE the request may look at: field staff only themselves, admin/manager anyone
function resolveUser(req, res) {
  const self = req.session.userId;
  const want = parseInt(req.query.user, 10) || self;
  if (want !== self && !canViewAll(res)) return { error: 403 };
  const u = db.prepare('SELECT id, full_name, username, employee_code FROM users WHERE id=?').get(want);
  return u ? { user: u } : { error: 404 };
}

// Both kinds of visit as one list. Old migrated enquiry visits (no recorder) are left out.
const VISITS_SQL = `
  SELECT 'site' AS kind, id, customer_name, contact_person, phone, purpose, remarks, visit_time,
         lat, lng, gps_accuracy, location_status, address, NULL AS enquiry_id, NULL AS enquiry_number, NULL AS entered_date, 0 AS kind_order
  FROM field_visits WHERE user_id = ? AND date(visit_time, '+330 minutes') BETWEEN ? AND ?
  UNION ALL
  SELECT 'enquiry', v.id, e.customer_name, '', e.phone, v.purpose,
         TRIM(COALESCE(v.outcome, '') || CASE WHEN v.demo_given = 1 THEN ' (demo given)' ELSE '' END), v.created_at,
         v.lat, v.lng, v.gps_accuracy, CASE WHEN v.lat IS NULL THEN 'missing' ELSE 'gps' END, v.visit_location,
         e.id, e.enquiry_number, v.visit_date, 1
  FROM enquiry_visits v JOIN enquiries e ON e.id = v.enquiry_id
  WHERE v.created_by = ? AND date(v.created_at, '+330 minutes') BETWEEN ? AND ?
  ORDER BY visit_time ASC, kind_order ASC, id ASC`;

function visitsBetween(userId, from, to) {
  return db.prepare(VISITS_SQL).all(userId, from, to, userId, from, to);
}
const visitsForDay = (userId, date) => visitsBetween(userId, date, date);

// Check-in / check-out of that day (attendance), used as the route's start and end
function dayEnds(userId, date) {
  const a = db.prepare(`SELECT check_in_time, check_in_lat, check_in_lng, check_in_photo,
      check_out_time, check_out_lat, check_out_lng, check_out_photo FROM attendance WHERE user_id=? AND date=?`).get(userId, date);
  const pt = (lat, lng, time, photo) => {
    const la = lat == null ? NaN : Number(lat), lo = lng == null ? NaN : Number(lng);
    return validCoords(la, lo) ? { lat: la, lng: lo, time: isoTime(time), photo: photo || '' } : null;
  };
  return {
    start: a?.check_in_time ? pt(a.check_in_lat, a.check_in_lng, a.check_in_time, a.check_in_photo) : null,
    end:   a?.check_out_time ? pt(a.check_out_lat, a.check_out_lng, a.check_out_time, a.check_out_photo) : null,
    att:   a ? { checkIn: isoTime(a.check_in_time), checkOut: isoTime(a.check_out_time),
                 checkInGps: !!(a.check_in_time && a.check_in_lat != null), checkOutGps: !!(a.check_out_time && a.check_out_lat != null) } : null,
  };
}

// ── Road routing with cache ───────────────────────────────────────────────────
const keyPart = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const legKey  = (a, b) => `${keyPart(a)}|${keyPart(b)}`;

// All routing calls go through one queue, spaced MIN_GAP_MS apart, even across users
let queue = Promise.resolve(), lastCall = 0;
function osrmRoute(points) {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return osrmRequest(points);
  });
  queue = run.catch(() => {});
  return run;
}

async function osrmRequest(points) {
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM_URL}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'SuperAllied-RouteMap/1.0' } });
    if (r.status === 429) throw new Error('rate limited');
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes?.[0]) throw new Error(j.code || 'no route');
    // One leg per consecutive pair; join each leg's step geometries into one line ([lat,lng])
    return j.routes[0].legs.map(leg => ({
      distance_m: leg.distance, duration_s: leg.duration,
      geometry: leg.steps.flatMap(s => s.geometry.coordinates).map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]),
    }));
  } finally { clearTimeout(timer); }
}

const getCached = db.prepare('SELECT * FROM route_legs WHERE leg_key=?');
const putCached = db.prepare(`INSERT OR REPLACE INTO route_legs (leg_key, ok, distance_m, duration_s, geometry, provider, created_at)
                              VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`);

function cachedLeg(a, b) {
  const row = getCached.get(legKey(a, b));
  if (!row) return null;
  if (!row.ok) {
    const ageH = (Date.now() - new Date(row.created_at.replace(' ', 'T') + 'Z')) / 36e5;
    if (ageH >= FAIL_RETRY_H) return null;          // try again
    return { ok: false };
  }
  return { ok: true, distance_m: row.distance_m, duration_s: row.duration_s, geometry: JSON.parse(row.geometry) };
}

// Legs between consecutive points, in the given (chronological) order — never reordered.
// cacheOnly: don't call the routing service (used for multi-day summaries).
async function routeLegs(points, { cacheOnly = false } = {}) {
  const legs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (haversineM(a, b) < SAME_SPOT_M) legs.push({ ok: true, same: true, distance_m: 0, duration_s: 0, geometry: [[a.lat, a.lng], [b.lat, b.lng]] });
    else legs.push(cachedLeg(a, b));
  }
  if (cacheOnly) return legs;

  // Route runs of consecutive uncached legs in batches (a run of n legs = n+1 waypoints)
  let i = 0;
  while (i < legs.length) {
    if (legs[i]) { i++; continue; }
    let j = i;
    while (j < legs.length && !legs[j] && j - i < BATCH_POINTS - 1) j++;
    const pts = points.slice(i, j + 1);
    let result = null;
    try { result = await osrmRoute(pts); } catch (e) { console.error('OSRM batch failed:', e.message); }
    if (result && result.length === j - i) {
      result.forEach((leg, k) => {
        legs[i + k] = { ok: true, ...leg };
        putCached.run(legKey(points[i + k], points[i + k + 1]), 1, leg.distance_m, leg.duration_s, JSON.stringify(leg.geometry), 'osrm');
      });
    } else {
      // Batch failed: try each leg alone, so one bad leg doesn't hide the others
      for (let k = i; k < j; k++) {
        try {
          const [leg] = await osrmRoute([points[k], points[k + 1]]);
          legs[k] = { ok: true, ...leg };
          putCached.run(legKey(points[k], points[k + 1]), 1, leg.distance_m, leg.duration_s, JSON.stringify(leg.geometry), 'osrm');
        } catch (e) {
          legs[k] = { ok: false, error: e.message };
          putCached.run(legKey(points[k], points[k + 1]), 0, null, null, null, 'osrm');
        }
      }
    }
    i = j;
  }
  return legs;
}

// ── Pages & API ───────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (canUse(res)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'You do not have access to route maps.' });
  req.session.flash = { error: `You don't have permission to view route maps.` };
  res.redirect('/');
});

router.get('/', (req, res) => {
  const all = canViewAll(res);
  const employees = all
    ? db.prepare(`SELECT u.id, u.full_name, u.username,
                    (SELECT COUNT(*) FROM field_visits v WHERE v.user_id = u.id) AS visits
                  FROM users u WHERE u.is_hr_active = 1 ORDER BY (visits = 0), u.full_name`).all()
    : [];
  res.render('route-map', {
    title: 'Route Map', canViewAll: all, employees,
    selUser: all ? (parseInt(req.query.user, 10) || req.session.userId) : req.session.userId,
    selDate: isDate(req.query.date) ? req.query.date : todayIST(),
    from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '',
    today: todayIST(), osrmPublic: !process.env.OSRM_URL,
  });
});

// One DSE, one day: visits in recorded order + road legs between consecutive located visits
router.get('/api/day', async (req, res) => {
  const who = resolveUser(req, res);
  if (who.error === 403) return res.status(403).json({ error: 'You can only view your own route.' });
  if (who.error) return res.status(404).json({ error: 'Employee not found.' });
  if (!isDate(req.query.date)) return res.status(400).json({ error: 'Choose a valid date.' });

  const rows = visitsForDay(who.user.id, req.query.date);
  const visits = rows.map((v, i) => {
    const lat = v.lat == null ? NaN : Number(v.lat), lng = v.lng == null ? NaN : Number(v.lng);
    const ok = validCoords(lat, lng);
    return {
      seq: i + 1, id: v.id, kind: v.kind,
      visitNo: v.kind === 'site' ? `VIS-${String(v.id).padStart(5, '0')}` : `${v.enquiry_number} · visit ${v.id}`,
      enquiryId: v.enquiry_id, enteredDate: v.entered_date,
      customer: v.customer_name, contact: v.contact_person, phone: v.phone, purpose: v.purpose, remarks: v.remarks,
      time: isoTime(v.visit_time), address: v.address,
      lat: ok ? lat : null, lng: ok ? lng : null, accuracy: v.gps_accuracy,
      location: ok ? 'gps' : (v.lat != null || v.lng != null ? 'invalid' : (v.location_status || 'missing')),
    };
  });

  // The day's route: check-in location → visits (chronological, valid GPS only) → check-out location
  const ends = dayEnds(who.user.id, req.query.date);
  const located = visits.filter(v => v.lat != null);
  const stops = [
    ...(ends.start ? [{ key: 'start', lat: ends.start.lat, lng: ends.start.lng }] : []),
    ...located.map(v => ({ key: v.seq, lat: v.lat, lng: v.lng })),
    ...(ends.end ? [{ key: 'end', lat: ends.end.lat, lng: ends.end.lng }] : []),
  ];
  let legs = [];
  try {
    legs = await routeLegs(stops);
  } catch (e) {
    console.error('Route map routing error:', e);
    legs = stops.slice(1).map(() => ({ ok: false, error: 'routing error' }));
  }
  const legOut = legs.map((l, i) => ({
    from: stops[i].key, to: stops[i + 1].key,
    a: [stops[i].lat, stops[i].lng], b: [stops[i + 1].lat, stops[i + 1].lng],
    ok: !!l?.ok, same: !!l?.same,
    km: l?.ok ? Math.round(l.distance_m / 10) / 100 : null,
    minutes: l?.ok ? Math.round(l.duration_s / 60) : null,
    geometry: l?.ok ? l.geometry : null,
  }));
  const okLegs = legOut.filter(l => l.ok);

  res.json({
    user: { id: who.user.id, name: who.user.full_name || who.user.username },
    date: req.query.date,
    visits, legs: legOut, checkIn: ends.start, checkOut: ends.end, attendance: ends.att,
    summary: {
      total: visits.length, located: located.length, missing: visits.length - located.length, stops: stops.length,
      routeKm: Math.round(okLegs.reduce((t, l) => t + l.km, 0) * 100) / 100,
      legsOk: okLegs.length, legsFailed: legOut.length - okLegs.length,
      first: visits[0]?.time || null, last: visits[visits.length - 1]?.time || null,
    },
  });
});

// One DSE, date range: per-day totals (distance only from already-routed legs, no new routing calls)
router.get('/api/range', async (req, res) => {
  const who = resolveUser(req, res);
  if (who.error === 403) return res.status(403).json({ error: 'You can only view your own route.' });
  if (who.error) return res.status(404).json({ error: 'Employee not found.' });
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: 'Choose a valid start and end date.' });
  const span = (new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5 + 1;
  if (span > MAX_RANGE_DAYS) return res.status(400).json({ error: `Choose a range of at most ${MAX_RANGE_DAYS} days.` });

  const rows = visitsBetween(who.user.id, from, to);
  const byDay = new Map();
  rows.forEach(r => {
    const day = new Date(isoTime(r.visit_time)).toLocaleDateString('en-CA');   // India date
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  });

  const days = [];
  for (const [day, list] of byDay) {
    const located = list.map(v => ({ lat: Number(v.lat), lng: Number(v.lng) })).filter(p => validCoords(p.lat, p.lng));
    const e = dayEnds(who.user.id, day);
    const stops = [...(e.start ? [e.start] : []), ...located, ...(e.end ? [e.end] : [])];
    const legs = await routeLegs(stops, { cacheOnly: true });
    const known = legs.every(l => l && l.ok);
    days.push({
      date: day, visits: list.length, located: located.length, enquiry: list.filter(v => v.kind === 'enquiry').length,
      first: isoTime(list[0].visit_time), last: isoTime(list[list.length - 1].visit_time),
      routeKm: known ? Math.round(legs.reduce((t, l) => t + l.distance_m, 0) / 10) / 100 : null,
    });
  }
  res.json({ user: { id: who.user.id, name: who.user.full_name || who.user.username }, from, to, days });
});

module.exports = router;
