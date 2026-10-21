// sw.js — Chatak's service worker. Push notifications only.
//
// There is deliberately no fetch handler and no cache: the app is served fresh
// every time, so a stale build can never hide behind the worker. It exists to
// receive pushes from the send-push edge function and to open the app on tap.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { title: 'Chatak', body: e.data ? e.data.text() : '' }; }
  const base = self.registration.scope;
  e.waitUntil(self.registration.showNotification(m.title || 'Chatak price alert', {
    body: m.body || '',
    tag: m.tag || 'chatak',
    icon: base + 'icons/icon-192.png',
    badge: base + 'icons/badge-96.png',
    data: { url: m.url || base + '#alerts' }
  }));
});

// Tap: reuse an open Chatak tab when there is one, else open a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '#alerts', self.registration.scope).href;
  const screen = new URL(url).hash.slice(1) || 'alerts';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) { open.postMessage({ chatak: 'open', screen }); return open.focus(); }
    return self.clients.openWindow(url);
  })());
});
