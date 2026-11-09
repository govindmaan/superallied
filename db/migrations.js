// One-time and corrective data migrations, run after seeding on every start.
// Each one is guarded (by a settings flag or by being idempotent) so it only
// changes data once.
const db = require('./connection');
const { EMP_CODE_START } = require('./helpers');

function migrate() {
  // The in-app Accounts module (Tally invoice upload, receipts, payments,
  // allocations, challans) was removed — the accountant works in Tally Prime.
  // Drop its tables so they stop shadowing the schema. DROP IF EXISTS is
  // idempotent; on a fresh DB these were never created.
  for (const tbl of ['acc_discrepancy_resolutions', 'acc_cheque_events', 'acc_adjustments',
    'acc_cancellations', 'acc_allocations', 'acc_payments', 'acc_receipts',
    'acc_invoice_challans', 'acc_invoice_files', 'acc_challans', 'acc_invoices', 'acc_sequences']) {
    try { db.exec(`DROP TABLE IF EXISTS ${tbl}`); } catch (e) { /* ignore */ }
  }

  // One-time correction for DBs (including production) seeded before this rate
  // policy existed — guarded so it never overwrites a rate an admin sets later
  // via /travel-expenses/rates. Also retires "Other" as a travel type.
  const ratesMigrationDone = db.prepare("SELECT value FROM settings WHERE key='rates_migration_2026_09'").get();
  if (!ratesMigrationDone) {
    db.prepare("UPDATE expense_rates SET rate_per_km=3 WHERE vehicle_type='Own Two Wheeler'").run();
    db.prepare("UPDATE expense_rates SET rate_per_km=5 WHERE vehicle_type='Own Four Wheeler'").run();
    db.prepare("DELETE FROM expense_rates WHERE vehicle_type='Other'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rates_migration_2026_09', '1')").run();
  }

  // Ensure EL and HD stay inactive even on existing DBs
  // Sick leave is not offered by company policy. Deactivated rather than deleted
  // because existing leave records reference it.
  db.prepare("UPDATE leave_types SET is_active=0 WHERE code IN ('EL','HD','SL')").run();

  // Sales (and its legacy alias "staff") no longer get Machine Quotations/Form 22 —
  // remove the row on existing DBs too, not just skip seeding it on fresh ones.
  db.prepare("DELETE FROM role_permissions WHERE role IN ('sales','staff') AND permission='quotations'").run();

  // Expense approvals now route only to the Head of Finance (and admin). Revoke
  // the old manager/hr approver rows on existing DBs so claims no longer land
  // in their queues. (head_of_finance's rows are added by seed.)
  db.prepare("DELETE FROM role_permissions WHERE role IN ('manager','hr') AND permission='expense_approval'").run();

  // One-time: attendance / odometer days used to be the UTC date, so a punch-in
  // before 5:30 am India time was filed under the previous day. Re-file them under
  // the India date (skipped if that user already has a row for that date).
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr_ist_dates_v1'").get()) {
    try {
      db.exec('BEGIN');
      const att = db.prepare(`UPDATE attendance SET date = date(check_in_time,'+330 minutes')
        WHERE check_in_time IS NOT NULL AND date <> date(check_in_time,'+330 minutes')
          AND NOT EXISTS (SELECT 1 FROM attendance a2 WHERE a2.user_id = attendance.user_id AND a2.date = date(attendance.check_in_time,'+330 minutes'))`).run();
      const jr = db.prepare(`UPDATE expense_journeys SET date = date(start_time,'+330 minutes')
        WHERE start_time IS NOT NULL AND date <> date(start_time,'+330 minutes')
          AND NOT EXISTS (SELECT 1 FROM expense_journeys j2 WHERE j2.user_id = expense_journeys.user_id AND j2.date = date(expense_journeys.start_time,'+330 minutes'))`).run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('migr_ist_dates_v1', ?)").run(`attendance ${att.changes}, journeys ${jr.changes}`);
      db.exec('COMMIT');
      if (att.changes || jr.changes) console.log(`India-time date fix: ${att.changes} attendance, ${jr.changes} journey rows re-dated.`);
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.error('India-time date fix failed:', e.message); }
  }

  // ── Employee IDs: 10001, 10002, … ───────────────────────────────────────────
  // Every user gets the next number when created. One-time: renumber everyone in
  // joining order (date of joining, then account creation); old codes are kept.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr_empcode_v1'").get()) {
    try {
      db.exec('BEGIN');
      const users = db.prepare(`SELECT id, employee_code FROM users
        ORDER BY (date_of_joining IS NULL OR date_of_joining = ''), date_of_joining, created_at, id`).all();
      const upd = db.prepare("UPDATE users SET old_employee_code = ?, employee_code = ? WHERE id = ?");
      users.forEach((u, i) => upd.run(u.employee_code || '', String(EMP_CODE_START + i), u.id));
      db.prepare("INSERT INTO settings (key, value) VALUES ('migr_empcode_v1', ?)").run(`${users.length} users renumbered`);
      db.exec('COMMIT');
      if (users.length) console.log(`Employee IDs renumbered from ${EMP_CODE_START} for ${users.length} users.`);
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.error('Employee ID renumbering failed:', e.message); }
  }

  // One-time (organisation chart, Nov 2026): place today's team in the chart
  // from their app role, so routing works from day one. Admin checks and moves
  // people on the Organisation Chart page. Managers and anyone whose role does
  // not map are left unplaced. Level 1: the admin named Govind, else 'admin'.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr_org_autoplace_v1'").get()) {
    const ROLE_TO_POSITION = {
      sales: 'sales_officer', staff: 'sales_officer', service: 'service_engineer', telecaller: 'sales_coordinator',
      office: 'store_parts_exec', accountant: 'accountant', accounts_manager: 'accounts_mgr',
      hr: 'payroll_hr_exec', employee: 'driver',
    };
    const pos = db.prepare('SELECT code, title, section FROM org_positions WHERE code=?');
    const place = db.prepare("UPDATE users SET position_code=?, designation=CASE WHEN COALESCE(designation,'')='' THEN ? ELSE designation END, department=CASE WHEN COALESCE(department,'')='' THEN ? ELSE department END WHERE id=?");
    const log = db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'position_auto', 'user', ?, ?)");
    const people = db.prepare("SELECT id, username, full_name, role FROM users WHERE COALESCE(position_code,'')='' AND COALESCE(is_hr_active,1)=1").all();
    const admins = people.filter(u => u.role === 'admin');
    const owner = admins.find(u => /govind/i.test(u.full_name + ' ' + u.username)) || admins.find(u => u.username === 'admin') || admins[0];
    let placed = 0;
    db.exec('BEGIN');
    try {
      for (const u of people) {
        const code = u === owner ? 'owner' : ROLE_TO_POSITION[u.role];
        const p = code && pos.get(code);
        if (!p) continue;
        place.run(p.code, p.title, p.section, u.id);
        log.run(String(u.id), `${u.full_name || u.username} (${u.role}) → ${p.title}`);
        placed++;
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('migr_org_autoplace_v1', ?)").run(`${placed} of ${people.length} placed`);
      db.exec('COMMIT');
      if (placed) console.log(`Organisation chart: placed ${placed} of ${people.length} people from their app role.`);
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.error('Organisation chart placement failed:', e.message); }
  }
}

module.exports = { migrate };
