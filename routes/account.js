// Company settings, and changing your own password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings, auditLog } = require('../db');
const { requireLogin } = require('../lib/auth');

const router = express.Router();

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', requireLogin, (req, res) => {
  res.render('settings', { title: 'Settings', s: getSettings() });
});

router.post('/settings', requireLogin, (req, res) => {
  const fields = [
    'company_name','company_gstin','company_address','dealer_of',
    'contact_name','contact_phone','company_phone_sales','company_phone_service',
    'company_email','company_udyam','company_state','company_state_code',
    'bank_beneficiary','bank_name','bank_account','bank_ifsc','bank_branch',
    'rto_default_rate','price_lock_enabled','roundoff_enabled','roundoff_amount',
    'company_upi'
  ];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  fields.forEach(k => { if (req.body[k] != null) upsert.run(k, req.body[k]); });
  req.session.flash = { success: 'Settings saved.' };
  res.redirect('/settings');
});

// Change password
router.post('/settings/password', requireLogin, (req, res) => {
  const { current, newpwd, confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    req.session.flash = { error: 'Current password is wrong.' };
    return res.redirect('/settings');
  }
  if (newpwd !== confirm || newpwd.length < 6) {
    req.session.flash = { error: 'Passwords do not match or too short (min 6).' };
    return res.redirect('/settings');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newpwd, 10), user.id);
  req.session.flash = { success: 'Password changed.' };
  res.redirect('/settings');
});

// After an admin reset: choose a new password (the temporary one was just used to log in)
router.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { title: 'Choose a New Password', forced: !!res.locals.user?.must_change_password });
});

router.post('/change-password', requireLogin, (req, res) => {
  const { newpwd, confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const back = (error) => { req.session.flash = { error }; res.redirect('/change-password'); };
  if (!newpwd || newpwd.length < 6)              return back('Password must be at least 6 characters.');
  if (newpwd !== confirm)                        return back('The two passwords do not match.');
  if (bcrypt.compareSync(newpwd, user.password_hash)) return back('Choose a different password from the temporary one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newpwd, 10), user.id);
  auditLog(user.id, 'password_changed_after_reset', 'user', user.id, '');
  req.session.flash = { success: 'Password changed. Welcome back!' };
  res.redirect('/');
});

module.exports = router;
