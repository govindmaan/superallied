// Organisation chart: positions, who sits where, and who approves for whom.
// Rule: a request goes to the nearest position above the requester that has an
// active person in it. While those positions are vacant it goes to Level 1
// (the owner); if nobody is placed at Level 1 yet, to the admin accounts.
const { db } = require('../db');

const SECTIONS = ['Leadership', 'Sales', 'Service', 'Operations', 'Support'];

function positions() {
  return db.prepare('SELECT * FROM org_positions ORDER BY level, sort_order').all();
}

function positionByCode(code) {
  return code ? db.prepare('SELECT * FROM org_positions WHERE code=?').get(code) : null;
}

// Active people in a position
function holders(code) {
  return db.prepare(`SELECT id, full_name, username, role, manager_id FROM users
    WHERE position_code=? AND COALESCE(is_hr_active,1)=1 ORDER BY full_name`).all(code);
}

// Level 1 approvers: whoever sits in the owner position, else the admins
function levelOneApprovers() {
  const owners = holders('owner');
  if (owners.length) return owners;
  return db.prepare(`SELECT id, full_name, username, role FROM users
    WHERE role='admin' AND COALESCE(is_hr_active,1)=1 ORDER BY id`).all();
}

// Who approves for this user, plus the vacant positions that were skipped.
// When a filled position has several people (e.g. 6 area leads), the person's
// "Reports To" picks which one; without it, the first in that position.
function approverFor(userId) {
  const user = db.prepare('SELECT id, position_code, manager_id FROM users WHERE id=?').get(userId);
  const vacant = [];
  let pos = positionByCode(user?.position_code);
  let code = pos ? pos.parent_code : null;
  while (code) {
    const p = positionByCode(code);
    if (!p) break;
    if (p.level === 1) break;                        // Level 1 handled below
    const people = holders(code).filter(h => h.id !== userId);
    if (people.length) {
      const chosen = people.find(h => h.id === user.manager_id) || people[0];
      return { approvers: [chosen], position: p, vacant };
    }
    vacant.push(p);
    code = p.parent_code;
  }
  const top = levelOneApprovers().filter(h => h.id !== userId);
  return { approvers: top.length ? top : levelOneApprovers(), position: positionByCode('owner'), vacant };
}

// Who would approve for a new person placed in this position (for the forms)
function approverForPosition(code) {
  const vacant = [];
  let p = positionByCode(positionByCode(code)?.parent_code);
  while (p && p.level > 1) {
    const people = holders(p.code);
    if (people.length) return { approvers: people, vacant };
    vacant.push(p);
    p = positionByCode(p.parent_code);
  }
  return { approvers: levelOneApprovers(), vacant };
}

// Position list for the add/edit forms: grouped options, default app role, and
// where approvals would go
function formOptions() {
  return chart().map(p => {
    const r = p.level === 1 ? { approvers: [], vacant: [] } : approverForPosition(p.code);
    return { code: p.code, title: p.title, level: p.level, section: p.section, filled: p.filled, planned: p.planned,
      default_role: p.default_role, approvers: r.approvers.map(a => a.full_name || a.username).join(', '),
      vacant: r.vacant.map(v => v.title) };
  });
}

const approverIdsFor = (userId) => approverFor(userId).approvers.map(a => a.id);

// True when `approverId` is the routed approver for `userId` (admins always may)
function canApproveFor(approverId, userId, role) {
  if (role === 'admin') return true;
  return approverIdsFor(userId).includes(approverId);
}

// Chart data: every position with its people and filled/planned counts
function chart() {
  const people = db.prepare(`SELECT id, full_name, username, role, position_code, employee_code FROM users
    WHERE position_code <> '' AND COALESCE(is_hr_active,1)=1 ORDER BY full_name`).all();
  return positions().map(p => {
    const inSeat = people.filter(u => u.position_code === p.code);
    return { ...p, people: inSeat, filled: inSeat.length, vacant: Math.max(0, p.planned - inSeat.length) };
  });
}

module.exports = { SECTIONS, formOptions, approverForPosition, positions, positionByCode, holders, approverFor, approverIdsFor, canApproveFor, chart, levelOneApprovers };
