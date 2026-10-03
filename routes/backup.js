const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { execSync, execFileSync } = require('child_process');
const { db } = require('../db');

const DB_PATH    = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quotation.db');
const DATA_DIR   = path.dirname(DB_PATH);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// List all backups
function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db') || f.endsWith('.zip') || f.endsWith('.tar.gz'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Consistent copy of the live database (safe while the app is running)
function snapshotDb(destPath) {
  db.prepare('VACUUM INTO ?').run(destPath);
}

// ZIP the project source (excluding node_modules, data, .git and secrets)
function zipSource(destZip) {
  const root = path.join(__dirname, '..');
  // Use Node's child_process with PowerShell on Windows, zip on Linux
  const isWin = process.platform === 'win32';
  if (isWin) {
    execSync(
      `powershell -Command "Compress-Archive -Force -Path (Get-ChildItem -Force -Path '${root}' | Where-Object { @('node_modules','data','.git','.env','.env.local') -notcontains $_.Name }).FullName -DestinationPath '${destZip}'"`,
      { timeout: 30000 }
    );
  } else {
    execSync(
      `zip -r "${destZip}" . --exclude "./node_modules/*" --exclude "./data/*" --exclude "./.git/*" --exclude "./.env" --exclude "./.env.local"`,
      { cwd: root, timeout: 30000 }
    );
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Database + uploaded files in one .tar.gz, for moving to another server
function exportAll(destTar, uploadsDir) {
  const stage = path.join(BACKUP_DIR, `.stage-${Date.now()}`);
  fs.mkdirSync(stage);
  try {
    snapshotDb(path.join(stage, 'quotation.db'));
    if (fs.existsSync(uploadsDir)) fs.cpSync(uploadsDir, path.join(stage, 'uploads'), { recursive: true });
    execFileSync('tar', ['-czf', destTar, '-C', stage, '.'], { timeout: 120000 });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Stage a .db for restore on next start, saving the current state first
function stageRestore(srcDb) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(srcDb, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (header.toString('latin1') !== 'SQLite format 3\0') throw new Error('Not a valid database file');
  const safeguard = path.join(BACKUP_DIR, `pre-restore-${timestamp()}.db`);
  snapshotDb(safeguard);
  fs.copyFileSync(srcDb, DB_PATH + '.restore');
  return path.basename(safeguard);
}

// GET /backup — dashboard
router.get('/', (req, res) => {
  const backups = listBackups();
  res.render('backup', { title: 'Backup & Restore', backups });
});

// POST /backup/data — create DB backup
router.post('/data', (req, res) => {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `data-${ts}.db`);
    snapshotDb(dest);
    req.session.flash = { success: `Database backup created: data-${ts}.db` };
  } catch (e) {
    req.session.flash = { error: `Backup failed: ${e.message}` };
  }
  res.redirect('/backup');
});

// POST /backup/code — create source code ZIP
router.post('/code', (req, res) => {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `code-${ts}.zip`);
    zipSource(dest);
    req.session.flash = { success: `Code backup created: code-${ts}.zip` };
  } catch (e) {
    req.session.flash = { error: `Code backup failed: ${e.message}` };
  }
  res.redirect('/backup');
});

// POST /backup/full — create both
router.post('/full', (req, res) => {
  const errors = [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    snapshotDb(path.join(BACKUP_DIR, `data-${ts}.db`));
  } catch (e) { errors.push(`DB: ${e.message}`); }
  try {
    zipSource(path.join(BACKUP_DIR, `code-${ts}.zip`));
  } catch (e) { errors.push(`Code: ${e.message}`); }

  if (errors.length) {
    req.session.flash = { error: `Some backups failed: ${errors.join('; ')}` };
  } else {
    req.session.flash = { success: `Full backup created (data-${ts}.db + code-${ts}.zip)` };
  }
  res.redirect('/backup');
});

// POST /backup/export — database + uploaded files, for moving servers
router.post('/export', (req, res) => {
  try {
    const name = `migrate-${timestamp()}.tar.gz`;
    exportAll(path.join(BACKUP_DIR, name), req.app.locals.UPLOADS_DIR);
    req.session.flash = { success: `Export created: ${name}. Download it below.` };
  } catch (e) {
    req.session.flash = { error: `Export failed: ${e.message}` };
  }
  res.redirect('/backup');
});

// POST /backup/upload?name=... — receive a backup file from another server (raw body)
router.post('/upload', express.raw({ type: '*/*', limit: '2gb' }), (req, res) => {
  const original = path.basename(String(req.query.name || ''));
  const ext = original.endsWith('.tar.gz') ? '.tar.gz' : original.endsWith('.db') ? '.db' : null;
  if (!ext || !req.body || !req.body.length) {
    return res.status(400).json({ error: 'Choose a .db or .tar.gz backup file' });
  }
  const name = `uploaded-${timestamp()}${ext}`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), req.body);
  req.session.flash = { success: `Uploaded as ${name}. Click Restore on it below.` };
  res.json({ ok: true });
});

// GET /backup/download/:filename — download a backup file
router.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // sanitize
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('Backup not found');
  }
  res.download(filepath, filename);
});

// POST /backup/restore/:filename — restore DB from a .db backup
router.post('/restore/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const isTar = filename.endsWith('.tar.gz');
  if (!filename.endsWith('.db') && !isTar) {
    req.session.flash = { error: 'Only .db or .tar.gz files can be restored' };
    return res.redirect('/backup');
  }
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) {
    req.session.flash = { error: 'Backup file not found' };
    return res.redirect('/backup');
  }

  const extract = path.join(BACKUP_DIR, `.extract-${Date.now()}`);
  try {
    // The live database file can't be replaced while open; stageRestore puts it
    // aside and db.js swaps it in on the next server start.
    let safeguard, filesNote = '';
    if (isTar) {
      fs.mkdirSync(extract);
      execFileSync('tar', ['-xzf', src, '-C', extract], { timeout: 120000 });
      const dbFile = path.join(extract, 'quotation.db');
      if (!fs.existsSync(dbFile)) throw new Error('Archive has no quotation.db');
      safeguard = stageRestore(dbFile);
      const uploads = path.join(extract, 'uploads');
      if (fs.existsSync(uploads)) {
        fs.cpSync(uploads, req.app.locals.UPLOADS_DIR, { recursive: true, force: true });
        filesNote = ' Uploaded photos/files copied.';
      }
    } else {
      safeguard = stageRestore(src);
    }

    req.session.flash = {
      success: `Restore from ${filename} is staged and will apply when the server restarts.${filesNote} Current state saved as ${safeguard}.`
    };
  } catch (e) {
    req.session.flash = { error: `Restore failed: ${e.message}` };
  } finally {
    fs.rmSync(extract, { recursive: true, force: true });
  }
  res.redirect('/backup');
});

// POST /backup/delete/:filename — delete a backup
router.post('/delete/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    req.session.flash = { success: `Deleted backup: ${filename}` };
  } catch (e) {
    req.session.flash = { error: `Delete failed: ${e.message}` };
  }
  res.redirect('/backup');
});

module.exports = router;
