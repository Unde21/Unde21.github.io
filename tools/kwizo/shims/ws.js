// ws (the WebSocket server engine.io creates at start-up). In the page the
// Socket.io clients use HTTP long-polling, so no upgrade ever reaches it.
const EventEmitter = require('events');
class WebSocketServer extends EventEmitter {
  constructor(opts) { super(); this.options = opts || {}; this.clients = new Set(); }
  handleUpgrade(req, socket) { socket.destroy && socket.destroy(); }
  shouldHandle() { return false; }
  close(cb) { if (cb) cb(); }
}
class WebSocket extends EventEmitter {}
WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
module.exports = WebSocket;
Object.assign(module.exports, { WebSocket, WebSocketServer, Server: WebSocketServer, Receiver: class {}, Sender: class {} });
