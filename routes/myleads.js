const express = require('express');
const router  = express.Router();
const { db, createNotification, auditLog } = require('../db');

const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const nowIST   = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const canSeeAll = (res) => ['admin', 'manager'].includes(res.locals.user?.role);

// Scope: a salesperson sees only their own assigned leads; admin/manager see all.
function scope(res) {
  return canSeeAll(res) ? { sql: '1=1', params: [] } : { sql: 'e.assigned_to = ?', params: [res.locals.user.id] };
}

function loadLeadOrDeny(req, res) {
  const lead = db.prepare(`SELECT e.*, u.full_name AS assignee_name, tc.full_name AS telecaller_name
    FROM enquiries e LEFT JOIN users u ON u.id=e.assigned_to LEFT JOIN users tc ON tc.id=e.telecaller_id
    WHERE e.id=?`).get(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; res.redirect('/my-leads'); return null; }
  if (!canSeeAll(res) && lead.assigned_to !== res.locals.user.id) {
    req.session.flash = { error: 'This lead is not assigned to you.' }; res.redirect('/my-leads'); return null;
  }
  return lead;
}

// ── Dashboard + filtered list ─────────────────────────────────────────────────
router.get('/', (req, res) => {
  const s = scope(res), t = todayIST();
  const base = `FROM enquiries e WHERE ${s.sql}`;
  const one = (extra, ...p) => db.prepare(`SELECT COUNT(DISTINCT e.id) c ${base} ${extra}`).get(...s.params, ...p).c;

  const notContacted = `AND NOT EXISTS (SELECT 1 FROM call_logs cl WHERE cl.enquiry_id=e.id AND cl.call_role='salesperson')`;
  const dueSub = `AND (SELECT MAX(next_followup_date) FROM enquiry_followups f WHERE f.enquiry_id=e.id) <= ?`;
  const meetingSub = `AND EXISTS (SELECT 1 FROM enquiry_visits v WHERE v.enquiry_id=e.id AND v.visit_date >= ?)`;

  const cards = {
    newLeads:   one(`AND e.status='active' ${notContacted}`),
    hotLeads:   one(`AND e.status='active' AND e.interest_class='HOT'`),
    callsPending: one(`AND e.status='active' ${notContacted}`),
    meetings:   one(`AND e.status='active' ${meetingSub}`, t),
    followupsDue: one(`AND e.status='active' ${dueSub}`, t),
    converted:  one(`AND e.status='won'`),
  };

  const f = req.query.f || 'new';
  const filters = {
    new:          `AND e.status='active' ${notContacted}`,
    today:        `AND date(COALESCE(e.qualified_at,e.created_at),'+330 minutes')='${t}'`,
    hot:          `AND e.status='active' AND e.interest_class='HOT'`,
    warm:         `AND e.status='active' AND e.interest_class='WARM'`,
    followup_due: `AND e.status='active' ${dueSub.replace('?', `'${t}'`)}`,
    meeting:      `AND e.status='active' ${meetingSub.replace('?', `'${t}'`)}`,
    closed:       `AND e.status IN ('won','lost')`,
  };
  const where = filters[f] || filters.new;
  const leads = db.prepare(`SELECT e.*, tc.full_name AS telecaller_name,
      (SELECT MAX(next_followup_date) FROM enquiry_followups ef WHERE ef.enquiry_id=e.id) AS next_followup,
      (SELECT notes FROM enquiry_followups ef WHERE ef.enquiry_id=e.id ORDER BY ef.created_at DESC LIMIT 1) AS last_note,
      (SELECT MAX(called_at) FROM call_logs cl WHERE cl.enquiry_id=e.id) AS last_call
    FROM enquiries e LEFT JOIN users tc ON tc.id=e.telecaller_id
    WHERE ${s.sql} ${where} ORDER BY (e.interest_class='HOT') DESC, e.updated_at DESC LIMIT 100`).all(...s.params);

  res.render('myleads/dashboard', { title: 'My Leads', cards, leads, f, canSeeAll: canSeeAll(res) });
});

// ── Lead detail ───────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  const calls = db.prepare(`SELECT cl.*, u.full_name FROM call_logs cl LEFT JOIN users u ON u.id=cl.user_id WHERE cl.enquiry_id=? ORDER BY cl.called_at DESC LIMIT 15`).all(lead.id);
  const followups = db.prepare('SELECT * FROM enquiry_followups WHERE enquiry_id=? ORDER BY created_at DESC LIMIT 10').all(lead.id);
  const visits = db.prepare('SELECT * FROM enquiry_visits WHERE enquiry_id=? ORDER BY created_at DESC LIMIT 10').all(lead.id);
  const remarks = db.prepare('SELECT r.*, u.full_name FROM enquiry_remarks r LEFT JOIN users u ON u.id=r.created_by WHERE r.enquiry_id=? ORDER BY r.created_at DESC LIMIT 15').all(lead.id);
  const activity = db.prepare('SELECT a.*, u.full_name FROM lead_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.enquiry_id=? ORDER BY a.created_at DESC LIMIT 30').all(lead.id);
  res.render('myleads/detail', { title: lead.customer_name || 'Lead', lead, calls, followups, visits, remarks, activity, canSeeAll: canSeeAll(res) });
});

