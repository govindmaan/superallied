// Shared data helpers: settings, document numbering, quotation maths,
// notifications, audit log and lead routing.
const db = require('./connection');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// Today's date as YYYY-MM-DD in server local time, shared by attendance and expense routes
function today() { return new Date().toLocaleDateString('en-CA'); }

function getFY(date = new Date()) {
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

function nextQuotationNumber() {
  const fy = getFY();
  const row = db.prepare('SELECT MAX(serial_number) as max FROM quotations WHERE financial_year = ?').get(fy);
  const serial = (row.max || 0) + 1;
  return { quotationNumber: `${fy}/${serial}`, financialYear: fy, serialNumber: serial };
}

function numberToWords(n) {
  n = Math.round(n);
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function two(x) { return x < 20 ? ones[x] : tens[Math.floor(x/10)] + (x%10 ? ' '+ones[x%10] : ''); }
  function three(x) { return x>=100 ? ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+two(x%100):'') : two(x); }
  let w = '';
  const cr = Math.floor(n/10000000); if (cr) { w += three(cr)+' Crore '; n %= 10000000; }
  const lk = Math.floor(n/100000);   if (lk) { w += two(lk)+' Lakh '; n %= 100000; }
  const th = Math.floor(n/1000);     if (th) { w += two(th)+' Thousand '; n %= 1000; }
  const hu = Math.floor(n/100);      if (hu) { w += ones[hu]+' Hundred '; n %= 100; }
  if (n) w += two(n)+' ';
  return w.trim()+' Rupees Only';
}

// Basic → GST → TCS → roundoff = Ex-Showroom Price; then Additional Items,
// Insurance, TRC/LTT, Handling and Transport are added on top to reach the Grand Total.
function calcQuotation(q, settings) {
  const basic = q.basic_price * q.quantity;
  const base  = basic;

  let cgst = 0, sgst = 0, igst = 0;
  if (q.tax_mode === 'IGST') {
    igst = base * (q.igst_rate || 18) / 100;
  } else {
    cgst = base * (q.cgst_rate || 9) / 100;
    sgst = base * (q.sgst_rate || 9) / 100;
  }
  const preTcs   = base + cgst + sgst + igst;
  const tcs      = q.has_tcs ? Math.round(preTcs * (q.tcs_rate || 1) / 100) : 0;
  const preRound = preTcs + tcs;

  // Upward roundoff (if enabled) lands on the Ex-Showroom Price
  let exShowroom = preRound;
  if (settings && settings.roundoff_enabled === '1') {
    const roundoffAmount = parseInt(settings.roundoff_amount) || 500;
    exShowroom = Math.ceil(preRound / roundoffAmount) * roundoffAmount;
  }
  const roundoff = exShowroom - preRound;

  const insuranceAmount = parseFloat(q.insurance_amount) || 0;
  const trcAmount       = parseFloat(q.trc) || 0;
  const handling        = parseFloat(q.handling_charges) || 0;
  const transport       = parseFloat(q.transport_charges) || 0;
  let extraItems = [];
  try { extraItems = JSON.parse(q.extra_items || '[]'); } catch (e) {}
  const extrasTotal = extraItems.reduce((sum, it) => sum + (parseFloat(it.amount) || 0), 0);
  const total = exShowroom + extrasTotal + insuranceAmount + trcAmount + handling + transport;

  return { basic, base, cgst, sgst, igst, preTcs, tcs, preRound,
           roundoff, roundoffApplied: roundoff > 0, exShowroom,
           extraItems, extrasTotal,
           insuranceAmount, trcAmount, handling, transport, total,
           amountWords: numberToWords(Math.round(total)) };
}

