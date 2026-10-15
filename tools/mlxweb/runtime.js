/*
 * runtime.js — browser runtime for MiniLibX programs compiled to WebAssembly.
 *
 * Provides: a minimal WASI (files bundled with the game, stdout/stderr,
 * clocks), the canvas side of mlx_web.c, X11-style keyboard/mouse events,
 * and the Asyncify glue that lets mlx_loop() yield once per frame.
 *
 * Usage:
 *   const game = await MlxWeb.start({
 *     canvas, wasm: 'game.wasm', assets: 'assets', args: ['maps/x.ber'],
 *     loopRate: 0, mouse: 'absolute' | 'relative', onExit, onStdout,
 *   });
 */
(function (global) {
  'use strict';

  const E = { SUCCESS: 0, ACCES: 2, BADF: 8, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, SPIPE: 70 };

  class ExitStatus extends Error {
    constructor(code) { super('exit(' + code + ')'); this.code = code; }
  }

  // ---------------------------------------------------------------- keys
  const SPECIAL = {
    Escape: 0xff1b, Enter: 0xff0d, NumpadEnter: 0xff8d, Tab: 0xff09, Backspace: 0xff08,
    Delete: 0xffff, Space: 0x20, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53,
    ArrowDown: 0xff54, ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3,
    ControlRight: 0xffe4, AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb,
    MetaRight: 0xffec, CapsLock: 0xffe5, Home: 0xff50, End: 0xff57, PageUp: 0xff55,
    PageDown: 0xff56,
  };
  // Punctuation keys send their character; this is only the fallback when the
  // browser gives no printable key (e.g. a dead key).
  const PUNCT = { Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b, BracketRight: 0x5d,
    Semicolon: 0x3b, Quote: 0x27, Backquote: 0x60, Backslash: 0x5c, Comma: 0x2c,
    Period: 0x2e, Slash: 0x2f, IntlBackslash: 0x3c };
  for (let i = 1; i <= 12; i++) SPECIAL['F' + i] = 0xffbe + i - 1;

  // Gameplay keys follow their physical position, so WASD-style controls sit
  // under the same fingers on any layout (ZQSD on AZERTY). Every other key
  // sends the character printed on it, like X11 does, so M is M and typed
  // words (cheat codes) work. See keyEvents() for keys that differ.
  const POSITIONAL = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV']);

  function positionSym(code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) + 32;
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (/^Numpad[0-9]$/.test(code)) return 0xffb0 + (code.charCodeAt(6) - 48);
    return PUNCT[code] || 0;
  }

  function charSym(e) {
    if (!e.key || [...e.key].length !== 1) return 0;
    const c = e.key.toLowerCase().codePointAt(0);
    if (c < 0x20 || c === 0x7f) return 0;
    return c <= 0xff ? c : 0x01000000 + c;
  }

  // Returns [primary, extra]: primary is held like a real key; extra (the
  // typed character, when it differs) is sent as a quick press + release, so
  // it counts for typed sequences without moving or acting in the game.
  function keyEvents(e, positional) {
    if (SPECIAL[e.code] !== undefined) return [SPECIAL[e.code], 0];
    const ch = charSym(e);
    let primary;
    if (positional.has(e.code) || /^(Digit|Numpad)[0-9]$/.test(e.code)) primary = positionSym(e.code);
    else primary = ch || positionSym(e.code);
    return [primary, ch && ch !== primary ? ch : 0];
  }

  function keysym(e) {
    return keyEvents(e, POSITIONAL)[0];
  }

  // ---------------------------------------------------------------- assets
  async function loadAssets(base, onProgress) {
    const files = new Map();
    if (!base) return files;
    const index = await fetch(base + '.json').then((r) => { if (!r.ok) throw new Error('assets index ' + r.status); return r.json(); });
    let resp;
    if (index.parts) {
      // Large packs are split in chunks (hosting limits); stream them back to back.
      const urls = index.parts.map((n) => base + n);
      let i = 0, reader = null;
      resp = new Response(new ReadableStream({
        async pull(c) {
          for (;;) {
            if (!reader) {
              if (i >= urls.length) { c.close(); return; }
              const r = await fetch(urls[i++]);
              if (!r.ok) throw new Error('assets data ' + r.status);
              if (index.b64) {
                const bin = atob((await r.text()).trim());
                const bytes = new Uint8Array(bin.length);
                for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
                c.enqueue(bytes);
                return;
              }
              reader = r.body.getReader();
            }
            const { done, value } = await reader.read();
            if (done) { reader = null; continue; }
            c.enqueue(value); return;
          }
        },
      }));
    } else {
      resp = await fetch(base + (index.b64 ? '.pak.txt' : index.gzip ? '.pak' : '.bin'));
    }
    if (!resp.ok) throw new Error('assets data ' + resp.status);
    if (index.b64 && !index.parts) {
      // Hosts that only serve text: the gzip pack is shipped as base64.
      const bin = atob((await resp.text()).trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resp = new Response(bytes);
    }
    if (onProgress && resp.body && index.size) {
      let got = 0;
      const total = index.packed || index.size;
      const tap = new TransformStream({ transform(chunk, c) { got += chunk.byteLength; onProgress(got / total); c.enqueue(chunk); } });
      resp = new Response(resp.body.pipeThrough(tap));
    }
    let body = resp;
    if (index.gzip) body = new Response(resp.body.pipeThrough(new DecompressionStream('gzip')));
    const blob = await body.arrayBuffer();
    for (const [path, [off, len]] of Object.entries(index.files)) {
      files.set(path, new Uint8Array(blob, off, len));
    }
    return files;
  }

  function normPath(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }

  // ---------------------------------------------------------------- start
  async function start(opts) {
    const canvas = opts.canvas;
    const ctx = canvas.getContext('2d');
    const program = opts.program || 'game';
    const args = [program].concat(opts.args || []);
    const files = await loadAssets(opts.assets, opts.onProgress);
    const dirs = new Set(['']);
    for (const p of files.keys()) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }

    const wasmBytes = await fetch(opts.wasm).then((r) => {
      if (!r.ok) throw new Error('wasm ' + r.status);
      return r.arrayBuffer();
    });

    let inst, mem, ex;
    const u8 = () => new Uint8Array(mem.buffer);
    const dv = () => new DataView(mem.buffer);
    const cstr = (ptr, len) => {
      const b = u8();
      if (len === undefined) { len = 0; while (b[ptr + len]) len++; }
      return new TextDecoder().decode(b.slice(ptr, ptr + len));
    };

    // ---------- file descriptors
    const fds = new Map();
    fds.set(0, { kind: 'stdin' });
    fds.set(1, { kind: 'out', stream: 1, buf: '' });
    fds.set(2, { kind: 'out', stream: 2, buf: '' });
    fds.set(3, { kind: 'dir', path: '', preopen: '.' });
    let nextFd = 4;

    const onStdout = opts.onStdout || ((stream, line) => (stream === 2 ? console.warn : console.log)('[' + program + '] ' + line));
    function writeOut(f, text) {
      f.buf += text;
      let i;
      while ((i = f.buf.indexOf('\n')) >= 0) {
        onStdout(f.stream, f.buf.slice(0, i));
        f.buf = f.buf.slice(i + 1);
      }
    }
    function flushOut() {
      for (const n of [1, 2]) { const f = fds.get(n); if (f.buf) { onStdout(f.stream, f.buf); f.buf = ''; } }
    }

    function iovs(ptr, len) {
      const v = dv(); const out = [];
      for (let i = 0; i < len; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
      return out;
    }

    const now = () => performance.now();
    const realNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    const monoNs = () => BigInt(Math.round(performance.now() * 1e6));

    const wasi = {
      args_sizes_get(argc, bufSize) {
        const v = dv();
        v.setUint32(argc, args.length, true);
        v.setUint32(bufSize, args.reduce((n, a) => n + new TextEncoder().encode(a).length + 1, 0), true);
        return 0;
      },
      args_get(argv, buf) {
        const v = dv(); const b = u8();
        args.forEach((a, i) => {
          const enc = new TextEncoder().encode(a);
          v.setUint32(argv + i * 4, buf, true);
          b.set(enc, buf); b[buf + enc.length] = 0; buf += enc.length + 1;
        });
        return 0;
      },
      environ_sizes_get(c, s) { dv().setUint32(c, 0, true); dv().setUint32(s, 0, true); return 0; },
      environ_get() { return 0; },
      clock_res_get(id, out) { dv().setBigUint64(out, 1000n, true); return 0; },
      clock_time_get(id, prec, out) { dv().setBigUint64(out, id === 0 ? realNs() : monoNs(), true); return 0; },
      random_get(buf, len) { crypto.getRandomValues(u8().subarray(buf, buf + len)); return 0; },
      proc_exit(code) { throw new ExitStatus(code); },
      sched_yield() { return 0; },
      fd_prestat_get(fd, out) {
        const f = fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        const v = dv(); v.setUint8(out, 0); v.setUint32(out + 4, f.preopen.length, true);
        return 0;
      },
      fd_prestat_dir_name(fd, path, len) {
        const f = fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        u8().set(new TextEncoder().encode(f.preopen).subarray(0, len), path);
        return 0;
      },
      fd_fdstat_get(fd, out) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        const v = dv();
        v.setUint8(out, f.kind === 'dir' ? 3 : f.kind === 'file' ? 4 : 2);
        v.setUint16(out + 2, 0, true);
        v.setBigUint64(out + 8, 0xffffffffffffffffn, true);
        v.setBigUint64(out + 16, 0xffffffffffffffffn, true);
        return 0;
      },
      fd_fdstat_set_flags() { return 0; },
      fd_filestat_get(fd, out) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        writeStat(out, f.kind === 'dir' ? 3 : f.kind === 'file' ? 4 : 2, f.kind === 'file' ? f.data.length : 0);
        return 0;
      },
      path_filestat_get(dirfd, flags, p, len, out) {
        const path = normPath(cstr(p, len));
        if (files.has(path)) { writeStat(out, 4, files.get(path).length); return 0; }
        if (dirs.has(path)) { writeStat(out, 3, 0); return 0; }
        return E.NOENT;
      },
      path_open(dirfd, dirflags, p, len, oflags, rb, ri, fdflags, outFd) {
        const base = fds.get(dirfd);
        if (!base || base.kind !== 'dir') return E.BADF;
        const path = normPath((base.path ? base.path + '/' : '') + cstr(p, len));
        const wantDir = (oflags & 2) !== 0;
        const create = (oflags & 1) !== 0;
        const trunc = (oflags & 8) !== 0;
        let entry;
        if (dirs.has(path) && !files.has(path)) {
          entry = { kind: 'dir', path };
        } else if (wantDir) {
          return files.has(path) ? E.NOTDIR : E.NOENT;
        } else if (files.has(path)) {
          let data = files.get(path);
          if (trunc) { data = new Uint8Array(0); files.set(path, data); }
          entry = { kind: 'file', path, data, pos: 0 };
        } else if (create) {
          files.set(path, new Uint8Array(0));
          entry = { kind: 'file', path, data: files.get(path), pos: 0 };
        } else {
          return E.NOENT;
        }
        if ((fdflags & 1) && entry.kind === 'file') entry.pos = entry.data.length;
        const fd = nextFd++;
        fds.set(fd, entry);
        dv().setUint32(outFd, fd, true);
        return 0;
      },
      fd_close(fd) {
        const f = fds.get(fd);
        if (!f || fd < 3) return f ? 0 : E.BADF;
        fds.delete(fd);
        return 0;
      },
      fd_read(fd, iov, iovcnt, nread) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind === 'dir') return E.ISDIR;
        let total = 0;
        if (f.kind === 'file') {
          const b = u8();
          for (const [ptr, len] of iovs(iov, iovcnt)) {
            const n = Math.min(len, f.data.length - f.pos);
            if (n <= 0) break;
            b.set(f.data.subarray(f.pos, f.pos + n), ptr);
            f.pos += n; total += n;
            if (n < len) break;
          }
        }
        dv().setUint32(nread, total, true);
        return 0;
      },
      fd_pread() { return E.NOSYS; },
      fd_write(fd, iov, iovcnt, nwritten) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        let total = 0;
        const b = u8();
        for (const [ptr, len] of iovs(iov, iovcnt)) {
          const chunk = b.slice(ptr, ptr + len);
          if (f.kind === 'out') writeOut(f, new TextDecoder().decode(chunk));
          else if (f.kind === 'file') {
            const need = f.pos + len;
            if (need > f.data.length) {
              const grown = new Uint8Array(need); grown.set(f.data); f.data = grown; files.set(f.path, grown);
            }
            f.data.set(chunk, f.pos); f.pos += len;
          }
          total += len;
        }
        dv().setUint32(nwritten, total, true);
        return 0;
      },
      fd_seek(fd, offset, whence, out) {
        const f = fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind !== 'file') return E.SPIPE;
        const off = Number(offset);
        let pos = whence === 0 ? off : whence === 1 ? f.pos + off : f.data.length + off;
        if (pos < 0) return E.INVAL;
        f.pos = pos;
        dv().setBigUint64(out, BigInt(pos), true);
        return 0;
      },
      fd_tell(fd, out) {
        const f = fds.get(fd);
        if (!f || f.kind !== 'file') return E.BADF;
        dv().setBigUint64(out, BigInt(f.pos), true);
        return 0;
      },
      fd_readdir() { return E.NOSYS; },
      poll_oneoff(inp, outp, nsubs, nevents) {
        // Only clock subscriptions (usleep / nanosleep). Short busy-wait.
        const v = dv();
        let wait = 0;
        for (let i = 0; i < nsubs; i++) {
          const s = inp + i * 48;
          if (v.getUint8(s + 8) === 0) wait = Math.max(wait, Number(v.getBigUint64(s + 24, true)) / 1e6);
        }
        const until = now() + Math.min(wait, 20);
        while (now() < until) { /* spin */ }
        for (let i = 0; i < nsubs; i++) {
          const s = inp + i * 48, o = outp + i * 32;
          v.setBigUint64(o, v.getBigUint64(s, true), true);
          v.setUint16(o + 8, 0, true);
          v.setUint8(o + 10, v.getUint8(s + 8));
        }
        v.setUint32(nevents, nsubs, true);
        return 0;
      },
    };
    function writeStat(out, type, size) {
      const v = dv();
      for (let i = 0; i < 64; i += 8) v.setBigUint64(out + i, 0n, true);
      v.setUint8(out + 16, type);
      v.setBigUint64(out + 24, 1n, true);
      v.setBigUint64(out + 32, BigInt(size), true);
    }
    const wasiProxy = new Proxy(wasi, {
      get(t, k) { return k in t ? t[k] : () => E.NOSYS; },
    });

    // ---------- events
    let running = true;
    const queue = [];
    let autorepeat = true;
    const mouseMode = opts.mouse || 'absolute';
    const pressed = new Set();

    function canvasXY(e) {
      const r = canvas.getBoundingClientRect();
      return [
        Math.floor(((e.clientX - r.left) * canvas.width) / r.width),
        Math.floor(((e.clientY - r.top) * canvas.height) / r.height),
      ];
    }
    const focusable = opts.keyTarget || window;
    const positional = new Set(opts.positionalKeys || POSITIONAL);
    const downByCode = new Map();
    function onKeyDown(e) {
      if (!running) return;
      const [k, extra] = keyEvents(e, positional);
      if (!k && !extra) return;
      if (opts.captureKeys !== false) e.preventDefault();
      if (opts.onKeyLayout) opts.onKeyLayout(e.code, e.key);
      if (e.repeat && !autorepeat) return;
      if (extra) { queue.push([2, extra, 0, 0]); queue.push([3, extra, 0, 0]); }
      if (!k) return;
      downByCode.set(e.code, k);
      pressed.add(k);
      queue.push([2, k, 0, 0]);
    }
    function onKeyUp(e) {
      if (!running) return;
      const k = downByCode.has(e.code) ? downByCode.get(e.code) : keyEvents(e, positional)[0];
      downByCode.delete(e.code);
      if (!k) return;
      pressed.delete(k);
      queue.push([3, k, 0, 0]);
    }
    function onBlur() {
      for (const k of pressed) queue.push([3, k, 0, 0]);
      pressed.clear();
      downByCode.clear();
    }
    // X11 button numbers: 1 left, 2 middle, 3 right, 4/5 wheel, 8/9 side buttons.
    function xButton(b) { return [1, 2, 3, 8, 9][b] || 1; }
    function onMouseDown(e) {
      if (!running) return;
      canvas.focus && canvas.focus();
      if (mouseMode === 'relative' && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
      }
      const [x, y] = canvasXY(e);
      queue.push([4, xButton(e.button), x, y]);
    }
    function onMouseUp(e) {
      if (!running) return;
      if (e.button === 3 || e.button === 4) e.preventDefault(); // no browser back/forward
      const [x, y] = canvasXY(e);
      queue.push([5, xButton(e.button), x, y]);
    }
    function onMouseMove(e) {
      if (!running) return;
      if (mouseMode === 'relative') {
        if (document.pointerLockElement !== canvas) return;
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width / r.width;
        const k = sx * (opts.mouseSpeed || 1);
        queue.push([6, Math.round(e.movementX * k), Math.round(e.movementY * k), 1]);
      } else {
        const [x, y] = canvasXY(e);
        queue.push([6, x, y, 0]);
      }
    }
    function onWheel(e) {
      if (!running) return;
      const [x, y] = canvasXY(e);
      queue.push([4, e.deltaY < 0 ? 4 : 5, x, y]);
    }
    focusable.addEventListener('keydown', onKeyDown);
    focusable.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('wheel', onWheel, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---------- pthreads (wasi-threads) on a pre-spawned Web Worker pool
    const pool = [];
    let nextTid = 1;
    function startPool(module, n) {
      const url = opts.workerUrl || 'runtime-worker.js';
      return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
        const w = new Worker(url);
        const slot = { w, busy: false };
        w.onmessage = (e) => {
          const m = e.data;
          if (m.cmd === 'ready') { pool.push(slot); resolve(); }
          else if (m.cmd === 'done') slot.busy = false;
          else if (m.cmd === 'stdout') writeOut(fds.get(m.fd), m.text);
          else if (m.cmd === 'exit') { if (running) finish(m.code); }
          else if (m.cmd === 'error') { console.error(m.message); if (running) finish(-1, new Error(m.message)); }
        };
        w.onerror = (e) => reject(e.message || e);
        w.postMessage({ cmd: 'init', module, memory: mem, timeOrigin: performance.timeOrigin });
      })));
    }
    function threadSpawn(arg) {
      const slot = pool.find((s) => !s.busy);
      if (!slot) return -6; // EAGAIN
      slot.busy = true;
      const tid = nextTid++;
      slot.w.postMessage({ cmd: 'run', tid, arg });
      return tid;
    }

    // ---------- sounds ("child processes" that play a file)
    const sounds = new Map();
    let nextPid = 1000;
    const soundBase = opts.soundBase !== undefined ? opts.soundBase : '';
    let muted = !!opts.muted;
    let imageData = null;
    let presented = 0;
    const mlxweb = {
      window(w, h, title) {
        canvas.width = w; canvas.height = h;
        imageData = ctx.createImageData(w, h);
        if (opts.onWindow) opts.onWindow(w, h, cstr(title));
      },
      present(ptr, w, h) {
        if (!imageData || imageData.width !== w || imageData.height !== h) {
          canvas.width = w; canvas.height = h; imageData = ctx.createImageData(w, h);
        }
        imageData.data.set(u8().subarray(ptr, ptr + w * h * 4));
        ctx.putImageData(imageData, 0, 0);
        presented++;
      },
      poll(ptr) {
        const ev = queue.shift();
        if (!ev) return 0;
        const v = dv();
        for (let i = 0; i < 4; i++) v.setInt32(ptr + i * 4, ev[i] | 0, true);
        return 1;
      },
      now() { return now(); },
      screen(wp, hp) {
        const s = opts.screen || [1920, 1080];
        if (wp) dv().setInt32(wp, s[0], true);
        if (hp) dv().setInt32(hp, s[1], true);
      },
      cursor(visible) { canvas.style.cursor = visible ? '' : 'none'; },
      autorepeat(on) { autorepeat = !!on; },
      can_block() { return 0; },
      sound_play(p, loop) {
        const pid = nextPid++;
        const path = normPath(cstr(p));
        const a = new Audio(soundBase + path);
        a.loop = !!loop;
        a.muted = muted;
        a.volume = opts.volume !== undefined ? opts.volume : 0.6;
        const s = { a, alive: true };
        a.addEventListener('ended', () => { if (!a.loop) s.alive = false; });
        a.addEventListener('error', () => { s.alive = false; });
        a.play().catch(() => { s.alive = false; });
        sounds.set(pid, s);
        return pid;
      },
      sound_alive(pid) { const s = sounds.get(pid); return s && s.alive ? 1 : 0; },
      sound_stop(pid) {
        const s = sounds.get(pid);
        if (s) { s.a.pause(); s.alive = false; sounds.delete(pid); }
      },
      yield() { unwind('frame'); },
      fiber_switch() { unwind('block'); },
    };

    const module = await WebAssembly.compile(wasmBytes);
    const needsMemory = WebAssembly.Module.imports(module).some((i) => i.module === 'env' && i.name === 'memory');
    const imports = { wasi_snapshot_preview1: wasiProxy, mlxweb, wasi: { 'thread-spawn': threadSpawn } };
    if (needsMemory) {
      if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
        throw new Error('Ce programme utilise des threads : la page doit être cross-origin isolated (COOP/COEP).');
      }
      mem = new WebAssembly.Memory({ initial: opts.initialPages || 1024, maximum: 32768, shared: true });
      imports.env = { memory: mem };
      await startPool(module, opts.threads || 16);
    }
    inst = await WebAssembly.instantiate(module, imports);
    ex = inst.exports;
    if (!mem) mem = ex.memory;
    const asyncBuf = ex.mlxweb_async_buf();
    const asyncSize = ex.mlxweb_async_size();
    if (opts.loopRate !== undefined || opts.budgetMs !== undefined) {
      ex.mlxweb_set_pacing(opts.loopRate || 0, opts.budgetMs || 10);
    }

    let state = 'normal';
    let reason = '';
    // Fibers: pthreads emulated on one core (see mlx_fibers.c). Fiber 0 is main.
    const fibered = typeof ex.mlxweb_fiber_start === 'function';
    const sp = ex.__stack_pointer || null;
    const savedSp = new Map();
    let curFiber = 0;
    let mainStarted = false;
    let switches = 0;
    function abufOf(i) { return fibered ? ex.mlxweb_fiber_abuf(i) : asyncBuf; }
    function unwind(kind) {
      if (state === 'rewinding') {
        ex.asyncify_stop_rewind();
        state = 'normal';
        return;
      }
      const buf = abufOf(curFiber);
      const size = fibered ? ex.mlxweb_fiber_abuf_size(curFiber) : asyncSize;
      const v = dv();
      v.setInt32(buf, buf + 8, true);
      v.setInt32(buf + 4, buf + size, true);
      ex.asyncify_start_unwind(buf);
      state = 'unwinding';
      reason = kind;
    }
    let rafId = 0;
    let finished = null;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));

    function cleanup() {
      running = false;
      cancelAnimationFrame(rafId);
      focusable.removeEventListener('keydown', onKeyDown);
      focusable.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      canvas.style.cursor = '';
      for (const s of sounds.values()) s.a.pause();
      sounds.clear();
      for (const s of pool) s.w.terminate();
      pool.length = 0;
    }
    function finish(code, error) {
      flushOut();
      cleanup();
      finished = { code, error };
      if (opts.onExit) opts.onExit(code, error);
      resolveDone(finished);
    }
    // Every fiber asleep (usleep): wait for the earliest wake-up time.
    function nextFiber() {
      for (;;) {
        const n = ex.mlxweb_fiber_next();
        if (n >= 0) return n;
        const until = Math.min(ex.mlxweb_fiber_wake_min(), performance.now() + 50);
        while (performance.now() < until) { /* short sleep */ }
      }
    }
    function rewind(i) {
      if (sp && savedSp.has(i)) sp.value = savedSp.get(i);
      ex.asyncify_start_rewind(abufOf(i));
      state = 'rewinding';
    }
    function run(i) {
      for (;;) {
        if (!running) return;
        curFiber = i;
        if (fibered) ex.mlxweb_fiber_set(i);
        try {
          if (i === 0) {
            if (mainStarted) rewind(0);
            mainStarted = true;
            ex._start();
          } else if (ex.mlxweb_fiber_state(i) === 1) {
            sp.value = ex.mlxweb_fiber_stack_top(i);
            ex.mlxweb_fiber_start(i);
          } else {
            rewind(i);
            ex.mlxweb_fiber_start(i);
          }
        } catch (e) {
          if (e instanceof ExitStatus) return finish(e.code);
          console.error(e);
          return finish(-1, e);
        }
        if (state === 'unwinding') {
          ex.asyncify_stop_unwind();
          state = 'normal';
          if (sp) savedSp.set(i, sp.value);
          if (reason === 'frame') {
            switches = 0;
            rafId = requestAnimationFrame(() => run(0));
            return;
          }
          if (++switches > 2000000) return finish(-1, new Error('Interblocage entre threads (deadlock).'));
          i = nextFiber();
          continue;
        }
        if (i === 0) return finish(0);
        i = nextFiber();
      }
    }
    run(0);

    return {
      done,
      stop() { if (!finished) { finish(-2); } },
      sendClose() { queue.push([17, 0, 0, 0]); },
      setMuted(m) { muted = !!m; for (const s of sounds.values()) s.a.muted = muted; },
      get finished() { return finished; },
      get frames() { return presented; },
    };
  }

  global.MlxWeb = { start, keysym };
})(typeof window !== 'undefined' ? window : globalThis);