// ── Mark as contacted (logs a salesperson call attempt) ───────────────────────
router.post('/:id/contacted', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  db.prepare(`INSERT INTO call_logs (enquiry_id,user_id,call_role,outcome,notes,called_at) VALUES (?,?, 'salesperson', ?, ?, ?)`)
    .run(lead.id, res.locals.user.id, (req.body.outcome || 'Connected'), (req.body.notes || '').slice(0, 1000), nowIST());
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,prev_status,new_status,remarks) VALUES (?,?, 'CONTACTED', ?, ?, ?)`)
    .run(lead.id, res.locals.user.id, lead.status, lead.status, (req.body.notes || 'Marked contacted'));
  db.prepare("UPDATE enquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lead.id);
  req.session.flash = { success: 'Marked as contacted.' };
  res.redirect(`/my-leads/${lead.id}`);
});

// ── Add remark (append-only; never erases telecaller data) ────────────────────
router.post('/:id/remark', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  const body = (req.body.body || '').trim();
  if (!body) { req.session.flash = { error: 'Remark cannot be empty.' }; return res.redirect(`/my-leads/${lead.id}`); }
  db.prepare('INSERT INTO enquiry_remarks (enquiry_id, body, created_by) VALUES (?,?,?)').run(lead.id, body, res.locals.user.id);
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,remarks) VALUES (?,?, 'REMARK', ?)`).run(lead.id, res.locals.user.id, body);
  db.prepare("UPDATE enquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lead.id);
  req.session.flash = { success: 'Remark added.' };
  res.redirect(`/my-leads/${lead.id}`);
});

// ── Schedule / record a meeting or demo ───────────────────────────────────────
router.post('/:id/meeting', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  const b = req.body;
  const isDemo = b.demo_given === '1' || b.demo_given === 'on';
  db.prepare(`INSERT INTO enquiry_visits (enquiry_id, visit_date, visit_location, purpose, demo_given, outcome, created_by)
    VALUES (?,?,?,?,?,?,?)`).run(lead.id, (b.visit_date || null), (b.visit_location || '').trim(),
      (b.purpose || 'Meeting').trim(), isDemo ? 1 : 0, (b.outcome || '').trim(), res.locals.user.id);
  // Optional: expected purchase date + next follow-up on the enquiry
  const fields = [], vals = [];
  if ((b.expected_purchase_date || '').match(/^\d{4}-\d{2}-\d{2}$/)) { fields.push('expected_purchase_date=?'); vals.push(b.expected_purchase_date); }
  if ((b.finance_mode || '').trim()) { fields.push('finance_mode=?'); vals.push(b.finance_mode.trim()); }
  // Advance the stage to at least "sales_visit"
  db.prepare("UPDATE enquiries SET current_stage=CASE WHEN current_stage='phone_followup' THEN 'sales_visit' ELSE current_stage END"
    + (fields.length ? ', ' + fields.join(', ') : '') + ", updated_at=CURRENT_TIMESTAMP WHERE id=?").run(...vals, lead.id);
  if ((b.next_followup_date || '').match(/^\d{4}-\d{2}-\d{2}$/)) {
    db.prepare(`INSERT INTO enquiry_followups (enquiry_id,next_followup_date,call_status,notes,created_by) VALUES (?,?,?,?,?)`)
      .run(lead.id, b.next_followup_date, 'Interested', (b.outcome || 'Meeting scheduled'), res.locals.user.id);
  }
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,remarks) VALUES (?,?,?,?)`)
    .run(lead.id, res.locals.user.id, isDemo ? 'DEMO' : 'MEETING', `${isDemo ? 'Demo' : 'Meeting'}: ${(b.outcome || b.visit_location || '').trim()}`);
  auditLog(res.locals.user.id, isDemo ? 'LEAD_DEMO' : 'LEAD_MEETING', 'enquiries', lead.id, lead.enquiry_number);
  req.session.flash = { success: isDemo ? 'Demo recorded.' : 'Meeting recorded.' };
  res.redirect(`/my-leads/${lead.id}`);
});

// ── Change status (active / won / lost) ───────────────────────────────────────
router.post('/:id/status', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  const next = ['active', 'won', 'lost'].includes(req.body.status) ? req.body.status : lead.status;
  const stage = next === 'won' ? 'sales_closed' : lead.current_stage;
  db.prepare("UPDATE enquiries SET status=?, current_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(next, stage, lead.id);
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,prev_status,new_status,remarks) VALUES (?,?, 'STATUS', ?, ?, ?)`)
    .run(lead.id, res.locals.user.id, lead.status, next, (req.body.notes || '').trim());
  auditLog(res.locals.user.id, 'LEAD_STATUS', 'enquiries', lead.id, `${lead.enquiry_number}: ${lead.status}→${next}`);
  req.session.flash = { success: `Status updated to ${next}.` };
  res.redirect(`/my-leads/${lead.id}`);
});

// ── Request reassignment (does not change the owner; notifies admins/managers) ─
router.post('/:id/reassign-request', (req, res) => {
  const lead = loadLeadOrDeny(req, res);
  if (!lead) return;
  const reason = (req.body.reason || '').trim() || 'No reason given';
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,remarks) VALUES (?,?, 'REASSIGN_REQUEST', ?)`)
    .run(lead.id, res.locals.user.id, reason);
  db.prepare("SELECT id FROM users WHERE role IN ('admin','manager')").all().forEach(a =>
    createNotification(a.id, 'Reassignment requested',
      `${res.locals.user.full_name || res.locals.user.username} asks to reassign ${lead.customer_name} (${lead.enquiry_number}): ${reason}`,
      'warning', `/telecaller/call/${lead.id}`));
  auditLog(res.locals.user.id, 'LEAD_REASSIGN_REQUEST', 'enquiries', lead.id, lead.enquiry_number);
  req.session.flash = { success: 'Reassignment requested. An admin will review it.' };
  res.redirect(`/my-leads/${lead.id}`);
});

module.exports = router;
