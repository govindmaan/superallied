const express = require('express');
const router  = express.Router();
const {
  db, createNotification, auditLog, getSettings,
  nextEnquiryNumber, routeLeadByDistrict,
} = require('../db');

// ── Helpers ───────────────────────────────────────────────────────────────────
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const nowIST   = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
const isAdminMgr = (res) => ['admin', 'manager'].includes(res.locals.user?.role);

const INTEREST = ['HOT', 'WARM', 'COLD', 'NOT_INTERESTED', 'NOT_REACHABLE', 'WRONG_NUMBER', 'ALREADY_PURCHASED'];
const OUTCOMES = ['Connected', 'Not Reachable', 'Busy', 'Switched Off', 'Wrong Number', 'Call Back Later'];

// First valid 10-digit Indian mobile (drops +91 / leading 0), else ''
function cleanPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

// The telecaller work pool: active leads not yet forwarded to a salesperson.
const POOL = "status='active' AND assigned_to IS NULL";

function adminOnly(req, res, next) {
  if (res.locals.hasPerm && res.locals.hasPerm('telecaller_admin')) return next();
  req.session.flash = { error: 'Only an administrator can manage telecaller settings.' };
  res.redirect('/telecaller');
}

function territoryOf(district) {
  if (!district) return null;
  return db.prepare(`SELECT t.* FROM territory_districts td JOIN territories t ON t.id=td.territory_id
    WHERE td.district = ? COLLATE NOCASE`).get(String(district).trim());
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid = res.locals.user.id;
  const t = todayIST();
  const stats = {
    enteredToday:  db.prepare(`SELECT COUNT(*) c FROM enquiries WHERE telecaller_id=? AND date(created_at,'+330 minutes')=?`).get(uid, t).c,
    pendingCalls:  db.prepare(`SELECT COUNT(*) c FROM enquiries WHERE ${POOL} AND (interest_class='' OR first_call_at IS NULL)`).get().c,
    contactedToday:db.prepare(`SELECT COUNT(DISTINCT enquiry_id) c FROM call_logs WHERE user_id=? AND outcome='Connected' AND date(called_at,'+330 minutes')=?`).get(uid, t).c,
    hotLeads:      db.prepare(`SELECT COUNT(*) c FROM enquiries WHERE interest_class='HOT' AND date(qualified_at,'+330 minutes')=?`).get(t).c,
    followupsDue:  db.prepare(`SELECT COUNT(DISTINCT e.id) c FROM enquiries e JOIN enquiry_followups f ON f.enquiry_id=e.id
                     WHERE ${POOL.replace(/status/g,'e.status').replace('assigned_to','e.assigned_to')} AND f.next_followup_date <= ?`).get(t).c,
    forwardedToday:db.prepare(`SELECT COUNT(*) c FROM lead_activity WHERE user_id=? AND activity_type='FORWARDED' AND date(created_at,'+330 minutes')=?`).get(uid, t).c,
  };
  res.render('telecaller/dashboard', { title: 'Telecaller', stats, isAdminMgr: isAdminMgr(res) });
});

// ── Next lead in the calling queue (priority order) ───────────────────────────
function nextLeadId() {
  const t = todayIST();
  const pick = db.prepare(`
    SELECT e.id,
      CASE
        WHEN e.interest_class='HOT' THEN 0
        WHEN e.interest_class='' AND e.first_call_at IS NULL THEN 1
        WHEN fu.due IS NOT NULL AND fu.due <= ? THEN 2
        ELSE 3
      END AS bucket
    FROM enquiries e
    LEFT JOIN (SELECT enquiry_id, MAX(next_followup_date) due FROM enquiry_followups GROUP BY enquiry_id) fu ON fu.enquiry_id=e.id
    WHERE ${POOL}
    ORDER BY bucket, COALESCE(fu.due, date(e.created_at,'+330 minutes')), e.created_at
    LIMIT 1`).get(t);
  return pick ? pick.id : null;
}

