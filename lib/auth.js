// Route guards shared by server.js and the route modules.
const { db } = require('../db');

// Auth guard
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  req.session.flash = { error: 'Please login to continue.' };
  res.redirect('/login');
}

// Admin-only guard
function requireAdmin(req, res, next) {
  const user = req.session.userId
    ? db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  if (user && user.role === 'admin') return next();
  req.session.flash = { error: 'Admin access required.' };
  res.redirect('/');
}

// ── Permission middleware factory ─────────────────────────────────────────────
function requirePerm(perm) {
  return (req, res, next) => {
    if (res.locals.hasPerm && res.locals.hasPerm(perm)) return next();
    req.session.flash = { error: `You don't have permission to access this area.` };
    res.redirect('/');
  };
}

// ── Role guards ───────────────────────────────────────────────────────────────
function requireManagerOrAdmin(req, res, next) {
  const role = res.locals.user?.role;
  if (['admin','manager'].includes(role)) return next();
  req.session.flash = { error: 'Manager or Admin access required.' };
  res.redirect('/');
}

module.exports = { requireLogin, requireAdmin, requirePerm, requireManagerOrAdmin };
