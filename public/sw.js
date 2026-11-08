// Service worker: shows push notifications and opens the right page when one is tapped.
// It does not cache pages; the app always loads live from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Super Allied', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const same = wins.find((w) => w.url === url) || wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (same) return same.focus().then((w) => (w && w.url !== url && 'navigate' in w ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  }));
});
