/*
 * kwizo-sw.js — images and other files the app loads from https://kwizo.demo
 * (avatars, quiz pictures: <img src>, which XMLHttpRequest never sees). The
 * worker asks the page that made the request; the page gets the file from
 * the backend running inside it and sends the bytes back.
 */
'use strict';
const HOST = 'kwizo.demo';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.host !== HOST) return;
  event.respondWith((async () => {
    const client = event.clientId && await self.clients.get(event.clientId);
    if (!client) return new Response('no page to answer', { status: 503 });
    const chan = new MessageChannel();
    const reply = new Promise((resolve) => {
      chan.port1.onmessage = (m) => resolve(m.data);
      setTimeout(() => resolve(null), 20000);
    });
    const body = ['GET', 'HEAD'].includes(event.request.method) ? null : await event.request.arrayBuffer();
    client.postMessage({ kwizo: 'fetch', method: event.request.method, url: url.href, body }, [chan.port2]);
    const r = await reply;
    if (!r) return new Response('timeout', { status: 504 });
    const h = new Headers(r.headers || {});
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers: h });
  })());
});
