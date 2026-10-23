// ── Private file storage for invoices and receipt PDFs ────────────────────────
// Files live outside the public /uploads folder (which any logged-in user can
// browse) and are only served through /accounts routes after a permission check.
// Uploads are checked by size, extension AND the file's own leading bytes.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { AccError } = require('./engine');

const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'quotation.db'));
const FILES_DIR = process.env.ACC_FILES_DIR || path.join(DATA_DIR, 'private', 'accounts');

const TYPES = {
  pdf: { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png',       magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg',      magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};
const EXT = { pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const NAME_RE = /^(inv|rct)-\d{13}-[0-9a-f]{16}\.(pdf|png|jpg)$/;

// upload = { data: base64 or data: URL, name }
function validateUpload(upload, maxMb = 10) {
  if (!upload?.data) throw new AccError('Attach the invoice file (PDF, JPG or PNG).');
  const name = String(upload.name || '').slice(0, 200);
  const ext = EXT[(name.split('.').pop() || '').toLowerCase()];
  if (!ext) throw new AccError('Only PDF, JPG and PNG files can be uploaded.');
  const b64 = String(upload.data).replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new AccError('The file could not be read. Try attaching it again.');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new AccError('The file is empty.');
  if (buf.length > maxMb * 1024 * 1024) throw new AccError(`The file is larger than ${maxMb} MB.`);
  const actual = Object.keys(TYPES).find(t => TYPES[t].magic(buf));
  if (!actual) throw new AccError('This is not a real PDF, JPG or PNG file.');
  if (actual !== ext) throw new AccError(`The file is named .${ext} but is actually a ${actual.toUpperCase()}. Rename or re-export it.`);
  return { buffer: buf, ext: actual, mime: TYPES[actual].mime, originalName: name.replace(/[^\w.\- ()]/g, '_') };
}

function store(buffer, ext, prefix = 'inv') {
  fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  const storedName = `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(FILES_DIR, storedName), buffer, { mode: 0o600, flag: 'wx' });
  return { storedName, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function filePath(storedName) {
  if (!NAME_RE.test(storedName || '')) return null;      // never a user-supplied path
  const p = path.join(FILES_DIR, storedName);
  return fs.existsSync(p) ? p : null;
}

function remove(storedName) {
  const p = filePath(storedName);
  if (p) fs.unlinkSync(p);
}

// ── Best-effort text from a text-based PDF (Tally exports usually are) ─────────
// Pulls strings out of the page content streams. Scans/images yield nothing.
function pdfText(buf) {
  const src = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src)) && out.length < 400) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    let body;
    try { body = zlib.inflateSync(raw).toString('latin1'); } catch (e) { body = raw.toString('latin1'); }
    if (!/T[Jj]/.test(body)) continue;
    const strs = [];
    body.replace(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]*)>\s*Tj|(T\*|Td|TD|ET)/g, (all, arr, single, hex, brk) => {
      if (brk) { strs.push('\n'); return ''; }
      if (hex !== undefined) { strs.push(fromHex(hex)); return ''; }
      const parts = arr !== undefined ? [...arr.matchAll(/\(((?:[^)\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>/g)].map(x => x[2] !== undefined ? fromHex(x[2]) : unescapePdf(x[1])) : [unescapePdf(single)];
      strs.push(parts.join(''));
      return '';
    });
    out.push(strs.join(''));
  }
  return out.join('\n').replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
// Hex strings in simple fonts are plain bytes; 2-byte glyph ids (CID fonts) cannot be read without the font's map
function fromHex(h) {
  const b = Buffer.from(h.replace(/\s+/g, '') + (h.replace(/\s+/g, '').length % 2 ? '0' : ''), 'hex').toString('latin1');
  return /^[\x20-\x7e\xa0-\xff\n\t]*$/.test(b) ? b : '';
}
function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (a, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function toIso(d) {
  let m = d.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3})[A-Za-z]*[-\/. ](\d{2,4})$/);
  let day, mon, yr;
  if (m) { day = +m[1]; mon = MONTHS[m[2].toLowerCase()]; yr = +m[3]; }
  else if ((m = d.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) { day = +m[1]; mon = +m[2]; yr = +m[3]; }
  else return null;
  if (yr < 100) yr += 2000;
  if (!mon || mon > 12 || day > 31) return null;
  return `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const amt = (s) => s ? s.replace(/,/g, '') : null;

// Suggestions only — the accountant confirms every value on the form.
function suggest(upload, ownGstin = '') {
  if (upload.ext !== 'pdf') return { found: false, note: 'Scanned image: no text to read. Enter the details from the invoice.' };
  let text = '';
  try { text = pdfText(upload.buffer); } catch (e) { text = ''; }
  if (text.length < 20) return { found: false, note: 'No readable text in this PDF (it may be a scan). Enter the details manually.' };
  const flat = text.replace(/\n/g, ' ');
  const gstins = [...new Set(flat.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g) || [])].filter(g => g !== ownGstin);
  const pick = (re) => { const x = flat.match(re); return x ? x[1].trim() : null; };
  const number = pick(/Invoice\s*No\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,30})/i) || pick(/Voucher\s*No\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,30})/i);
  const rawDate = pick(/(?:Dated|Invoice\s*Date|Date)\s*[:\-]?\s*(\d{1,2}[-\/. ](?:[A-Za-z]{3,9}|\d{1,2})[-\/. ]\d{2,4})/i);
  const money = '([\\d,]+\\.\\d{2})';
  return {
    found: true,
    invoice_number: number,
    invoice_date: rawDate ? toIso(rawDate) : null,
    customer_gstin: gstins[0] || null,
    basic_value: amt(pick(new RegExp('Taxable\\s*Value[^\\d]{0,40}' + money, 'i'))),
    gst_amount: amt(pick(new RegExp('Total\\s*Tax\\s*Amount[^\\d]{0,40}' + money, 'i'))),
    total_amount: amt(pick(new RegExp('(?:Grand\\s*)?Total[^\\d]{0,30}' + money + '(?![\\s\\S]*Total[^\\d]{0,30}[\\d,]+\\.\\d{2})', 'i'))),
    note: 'Read from the PDF text — unverified. Check each value against the invoice before saving.',
  };
}

module.exports = { validateUpload, store, filePath, remove, suggest, pdfText, FILES_DIR };
