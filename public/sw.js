'use strict';
// Lets a phone install Claude Sessions as an app. Nothing is cached: sessions are
// live, so every request goes to the PC as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#0f1115;color:#e8eaef;padding:24px">' +
    '<h2>Can not reach your PC</h2><p>Check that Tailscale is connected on this phone and that the PC is on, then pull down to try again.</p>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
