// Organisation chart (growth plan v2): positions, who sits where, and where
// each person's approvals go. Admin places people; HR admins can view.
const express = require('express');
const { db, auditLog } = require('../db');
const org = require('../lib/org');

const router = express.Router();

const isAdmin = (res) => res.locals.hasPerm('*');

router.get('/', (req, res) => {
  if (!isAdmin(res) && !res.locals.hasPerm('hr_admin')) {
    req.session.flash = { error: 'Only the admin and HR can see the organisation chart.' };
    return res.redirect('/');
  }
  const chart = org.chart();
  const people = db.prepare(`SELECT id, full_name, username, role, position_code, employee_code FROM users
    WHERE COALESCE(is_hr_active,1)=1 ORDER BY full_name`).all();
  const byCode = Object.fromEntries(chart.map(p => [p.code, p]));
  const routing = people.filter(u => u.position_code).map(u => {
    const r = org.approverFor(u.id);
    return { ...u, position: byCode[u.position_code], approvers: r.approvers, vacant: r.vacant };
  }).sort((a, b) => (a.position?.level - b.position?.level) || (a.position?.sort_order - b.position?.sort_order) || a.full_name.localeCompare(b.full_name));
  const unplaced = people.filter(u => !u.position_code || !byCode[u.position_code]);
  const totals = org.SECTIONS.map(s => {
    const ps = chart.filter(p => p.section === s);
    return { section: s, planned: ps.reduce((a, p) => a + p.planned, 0), filled: ps.reduce((a, p) => a + Math.min(p.filled, p.planned), 0) };
  });
  res.render('org-chart', { title: 'Organisation Chart', chart, people, routing, unplaced, totals,
    sections: org.SECTIONS, levelOne: org.levelOneApprovers(), canEdit: isAdmin(res) });
});

// Place a person in a position (designation and department follow the position)
router.post('/place', (req, res) => {
  if (!isAdmin(res)) return res.status(403).send('Admin only');
  const uid = +req.body.user_id;
  const pos = org.positionByCode(req.body.position_code);
  const u = db.prepare('SELECT id, full_name FROM users WHERE id=?').get(uid);
  if (!u || !pos) { req.session.flash = { error: 'Choose a person and a position.' }; return res.redirect('/org-chart'); }
  db.prepare('UPDATE users SET position_code=?, designation=?, department=? WHERE id=?').run(pos.code, pos.title, pos.section, uid);
  auditLog(req.session.userId, 'position_set', 'user', uid, `${u.full_name} → ${pos.title}`);
  req.session.flash = { success: `${u.full_name} placed as ${pos.title}.` };
  res.redirect('/org-chart#pos-' + pos.code);
});

// Take a person out of their position (they keep their account and access)
router.post('/unplace', (req, res) => {
  if (!isAdmin(res)) return res.status(403).send('Admin only');
  const u = db.prepare('SELECT id, full_name, position_code FROM users WHERE id=?').get(+req.body.user_id);
  if (!u) return res.redirect('/org-chart');
  db.prepare("UPDATE users SET position_code='' WHERE id=?").run(u.id);
  auditLog(req.session.userId, 'position_cleared', 'user', u.id, `${u.full_name} (was ${u.position_code})`);
  req.session.flash = { success: `${u.full_name} removed from the position.` };
  res.redirect('/org-chart');
});

module.exports = router;
