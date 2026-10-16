// node:http for the browser, without a network: http.createServer() gives a
// server that Express and engine.io (Socket.io) attach to as usual, and
// globalThis.__kwizoHttp.request() hands it a request from the page.
const EventEmitter = require('events');
const { Readable, Writable } = require('stream');

const METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE',
  'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE',
  'PUT', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];
const STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function fakeSocket() {
  const s = new EventEmitter();
  Object.assign(s, {
    remoteAddress: '127.0.0.1', remotePort: 40000, localAddress: '127.0.0.1', localPort: 80, encrypted: false,
    readable: true, writable: true, destroyed: false,
    setTimeout() { return s; }, setNoDelay() { return s; }, setKeepAlive() { return s; },
    destroy() { s.destroyed = true; return s; }, end() {}, write() { return true; }, address: () => ({ port: 80, address: '127.0.0.1' }),
  });
  return s;
}

class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = this.connection = socket || fakeSocket();
    this.httpVersion = '1.1'; this.httpVersionMajor = 1; this.httpVersionMinor = 1;
    this.headers = {}; this.rawHeaders = []; this.trailers = {}; this.rawTrailers = [];
    this.method = 'GET'; this.url = '/'; this.complete = false; this.aborted = false;
  }
  _read() {}
  setTimeout() { return this; }
}

class OutgoingMessage extends Writable {
  constructor() {
    super();
    this._hdrs = Object.create(null);
    this._names = Object.create(null);
    this.headersSent = false;
    this.finished = false;
    this.sendDate = true;
    this.chunkedEncoding = false;
    this.socket = this.connection = fakeSocket();
  }
  setHeader(name, value) {
    if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent to the client');
    const k = String(name).toLowerCase();
    this._hdrs[k] = value; this._names[k] = name;
    return this;
  }
  appendHeader(name, value) {
    const prev = this.getHeader(name);
    return this.setHeader(name, prev === undefined ? value : [].concat(prev, value));
  }
  getHeader(name) { return this._hdrs[String(name).toLowerCase()]; }
  getHeaders() { return Object.assign(Object.create(null), this._hdrs); }
  getHeaderNames() { return Object.keys(this._hdrs); }
  getRawHeaderNames() { return Object.keys(this._hdrs).map((k) => this._names[k]); }
  hasHeader(name) { return String(name).toLowerCase() in this._hdrs; }
  removeHeader(name) { const k = String(name).toLowerCase(); delete this._hdrs[k]; delete this._names[k]; }
  flushHeaders() { this.headersSent = true; }
  setTimeout() { return this; }
}

class ServerResponse extends OutgoingMessage {
  constructor(req) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this._chunks = [];
    this.on('finish', () => { this.finished = true; });
  }
  writeHead(code, msg, headers) {
    if (typeof msg !== 'string') { headers = msg; msg = undefined; }
    this.statusCode = code;
    if (msg) this.statusMessage = msg;
    if (Array.isArray(headers)) { for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]); }
    else if (headers) for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
    this.headersSent = true;
    return this;
  }
  _write(chunk, enc, cb) {
    this.headersSent = true;
    this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : Buffer.from(chunk));
    cb();
  }
  end(chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    this.headersSent = true;
    return super.end(chunk === undefined || chunk === null ? undefined : chunk, enc, cb);
  }
  get body() { return Buffer.concat(this._chunks); }
  assignSocket() {} detachSocket() {} writeContinue() {} writeProcessing() {} addTrailers() {}
}

const servers = new Map(); // port -> Server
class Server extends EventEmitter {
  constructor(opts, onRequest) {
    super();
    if (typeof opts === 'function') onRequest = opts;
    if (onRequest) this.on('request', onRequest);
    this.listening = false;
    this.timeout = 0; this.keepAliveTimeout = 5000; this.headersTimeout = 60000; this.requestTimeout = 0;
  }
  listen(...args) {
    const cb = args.find((a) => typeof a === 'function');
    const port = typeof args[0] === 'object' && args[0] ? args[0].port : args[0];
    this._port = +port || 80;
    servers.set(this._port, this);
    this.listening = true;
    Promise.resolve().then(() => { this.emit('listening'); if (cb) cb(); });
    return this;
  }
  address() { return { port: this._port, family: 'IPv4', address: '127.0.0.1' }; }
  close(cb) { servers.delete(this._port); this.listening = false; Promise.resolve().then(() => { this.emit('close'); if (cb) cb(); }); return this; }
  setTimeout() { return this; }
  ref() { return this; } unref() { return this; }
  closeAllConnections() {} closeIdleConnections() {}
}
function createServer(opts, onRequest) { return new Server(opts, onRequest); }

// The page's side: one request, resolved with the complete response.
function request({ port = 80, method = 'GET', url = '/', headers = {}, body = null }) {
  const server = servers.get(port) || servers.values().next().value;
  if (!server) return Promise.reject(new Error('backend is not listening'));
  return new Promise((resolve) => {
    const req = new IncomingMessage();
    req.method = method.toUpperCase();
    req.url = url;
    for (const [k, v] of Object.entries(headers)) { req.headers[k.toLowerCase()] = v; req.rawHeaders.push(k, v); }
    const bytes = body ? Buffer.from(body) : null;
    if (bytes && req.headers['content-length'] === undefined) req.headers['content-length'] = String(bytes.length);
    const res = new ServerResponse(req);
    res.on('finish', () => {
      const out = {};
      for (const k of Object.keys(res._hdrs)) out[k] = res._hdrs[k];
      resolve({ status: res.statusCode, statusText: res.statusMessage || STATUS_CODES[res.statusCode] || '', headers: out, body: res.body });
    });
    server.emit('request', req, res);
    Promise.resolve().then(() => {
      if (bytes && bytes.length) req.push(bytes);
      req.complete = true;
      req.push(null);
    });
  });
}

class Agent { constructor() {} destroy() {} }
const notSupported = () => { throw new Error('outgoing HTTP is not available in the demo'); };
globalThis.__kwizoHttp = { request, servers };

module.exports = {
  METHODS, STATUS_CODES, IncomingMessage, OutgoingMessage, ServerResponse, Server, createServer, Agent,
  globalAgent: new Agent(), request: notSupported, get: notSupported, validateHeaderName() {}, validateHeaderValue() {},
  maxHeaderSize: 16384,
};
