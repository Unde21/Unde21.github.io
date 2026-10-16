// Node globals for the bundled backend.
import { Buffer } from 'buffer';
import process from 'process';
import 'setimmediate';
globalThis.Buffer = globalThis.Buffer || Buffer;
// Node's internal Buffer methods that some parsers (busboy) call directly.
for (const enc of ['latin1', 'utf8', 'ascii', 'hex', 'base64', 'ucs2', 'utf16le']) {
  const P = Buffer.prototype;
  if (!P[enc + 'Slice']) P[enc + 'Slice'] = function (start = 0, end = this.length) { return this.toString(enc, start, end); };
  if (!P[enc + 'Write']) P[enc + 'Write'] = function (str, offset = 0, length) { return this.write(str, offset, length === undefined ? this.length - offset : length, enc); };
}
globalThis.process = globalThis.process || process;
if (!process.env) process.env = {};
if (!process.versions) process.versions = {};
if (!process.version) process.version = 'v22.0.0';
process.cwd = process.cwd || (() => '/');
process.hrtime = process.hrtime || ((prev) => { const t = performance.now(); const s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6); if (!prev) return [s, ns]; let ds = s - prev[0], dn = ns - prev[1]; if (dn < 0) { ds--; dn += 1e9; } return [ds, dn]; });
process.hrtime.bigint = process.hrtime.bigint || (() => BigInt(Math.floor(performance.now() * 1e6)));
process.memoryUsage = process.memoryUsage || (() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }));
process.emitWarning = process.emitWarning || (() => {});
process.stdout = process.stdout || { write: (s) => { console.log(String(s).replace(/\n$/, '')); return true; }, isTTY: false, columns: 120 };
process.stderr = process.stderr || { write: (s) => { console.warn(String(s).replace(/\n$/, '')); return true; }, isTTY: false };
process.exit = process.exit || ((c) => { throw new Error('process.exit(' + c + ')'); });
process.pid = process.pid || 1;
process.platform = process.platform || 'browser';
export { Buffer, process };

// Node-style timers inside the backend bundle (see timers.js), injected by
// esbuild in place of the globals; the app keeps the browser's.
import timers from './timers.js';
const { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate } = timers;
export { setTimeout, setInterval, clearTimeout, clearInterval };
