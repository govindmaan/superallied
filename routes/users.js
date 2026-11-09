// User accounts (admin only): create, deactivate, reset password, activate.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, auditLog, nextEmployeeCode } = require('../db');
const { requireLogin, requireAdmin } = require('../lib/auth');
const org = require('../lib/org');

const router = express.Router();

// ── Users (admin only) ────────────────────────────────────────────────────────
router.get('/users', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.is_hr_active, u.created_at, u.must_change_password,
      (u.pin_hash IS NOT NULL) AS has_pin, (u.locked_until IS NOT NULL AND u.locked_until > ?) AS locked,
      p.title AS position_title, p.level AS position_level
    FROM users u LEFT JOIN org_positions p ON p.code = u.position_code ORDER BY u.created_at`).all(new Date().toISOString());
  res.render('users', { title: 'Users', users });
});

router.get('/users/new', requireLogin, requireAdmin, (req, res) => {
  res.render('user-form', { title: 'New User', positions: org.formOptions(), sections: org.SECTIONS });
});

router.post('/users', requireLogin, requireAdmin, (req, res) => {
  const { username, full_name, role, password, confirm, position_code } = req.body;
  const pos = org.positionByCode(position_code);
  if (!pos) {
    req.session.flash = { error: 'Choose the position this person will hold.' };
    return res.redirect('/users/new');
  }
  if (!username?.trim() || !password) {
    req.session.flash = { error: 'Username and password are required.' };
    return res.redirect('/users/new');
  }
  if (password !== confirm) {
    req.session.flash = { error: 'Passwords do not match.' };
    return res.redirect('/users/new');
  }
  if (password.length < 6) {
    req.session.flash = { error: 'Password must be at least 6 characters.' };
    return res.redirect('/users/new');
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())) {
    req.session.flash = { error: `Username "${username.trim()}" is already taken.` };
    return res.redirect('/users/new');
  }
  const hash = bcrypt.hashSync(password, 10);
  const allowedRoles = ['admin','sales','office','manager','hr','service','staff','employee','accountant','accounts_manager','telecaller'];
  const safeRole = allowedRoles.includes(role) ? role : 'sales';
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role, employee_code, position_code, designation, department)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(username.trim(), hash, full_name?.trim() || '', safeRole, nextEmployeeCode(), pos.code, pos.title, pos.section);
  req.session.flash = { success: `User "${username.trim()}" created successfully.` };
  res.redirect('/users');
});

// Hard-deleting a user cascades across attendance, salary, quotations, travel
// expenses, and other financial/HR records — the FOREIGN KEY failures that
// used to surface here are exactly why the app deactivates instead of
// deleting everywhere else (see /hr/employees). These two routes replace the
// old destructive delete.
router.post('/users/:id/deactivate', requireLogin, requireAdmin, (req, res) => {
  const uid = +req.params.id;
  if (uid === req.session.userId) {
    req.session.flash = { error: 'You cannot deactivate your own account.' };
    return res.redirect('/users');
  }
  const u = db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(uid);
  if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/users'); }

  db.prepare('UPDATE users SET is_hr_active=0 WHERE id=?').run(uid);
  auditLog(req.session.userId, 'user_deactivated', 'user', uid, `Deactivated "${u.full_name || u.username}"`);
  req.session.flash = { success: `${u.full_name || u.username} deactivated. Their records are preserved; they can no longer log in.` };
  res.redirect('/users');
});

// Admin resets a user's password: clears any lockout, signs them out on every
// device, and (by default) makes them choose their own password at next login.
router.post('/users/:id/reset-password', requireLogin, requireAdmin, (req, res) => {
  const uid = +req.params.id;
  const u = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(uid);
  if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/users'); }
  const name = u.full_name || u.username;
  const { password, confirm, must_change, remove_pin } = req.body;
  if (!password || password.length < 6) { req.session.flash = { error: `New password for ${name} must be at least 6 characters.` }; return res.redirect('/users'); }
  if (password !== confirm)             { req.session.flash = { error: `The two passwords for ${name} do not match.` }; return res.redirect('/users'); }

  const self = uid === req.session.userId;
  const force = !self && must_change === '1';
  db.prepare(`UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL,
      must_change_password = ?, sessions_valid_after = ?${remove_pin === '1' ? ', pin_hash = NULL' : ''} WHERE id = ?`)
    .run(bcrypt.hashSync(password, 10), force ? 1 : 0, self ? null : Date.now(), uid);
  auditLog(req.session.userId, 'user_password_reset', 'user', uid,
    `Reset password for "${name}"${force ? ', must change at next login' : ''}${remove_pin === '1' ? ', PIN removed' : ''}`);

  req.session.flash = { success: `Password reset for ${name}.` + (self ? '' : ` They have been signed out${force ? ' and will choose a new password at next login' : ''}.`)
    + (remove_pin === '1' ? ' Their login PIN was removed.' : '') + ' Share the new password with them directly.' };
  res.redirect('/users');
});

router.post('/users/:id/activate', requireLogin, requireAdmin, (req, res) => {
  const uid = +req.params.id;
  const u = db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(uid);
  if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/users'); }

  db.prepare('UPDATE users SET is_hr_active=1 WHERE id=?').run(uid);
  auditLog(req.session.userId, 'user_activated', 'user', uid, `Activated "${u.full_name || u.username}"`);
  req.session.flash = { success: `${u.full_name || u.username} activated. They can log in again.` };
  res.redirect('/users');
});

module.exports = router;
