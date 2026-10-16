// socket.io-client for the demo build: the app asks for WebSocket-only
// connections; in the page, the backend is reached over HTTP long-polling,
// which goes through the same XMLHttpRequest bridge as the REST calls.
const real = require('socket.io-client/dist/socket.io.js');
function io(uri, opts) {
  if (typeof uri === 'object') { opts = uri; uri = undefined; }
  return real.io(uri, { ...(opts || {}), transports: ['polling'], upgrade: false });
}
module.exports = { ...real, io, connect: io, default: io };
