// Login (password or PIN), logout, and the public shared spare-quotation link.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const spareQuotationsRoutes = require('./spare-quotations');

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
// ── Login (password or 6-digit PIN) ──────────────────────────────────────────
// Cloudflare Turnstile (free CAPTCHA) is on when both keys are set; otherwise skipped.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET   = process.env.TURNSTILE_SECRET_KEY || '';
const MAX_FAILED_LOGINS = 5;   // per account, then locked for LOCK_MINUTES
const LOCK_MINUTES      = 15;
const IP_MAX_ATTEMPTS   = 30;  // per network address per 15 minutes
// Per-IP request counter over a 15-minute window; separate counters per purpose
function ipLimiter(max) {
  const seen = new Map();  // ip -> { count, since }
  return (ip) => {
    const now = Date.now(), win = 15 * 60000;
    const rec = seen.get(ip);
    if (!rec || now - rec.since > win) { seen.set(ip, { count: 1, since: now }); return false; }
    rec.count++;
    return rec.count > max;
  };
}
const ipRateLimited    = ipLimiter(IP_MAX_ATTEMPTS);  // login attempts
const shareRateLimited = ipLimiter(120);              // public shared-quotation downloads

async function verifyCaptcha(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }) });
    return !!(await r.json()).success;
  } catch (e) {
    console.error('Turnstile verify failed:', e.message);
    return false;
  }
}

// Public: a spare quotation PDF shared on WhatsApp (customer copy, link expires)
router.get('/share/spare-quotation/:token', async (req, res) => {
  if (shareRateLimited(req.ip)) return res.status(429).send('Too many requests. Please try again later.');
  try {
    const pdf = await spareQuotationsRoutes.pdfForShareToken(req.app, req.params.token);
    if (!pdf) return res.status(404).send('This quotation link is not valid.');
    if (pdf.expired) return res.status(410).send('This quotation link has expired. Please ask Super Allied for a new one.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf.buffer);
  } catch (e) {
    console.error('Shared quotation PDF error:', e);
    res.status(500).send('Could not prepare the quotation. Please try again.');
  }
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Login', turnstileSiteKey: TURNSTILE_SECRET ? TURNSTILE_SITE_KEY : '' });
});

router.post('/login', async (req, res) => {
  const mode     = req.body.mode === 'pin' ? 'pin' : 'password';
  const username = String(req.body.username || '').trim();
  const fail = (error) => { req.session.flash = { error, loginMode: mode, username }; res.redirect('/login'); };

  if (ipRateLimited(req.ip)) return fail('Too many login attempts. Please wait 15 minutes and try again.');
  if (!(await verifyCaptcha(req.body['cf-turnstile-response'], req.ip))) return fail('Please complete the security check.');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return fail(`Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }

  let ok = false;
  if (user && mode === 'pin') {
    if (!user.pin_hash) return fail('No PIN set for this account. Log in with your password, then set a PIN in My Profile.');
    ok = /^\d{6}$/.test(req.body.pin || '') && bcrypt.compareSync(req.body.pin, user.pin_hash);
  } else if (user) {
    ok = bcrypt.compareSync(String(req.body.password || ''), user.password_hash);
  }

  if (!ok) {
    if (user) {
      const fails = (user.failed_logins || 0) + 1;
      if (fails >= MAX_FAILED_LOGINS) {
        db.prepare('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?')
          .run(new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), user.id);
        return fail(`Too many wrong attempts. Account locked for ${LOCK_MINUTES} minutes.`);
      }
      db.prepare('UPDATE users SET failed_logins=? WHERE id=?').run(fails, user.id);
    }
    return fail(mode === 'pin' ? 'Invalid username or PIN.' : 'Invalid username or password.');
  }
  if (user.is_hr_active === 0) return fail('Your account has been deactivated. Contact HR/Admin.');

  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(user.id);
  // New session id on login (prevents session fixation)
  req.session.regenerate(err => {
    if (err) return fail('Login failed, please try again.');
    req.session.userId = user.id;
    req.session.authAt = Date.now();
    res.redirect('/');
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
