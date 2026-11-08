// English / Hindi. English text is the key: t('Save') returns the Hindi from
// i18n/hi.js, or the English when no translation exists. Keys may hold {name}
// placeholders ('Quotation {no} saved.'); these also match runtime messages
// built in routes, so flash and JSON messages translate without code changes.
// Only interface text goes through t(); stored data (names, remarks, statuses,
// roles) and all outputs (PDFs, Excel/CSV exports) stay English.
const crypto = require('crypto');
const HI = require('../i18n/hi');

const LANGS = { en: { label: 'English', locale: 'en-IN' }, hi: { label: 'हिंदी', locale: 'hi-IN' } };
const DEFAULT_LANG = 'en';
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

const exact = new Map(), lower = new Map(), patterns = [];
for (const [en, hi] of Object.entries(HI)) {
  const k = norm(en);
  if (/\{\w+\}/.test(k)) {
    const names = [];
    const src = k.split(/(\{\w+\})/).map(p => {
      const m = p.match(/^\{(\w+)\}$/);
      if (m) { names.push(m[1]); return '(.+?)'; }
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    patterns.push({ re: new RegExp('^' + src + '$'), names, hi, lit: k.replace(/\{\w+\}/g, '').length });
  }
  exact.set(k, hi);
  if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), hi);
}

patterns.sort((a, b) => b.lit - a.lit); // most specific first
const fill = (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;

// Hindi for one string, or null
const cache = new Map();
function lookupHi(s) {
  if (cache.has(s)) return cache.get(s);
  const k = norm(s);
  let out = exact.get(k) ?? lower.get(k.toLowerCase()) ?? null;
  if (out == null) {
    // "Name:" / "Name *" → translate "Name", keep the punctuation
    const m = k.match(/^(.*?)(\s*[:*]+)$/);
    if (m && m[1]) { const base = exact.get(m[1]) ?? lower.get(m[1].toLowerCase()); if (base != null) out = base + m[2]; }
  }
  if (out == null) {
    for (const p of patterns) {
      const m = k.match(p.re);
      if (!m) continue;
      const vars = {};
      p.names.forEach((n, i) => { vars[n] = m[i + 1]; }); // values (names, statuses) stay as stored
      out = fill(p.hi, vars);
      break;
    }
  }
  if (out != null && k !== s) out = s.match(/^\s*/)[0] + out + s.match(/\s*$/)[0];
  if (cache.size < 20000) cache.set(s, out);
  return out;
}

function translator(lang) {
  const hi = lang === 'hi';
  return (s, vars) => {
    if (s == null || s === '') return s;
    if (typeof s !== 'string') return s;
    return fill(hi ? (lookupHi(s) ?? s) : s, vars);
  };
}
// For text placed inside a single-quoted JS string in an HTML attribute (onclick="confirm('…')")
const jsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

// Language for a request: this device's choice (cookie), then the user's saved choice
function cookieLang(req) {
  const m = /(?:^|;\s*)lang=(en|hi)\b/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function pickLang(req, user) {
  const l = cookieLang(req) || user?.language;
  return LANGS[l] ? l : DEFAULT_LANG;
}

// Script served at /i18n/<lang>.js: window.T for alerts and text set by page scripts
const VERSION = crypto.createHash('md5').update(JSON.stringify(HI)).digest('hex').slice(0, 8);
function clientScript(lang) {
  const dict = lang === 'hi' ? HI : {};
  return `(function(){var L=${JSON.stringify(lang)},D=${JSON.stringify(dict)},E={},P=[];
for(var k in D){var n=k.replace(/\\s+/g,' ').trim();E[n]=D[k];E[n.toLowerCase()]=E[n.toLowerCase()]||D[k];
if(/\\{\\w+\\}/.test(n)){var names=[];var src=n.split(/(\\{\\w+\\})/).map(function(p){var m=p.match(/^\\{(\\w+)\\}$/);if(m){names.push(m[1]);return '(.+?)';}return p.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}).join('');P.push({re:new RegExp('^'+src+'$'),names:names,hi:D[k],lit:n.replace(/\\{\\w+\\}/g,'').length});}}P.sort(function(a,b){return b.lit-a.lit;});
function fill(s,v){return v?s.replace(/\\{(\\w+)\\}/g,function(m,k){return k in v?v[k]:m;}):s;}
function look(s){var k=s.replace(/\\s+/g,' ').trim();var o=E[k]||E[k.toLowerCase()];if(o==null){var m=k.match(/^(.*?)(\\s*[:*]+)$/);if(m&&m[1]&&(E[m[1]]||E[m[1].toLowerCase()]))o=(E[m[1]]||E[m[1].toLowerCase()])+m[2];}
if(o==null)for(var i=0;i<P.length;i++){var mm=k.match(P[i].re);if(mm){var v={};P[i].names.forEach(function(nm,j){v[nm]=mm[j+1];});o=fill(P[i].hi,v);break;}}return o;}
window.LANG=L;window.LOCALE=${JSON.stringify(LANGS[lang].locale)};
window.T=function(s,v){if(s==null||s==='')return s;s=String(s);return fill(L==='hi'?(look(s)||s):s,v);};})();`;
}

// Locals every template can rely on (English); a request's middleware overrides them
const defaultLocals = { t: translator('en'), tjs: jsEscape, lang: 'en', locale: 'en-IN', LANGS, i18nVersion: VERSION };

module.exports = { defaultLocals, LANGS, DEFAULT_LANG, translator, jsEscape, pickLang, clientScript, VERSION, lookupHi };
