const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const { db } = require('../db');

const DB_PATH    = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quotation.db');
const DATA_DIR   = path.dirname(DB_PATH);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// List all backups
function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db') || f.endsWith('.zip'))
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
  if (!filename.endsWith('.db')) {
    req.session.flash = { error: 'Only .db files can be restored' };
    return res.redirect('/backup');
  }
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) {
    req.session.flash = { error: 'Backup file not found' };
    return res.redirect('/backup');
  }

  try {
    // Snapshot current state before overwriting (safety net)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeguard = path.join(BACKUP_DIR, `pre-restore-${ts}.db`);
    snapshotDb(safeguard);

    // The live database file can't be replaced while open; stage it and let
    // db.js swap it in on the next server start.
    fs.copyFileSync(src, DB_PATH + '.restore');

    req.session.flash = {
      success: `Restore from ${filename} is staged and will apply when the server restarts. Current state saved as ${path.basename(safeguard)}.`
    };
  } catch (e) {
    req.session.flash = { error: `Restore failed: ${e.message}` };
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
