const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');
const XLSX = require('xlsx');

const PAGE_SIZE = 50;
const isAdmin = (res) => res.locals.user?.role === 'admin';
function adminOnly(req, res, next) {
  if (isAdmin(res)) return next();
  req.session.flash = { error: 'Only the admin can do this.' };
  res.redirect('/databank');
}

// First valid 10-digit Indian mobile in the value (drops +91 / leading 0), else ''
function cleanPhone(v) {
  for (const chunk of String(v ?? '').split(/[\/,;&\n]| {2,}/)) {
    let d = chunk.replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
    if (/^[6-9]\d{9}$/.test(d) && new Set(d).size > 2) return d;
  }
  return '';
}

const villageOf  = (loc) => String(loc || '').split(',')[0].trim().replace(/\s+/g, ' ')
  .toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const searchText = (r) => [r.phone, r.name, r.location, r.district, r.last_remark].join(' ').toLowerCase();
const { todayIST } = require('../lib/dates');

// Builds the WHERE clause shared by the list, counts and export
function filters(qs) {
  const where = ['1=1'], params = [];
  // every word must match somewhere: "rahul sardhana", "9837", "brick field"
  (qs.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach(t => {
    where.push('search_text LIKE ?'); params.push(`%${t}%`);
  });
  if (qs.district === 'Unmapped') where.push("district = ''");
  else if (qs.district) { where.push('district = ?'); params.push(qs.district); }
  if (qs.village)  { where.push('village = ? COLLATE NOCASE'); params.push(qs.village); }
  if (qs.remark === 'with')    where.push("last_remark <> '' AND last_remark NOT LIKE 'Machine:%'");
  if (qs.remark === 'none')    where.push("(last_remark = '' OR last_remark LIKE 'Machine:%')");
  if (qs.remark === 'machine') where.push("last_remark LIKE '%Machine:%'");
  if (qs.remark === 'mine')    where.push('remark_at IS NOT NULL');
  // Bull CRM enquiry stage: "any" = has enquired at all; else an exact stage
  if (qs.stage === 'any')      where.push("IFNULL(bull_stage,'') <> ''");
  else if (qs.stage === 'none') where.push("IFNULL(bull_stage,'') = ''");
  else if (qs.stage)           { where.push('bull_stage = ?'); params.push(qs.stage); }
  return { sql: where.join(' AND '), params };
}

// ── Area overview + search ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const qs   = { q: (req.query.q || '').trim(), district: req.query.district || '', village: req.query.village || '', remark: req.query.remark || '', stage: req.query.stage || '' };
  const sort = { name: 'name COLLATE NOCASE', recent: 'COALESCE(remark_at, last_activity) DESC, name COLLATE NOCASE' }[req.query.sort]
    || 'village COLLATE NOCASE, name COLLATE NOCASE';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const f    = filters(qs);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM databank WHERE ${f.sql}`).get(...f.params).c;
  const rows  = db.prepare(`SELECT id, phone, name, location, district, last_remark, remark_at, last_activity
    FROM databank WHERE ${f.sql} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...f.params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  // District cards: counts follow the search text / remark filter, not the chosen area
  const fa = filters({ q: qs.q, remark: qs.remark, stage: qs.stage });
  const districts = db.prepare(`SELECT COALESCE(NULLIF(district,''),'Unmapped') AS district, COUNT(*) AS c
    FROM databank WHERE ${fa.sql} GROUP BY 1 ORDER BY (district='' OR district='Unmapped'), c DESC`).all(...fa.params);
  const villages = qs.district
    ? db.prepare(`SELECT village, COUNT(*) AS c FROM databank WHERE ${filters({ ...qs, village: '' }).sql}
        AND village <> '' GROUP BY village COLLATE NOCASE ORDER BY c DESC, village LIMIT 300`)
        .all(...filters({ ...qs, village: '' }).params)
    : [];
  const grand = db.prepare('SELECT COUNT(*) AS c FROM databank').get().c;

  res.render('databank/index', {
    title: 'Databank', rows, total, grand, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    qs, sort: req.query.sort || '', districts, villages, isAdmin: isAdmin(res),
  });
});

// ── Phone lookup (JSON) — exact 10-digit match ────────────────────────────────
router.get('/lookup', (req, res) => {
  const phone = cleanPhone(req.query.phone);
  if (!phone) return res.json({ found: false });
  const r = db.prepare('SELECT id, phone, name, location, village, district, last_remark FROM databank WHERE phone=?').get(phone);
  res.json(r ? { found: true, ...r } : { found: false });
});

// ── Admin: who can open the databank ──────────────────────────────────────────
router.get('/access', adminOnly, (req, res) => {
  const users = db.prepare(`SELECT id, username, full_name, role, databank_access, is_hr_active
    FROM users WHERE role <> 'admin' ORDER BY is_hr_active DESC, full_name COLLATE NOCASE`).all();
  res.render('databank/access', { title: 'Databank Access', users });
});

