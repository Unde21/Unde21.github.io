/*
 * runtime-worker.js — one pthread of a MiniLibX program (wasi-threads).
 * The main runtime pre-spawns a pool of these; each instantiates the same
 * module on the shared memory and runs wasi_thread_start(tid, arg) on demand.
 */
'use strict';
let ex = null;
let mem = null;
let mainOrigin = 0;
const dec = new TextDecoder();
const ENOSYS = 52;

class ExitStatus extends Error {
  constructor(code) { super('exit(' + code + ')'); this.code = code; }
}

function dv() { return new DataView(mem.buffer); }
function nowMain() { return performance.timeOrigin + performance.now() - mainOrigin; }

const wasi = {
  fd_write(fd, iov, n, out) {
    const v = dv();
    let total = 0;
    let s = '';
    for (let i = 0; i < n; i++) {
      const p = v.getUint32(iov + i * 8, true), l = v.getUint32(iov + i * 8 + 4, true);
      s += dec.decode(new Uint8Array(mem.buffer).slice(p, p + l));
      total += l;
    }
    if (fd === 1 || fd === 2) postMessage({ cmd: 'stdout', fd, text: s });
    v.setUint32(out, total, true);
    return 0;
  },
  clock_time_get(id, prec, out) {
    const ms = id === 0 ? performance.timeOrigin + performance.now() : nowMain();
    dv().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
    return 0;
  },
  clock_res_get(id, out) { dv().setBigUint64(out, 1000n, true); return 0; },
  random_get(buf, len) { crypto.getRandomValues(new Uint8Array(len)).forEach((b, i) => new Uint8Array(mem.buffer)[buf + i] = b); return 0; },
  sched_yield() { return 0; },
  proc_exit(code) { throw new ExitStatus(code); },
  fd_close() { return 0; },
  fd_fdstat_get() { return ENOSYS; },
  fd_prestat_get() { return 8; },
};
const wasiProxy = new Proxy(wasi, { get(t, k) { return k in t ? t[k] : () => ENOSYS; } });
const mlxweb = new Proxy({
  can_block() { return 1; },
  now() { return nowMain(); },
}, { get(t, k) { return k in t ? t[k] : () => 0; } });

onmessage = async (e) => {
  const msg = e.data;
  if (msg.cmd === 'init') {
    mem = msg.memory;
    mainOrigin = msg.timeOrigin;
    const inst = await WebAssembly.instantiate(msg.module, {
      env: { memory: mem },
      wasi_snapshot_preview1: wasiProxy,
      mlxweb,
      wasi: { 'thread-spawn': () => -1 },
    });
    ex = inst.exports;
    postMessage({ cmd: 'ready' });
  } else if (msg.cmd === 'run') {
    try {
      ex.wasi_thread_start(msg.tid, msg.arg);
      postMessage({ cmd: 'done', tid: msg.tid });
    } catch (err) {
      if (err instanceof ExitStatus) postMessage({ cmd: 'exit', code: err.code });
      else postMessage({ cmd: 'error', message: String(err && err.stack || err) });
    }
  }
};
