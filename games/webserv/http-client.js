/*
 * http-client.js — the browser's side of an HTTP/1.1 exchange with a server
 * running in posix.js: send raw bytes on a virtual connection, read back one
 * response (Content-Length, chunked, or until the server closes), then close
 * the connection like a browser would.
 */
(function (global) {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const latin1 = new TextDecoder('latin1');

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of parts) { out.set(a, off); off += a.length; }
    return out;
  }
  function indexOfCRLF2(b, from) {
    for (let i = Math.max(0, from); i + 3 < b.length; i++) {
      if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
    }
    return -1;
  }
  function parseHead(text) {
    const lines = text.split('\r\n');
    // lenient: webserv echoes the request's version, so a request without one
    // gets ' 404 Not Found' back; the code is still read
    const m = /^(HTTP\/\d\.\d)?\s*(\d{3})\s*(.*)$/.exec(lines[0] || '');
    const headers = [];
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
    }
    return { version: m ? m[1] || '' : '', status: m ? +m[2] : 0, statusText: m ? m[3] : '', headers };
  }
  const header = (head, name) => {
    const h = head.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return h ? h[1] : null;
  };
  // Decode a chunked body; returns null while incomplete.
  function dechunk(b) {
    const out = [];
    let i = 0;
    for (;;) {
      let j = i;
      while (j + 1 < b.length && !(b[j] === 13 && b[j + 1] === 10)) j++;
      if (j + 1 >= b.length) return null;
      const size = parseInt(latin1.decode(b.subarray(i, j)).split(';')[0].trim(), 16);
      if (Number.isNaN(size)) return { body: concat(out), bad: true };
      i = j + 2;
      if (size === 0) {
        // trailers end with an empty line
        if (b.length >= i + 2 && b[i] === 13 && b[i + 1] === 10) return { body: concat(out) };
        return indexOfCRLF2(b, i - 2) >= 0 ? { body: concat(out) } : null;
      }
      if (b.length < i + size + 2) return null;
      out.push(b.subarray(i, i + size));
      i += size + 2;
    }
  }

  // exchange(net, port, request, { timeout, headOnly }) -> response
  async function exchange(net, port, request, options = {}) {
    const timeout = options.timeout || 15000;
    const t0 = performance.now();
    const conn = net.connect(port);
    conn.write(typeof request === 'string' ? enc.encode(request) : request);
    const parts = [];
    let buf = new Uint8Array(0), head = null, headEnd = -1, result = null, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; conn.close(); }, timeout);
    try {
      for (;;) {
        const chunk = await conn.read();
        if (!chunk) break; // server closed
        parts.push(chunk);
        buf = concat(parts);
        if (!head) {
          headEnd = indexOfCRLF2(buf, 0);
          if (headEnd < 0) continue;
          head = parseHead(latin1.decode(buf.subarray(0, headEnd)));
        }
        const body = buf.subarray(headEnd + 4);
        const te = (header(head, 'Transfer-Encoding') || '').toLowerCase();
        const cl = header(head, 'Content-Length');
        if (options.headOnly || head.status === 204 || head.status === 304 || (head.status >= 100 && head.status < 200)) { result = new Uint8Array(0); break; }
        if (te.includes('chunked')) { const d = dechunk(body); if (d) { result = d.body; break; } }
        else if (cl !== null) { if (body.length >= +cl) { result = body.subarray(0, +cl); break; } }
      }
    } finally {
      clearTimeout(timer);
      conn.close();
    }
    if (!head && buf.length) { headEnd = indexOfCRLF2(buf, 0); if (headEnd >= 0) head = parseHead(latin1.decode(buf.subarray(0, headEnd))); }
    if (head && !result) result = buf.subarray(headEnd + 4);
    return {
      ok: !!head,
      timedOut,
      ms: Math.round(performance.now() - t0),
      raw: buf,
      status: head ? head.status : 0,
      statusText: head ? head.statusText : '',
      version: head ? head.version : '',
      headers: head ? head.headers : [],
      header: (n) => (head ? header(head, n) : null),
      body: result || new Uint8Array(0),
      text: () => dec.decode(result || new Uint8Array(0)),
    };
  }

  global.HttpClient = { exchange, concat };
})(typeof window !== 'undefined' ? window : globalThis);
