// Web push: phone / desktop notifications that arrive even when the app is closed.
// Server keys (VAPID) come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set;
// otherwise a pair is generated once and kept in push_state, so every device
// subscribed stays valid across restarts. Messages go out in each user's language.
const webpush = require('web-push');
const { db } = require('../db');
const i18n = require('./i18n');

let keys = null;
function vapidKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = db.prepare("SELECT value FROM push_state WHERE key='vapid'").get();
    keys = row ? JSON.parse(row.value) : webpush.generateVAPIDKeys();
    if (!row) db.prepare("INSERT INTO push_state (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://superallied.up.railway.app', keys.publicKey, keys.privateKey);
  return keys;
}
const publicKey = () => vapidKeys().publicKey;

function subscribe(userId, sub, userAgent = '') {
  const { endpoint, keys: k = {} } = sub || {};
  if (!/^https:\/\//.test(endpoint || '') || !k.p256dh || !k.auth) return false;
  // One device = one endpoint; if someone else logs in on it, it becomes theirs
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent`)
    .run(userId, endpoint, k.p256dh, k.auth, String(userAgent).slice(0, 200));
  return true;
}
const unsubscribe = (endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
const hasDevices = (userId) => !!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id=? LIMIT 1').get(userId);

// Tests replace this to capture what would be sent
let transport = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' });
const setTransport = (fn) => { transport = fn; };

// Send to every device of one user. Never throws; dead subscriptions are removed.
async function sendToUser(userId, { title, body = '', url = '/', tag = '' }) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  if (!subs.length) return 0;
  vapidKeys();
  const u = db.prepare('SELECT language FROM users WHERE id=?').get(userId);
  const t = i18n.translator(u?.language === 'hi' ? 'hi' : 'en');
  const payload = JSON.stringify({ title: t(title), body: t(body), url, tag });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      db.prepare('UPDATE push_subscriptions SET last_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(s.id);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint);  // device unsubscribed or app removed
      else console.error('Push failed:', e.statusCode || '', e.message);
    }
  }));
  return sent;
}
// Fire-and-forget form for request handlers
const notifyUser = (userId, msg) => { sendToUser(userId, msg).catch(() => {}); };

module.exports = { publicKey, subscribe, unsubscribe, hasDevices, sendToUser, notifyUser, setTransport };