router.get('/queue', (req, res) => {
  const id = nextLeadId();
  if (!id) { req.session.flash = { success: 'No pending calls in the queue right now.' }; return res.redirect('/telecaller'); }
  res.redirect(`/telecaller/call/${id}`);
});

// ── New enquiry entry (telecaller) ────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('telecaller/new', { title: 'New Enquiry' });
});

router.post('/new', (req, res) => {
  const b = req.body;
  const name = (b.customer_name || '').trim();
  const phone = cleanPhone(b.phone);
  if (!name || !phone) { req.session.flash = { error: 'Customer name and a valid 10-digit mobile are required.' }; return res.redirect('/telecaller/new'); }
  const enquiryNumber = nextEnquiryNumber();
  const info = db.prepare(`INSERT INTO enquiries
    (enquiry_number, customer_name, phone, alt_phone, village_city, location, district, state,
     machine_interested, lead_source, telecaller_id, created_by, current_stage, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'phone_followup', 'active')`)
    .run(enquiryNumber, name, phone, cleanPhone(b.alt_phone), (b.village_city || '').trim(), (b.village_city || '').trim(),
      (b.district || '').trim(), (b.state || '').trim(), (b.machine_interested || '').trim(),
      (b.lead_source || 'Telecaller').trim(), res.locals.user.id, res.locals.user.id);
  const id = Number(info.lastInsertRowid);
  auditLog(res.locals.user.id, 'ENQUIRY_CREATED', 'enquiries', id, `${enquiryNumber} — ${name} (telecaller)`);
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,new_status,remarks) VALUES (?,?,?,?,?)`)
    .run(id, res.locals.user.id, 'ENTERED', 'active', `Entered by telecaller: ${name}`);
  req.session.flash = { success: 'Enquiry saved. Opening the calling screen…' };
  res.redirect(`/telecaller/call/${id}`);
});

// ── Calling screen ────────────────────────────────────────────────────────────
function loadLead(id) {
  return db.prepare(`SELECT e.*, u.full_name AS assignee_name FROM enquiries e
    LEFT JOIN users u ON u.id=e.assigned_to WHERE e.id=?`).get(id);
}

router.get('/call/:id', (req, res) => {
  const lead = loadLead(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; return res.redirect('/telecaller'); }
  const calls = db.prepare(`SELECT cl.*, u.full_name FROM call_logs cl LEFT JOIN users u ON u.id=cl.user_id
    WHERE cl.enquiry_id=? ORDER BY cl.called_at DESC LIMIT 20`).all(lead.id);
  const followups = db.prepare(`SELECT * FROM enquiry_followups WHERE enquiry_id=? ORDER BY created_at DESC LIMIT 10`).all(lead.id);
  const s = getSettings();
  let script = [];
  try { script = JSON.parse(s.tc_script || '[]'); } catch (e) { script = []; }
  const pitches = {
    filtering: s.tc_pitch_filtering || '',
    closing:   s.tc_pitch_closing || '',
    bull:      s.tc_pitch_bull_promise || '',
  };
  const waText = (s.tc_wa_customer_template || '').replace('{name}', lead.customer_name);
  const terr = territoryOf(lead.district);
  res.render('telecaller/call', {
    title: lead.customer_name || 'Call', lead, calls, followups, script, pitches, waText,
    INTEREST, OUTCOMES, terr, isAdminMgr: isAdminMgr(res),
    idemToken: `${lead.id}-${Date.now()}`,
  });
});

// ── Log a call attempt (timestamped; attempts ≠ unique contacted) ─────────────
router.post('/call/:id/log', (req, res) => {
  const lead = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!lead) return res.json({ ok: false, error: 'Lead not found.' });
  const outcome = OUTCOMES.includes(req.body.outcome) ? req.body.outcome : 'Connected';
  db.prepare(`INSERT INTO call_logs (enquiry_id,user_id,call_role,outcome,notes,called_at)
    VALUES (?,?, 'telecaller', ?, ?, ?)`).run(lead.id, res.locals.user.id, outcome, (req.body.notes || '').slice(0, 1000), nowIST());
  if (!lead.first_call_at) db.prepare("UPDATE enquiries SET first_call_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(nowIST(), lead.id);
  res.json({ ok: true });
});

// ── Save disposition / qualification ──────────────────────────────────────────
router.post('/call/:id/dispose', (req, res) => {
  const b = req.body;
  const lead = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; return res.redirect('/telecaller'); }

  // Already forwarded → only an admin/manager may change it (no silent re-assign)
  if (lead.assigned_to && !isAdminMgr(res)) {
    req.session.flash = { error: `This lead is already forwarded to ${loadLead(lead.id).assignee_name || 'a salesperson'}.` };
    return res.redirect(`/telecaller/call/${lead.id}`);
  }

  const interest = INTEREST.includes(b.interest_class) ? b.interest_class : 'COLD';
  const remarks  = (b.remarks || '').trim();
  if (!remarks) { req.session.flash = { error: 'Customer remarks are required.' }; return res.redirect(`/telecaller/call/${lead.id}`); }

  const machine  = (b.machine_interested || lead.machine_interested || '').trim();
  const timeline = (b.purchase_timeline || '').trim();
  const district = (b.district || lead.district || '').trim();

  // A HOT lead must be a real opportunity, not just "they answered"
  if (interest === 'HOT' && (!machine || !timeline || !district)) {
    req.session.flash = { error: 'A HOT lead needs an interested machine, a purchase timeline and a location (district).' };
    return res.redirect(`/telecaller/call/${lead.id}`);
  }

  const wantsForward = interest === 'HOT' || (interest === 'WARM' && (b.forward === '1' || b.forward === 'on'));
  const nextDate = (b.next_followup_date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? b.next_followup_date : null;

  let r = { forwarded: false };
  db.exec('BEGIN');
  try {
    // Update the qualification on the enquiry
    db.prepare(`UPDATE enquiries SET interest_class=?, machine_interested=?, purchase_timeline=?, finance_mode=?,
        existing_machine=?, meeting_requirement=?, preferred_contact_time=?, village_city=COALESCE(NULLIF(?,''),village_city),
        district=COALESCE(NULLIF(?,''),district), state=COALESCE(NULLIF(?,''),state), updated_at=CURRENT_TIMESTAMP
        WHERE id=?`)
      .run(interest, machine, timeline, (b.finance_mode || '').trim(), (b.existing_machine || '').trim(),
        (b.meeting_requirement || '').trim(), (b.preferred_contact_time || '').trim(),
        (b.village_city || '').trim(), district, (b.state || '').trim(), lead.id);

    // Follow-up row (keeps the existing enquiry lifecycle intact)
    db.prepare(`INSERT INTO enquiry_followups (enquiry_id,next_followup_date,call_status,notes,created_by)
      VALUES (?,?,?,?,?)`).run(lead.id, nextDate, interest, remarks, res.locals.user.id);

    let newStatus = 'active', activity = 'QUALIFIED', msg = remarks;
    if (interest === 'NOT_INTERESTED')  { newStatus = 'lost'; activity = 'CLOSED'; msg = `Not interested: ${remarks}`; }
    else if (interest === 'WRONG_NUMBER') { newStatus = 'lost'; activity = 'WRONG_NUMBER'; msg = `Wrong number — flag for CRM correction: ${remarks}`; }
    else if (interest === 'ALREADY_PURCHASED') { newStatus = 'lost'; activity = 'CLOSED'; msg = `Already purchased: ${remarks}`; }

    if (newStatus === 'lost') db.prepare("UPDATE enquiries SET status='lost', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lead.id);

    db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,prev_status,new_status,remarks)
      VALUES (?,?,?,?,?,?)`).run(lead.id, res.locals.user.id, activity, lead.status, newStatus, msg);

    // Forward to the area salesperson
    if (wantsForward && newStatus === 'active') {
      const spId = routeLeadByDistrict(district);
      if (spId) {
        db.prepare("UPDATE enquiries SET assigned_to=?, qualified_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(spId, nowIST(), lead.id);
        db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,prev_status,new_status,remarks)
          VALUES (?,?,?,?,?,?)`).run(lead.id, res.locals.user.id, 'FORWARDED', 'active', 'active', `Routed to salesperson by district: ${district}`);
        createNotification(spId, 'New lead assigned',
          `${lead.customer_name} (${lead.enquiry_number}) — ${interest}, ${district}. ${machine || ''}`.trim(),
          interest === 'HOT' ? 'warning' : 'info', `/enquiries/${lead.id}`);
        r = { forwarded: true, spId };
      } else {
        // No salesperson for this district → stays in the UNASSIGNED pool
        db.prepare("UPDATE enquiries SET qualified_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(nowIST(), lead.id);
        r = { forwarded: false, unassigned: true };
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  auditLog(res.locals.user.id, 'LEAD_DISPOSED', 'enquiries', lead.id, `${lead.enquiry_number} — ${interest}`);
  if (r.forwarded) req.session.flash = { success: `Lead qualified ${interest} and forwarded to the area salesperson.` };
  else if (r.unassigned) req.session.flash = { error: `No salesperson is mapped to "${district}". Lead is in the Unassigned queue for admin review.` };
  else req.session.flash = { success: `Saved as ${interest}.` };

  // If sharing was requested, go back to the card (share buttons live there); else next lead
  if (b.after === 'stay') return res.redirect(`/telecaller/call/${lead.id}`);
  return res.redirect('/telecaller/queue');
});

// ── Prepare a WhatsApp share for the internal sales group (log, don't auto-send)
router.post('/call/:id/share-group', (req, res) => {
  const lead = loadLead(req.params.id);
  if (!lead) return res.json({ ok: false, error: 'Lead not found.' });
  const terr = territoryOf(lead.district);
  const s = getSettings();
  const groupLink = (terr && terr.whatsapp_group_link) || s.tc_wa_group_default || '';
  const message =
`🔥 ${lead.interest_class || 'NEW'} ENQUIRY – SUPER ALLIED

Customer: ${lead.customer_name}
Mobile: ${lead.phone}
Location: ${[lead.village_city, lead.district].filter(Boolean).join(', ')}
Interested Model: ${lead.machine_interested || '-'}
Purchase Timeline: ${lead.purchase_timeline || '-'}
Finance: ${lead.finance_mode || '-'}
Existing Machine: ${lead.existing_machine || '-'}
Meeting: ${lead.meeting_requirement || '-'}

Telecaller Remarks:
${(req.body.remarks || '').trim() || '-'}

Assigned Salesperson: ${lead.assignee_name || 'Unassigned'}

Lead ID: ${lead.enquiry_number}

Action Required:
Please call the customer and arrange a meeting/demo.`;

  db.prepare(`INSERT INTO lead_shares (enquiry_id,user_id,channel,destination,message) VALUES (?,?, 'group', ?, ?)`)
    .run(lead.id, res.locals.user.id, groupLink, message);
  auditLog(res.locals.user.id, 'LEAD_SHARED', 'enquiries', lead.id, `group share — ${lead.enquiry_number}`);
  // Click-to-chat cannot target a group reliably; return text to copy + any configured group link.
  res.json({ ok: true, message, groupLink });
});

// ── Telecaller's own call history ─────────────────────────────────────────────
router.get('/history', (req, res) => {
  const rows = db.prepare(`SELECT cl.*, e.customer_name, e.enquiry_number, e.phone FROM call_logs cl
    JOIN enquiries e ON e.id=cl.enquiry_id WHERE cl.user_id=? ORDER BY cl.called_at DESC LIMIT 200`).all(res.locals.user.id);
  res.render('telecaller/history', { title: 'My Call History', rows });
});

// ── Admin: script, pitches, WhatsApp templates ───────────────────────────────
router.get('/config', adminOnly, (req, res) => {
  const s = getSettings();
  res.render('telecaller/config', { title: 'Telecaller Config', s });
});

router.post('/config', adminOnly, (req, res) => {
  const set = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const keys = ['tc_pitch_filtering', 'tc_pitch_closing', 'tc_pitch_bull_promise', 'tc_wa_customer_template', 'tc_wa_group_default', 'tc_sales_phone'];
  keys.forEach(k => { if (req.body[k] !== undefined) set.run(k, String(req.body[k])); });
  if (req.body.tc_script) { try { JSON.parse(req.body.tc_script); set.run('tc_script', req.body.tc_script); } catch (e) { /* ignore bad JSON */ } }
  auditLog(res.locals.user.id, 'TELECALLER_CONFIG', 'settings', '', keys.join(','));
  req.session.flash = { success: 'Telecaller settings saved.' };
  res.redirect('/telecaller/config');
});

// ── Admin: territories (district → salesperson) ──────────────────────────────
router.get('/territories', adminOnly, (req, res) => {
  const territories = db.prepare(`SELECT t.*, u.full_name AS primary_name,
      (SELECT GROUP_CONCAT(district, ', ') FROM territory_districts WHERE territory_id=t.id) AS districts
    FROM territories t LEFT JOIN users u ON u.id=t.primary_user_id ORDER BY t.name`).all();
  const salespeople = db.prepare("SELECT id, full_name, username FROM users WHERE role='sales' ORDER BY full_name").all();
  const unassigned = db.prepare(`SELECT e.id, e.enquiry_number, e.customer_name, e.district, e.interest_class
    FROM enquiries e WHERE ${POOL} AND e.interest_class IN ('HOT','WARM') ORDER BY e.updated_at DESC LIMIT 100`).all();
  res.render('telecaller/territories', { title: 'Territories', territories, salespeople, unassigned });
});

router.post('/territories', adminOnly, (req, res) => {
  const name = (req.body.name || '').trim();
  const primary = parseInt(req.body.primary_user_id) || null;
  const districts = [].concat(req.body.districts || []).map(d => String(d).trim()).filter(Boolean);
  if (!name) { req.session.flash = { error: 'Territory name is required.' }; return res.redirect('/telecaller/territories'); }
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO territories (name, primary_user_id, whatsapp_group_link) VALUES (?,?,?)')
      .run(name, primary, (req.body.whatsapp_group_link || '').trim());
    const tid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT OR IGNORE INTO territory_districts (territory_id, district) VALUES (?,?)');
    districts.forEach(d => ins.run(tid, d));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  auditLog(res.locals.user.id, 'TERRITORY_CREATED', 'territories', '', `${name}: ${districts.join(', ')}`);
  req.session.flash = { success: `Territory "${name}" saved.` };
  res.redirect('/telecaller/territories');
});

router.post('/territories/:id/delete', adminOnly, (req, res) => {
  db.prepare('DELETE FROM territories WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Territory removed.' };
  res.redirect('/telecaller/territories');
});

// ── Admin reassign a lead (keeps full history; never silent) ──────────────────
router.post('/call/:id/reassign', adminOnly, (req, res) => {
  const lead = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  const spId = parseInt(req.body.salesperson_id) || null;
  if (!lead || !spId) { req.session.flash = { error: 'Lead or salesperson missing.' }; return res.redirect('/telecaller'); }
  db.prepare("UPDATE enquiries SET assigned_to=?, qualified_at=COALESCE(qualified_at,?), updated_at=CURRENT_TIMESTAMP WHERE id=?").run(spId, nowIST(), lead.id);
  db.prepare(`INSERT INTO lead_activity (enquiry_id,user_id,activity_type,prev_status,new_status,remarks)
    VALUES (?,?, 'REASSIGNED', ?, ?, ?)`).run(lead.id, res.locals.user.id, lead.status, lead.status, `Manually reassigned by admin`);
  createNotification(spId, 'Lead assigned to you', `${lead.customer_name} (${lead.enquiry_number})`, 'info', `/enquiries/${lead.id}`);
  auditLog(res.locals.user.id, 'LEAD_REASSIGNED', 'enquiries', lead.id, `${lead.enquiry_number} → user ${spId}`);
  req.session.flash = { success: 'Lead reassigned.' };
  res.redirect(`/telecaller/call/${lead.id}`);
});

module.exports = router;
