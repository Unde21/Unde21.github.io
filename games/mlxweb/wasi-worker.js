/*
 * wasi-worker.js — runs a command-line C program (WebAssembly, WASI) in a
 * Web Worker. pthreads are cooperative fibers (tools/mlxweb/mlx_fibers.c),
 * so no SharedArrayBuffer is needed; usleep() really waits.
 *
 * main → worker: { cmd: 'run', wasm: url, args: [...] }
 * worker → main: { cmd: 'out', fd, text } (batched), { cmd: 'exit', code },
 *                { cmd: 'error', message }
 * Stop a run with worker.terminate().
 */
'use strict';

class ExitStatus extends Error {
  constructor(code) { super('exit(' + code + ')'); this.code = code; }
}

const E = { BADF: 8, NOSYS: 52 };
const enc = new TextEncoder();
const dec = new TextDecoder();

onmessage = async (e) => {
  if (e.data.cmd !== 'run') return;
  try {
    const code = await run(e.data.wasm, e.data.args || []);
    postMessage({ cmd: 'exit', code });
  } catch (err) {
    postMessage({ cmd: 'error', message: String((err && err.stack) || err) });
  }
};

async function run(url, argv) {
  const bytes = await fetch(url).then((r) => {
    if (!r.ok) throw new Error('wasm ' + r.status);
    return r.arrayBuffer();
  });
  const args = ['program'].concat(argv);
  let ex, mem;
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  const now = () => performance.now();

  // ---- batched output
  const out = { 1: '', 2: '' };
  let lastFlush = now();
  function flush() {
    for (const fd of [1, 2]) if (out[fd]) { postMessage({ cmd: 'out', fd, text: out[fd] }); out[fd] = ''; }
    lastFlush = now();
  }

  const wasi = {
    args_sizes_get(c, s) {
      dv().setUint32(c, args.length, true);
      dv().setUint32(s, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return 0;
    },
    args_get(argvPtr, buf) {
      const v = dv();
      args.forEach((a, i) => {
        const b = enc.encode(a);
        v.setUint32(argvPtr + i * 4, buf, true);
        u8().set(b, buf); u8()[buf + b.length] = 0; buf += b.length + 1;
      });
      return 0;
    },
    environ_sizes_get(c, s) { dv().setUint32(c, 0, true); dv().setUint32(s, 0, true); return 0; },
    environ_get() { return 0; },
    clock_res_get(id, o) { dv().setBigUint64(o, 1000n, true); return 0; },
    clock_time_get(id, prec, o) {
      const ms = id === 0 ? performance.timeOrigin + now() : now();
      dv().setBigUint64(o, BigInt(Math.round(ms * 1e6)), true);
      return 0;
    },
    random_get(buf, len) { crypto.getRandomValues(u8().subarray(buf, buf + len)); return 0; },
    proc_exit(code) { throw new ExitStatus(code); },
    sched_yield() { return 0; },
    fd_write(fd, iov, n, nw) {
      const v = dv();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = v.getUint32(iov + i * 8, true), l = v.getUint32(iov + i * 8 + 4, true);
        if (fd === 1 || fd === 2) out[fd] += dec.decode(u8().slice(p, p + l));
        total += l;
      }
      v.setUint32(nw, total, true);
      if (now() - lastFlush > 30) flush();
      return 0;
    },
    fd_read(fd, iov, n, nr) { dv().setUint32(nr, 0, true); return 0; },
    fd_close() { return 0; },
    fd_seek() { return 70; },
    fd_fdstat_get(fd, o) {
      if (fd > 2) return E.BADF;
      const v = dv();
      v.setUint8(o, 2); v.setUint16(o + 2, 0, true);
      v.setBigUint64(o + 8, 0xffffffffffffffffn, true); v.setBigUint64(o + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_prestat_get() { return E.BADF; },
    poll_oneoff(inp, outp, nsubs, nev) {
      const v = dv();
      let wait = 0;
      for (let i = 0; i < nsubs; i++) {
        const s = inp + i * 48;
        if (v.getUint8(s + 8) === 0) wait = Math.max(wait, Number(v.getBigUint64(s + 24, true)) / 1e6);
      }
      const until = now() + wait;
      while (now() < until) { /* worker: blocking is fine */ }
      for (let i = 0; i < nsubs; i++) {
        const s = inp + i * 48, o = outp + i * 32;
        v.setBigUint64(o, v.getBigUint64(s, true), true);
        v.setUint16(o + 8, 0, true);
        v.setUint8(o + 10, v.getUint8(s + 8));
      }
      v.setUint32(nev, nsubs, true);
      return 0;
    },
  };

  // ---- fibers (same protocol as runtime.js)
  let state = 'normal';
  let cur = 0;
  let mainStarted = false;
  const saved = new Map();
  function unwind() {
    if (state === 'rewinding') { ex.asyncify_stop_rewind(); state = 'normal'; return; }
    const buf = ex.mlxweb_fiber_abuf(cur);
    const v = dv();
    v.setInt32(buf, buf + 8, true);
    v.setInt32(buf + 4, buf + ex.mlxweb_fiber_abuf_size(cur), true);
    ex.asyncify_start_unwind(buf);
    state = 'unwinding';
  }
  const mlxweb = new Proxy({
    now,
    fiber_switch: unwind,
    yield: unwind,
    can_block: () => 1,
  }, { get(t, k) { return k in t ? t[k] : () => 0; } });
  const wasiProxy = new Proxy(wasi, { get(t, k) { return k in t ? t[k] : () => E.NOSYS; } });

  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasiProxy, mlxweb });
  ex = instance.exports;
  mem = ex.memory;
  const sp = ex.__stack_pointer;
  if (!ex.mlxweb_fiber_start) throw new Error('This program was not built with FIBERS=1.');

  function next() {
    for (;;) {
      const n = ex.mlxweb_fiber_next();
      if (n >= 0) return n;
      const until = ex.mlxweb_fiber_wake_min();
      if (now() - lastFlush > 30) flush();
      while (now() < until) { /* every thread is in usleep() */ }
    }
  }

  let i = 0;
  try {
    for (;;) {
      cur = i;
      ex.mlxweb_fiber_set(i);
      const rewinding = (i === 0 && mainStarted) || (i !== 0 && ex.mlxweb_fiber_state(i) !== 1);
      if (rewinding) {
        sp.value = saved.get(i);
        ex.asyncify_start_rewind(ex.mlxweb_fiber_abuf(i));
        state = 'rewinding';
      } else if (i !== 0) {
        sp.value = ex.mlxweb_fiber_stack_top(i);
      }
      if (i === 0) { mainStarted = true; ex._start(); } else ex.mlxweb_fiber_start(i);
      if (state === 'unwinding') {
        ex.asyncify_stop_unwind();
        state = 'normal';
        saved.set(i, sp.value);
      } else if (i === 0) {
        flush();
        return 0;
      }
      i = next();
    }
  } catch (err) {
    flush();
    if (err instanceof ExitStatus) return err.code;
    throw err;
  }
}
