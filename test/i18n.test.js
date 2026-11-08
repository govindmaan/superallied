// English / Hindi interface text (lib/i18n.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../lib/i18n');

const hi = i18n.translator('hi'), en = i18n.translator('en');

test('English is unchanged; Hindi uses the agreed glossary', () => {
  assert.strictEqual(en('Save'), 'Save');
  assert.strictEqual(hi('Save'), 'सुरक्षित करें');
  assert.strictEqual(hi('Leads'), 'संभावित ग्राहक');
  assert.strictEqual(hi('Assigned To'), 'जिम्मेदार कर्मचारी');
  assert.strictEqual(hi('Customer Name *'), 'ग्राहक का नाम *');
});

test('messages keep their values exactly as stored', () => {
  assert.strictEqual(hi('Quotation SA/Q/26-27/0042 created.'), 'कोटेशन SA/Q/26-27/0042 बना।');
  assert.strictEqual(hi('Status updated to won.'), 'स्थिति अपडेट हुई: won।');
  assert.strictEqual(hi('Customer "Ram Singh" deleted.'), 'ग्राहक "Ram Singh" हटाया गया।');
});

test('unknown text and data fall back to the original', () => {
  assert.strictEqual(hi('Ramesh Kumar, Sardhana'), 'Ramesh Kumar, Sardhana');
  assert.strictEqual(hi(''), '');
  assert.strictEqual(hi(null), null);
});

test('the browser script translates the same way', () => {
  const w = {};
  new Function('window', i18n.clientScript('hi'))(w);
  assert.strictEqual(w.T('Save'), 'सुरक्षित करें');
  assert.strictEqual(w.T('Quotation X created.'), 'कोटेशन X बना।');
});

test('dropdowns that submit their text always submit English', () => {
  // An <option> without value= sends its label; a translated label would put Hindi in the database
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.ejs') && files.push(p); } })(path.join(__dirname, '..', 'views'));
  const bad = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/<option\b((?:[^>%]|<%[\s\S]*?%>)*)>([\s\S]*?)<\/option>/g))
      if (!/\bvalue=/.test(m[1]) && /\bt\(/.test(m[2])) bad.push(path.basename(f) + ': ' + m[0].slice(0, 80));
  }
  assert.deepStrictEqual(bad, []);
});
