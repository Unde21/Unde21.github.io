// Serves the Expo web export and forwards /api, /socket.io, /upload to the backend.
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net');
const [root, port = '8790', backend = '8080'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
  if (/^\/(api|socket\.io|upload)\b/.test(req.url)) {
    const p = http.request({ host: '127.0.0.1', port: backend, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    return req.pipe(p);
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f)) f = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
srv.on('upgrade', (req, sock, head) => {
  const up = net.connect(backend, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head); sock.pipe(up).pipe(sock);
  });
  up.on('error', () => sock.destroy());
});
srv.listen(+port, () => console.log('devproxy on', port));
