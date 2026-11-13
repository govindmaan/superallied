// Help & Updates (changelog.js): well-formed, newest first, and every entry has Hindi.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const path = require('path');
const changelog = require('../changelog');
const hi = require('../i18n/changelog-hi');

const TYPES = ['new', 'improved', 'fixed', 'removed'];

test('every entry is well-formed and dates run newest first', () => {
  let prev = '9999-99-99';
  for (const day of changelog) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(day.date < prev, `${day.date} is out of order or repeated`);
    prev = day.date;
    assert.ok(day.items.length, `${day.date} has no items`);
    for (const it of day.items) {
      assert.ok(TYPES.includes(it.type), `${it.title}: type "${it.type}"`);
      assert.ok(it.title && Array.isArray(it.details), `${it.title}: needs a title and a details list`);
    }
  }
});

test('every entry has its Hindi title and the same number of details', () => {
  for (const day of changelog) for (const it of day.items) {
    assert.ok(hi[it.title], `No Hindi for "${it.title}" in i18n/changelog-hi.js`);
    assert.equal(hi[it.title].d.length, it.details.length, `Hindi details count for "${it.title}"`);
  }
});

test('the Help page is not behind the latest app change', (t) => {
  let last;
  try {
    // newest commit that is not tagged [no-help] (date in India time)
    last = execSync("git log -1 --invert-grep --grep='\\[no-help\\]' --format=%cd --date=format-local:%Y-%m-%d",
      { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: 'Asia/Kolkata' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return t.skip('no git history here'); }
  if (!last) return t.skip('no git history here');
  assert.ok(changelog[0].date >= last, `Latest change is ${last} but the newest Help entry is ${changelog[0].date}. Add it to changelog.js.`);
});
