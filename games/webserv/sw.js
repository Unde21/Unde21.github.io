/*
 * sw.js — lets an iframe browse a server running inside the page.
 *
 * The iframe lives under <scope>/<sid>/ (scope = games/webserv/net/). Every
 * request it makes — the page, its CSS, images, form posts — is caught here
 * and sent over a BroadcastChannel to the page that runs webserv
 * (webserv.html), which turns it into a raw HTTP request on the virtual
 * network and sends back webserv's answer.
 *
 * The site uses root paths ("/Dart", "/css/Global.css"). Subresources reach
 * this worker anyway (they come from a controlled iframe); for links, forms
 * and redirects a small script is added to HTML pages and Location headers
 * are rewritten, so navigation stays inside the scope.
 */
'use strict';

const SCOPE = new URL(self.registration.scope).pathname; // /games/webserv/net/
const channel = new BroadcastChannel('webserv-net');
const pending = new Map();
let nextId = 1;

channel.onmessage = (e) => {
  const m = e.data;
  if (m && m.type === 'response' && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function split(pathname) {
  const rest = pathname.slice(SCOPE.length);
  const i = rest.indexOf('/');
  return i < 0 ? { sid: rest, path: '/' } : { sid: rest.slice(0, i), path: rest.slice(i) };
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(SCOPE)) {
    const { sid, path } = split(url.pathname);
    if (!sid) return;
    event.respondWith(forward(event.request, sid, path + url.search));
    return;
  }
  // A root path ("/css/x.css") requested by one of our iframes.
  if (!event.clientId) return;
  event.respondWith((async () => {
    const client = await self.clients.get(event.clientId);
    const cu = client && new URL(client.url);
    if (!cu || !cu.pathname.startsWith(SCOPE)) return fetch(event.request);
    const { sid } = split(cu.pathname);
    return forward(event.request, sid, url.pathname + url.search);
  })());
});

function shim(prefix) {
  // Keeps links, forms and history inside the iframe's scope.
  return `<script>(function(){var P=${JSON.stringify(prefix)};
function fix(u){u=new URL(u,location.href);if(u.origin!==location.origin||u.pathname.indexOf(P)===0)return null;return P+u.pathname.slice(1)+u.search+u.hash;}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||(a.target&&a.target!=='_self'))return;var t=fix(a.href);if(t){e.preventDefault();location.href=t;}},true);
document.addEventListener('submit',function(e){var f=e.target,t=fix(f.getAttribute('action')||location.href);if(t)f.action=t;},true);
})();</script>`;
}

async function forward(request, sid, path) {
  const id = nextId++;
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers = [];
  for (const [k, v] of request.headers) headers.push([k, v]);
  const reply = new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 30000);
  });
  channel.postMessage({ type: 'request', id, sid, method: request.method, path, headers, body,
    navigate: request.mode === 'navigate', dest: request.destination });
  const m = await reply;
  const prefix = SCOPE + sid + '/';
  const isolate = { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (!m) {
    return new Response('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#111;color:#eee;padding:2rem">'
      + '<h1>Connection failed</h1><p>The webserv page is not running. Reload it to start the server again.</p>',
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', ...isolate } });
  }
  if (m.error) {
    return new Response('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#111;color:#eee;padding:2rem">'
      + '<h1>' + m.error + '</h1>', { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', ...isolate } });
  }
  const out = new Headers(isolate);
  let location = null;
  for (const [k, v] of m.headers) {
    const l = k.toLowerCase();
    if (['transfer-encoding', 'connection', 'content-length', 'keep-alive', 'set-cookie'].includes(l)) continue;
    if (l === 'location') { location = v; continue; }
    try { out.append(k, v); } catch (e) { /* invalid header from the server */ }
  }
  if (location !== null && m.status >= 300 && m.status < 400) {
    const target = new URL(location, 'http://x' + path);
    const inside = location.startsWith('http') ? location : prefix + target.pathname.slice(1) + target.search;
    return Response.redirect(new URL(inside, self.location.origin).href, [301, 302, 303, 307, 308].includes(m.status) ? m.status : 302);
  }
  let data = m.body;
  const type = (out.get('Content-Type') || '').toLowerCase();
  if (type.includes('text/html') && m.method !== 'HEAD' && data && data.byteLength) {
    const html = new TextDecoder().decode(data);
    const at = html.search(/<head[^>]*>/i);
    const s = shim(prefix);
    data = at >= 0 ? html.replace(/<head[^>]*>/i, (h) => h + s) : s + html;
  }
  const noBody = m.method === 'HEAD' || m.status === 204 || m.status === 304 || (m.status >= 100 && m.status < 200);
  const status = m.status >= 200 && m.status <= 599 ? m.status : 502;
  return new Response(noBody ? null : data, { status, statusText: m.statusText || '', headers: out });
}