function formatINR(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getUserPermissions(role) {
  if (role === 'admin') return ['*'];
  return db.prepare('SELECT permission FROM role_permissions WHERE role=?').all(role).map(r => r.permission);
}

// Position-based permissions: looks up the position's default_role in org_positions,
// then returns that role's permissions. Falls back to roleOverride (e.g. the stored
// users.role) for users without a position_code (e.g. the seeded admin account).
function getPositionPermissions(positionCode, roleOverride) {
  if (positionCode) {
    const pos = db.prepare('SELECT default_role FROM org_positions WHERE code=?').get(positionCode);
    if (pos) return getUserPermissions(pos.default_role);
  }
  return getUserPermissions(roleOverride || '');
}

// In-app notification, also pushed to the user's phones/browsers that have notifications on
function createNotification(userId, title, body = '', type = 'info', link = '') {
  try {
    db.prepare('INSERT INTO notifications (user_id,title,body,type,link) VALUES (?,?,?,?,?)')
      .run(userId, title, body, type, link);
  } catch(e) { return; /* non-critical */ }
  require('../lib/push').notifyUser(userId, { title, body, url: link || '/notifications', tag: type });
}

function nextEnquiryNumber() {
  const ym = new Date().toLocaleDateString('en-CA').slice(0, 7).replace('-', '');
  const count = db.prepare("SELECT COUNT(*) as c FROM enquiries WHERE enquiry_number LIKE ?").get(`ENQ-${ym}-%`).c;
  return `ENQ-${ym}-${String(count + 1).padStart(4, '0')}`;
}

function nextEnquiryQuotationNumber() {
  const fy = getFY();
  const row = db.prepare('SELECT MAX(serial_number) as max FROM enquiry_quotations WHERE financial_year = ?').get(fy);
  const serial = (row.max || 0) + 1;
  const padded = String(serial).padStart(4, '0');
  return { quotationNumber: `EQ-${fy}/${padded}`, financialYear: fy, serialNumber: serial };
}

// Merged, time-ordered timeline for one enquiry — remarks/followups/visits/quotations/sale/system events.
function getEnquiryTimeline(enquiryId) {
  const rows = db.prepare(`
    SELECT r.id, 'remark' as type, r.created_at, r.created_by, r.body as text, r.id as ref_id
    FROM enquiry_remarks r WHERE r.enquiry_id = ?
    UNION ALL
    SELECT f.id, 'followup', f.created_at, f.created_by,
      'Call status: ' || f.call_status || COALESCE(NULLIF(' — ' || f.notes, ' — '), '') ||
      COALESCE(NULLIF(' | Next follow-up: ' || f.next_followup_date, ' | Next follow-up: '), ''),
      f.id
    FROM enquiry_followups f WHERE f.enquiry_id = ?
    UNION ALL
    SELECT v.id, 'visit', v.created_at, v.created_by,
      'Visit to ' || COALESCE(NULLIF(v.visit_location,''), 'site') ||
      COALESCE(NULLIF(' — ' || v.purpose, ' — '), '') ||
      COALESCE(NULLIF(' | Outcome: ' || v.outcome, ' | Outcome: '), ''),
      v.id
    FROM enquiry_visits v WHERE v.enquiry_id = ?
    UNION ALL
    SELECT q.id, 'quotation', q.created_at, q.created_by,
      'Quotation ' || q.quotation_number || COALESCE(NULLIF(' (' || q.machine_model || ')', ' ()'), '') || ' — ' || q.status,
      q.id
    FROM enquiry_quotations q WHERE q.enquiry_id = ?
    UNION ALL
    SELECT s.id, 'sale', s.created_at, s.created_by,
      'Sale closed — Invoice ' || COALESCE(NULLIF(s.invoice_number,''),'—') || ', Machine ' || COALESCE(NULLIF(s.machine_number,''),'—'),
      s.id
    FROM enquiry_sales s WHERE s.enquiry_id = ?
    UNION ALL
    SELECT a.id, 'system', a.created_at, a.user_id,
      a.action || COALESCE(NULLIF(' — ' || a.details, ' — '), ''),
      NULL
    FROM audit_log a WHERE a.entity = 'enquiries' AND a.entity_id = ?
      AND a.action NOT IN ('ENQUIRY_QUOTATION_CREATED', 'ENQUIRY_SALE_CLOSED')
    ORDER BY created_at DESC, id DESC
  `).all(enquiryId, enquiryId, enquiryId, enquiryId, enquiryId, String(enquiryId));

  const userIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))];
  const users = userIds.length
    ? db.prepare(`SELECT id, full_name, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).all(...userIds)
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.id, u.full_name || u.username]));

  const attachments = db.prepare('SELECT * FROM enquiry_attachments WHERE enquiry_id=?').all(enquiryId);
  return rows.map(r => ({
    ...r,
    user_name: userMap[r.created_by] || 'System',
    attachments: attachments.filter(a => a.activity_type === r.type && a.activity_id === r.ref_id),
  }));
}

// Idempotent: notifies the assignee once per day about a due/overdue follow-up.
function checkFollowupNotifications(userId) {
  const today = new Date().toLocaleDateString('en-CA');
  const due = db.prepare(`
    SELECT e.id, e.enquiry_number, e.customer_name, f.next_followup_date
    FROM enquiries e
    JOIN (
      SELECT enquiry_id, MAX(next_followup_date) as next_followup_date
      FROM enquiry_followups WHERE next_followup_date IS NOT NULL
      GROUP BY enquiry_id
    ) f ON f.enquiry_id = e.id
    WHERE e.assigned_to = ? AND e.status = 'active' AND f.next_followup_date <= ?
  `).all(userId, today);

  due.forEach(d => {
    const link = `/enquiries/${d.id}`;
    const already = db.prepare(`SELECT id FROM notifications WHERE user_id=? AND link=? AND date(created_at,'+330 minutes')=?`)
      .get(userId, link, today);
    if (already) return;
    const overdue = d.next_followup_date < today;
    createNotification(userId,
      overdue ? 'Missed Follow-up' : 'Follow-up Due Today',
      `${d.customer_name} (${d.enquiry_number}) — follow-up was due ${d.next_followup_date}`,
      overdue ? 'warning' : 'info', link);
  });
}

function nextSpareQuotationNumber() {
  const fy = getFY();
  const row = db.prepare('SELECT MAX(serial_number) as max FROM spare_quotations WHERE financial_year = ?').get(fy);
  const serial = (row.max || 0) + 1;
  const padded = String(serial).padStart(4, '0');
  return { quotationNo: `SP-${fy}/${padded}`, financialYear: fy, serialNumber: serial };
}

function nextExpenseNumber() {
  const year = new Date().getFullYear();
  const count = db.prepare("SELECT COUNT(*) as c FROM travel_expenses WHERE expense_number LIKE ?").get(`EXP-${year}-%`).c;
  return `EXP-${year}-${String(count + 1).padStart(6, '0')}`;
}

function nextComplaintNumber() {
  const year = new Date().getFullYear();
  const count = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE complaint_number LIKE ?").get(`CMP-${year}-%`).c;
  return `CMP-${year}-${String(count + 1).padStart(5, '0')}`;
}

function auditLog(userId, action, entity = '', entityId = '', details = '') {
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,details) VALUES (?,?,?,?,?)')
      .run(userId, action, entity, String(entityId), details);
  } catch(e) {}
}

// Route a lead to the salesperson who owns its district (district-level routing).
// Returns a user id, or null when the district is unmapped (→ UNASSIGNED queue).
function routeLeadByDistrict(district) {
  if (!district || !String(district).trim()) return null;
  const row = db.prepare(`SELECT t.primary_user_id AS uid
    FROM territory_districts td JOIN territories t ON t.id = td.territory_id
    WHERE td.district = ? COLLATE NOCASE AND t.active = 1`).get(String(district).trim());
  return row && row.uid ? row.uid : null;
}

const EMP_CODE_START = 10001;
function nextEmployeeCode() {
  const r = db.prepare("SELECT MAX(CAST(employee_code AS INTEGER)) AS m FROM users WHERE employee_code GLOB '[0-9]*'").get();
  return String(Math.max(EMP_CODE_START, (r?.m || 0) + 1));
}

module.exports = { nextEmployeeCode, getSettings, getFY, today, nextQuotationNumber, nextSpareQuotationNumber, numberToWords, calcQuotation, formatINR, createNotification, getUserPermissions, getPositionPermissions, auditLog, nextEnquiryNumber, nextEnquiryQuotationNumber, getEnquiryTimeline, checkFollowupNotifications, nextExpenseNumber, nextComplaintNumber, routeLeadByDistrict, EMP_CODE_START };
