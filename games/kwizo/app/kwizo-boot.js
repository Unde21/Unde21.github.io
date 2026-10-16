/*
 * boot.js — loaded before the Kwizo web app. Starts the real backend inside
 * the page and sends it every request the app makes to https://kwizo.demo
 * (the backend URL the app is built with): REST calls through axios, and
 * Socket.io in long-polling mode. Both go through XMLHttpRequest, so a small
 * XMLHttpRequest stand-in carries them to the backend's virtual HTTP server.
 */
(function () {
  'use strict';
  var HOST = 'kwizo.demo';
  var base = (document.currentScript && document.currentScript.src) || location.href;
  var ASSETS = new URL('../', base).href;          // games/kwizo/
  var DB_NAME = 'kwizo-demo';
  var SEED_VERSION = '1';

  function setStatus(s) { try { window.parent.postMessage({ kwizo: 'status', status: s }, '*'); } catch (e) { /* not framed */ } }

  // ---------------------------------------------------------------- backend
  async function hasDb() {
    try {
      if (localStorage.getItem('kwizo-demo-seed') !== SEED_VERSION) return false;
      if (!indexedDB.databases) return false;
      return (await indexedDB.databases()).some(function (d) { return d.name === '/pglite/' + DB_NAME; });
    } catch (e) { return false; }
  }
  async function start() {
    setStatus('loading');
    var mod = await import(ASSETS + 'backend.js');
    // One tab owns the stored database; another tab gets a fresh copy in memory.
    var persist = !!(navigator.locks && window.indexedDB);
    if (persist) {
      persist = await new Promise(function (resolve) {
        navigator.locks.request('kwizo-demo-db', { ifAvailable: true }, function (lock) {
          resolve(!!lock);
          return lock ? new Promise(function () {}) : null; // keep it for the page's life
        });
      });
    }
    var existing = persist && (await hasDb());
    var seed = existing ? null : await (await fetch(ASSETS + 'kwizo-seed.tar.gz')).blob();
    var be = await mod.startBackend({ dataDir: persist ? 'idb://' + DB_NAME : 'memory://', loadDataDir: seed || undefined, filesDb: persist ? DB_NAME + '-files' : undefined });
    if (persist && !existing) { try { localStorage.setItem('kwizo-demo-seed', SEED_VERSION); } catch (e) { /* private mode */ } }
    setStatus('ready');
    return be;
  }
  var ready = start().catch(function (e) { console.error('[kwizo] backend failed', e); setStatus('error'); throw e; });
  window.__kwizoBackend = ready;

  // ---------------------------------------------------------------- cookies
  var JAR_KEY = 'kwizo-demo-cookies';
  function jar() { try { return JSON.parse(localStorage.getItem(JAR_KEY) || '{}'); } catch (e) { return {}; } }
  function saveJar(j) { try { localStorage.setItem(JAR_KEY, JSON.stringify(j)); } catch (e) { /* ignore */ } }
  function keepCookies(setCookie) {
    if (!setCookie) return;
    var j = jar();
    [].concat(setCookie).forEach(function (c) {
      var parts = String(c).split(';'), kv = parts[0], i = kv.indexOf('=');
      var name = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim();
      var expired = parts.some(function (p) { return /^\s*max-age\s*=\s*(0|-)/i.test(p) || (/^\s*expires\s*=/i.test(p) && Date.parse(p.split('=')[1]) < Date.now()); });
      if (expired || !value) delete j[name]; else j[name] = value;
    });
    saveJar(j);
  }
  function cookieHeader() { var j = jar(); return Object.keys(j).map(function (k) { return k + '=' + j[k]; }).join('; '); }

  // ---------------------------------------------------------------- transport
  async function bodyBytes(body, headers) {
    if (body == null) return null;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof Blob) { if (body.type && !headers['content-type']) headers['content-type'] = body.type; return new Uint8Array(await body.arrayBuffer()); }
    if (body instanceof FormData || body instanceof URLSearchParams) {
      var r = new Response(body);
      headers['content-type'] = r.headers.get('content-type');
      return new Uint8Array(await r.arrayBuffer());
    }
    return new TextEncoder().encode(String(body));
  }
  async function send(method, url, headers, body) {
    var be = await ready;
    var h = {};
    Object.keys(headers).forEach(function (k) { h[k.toLowerCase()] = headers[k]; });
    var bytes = await bodyBytes(body, h);
    h.host = HOST;
    h.origin = h.origin || location.origin;
    var c = cookieHeader();
    if (c) h.cookie = c;
    var u = new URL(url);
    var res = await be.request({ method: method, url: u.pathname + u.search, headers: h, body: bytes });
    keepCookies(res.headers['set-cookie']);
    return res;
  }
  window.__kwizoSend = send;

  var RealXHR = window.XMLHttpRequest;
  function ours(url) { try { return new URL(url, location.href).host === HOST; } catch (e) { return false; } }

  function FakeXHR() {
    this._real = null;
    this._listeners = {};
    this.readyState = 0; this.status = 0; this.statusText = '';
    this.responseType = ''; this.response = null; this.responseText = ''; this.responseURL = '';
    this.timeout = 0; this.withCredentials = false;
    this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
    this._headers = {}; this._resHeaders = {};
  }
  var EVENTS = ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'loadstart', 'progress'];
  FakeXHR.UNSENT = 0; FakeXHR.OPENED = 1; FakeXHR.HEADERS_RECEIVED = 2; FakeXHR.LOADING = 3; FakeXHR.DONE = 4;
  FakeXHR.prototype.addEventListener = function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); if (this._real) this._real.addEventListener(t, f); };
  FakeXHR.prototype.removeEventListener = function (t, f) { var l = this._listeners[t] || []; var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); if (this._real) this._real.removeEventListener(t, f); };
  FakeXHR.prototype._fire = function (t) {
    var ev = { type: t, target: this, currentTarget: this, lengthComputable: false, loaded: 0, total: 0 };
    if (typeof this['on' + t] === 'function') this['on' + t](ev);
    (this._listeners[t] || []).slice().forEach(function (f) { f.call(this, ev); }, this);
  };
  FakeXHR.prototype.open = function (method, url, async) {
    this._method = method; this._url = new URL(url, location.href).href;
    if (!ours(this._url)) {
      var self = this, r = this._real = new RealXHR();
      Object.keys(this._listeners).forEach(function (t) { self._listeners[t].forEach(function (f) { r.addEventListener(t, f); }); });
      EVENTS.forEach(function (t) {
        r['on' + t] = function (ev) {
          ['readyState', 'status', 'statusText', 'response', 'responseURL'].forEach(function (k) { try { self[k] = r[k]; } catch (e) { /* not ready */ } });
          try { if (r.responseType === '' || r.responseType === 'text') self.responseText = r.responseText; } catch (e) { /* binary */ }
          if (typeof self['on' + t] === 'function') self['on' + t](ev);
        };
      });
      r.open(method, url, async !== false);
      return;
    }
    this.readyState = 1; this._fire('readystatechange');
  };
  FakeXHR.prototype.setRequestHeader = function (k, v) { if (this._real) return this._real.setRequestHeader(k, v); this._headers[k] = v; };
  FakeXHR.prototype.overrideMimeType = function (m) { if (this._real) this._real.overrideMimeType(m); };
  FakeXHR.prototype.getResponseHeader = function (k) {
    if (this._real) return this._real.getResponseHeader(k);
    var v = this._resHeaders[String(k).toLowerCase()];
    return v === undefined ? null : [].concat(v).join(', ');
  };
  FakeXHR.prototype.getAllResponseHeaders = function () {
    if (this._real) return this._real.getAllResponseHeaders();
    var h = this._resHeaders;
    return Object.keys(h).filter(function (k) { return k !== 'set-cookie'; }).map(function (k) { return k + ': ' + [].concat(h[k]).join(', '); }).join('\r\n');
  };
  FakeXHR.prototype.abort = function () {
    if (this._real) return this._real.abort();
    this._aborted = true;
    if (this.readyState > 0 && this.readyState < 4) { this.readyState = 4; this._fire('readystatechange'); this._fire('abort'); this._fire('loadend'); }
  };
  FakeXHR.prototype.send = function (body) {
    if (this._real) { this._real.timeout = this.timeout; this._real.withCredentials = this.withCredentials; if (this.responseType) this._real.responseType = this.responseType; return this._real.send(body); }
    var self = this;
    this._fire('loadstart');
    var timer = this.timeout ? setTimeout(function () { if (self.readyState !== 4) { self._aborted = true; self.readyState = 4; self._fire('timeout'); self._fire('loadend'); } }, this.timeout) : null;
    send(this._method, this._url, this._headers, body).then(function (res) {
      if (timer) clearTimeout(timer);
      if (self._aborted) return;
      self.status = res.status; self.statusText = res.statusText; self._resHeaders = res.headers; self.responseURL = self._url;
      self.readyState = 2; self._fire('readystatechange');
      var bytes = new Uint8Array(res.body);
      var text = function () { return new TextDecoder().decode(bytes); };
      var type = self.responseType;
      if (type === 'arraybuffer') self.response = bytes.slice().buffer;
      else if (type === 'blob') self.response = new Blob([bytes], { type: [].concat(res.headers['content-type'] || '')[0] });
      else if (type === 'json') { try { self.response = JSON.parse(text()); } catch (e) { self.response = null; } }
      else { self.responseText = text(); self.response = self.responseText; }
      self.readyState = 3; self._fire('readystatechange');
      self.readyState = 4; self._fire('readystatechange');
      self._fire('load'); self._fire('loadend');
    }, function (err) {
      if (timer) clearTimeout(timer);
      console.error('[kwizo] request failed', self._method, self._url, err);
      if (self._aborted) return;
      self.readyState = 4; self.status = 0; self._fire('readystatechange'); self._fire('error'); self._fire('loadend');
    });
  };
  window.XMLHttpRequest = FakeXHR;

  // Files the app loads as <img src="https://kwizo.demo/..."> come through
  // the service worker (kwizo-sw.js), which asks this page for them.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || m.kwizo !== 'fetch' || !e.ports[0]) return;
      send(m.method, m.url, {}, m.body).then(function (res) {
        var h = {};
        Object.keys(res.headers).forEach(function (k) { if (k !== 'set-cookie') h[k] = [].concat(res.headers[k]).join(', '); });
        var buf = new Uint8Array(res.body).slice().buffer;
        e.ports[0].postMessage({ status: res.status, headers: h, body: buf }, [buf]);
      }, function () { e.ports[0].postMessage({ status: 502, headers: {}, body: null }); });
    });
    navigator.serviceWorker.register(new URL('kwizo-sw.js', base).href, { scope: new URL('./', base).pathname }).catch(function (e) { console.warn('[kwizo] no service worker, uploaded images will not show', e); });
  }

  // fetch() to the backend host goes the same way.
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!ours(url)) return realFetch(input, init);
    var req = new Request(input, init);
    var headers = {};
    req.headers.forEach(function (v, k) { headers[k] = v; });
    return (['GET', 'HEAD'].indexOf(req.method) >= 0 ? Promise.resolve(null) : req.arrayBuffer()).then(function (b) {
      return send(req.method, req.url, headers, b);
    }).then(function (res) {
      var h = new Headers();
      Object.keys(res.headers).forEach(function (k) { if (k !== 'set-cookie') [].concat(res.headers[k]).forEach(function (v) { h.append(k, v); }); });
      return new Response([101, 204, 205, 304].indexOf(res.status) >= 0 ? null : res.body, { status: res.status, statusText: res.statusText, headers: h });
    });
  };
})();
