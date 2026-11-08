// Opens the SQLite database (applying a restore staged from /backup first).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quotation.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Apply a restore staged from /backup before the database is opened
const RESTORE_PATH = DB_PATH + '.restore';
if (fs.existsSync(RESTORE_PATH)) {
  [DB_PATH + '-wal', DB_PATH + '-shm'].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  fs.renameSync(RESTORE_PATH, DB_PATH);
  console.log('Database restored from staged backup.');
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

module.exports = db;
