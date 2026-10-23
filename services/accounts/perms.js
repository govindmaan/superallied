// Same rule as db.js getUserPermissions, but for any connection (tests use their own)
function getUserPermissions(db, role) {
  if (role === 'admin') return ['*'];
  return db.prepare('SELECT permission FROM role_permissions WHERE role=?').all(role).map(r => r.permission);
}

module.exports = { getUserPermissions };
