// node:net / node:tls: no raw sockets in the browser.
const EventEmitter = require('events');
class Socket extends EventEmitter { connect() { throw new Error('raw sockets are not available in the demo'); } }
module.exports = { Socket, Server: class extends EventEmitter {}, createServer() { return new module.exports.Server(); },
  connect() { throw new Error('raw sockets are not available in the demo'); }, isIP: (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(':') ? 6 : 0),
  isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s), isIPv6: (s) => s.includes(':') };
