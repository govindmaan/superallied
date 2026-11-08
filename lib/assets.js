// File locations and images encoded once at startup.
const path = require('path');
const fs   = require('fs');
const ROOT = path.join(__dirname, '..');

const LETTERHEAD_PATH = path.join(ROOT, 'Super Allied Letterhead.pdf');

// ── File storage setup ────────────────────────────────────────────────────────
const DATA_DIR    = path.dirname(process.env.DB_PATH || path.join(ROOT, 'data', 'quotation.db'));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Pre-encode images once at startup
const LOGO_PATH = path.join(ROOT, 'public', 'bull-logo.jpg');
const BULL_LOGO_B64 = fs.existsSync(LOGO_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

const QR_PATH = path.join(ROOT, 'public', 'payment-qr.jpg');
const PAYMENT_QR_B64 = fs.existsSync(QR_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(QR_PATH).toString('base64')}` : '';

module.exports = { LETTERHEAD_PATH, DATA_DIR, UPLOADS_DIR, BULL_LOGO_B64, PAYMENT_QR_B64 };