router.post('/access', adminOnly, (req, res) => {
  const allowed = new Set([].concat(req.body.allow || []).map(Number));
  const users = db.prepare("SELECT id, username, full_name, databank_access FROM users WHERE role <> 'admin'").all();
  const set = db.prepare('UPDATE users SET databank_access=? WHERE id=?');
  const changed = [];
  users.forEach(u => {
    const v = allowed.has(u.id) ? 1 : 0;
    if ((u.databank_access || 0) !== v) { set.run(v, u.id); changed.push(`${v ? '+' : '-'}${u.full_name || u.username}`); }
  });
  if (changed.length) auditLog(req.session.userId, 'DATABANK_ACCESS', 'users', '', changed.join(', '));
  req.session.flash = { success: changed.length ? `Access updated for ${changed.length} user(s).` : 'No changes.' };
  res.redirect('/databank/access');
});

// ── Admin: Excel / CSV import (upsert on phone) ───────────────────────────────
router.post('/import', adminOnly, (req, res) => {
  try {
    if (!req.body.data) return res.json({ ok: false, error: 'No file received.' });
    const wb = XLSX.read(Buffer.from(req.body.data, 'base64'), { type: 'buffer', cellDates: true });
    const sheet = wb.SheetNames.find(n => n.toLowerCase() === 'databank') || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '', raw: false });
    const pick = (row, ...names) => {
      const key = Object.keys(row).find(k => names.includes(k.trim().toLowerCase()));
      return key ? String(row[key]).trim() : '';
    };

    const toISO = (v) => (String(v ?? '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
    const get = db.prepare('SELECT * FROM databank WHERE phone=?');
    const ins = db.prepare(`INSERT INTO databank
      (phone,name,location,village,district,last_remark,data_source,last_activity,
       machine_interested,bull_stage,bull_status,lead_source,enquiry_count,first_seen,search_text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE databank SET name=?, location=?, village=?, district=?, last_remark=?, data_source=?,
      last_activity=?, machine_interested=?, bull_stage=?, bull_status=?, lead_source=?, enquiry_count=?, first_seen=?,
      search_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
    let inserted = 0, updated = 0, skipped = 0;

    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const phone = cleanPhone(pick(row, 'phone', 'mobile', 'mobile no', 'phone number', 'contact no', 'contact number'));
        if (!phone) { skipped++; continue; }
        const n = {
          phone,
          name:          pick(row, 'name', 'customer name'),
          location:      pick(row, 'location', 'village', 'address'),
          district:      pick(row, 'area (district)', 'district', 'area'),
          last_remark:   pick(row, 'last remark', 'remark', 'remarks'),
          data_source:   pick(row, 'data source', 'source') || `Import ${todayIST()}`,
          last_activity: toISO(pick(row, 'last activity', 'date')),
          machine:       pick(row, 'machine interested', 'machine', 'machine model', 'product', 'productgroup'),
          stage:         pick(row, 'bull stage', 'stage', 'enquiry stage'),
          status:        pick(row, 'bull status', 'status', 'enquiry status'),
          source_name:   pick(row, 'lead source', 'leadsource'),
          enq_count:     parseInt(pick(row, 'enquiry count', 'leads', 'enquiries')) || 0,
          first_seen:    toISO(pick(row, 'first seen', 'first contact', 'first enquiry date')),
        };
        if (n.district === 'Unmapped') n.district = '';
        const e = get.get(phone);
        if (!e) {
          ins.run(n.phone, n.name, n.location, villageOf(n.location), n.district, n.last_remark, n.data_source,
                  n.last_activity, n.machine, n.stage, n.status, n.source_name, n.enq_count, n.first_seen, searchText(n));
          inserted++; continue;
        }
        // Existing record: fill gaps, merge sources; a remark added in the app is never overwritten
        const m = {
          ...e,
          name:        n.name || e.name,
          location:    n.location || e.location,
          district:    n.district || e.district,
          last_remark: e.remark_at ? e.last_remark : (n.last_remark || e.last_remark),
          data_source: [...new Set([...e.data_source.split('; '), ...n.data_source.split('; ')].filter(Boolean))].join('; '),
          last_activity: [e.last_activity, n.last_activity].filter(Boolean).sort().pop() || null,
          machine_interested: n.machine || e.machine_interested || '',
          bull_stage:  n.stage  || e.bull_stage  || '',
          bull_status: n.status || e.bull_status || '',
          lead_source: n.source_name || e.lead_source || '',
          enquiry_count: Math.max(n.enq_count, e.enquiry_count || 0),
          first_seen:  [e.first_seen, n.first_seen].filter(Boolean).sort()[0] || null,
        };
        upd.run(m.name, m.location, villageOf(m.location), m.district, m.last_remark, m.data_source,
                m.last_activity, m.machine_interested, m.bull_stage, m.bull_status, m.lead_source,
                m.enquiry_count, m.first_seen, searchText(m), e.id);
        updated++;
      }

      // ── Follow-up history sheet → databank_remarks (dated, source-tagged) ──────
      // Optional second sheet; each row is one call/visit for a phone. Re-import
      // safe: a phone + date + remark already present is skipped, not duplicated.
      let remarksAdded = 0, remarksSkipped = 0;
      const fuName = wb.SheetNames.find(n => /follow|history|timeline|remark/i.test(n));
      if (fuName && fuName !== sheet) {
        const fuRows = XLSX.utils.sheet_to_json(wb.Sheets[fuName], { defval: '', raw: false });
        const idOf  = db.prepare('SELECT id FROM databank WHERE phone=?');
        const exists = db.prepare('SELECT 1 FROM databank_remarks WHERE databank_id=? AND IFNULL(activity_date,\'\')=? AND remark=?');
        const insR  = db.prepare(`INSERT INTO databank_remarks (databank_id, remark, created_by, created_at, source, activity_date)
          VALUES (?,?,?,?,?,?)`);
        for (const row of fuRows) {
          const phone = cleanPhone(pick(row, 'phone', 'mobile', 'mobile no', 'contact no'));
          if (!phone) { remarksSkipped++; continue; }
          const rec = idOf.get(phone);
          if (!rec) { remarksSkipped++; continue; }
          const date = toISO(pick(row, 'activity date', 'date', 'followup date', 'salescall date', 'enquiry date'));
          const type = pick(row, 'type');
          const body = pick(row, 'remark', 'remarks', 'notes');
          const stage = pick(row, 'stage / outcome', 'stage', 'outcome');
          const remark = [type && `[${type}]`, stage && stage !== type && `(${stage})`, body].filter(Boolean).join(' ').trim();
          if (!remark) { remarksSkipped++; continue; }
          const src = pick(row, 'source') || 'Bull CRM Enquiry';
          if (exists.get(rec.id, date || '', remark)) { remarksSkipped++; continue; }
          insR.run(rec.id, remark, req.session.userId, (date ? date + ' 00:00:00' : todayIST()), src, date);
          remarksAdded++;
        }
      }
      db.exec('COMMIT');

      auditLog(req.session.userId, 'DATABANK_IMPORT', 'databank', '',
        `inserted=${inserted} updated=${updated} skipped=${skipped} remarks=${remarksAdded}/${remarksSkipped}`);
      return res.json({ ok: true, inserted, updated, skipped, remarksAdded, remarksSkipped });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Admin: export current filter as CSV ───────────────────────────────────────
router.get('/export', adminOnly, (req, res) => {
  const f = filters(req.query);
  const rows = db.prepare(`SELECT phone, name, location, district, last_remark, data_source, last_activity
    FROM databank WHERE ${f.sql} ORDER BY district, village, name`).all(...f.params);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Phone', 'Name', 'Location', 'District', 'Last Remark', 'Data Source', 'Last Activity'].join(','),
    ...rows.map(r => [r.phone, r.name, r.location, r.district, r.last_remark, r.data_source, r.last_activity].map(esc).join(','))].join('\n');
  auditLog(req.session.userId, 'DATABANK_EXPORT', 'databank', '', `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="databank-${todayIST()}.csv"`);
  res.send('﻿' + csv);
});

// ── Customer card ─────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM databank WHERE id=?').get(req.params.id);
  if (!r) return res.redirect('/databank');
  const history = db.prepare(`SELECT dr.*, u.full_name, u.username FROM databank_remarks dr
    LEFT JOIN users u ON u.id = dr.created_by WHERE dr.databank_id=?
    ORDER BY COALESCE(dr.activity_date, dr.created_at) DESC, dr.id DESC`).all(r.id);
  const enquiries = db.prepare('SELECT id, enquiry_number, current_stage, status FROM enquiries WHERE phone=? ORDER BY created_at DESC LIMIT 5').all(r.phone);
  res.render('databank/detail', { title: r.name || r.phone, r, history, enquiries, back: req.query.back || '/databank' });
});

// ── Add a call / visit remark ─────────────────────────────────────────────────
router.post('/:id/remark', (req, res) => {
  const r = db.prepare('SELECT * FROM databank WHERE id=?').get(req.params.id);
  const remark = (req.body.remark || '').trim().slice(0, 1000);
  if (!r) return res.redirect('/databank');
  if (!remark) { req.session.flash = { error: 'Write a remark first.' }; return res.redirect(`/databank/${r.id}`); }
  db.prepare('INSERT INTO databank_remarks (databank_id, remark, created_by) VALUES (?,?,?)').run(r.id, remark, req.session.userId);
  const m = { ...r, last_remark: remark };
  db.prepare(`UPDATE databank SET last_remark=?, remark_by=?, remark_at=CURRENT_TIMESTAMP, last_activity=?, search_text=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(remark, req.session.userId, todayIST(), searchText(m), r.id);
  req.session.flash = { success: 'Remark saved.' };
  const back = String(req.body.back || '');
  res.redirect(`/databank/${r.id}` + (back.startsWith('/databank') ? `?back=${encodeURIComponent(back)}` : ''));
});

module.exports = router;
