// Coil Rush service worker: shows push notifications and opens the game when one is tapped.
// It deliberately does no caching, so every deploy is picked up immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Coil Rush', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin) {
        w.postMessage({ type: 'open', url });          // tell the game first, then bring it forward
        try { await w.focus(); } catch (e) {}
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
