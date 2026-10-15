/*
 * posix.js — a small Unix in the browser for command-line C programs
 * compiled with POSIX=1 (tools/mlxweb/build.sh + mlx_posix.c).
 *
 * - every process is its own WebAssembly instance with its own memory;
 *   fork() copies the parent's memory into the child, so both continue
 *   from the fork() call like on Linux;
 * - execve() replaces the program: another wasm module or a command
 *   written in JS (see commands.js), keeping pid and file descriptors;
 * - pipes, dup/dup2, waitpid, kill and signal handlers (Ctrl-C, Ctrl-\);
 * - an in-memory file system and a terminal (xterm.js) with a line editor
 *   that serves readline() and canonical reads;
 * - a virtual network: TCP-like sockets, accept/recv/send, epoll and
 *   non-blocking fds. The page opens connections with sys.net.connect().
 *
 * Blocking calls (read, write to a full pipe, waitpid, readline, fork)
 * unwind the process with Asyncify; it resumes when it can continue.
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // WASI errno values
  const E = { ACCES: 2, ADDRINUSE: 3, AGAIN: 6, BADF: 8, CHILD: 12, CONNREFUSED: 14, EXIST: 20, INVAL: 28, ISDIR: 31, MFILE: 33,
    NOENT: 44, NOEXEC: 45, NOSYS: 52, NOTCONN: 53, NOTDIR: 54, NOTEMPTY: 55, NOTSOCK: 57, NOTTY: 59, OPNOTSUPP: 58, PIPE: 64, SPIPE: 70, SRCH: 71 };
  const SIG = { INT: 2, QUIT: 3, KILL: 9, PIPE: 13, TERM: 15 };
  const PIPE_CAP = 64 * 1024;
  const SOCK_CAP = 1024 * 1024;
  const EP = { IN: 0x1, OUT: 0x4, ERR: 0x8, HUP: 0x10, RDHUP: 0x2000 };
  const NONBLOCK = 0x4000;   // SOCK_NONBLOCK, accept4 flags
  const MSG = { DONTWAIT: 0x40, NOSIGNAL: 0x4000 };

  class ProcExit { constructor(status) { this.status = status; } }
  class ExecReq { constructor(req) { this.req = req; } }
  class Killed extends Error { constructor(sig) { super('killed'); this.sig = sig; } }

  // ------------------------------------------------------------ file system
  let ino = 1;
  class Node {
    constructor(type, mode) {
      this.type = type; this.mode = mode; this.ino = ino++;
      this.mtime = Date.now();
      if (type === 'dir') this.children = new Map();
      else this.data = new Uint8Array(0);
    }
  }

  class FS {
    constructor() { this.root = new Node('dir', 0o755); }
    static norm(p) {
      const out = [];
      for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop(); else out.push(part);
      }
      return '/' + out.join('/');
    }
    resolve(cwd, p) { return FS.norm(p.startsWith('/') ? p : cwd + '/' + p); }
    lookup(abs) {
      let n = this.root;
      for (const part of abs.split('/').filter(Boolean)) {
        if (n.type !== 'dir') return null;
        n = n.children.get(part);
        if (!n) return null;
      }
      return n;
    }
    parent(abs) {
      const parts = abs.split('/').filter(Boolean);
      const name = parts.pop();
      const dir = this.lookup('/' + parts.join('/'));
      return { dir, name };
    }
    mkdirp(abs, mode = 0o755) {
      let n = this.root;
      for (const part of abs.split('/').filter(Boolean)) {
        let c = n.children.get(part);
        if (!c) { c = new Node('dir', mode); n.children.set(part, c); }
        n = c;
      }
      return n;
    }
    device(abs, dev, mode = 0o666) {
      const n = this.writeFile(abs, '', mode);
      n.dev = dev;
      return n;
    }
    writeFile(abs, content, mode = 0o644) {
      const { dir, name } = this.parent(abs);
      if (!dir || dir.type !== 'dir') throw new Error('no dir for ' + abs);
      let n = dir.children.get(name);
      if (!n) { n = new Node('file', mode); dir.children.set(name, n); }
      n.data = typeof content === 'string' ? enc.encode(content) : content;
      n.mtime = Date.now();
      return n;
    }
  }

  // ------------------------------------------------------------ open files
  class Pipe {
    constructor() { this.chunks = []; this.size = 0; this.r = null; this.w = null; }
    get readers() { return this.r ? this.r.refs : 0; }
    get writers() { return this.w ? this.w.refs : 0; }
    take(n) {
      const out = new Uint8Array(Math.min(n, this.size));
      let off = 0;
      while (off < out.length) {
        const c = this.chunks[0];
        const k = Math.min(c.length, out.length - off);
        out.set(c.subarray(0, k), off); off += k;
        if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
      }
      this.size -= out.length;
      return out;
    }
  }
  // One direction of a connection: bytes queued until the other side reads.
  class Stream {
    constructor() { this.chunks = []; this.size = 0; this.wclosed = false; this.rclosed = false; }
    push(b) { if (b.length) { this.chunks.push(b.slice()); this.size += b.length; } }
  }
  Stream.prototype.take = Pipe.prototype.take;
  // An open file description, shared by dup()/fork()
  class OFD {
    constructor(kind, props) { this.kind = kind; this.refs = 0; Object.assign(this, props); }
  }

  // ------------------------------------------------------------ the system
  // Terminal cells used by a string (ANSI colours take none, emoji/CJK take two).
  function cellWidth(str) {
    let w = 0;
    for (const ch of str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) {
      const c = ch.codePointAt(0);
      if (c < 32 || (c >= 0x300 && c < 0x370) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
      w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
        || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
        || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f000
        || [0x231a, 0x231b, 0x23f0, 0x23f3, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
          0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e,
          0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55].includes(c)
        ? 2 : 1;
    }
    return w;
  }

  function create(opts) {
    const fs = opts.fs || new FS();
    const term = opts.term || { write() {}, cols: 80 };
    const commands = opts.commands || {};
    const programs = opts.programs || {};   // name -> WebAssembly.Module
    const procs = new Map();
    let nextPid = opts.firstPid || 100;
    const waiters = new Set();             // JS waits: {cond, resolve, reject, proc}
    let onSessionEnd = opts.onSessionEnd || (() => {});

    // ---------------- terminal + line editor
    const tty = {
      reader: null,          // {proc, mode:'readline'|'canon', prompt, buf, pos, done, eof}
      history: [], hidx: 0,
      ttyOfd: new OFD('tty', {}),
      lastLine: '',          // what follows the last newline written by programs
      pending: '',           // type-ahead: keys typed while nobody reads
      out(s) { term.write(s); },
      cols() { return Math.max(10, term.cols || 80); },
      // Redraw the edited line, which may wrap over several rows. r.cur is
      // the cursor's offset (in cells) from the start of the prompt.
      redraw() {
        const r = this.reader; if (!r) return;
        const cols = this.cols();
        const up = Math.floor(r.cur / cols);
        const text = r.prompt + r.buf;
        const end = cellWidth(text);
        let s = (up ? '\x1b[' + up + 'A' : '') + '\r\x1b[J' + text;
        if (end > 0 && end % cols === 0) s += ' \b'; // leave the pending-wrap state
        const target = cellWidth(r.prompt + r.buf.slice(0, r.pos));
        const back = Math.floor(end / cols) - Math.floor(target / cols);
        s += (back ? '\x1b[' + back + 'A' : '') + '\r' + (target % cols ? '\x1b[' + (target % cols) + 'C' : '');
        r.cur = target;
        this.out(s);
      },
      start(proc, mode, prompt) {
        prompt = prompt.replace(/[\x01\x02]/g, '');
        this.reader = { proc, mode, prompt, buf: '', pos: 0, cur: 0, done: false, eof: false };
        this.hidx = this.history.length;
        if (mode === 'readline') this.out(prompt);
        else this.reader.prompt = this.lastLine; // e.g. "> " written by the program before read()
        this.reader.cur = cellWidth(this.reader.prompt);
        if (this.pending) { const d = this.pending; this.pending = ''; this.input(d); }
      },
      finish(eof) {
        const r = this.reader; r.done = true; r.eof = eof;
        if (r.pos !== r.buf.length) { r.pos = r.buf.length; this.redraw(); }
        this.out('\r\n');
        this.lastLine = '';
        notify();
      },
      input(data) {
        // signals first, whoever is reading
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          if (ch === '\x03') { this.pending = ''; if (!this.reader || this.reader.mode !== 'readline') this.out('^C'); signalAll(SIG.INT); continue; }
          if (ch === '\x1c') { this.pending = ''; if (!this.reader || this.reader.mode !== 'readline') this.out('^\\'); signalAll(SIG.QUIT); continue; }
          const r = this.reader;
          if (!r || r.done) { this.pending += ch; continue; }
          if (ch === '\x1b') {
            const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i));
            if (m) { this.escape(m[1]); i += m[0].length - 1; }
            continue;
          }
          if (ch === '\r' || ch === '\n') { this.finish(false); continue; }
          if (ch === '\x7f' || ch === '\b') { if (r.pos > 0) { r.buf = r.buf.slice(0, r.pos - 1) + r.buf.slice(r.pos); r.pos--; this.redraw(); } continue; }
          if (ch === '\x04') {
            if (r.buf === '') { if (r.mode === 'canon') this.out(''); r.done = true; r.eof = true; if (r.mode === 'readline') this.out('\r\n'); notify(); }
            else if (r.mode === 'canon') { r.done = true; r.eof = false; r.noNewline = true; notify(); }
            continue;
          }
          if (ch === '\x01') { r.pos = 0; this.redraw(); continue; }
          if (ch === '\x05') { r.pos = r.buf.length; this.redraw(); continue; }
          if (ch === '\x15') { r.buf = r.buf.slice(r.pos); r.pos = 0; this.redraw(); continue; }
          if (ch === '\x0b') { r.buf = r.buf.slice(0, r.pos); this.redraw(); continue; }
          if (ch === '\x0c') { this.out('\x1b[H\x1b[2J'); this.redraw(); continue; }
          if (ch === '\t') continue;
          if (ch < ' ') continue;
          r.buf = r.buf.slice(0, r.pos) + ch + r.buf.slice(r.pos); r.pos += ch.length;
          if (r.pos === r.buf.length) {
            r.cur += cellWidth(ch);
            this.out(ch + (r.cur % this.cols() === 0 ? ' \b' : ''));
          } else this.redraw();
        }
      },
      escape(seq) {
        const r = this.reader;
        if (seq === '[D' && r.pos > 0) { r.pos--; this.redraw(); }
        else if (seq === '[C' && r.pos < r.buf.length) { r.pos++; this.redraw(); }
        else if (seq === '[H' || seq === 'OH' || seq === '[1~') { r.pos = 0; this.redraw(); }
        else if (seq === '[F' || seq === 'OF' || seq === '[4~') { r.pos = r.buf.length; this.redraw(); }
        else if (seq === '[3~' && r.pos < r.buf.length) { r.buf = r.buf.slice(0, r.pos) + r.buf.slice(r.pos + 1); this.redraw(); }
        else if (r.mode === 'readline' && (seq === '[A' || seq === '[B')) {
          if (seq === '[A' && this.hidx > 0) this.hidx--;
          else if (seq === '[B' && this.hidx < this.history.length) this.hidx++;
          else return;
          r.buf = this.history[this.hidx] || ''; r.pos = r.buf.length; this.redraw();
        }
      },
    };
    tty.ttyOfd.refs = 1; // kept by the system

    // ---------------- notification / scheduling
    let pumpQueued = false;
    function notify() {
      if (pumpQueued) return;
      pumpQueued = true;
      queueMicrotask(pump);
    }
    async function pump() {
      pumpQueued = false;
      let progressed = true, rounds = 0;
      const start = performance.now();
      while (progressed) {
        progressed = false;
        // let the page breathe (rendering, input) when processes keep each other busy
        if (performance.now() - start > 25) { pumpQueued = true; setTimeout(pump, 0); return; }
        if (++rounds > 5000) { console.error('[posix] scheduler: no progress', [...procs.values()].map((q) => q.pid + ':' + q.status + ':' + (q.wait ? q.wait.toString().slice(0, 80) : ''))); setTimeout(notify, 50); return; }
        for (const w of [...waiters]) {
          if (w.proc && w.proc.killed) { waiters.delete(w); w.reject(new Killed(w.proc.killed)); progressed = true; }
          else if (w.cond()) { waiters.delete(w); w.resolve(); progressed = true; }
        }
        for (const p of [...procs.values()]) {
          if (p.kind === 'wasm' && p.status === 'blocked' && p.wait && p.wait()) {
            p.wait = null;
            progressed = true;
            await runWasm(p);
          }
        }
      }
    }
    function until(proc, cond) {
      if (proc && proc.killed) return Promise.reject(new Killed(proc.killed));
      if (cond()) return Promise.resolve();
      return new Promise((resolve, reject) => { waiters.add({ cond, resolve, reject, proc }); });
    }

    // ---------------- fds
    function ref(ofd) {
      ofd.refs++;
      return ofd;
    }
    function unref(ofd) {
      ofd.refs--;
      if (ofd.refs > 0) return;
      if (ofd.pipe) notify();
      if (ofd.kind === 'sock') closeSock(ofd);
    }
    function allocFd(p, ofd, min = 0) {
      let fd = min;
      while (p.fds.has(fd) || fd === 3) fd++; // 3 is the "/" preopen
      p.fds.set(fd, ref(ofd));
      return fd;
    }
    function closeFd(p, fd) {
      const o = p.fds.get(fd);
      if (!o) return -E.BADF;
      p.fds.delete(fd);
      unref(o);
      return 0;
    }
    function standardFs() {
      for (const d of ['/dev', '/tmp']) fs.mkdirp(d);
      for (const dev of ['null', 'zero', 'random', 'urandom', 'tty']) fs.device('/dev/' + dev, dev);
    }
    standardFs();

    // ---------------- processes
    function newProc(ppid, fds, cwd) {
      const p = { pid: nextPid++, ppid, fds: new Map(), status: 'new', sig: {}, cwd: cwd || '/', exitStatus: 0, reaped: false };
      for (const [fd, o] of fds) p.fds.set(fd, ref(o));
      procs.set(p.pid, p);
      return p;
    }

    function exitProc(p, status) {
      if (p.status === 'zombie') return;
      p.status = 'zombie';
      p.exitStatus = status;
      for (const fd of [...p.fds.keys()]) closeFd(p, fd);
      if (tty.reader && tty.reader.proc === p) tty.reader = null;
      p.inst = p.ex = p.mem = null;
      // reparent children to "init" and auto-reap them
      for (const c of procs.values()) if (c.ppid === p.pid) { c.ppid = 0; if (c.status === 'zombie') procs.delete(c.pid); }
      if (p.ppid === 0 || !procs.has(p.ppid)) procs.delete(p.pid);
      if (p.root) onSessionEnd(status);
      notify();
    }

    function kill(p, sig) {
      if (!p || p.status === 'zombie') return;
      if (sig === SIG.KILL || p.kind === 'js') return terminate(p, sig);
      const h = p.sig[sig];
      if (h === -2) return;                       // ignored
      if (h > 0 && p.ex) {                        // handler: run it now (process is waiting)
        try { p.ex.mlxweb_call_handler(h, sig); } catch (e) { if (e instanceof ProcExit) return exitProc(p, e.status); throw e; }
        notify();
        return;
      }
      if (sig === 17 || sig === 28) return;       // SIGCHLD, SIGWINCH: ignored by default
      terminate(p, sig);
    }
    function terminate(p, sig) {
      p.killed = sig;
      exitProc(p, (sig & 0x7f) | (sig === SIG.QUIT ? 0x80 : 0));
    }
    function signalAll(sig) {
      for (const p of [...procs.values()]) kill(p, sig);
    }

    // ---------------- memory helpers (wasm)
    const view = (p) => new DataView(p.mem.buffer);
    const bytes = (p) => new Uint8Array(p.mem.buffer);
    function cstr(p, ptr, len) {
      const b = bytes(p);
      if (len === undefined) { len = 0; while (b[ptr + len]) len++; }
      return dec.decode(b.slice(ptr, ptr + len));
    }
    function strArray(p, ptr) {
      const out = [];
      if (!ptr) return out;
      const v = view(p);
      for (let i = 0; ; i++) {
        const s = v.getUint32(ptr + i * 4, true);
        if (!s) break;
        out.push(cstr(p, s));
      }
      return out;
    }

    // Blocking wasm call: try now, otherwise unwind until `wait` says go.
    function blocking(p, attempt) {
      if (p.state === 'rewinding') { p.ex.asyncify_stop_rewind(); p.state = 'normal'; }
      const r = attempt();
      if (r.done) return r.value;
      p.wait = r.wait;
      const v = view(p);
      v.setInt32(p.abuf, p.abuf + 8, true);
      v.setInt32(p.abuf + 4, p.abuf + p.abufSize, true);
      p.ex.asyncify_start_unwind(p.abuf);
      p.state = 'unwinding';
      return 0;
    }

    // ---------------- reading / writing an OFD (shared by wasm + JS)
    function tryRead(p, o, n) {
      if (o.kind === 'tty') {
        const r = tty.reader;
        if (r && r.proc === p && r.mode === 'canon' && r.done) {
          tty.reader = null;
          if (r.eof) return { done: true, value: new Uint8Array(0) };
          return { done: true, value: enc.encode(r.buf + (r.noNewline ? '' : '\n')).subarray(0, n) };
        }
        if (!r) tty.start(p, 'canon', '');
        return { done: false, wait: () => !tty.reader || (tty.reader.proc === p && tty.reader.done) };
      }
      if (o.kind === 'pipe-r') {
        const pipe = o.pipe;
        if (pipe.size > 0) { notify(); return { done: true, value: pipe.take(n) }; }
        if (pipe.writers === 0) return { done: true, value: new Uint8Array(0) };
        return { done: false, wait: () => pipe.size > 0 || pipe.writers === 0 };
      }
      if (o.kind === 'file') {
        const d = o.node.data;
        const out = d.subarray(o.pos, Math.min(d.length, o.pos + n));
        o.pos += out.length;
        return { done: true, value: out };
      }
      if (o.kind === 'dev') {
        if (o.dev === 'null') return { done: true, value: new Uint8Array(0) };
        const out = new Uint8Array(Math.min(n, 65536));
        if (o.dev !== 'zero') crypto.getRandomValues(out);
        return { done: true, value: out };
      }
      if (o.kind === 'sock') {
        if (o.state !== 'conn') return { done: true, error: E.NOTCONN };
        const rx = o.rx;
        if (rx.size > 0) { notify(); return { done: true, value: rx.take(n) }; }
        if (rx.wclosed || o.rdShut) return { done: true, value: new Uint8Array(0) };
        return { done: false, wait: () => rx.size > 0 || rx.wclosed };
      }
      if (o.kind === 'sink') return { done: true, value: new Uint8Array(0) };
      if (o.kind === 'dir') return { done: true, error: E.ISDIR };
      return { done: true, error: E.BADF };
    }
    function tryWrite(p, o, data) {
      if (o.kind === 'dev') return { done: true, value: data.length };
      if (o.kind === 'tty') {
        term.write(data);
        const t = dec.decode(data), nl = Math.max(t.lastIndexOf('\n'), t.lastIndexOf('\r'));
        tty.lastLine = nl < 0 ? (tty.lastLine + t).slice(-200) : t.slice(nl + 1);
        if (tty.reader) tty.reader.cur = 0;
        return { done: true, value: data.length }; }
      if (o.kind === 'pipe-w') {
        const pipe = o.pipe;
        if (pipe.readers === 0) return { done: true, error: E.PIPE, sigpipe: true };
        const room = PIPE_CAP - pipe.size;
        if (room <= 0) return { done: false, wait: () => pipe.size < PIPE_CAP || pipe.readers === 0 };
        const chunk = data.slice(0, room);
        pipe.chunks.push(chunk); pipe.size += chunk.length;
        notify();
        return { done: true, value: chunk.length };
      }
      if (o.kind === 'sock') {
        if (o.state !== 'conn') return { done: true, error: E.NOTCONN };
        const tx = o.tx;
        if (tx.rclosed || tx.wclosed) return { done: true, error: E.PIPE, sigpipe: true };
        const room = SOCK_CAP - tx.size;
        if (room <= 0) return { done: false, wait: () => tx.size < SOCK_CAP || tx.rclosed };
        tx.push(data.subarray(0, room));
        notify();
        return { done: true, value: Math.min(room, data.length) };
      }
      if (o.kind === 'sink') { o.sink(data); return { done: true, value: data.length }; }
      if (o.kind === 'file') {
        const n = o.node;
        if (o.append) o.pos = n.data.length;
        const need = o.pos + data.length;
        if (need > n.data.length) { const g = new Uint8Array(need); g.set(n.data); n.data = g; }
        n.data.set(data, o.pos); o.pos += data.length; n.mtime = Date.now();
        return { done: true, value: data.length };
      }
      return { done: true, error: E.BADF };
    }

    // ---------------- WASI + posix imports for one wasm process
    function wasiFor(p) {
      const w = {
        args_sizes_get(c, s) {
          const v = view(p);
          v.setUint32(c, p.argv.length, true);
          v.setUint32(s, p.argv.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
          return 0;
        },
        args_get(argv, buf) { return putStrings(p, p.argv, argv, buf); },
        environ_sizes_get(c, s) {
          const v = view(p);
          v.setUint32(c, p.env.length, true);
          v.setUint32(s, p.env.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
          return 0;
        },
        environ_get(envp, buf) { return putStrings(p, p.env, envp, buf); },
        clock_res_get(id, o) { view(p).setBigUint64(o, 1000n, true); return 0; },
        clock_time_get(id, prec, o) {
          const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
          view(p).setBigUint64(o, BigInt(Math.round(ms * 1e6)), true);
          return 0;
        },
        random_get(buf, len) { crypto.getRandomValues(bytes(p).subarray(buf, buf + len)); return 0; },
        proc_exit(code) { throw new ProcExit((code & 0xff) << 8); },
        sched_yield() { return 0; },
        fd_prestat_get(fd, o) {
          if (fd !== 3) return E.BADF;
          const v = view(p); v.setUint8(o, 0); v.setUint32(o + 4, 1, true);
          return 0;
        },
        fd_prestat_dir_name(fd, path, len) { if (fd !== 3) return E.BADF; bytes(p)[path] = 47; return 0; },
        fd_fdstat_get(fd, o) {
          const ofd = fd === 3 ? { kind: 'dir' } : p.fds.get(fd);
          if (!ofd) return E.BADF;
          const v = view(p);
          const type = ofd.kind === 'tty' ? 2 : ofd.kind === 'file' ? 4 : ofd.kind === 'dir' ? 3 : 6;
          v.setUint8(o, type); v.setUint16(o + 2, (ofd.append ? 1 : 0) | (ofd.nonblock ? 4 : 0), true);
          // a tty must not advertise seek/tell, or isatty() says no
          const rights = ofd.kind === 'tty' ? 0xffffffffffffffffn & ~0x24n : 0xffffffffffffffffn;
          v.setBigUint64(o + 8, rights, true); v.setBigUint64(o + 16, 0xffffffffffffffffn, true);
          return 0;
        },
        fd_fdstat_set_flags(fd, flags) {
          const ofd = p.fds.get(fd);
          if (!ofd) return E.BADF;
          ofd.nonblock = !!(flags & 4);
          if (ofd.kind === 'file') ofd.append = !!(flags & 1);
          return 0;
        },
        fd_filestat_get(fd, o) {
          const ofd = p.fds.get(fd);
          if (!ofd) return E.BADF;
          writeStat(p, o, ofd.node || null, ofd.kind);
          return 0;
        },
        path_filestat_get(dirfd, flags, path, len, o) {
          const n = fs.lookup(FS.norm(cstr(p, path, len)));
          if (!n) return E.NOENT;
          writeStat(p, o, n);
          return 0;
        },
        path_open(dirfd, dirflags, path, len, oflags, rb, ri, fdflags, outFd) {
          const abs = FS.norm(cstr(p, path, len));
          let n = fs.lookup(abs);
          const creat = oflags & 1, directory = oflags & 2, excl = oflags & 4, trunc = oflags & 8;
          if (n && creat && excl) return E.EXIST;
          if (!n) {
            if (!creat) return E.NOENT;
            const { dir, name } = fs.parent(abs);
            if (!dir) return E.NOENT;
            if (dir.type !== 'dir') return E.NOTDIR;
            n = new Node('file', 0o644);
            dir.children.set(name, n);
          }
          if (directory && n.type !== 'dir') return E.NOTDIR;
          let ofd;
          if (n.dev === 'tty') ofd = tty.ttyOfd;
          else if (n.dev) ofd = new OFD('dev', { dev: n.dev });
          else if (n.type === 'dir') {
            if (!directory && ((oflags & 9) || (BigInt(rb) & 0x40n) !== 0n)) return E.ISDIR;
            ofd = new OFD('dir', { node: n, path: abs });
          } else {
            if (trunc) { n.data = new Uint8Array(0); n.mtime = Date.now(); }
            ofd = new OFD('file', { node: n, pos: 0, append: !!(fdflags & 1) });
          }
          view(p).setUint32(outFd, allocFd(p, ofd, 4), true);
          return 0;
        },
        fd_close(fd) { return -closeFd(p, fd) || 0; },
        fd_read(fd, iov, n, nread) {
          return blocking(p, () => {
            const o = p.fds.get(fd);
            if (!o) return { done: true, value: E.BADF };
            const v = view(p);
            let want = 0;
            for (let i = 0; i < n; i++) want += v.getUint32(iov + i * 8 + 4, true);
            const r = tryRead(p, o, want);
            if (!r.done) return o.nonblock ? { done: true, value: E.AGAIN } : r;
            if (r.error) return { done: true, value: r.error };
            let off = 0; const b = bytes(p);
            for (let i = 0; i < n && off < r.value.length; i++) {
              const ptr = v.getUint32(iov + i * 8, true), len = v.getUint32(iov + i * 8 + 4, true);
              const k = Math.min(len, r.value.length - off);
              b.set(r.value.subarray(off, off + k), ptr); off += k;
            }
            view(p).setUint32(nread, off, true);
            return { done: true, value: 0 };
          });
        },
        fd_write(fd, iov, n, nw) {
          return blocking(p, () => {
            const o = p.fds.get(fd);
            if (!o) return { done: true, value: E.BADF };
            const v = view(p);
            const parts = [];
            for (let i = 0; i < n; i++) {
              const ptr = v.getUint32(iov + i * 8, true), len = v.getUint32(iov + i * 8 + 4, true);
              parts.push(bytes(p).slice(ptr, ptr + len));
            }
            const data = parts.length === 1 ? parts[0] : concat(parts);
            if (data.length === 0) { v.setUint32(nw, 0, true); return { done: true, value: 0 }; }
            const r = tryWrite(p, o, data);
            if (!r.done) return o.nonblock ? { done: true, value: E.AGAIN } : r;
            if (r.sigpipe) { kill(p, SIG.PIPE); if (p.status === 'zombie') throw new ProcExit(p.exitStatus); }
            if (r.error) return { done: true, value: r.error };
            view(p).setUint32(nw, r.value, true);
            return { done: true, value: 0 };
          });
        },
        fd_seek(fd, offset, whence, out) {
          const o = p.fds.get(fd);
          if (!o) return E.BADF;
          if (o.kind !== 'file') return E.SPIPE;
          const off = Number(offset);
          const pos = whence === 0 ? off : whence === 1 ? o.pos + off : o.node.data.length + off;
          if (pos < 0) return E.INVAL;
          o.pos = pos;
          view(p).setBigUint64(out, BigInt(pos), true);
          return 0;
        },
        fd_tell(fd, out) {
          const o = p.fds.get(fd);
          if (!o || o.kind !== 'file') return E.SPIPE;
          view(p).setBigUint64(out, BigInt(o.pos), true);
          return 0;
        },
        fd_readdir(fd, buf, len, cookie, used) {
          const o = p.fds.get(fd);
          if (!o || o.kind !== 'dir') return E.BADF;
          const names = ['.', '..', ...o.node.children.keys()];
          const b = bytes(p), v = view(p);
          let off = 0;
          for (let i = Number(cookie); i < names.length; i++) {
            const name = enc.encode(names[i]);
            const child = i < 2 ? o.node : o.node.children.get(names[i]);
            const ent = new Uint8Array(24 + name.length);
            const dv = new DataView(ent.buffer);
            dv.setBigUint64(0, BigInt(i + 1), true);
            dv.setBigUint64(8, BigInt(child.ino), true);
            dv.setUint32(16, name.length, true);
            dv.setUint8(20, child.type === 'dir' ? 3 : 4);
            ent.set(name, 24);
            const k = Math.min(ent.length, len - off);
            b.set(ent.subarray(0, k), buf + off); off += k;
            if (off >= len) break;
          }
          v.setUint32(used, off, true);
          return 0;
        },
        path_unlink_file(dirfd, path, len) {
          const abs = FS.norm(cstr(p, path, len));
          const { dir, name } = fs.parent(abs);
          const n = dir && dir.children.get(name);
          if (!n) return E.NOENT;
          if (n.type === 'dir') return E.ISDIR;
          dir.children.delete(name);
          return 0;
        },
        path_create_directory(dirfd, path, len) {
          const abs = FS.norm(cstr(p, path, len));
          if (fs.lookup(abs)) return E.EXIST;
          const { dir, name } = fs.parent(abs);
          if (!dir) return E.NOENT;
          dir.children.set(name, new Node('dir', 0o755));
          return 0;
        },
        path_remove_directory(dirfd, path, len) {
          const abs = FS.norm(cstr(p, path, len));
          const { dir, name } = fs.parent(abs);
          const n = dir && dir.children.get(name);
          if (!n) return E.NOENT;
          if (n.type !== 'dir') return E.NOTDIR;
          if (n.children.size) return E.NOTEMPTY;
          dir.children.delete(name);
          return 0;
        },
        poll_oneoff(inp, outp, nsubs, nev) {
          // clock subscriptions only (usleep / sleep)
          let until = 0;
          const v = view(p);
          for (let i = 0; i < nsubs; i++) {
            const s = inp + i * 48;
            if (v.getUint8(s + 8) === 0) until = Math.max(until, Number(v.getBigUint64(s + 24, true)) / 1e6);
          }
          if (!p.sleepUntil) p.sleepUntil = performance.now() + until;
          return blocking(p, () => {
            if (performance.now() < p.sleepUntil) {
              const t = p.sleepUntil;
              setTimeout(notify, Math.max(0, t - performance.now()) + 1);
              return { done: false, wait: () => performance.now() >= t };
            }
            p.sleepUntil = 0;
            const v2 = view(p);
            for (let i = 0; i < nsubs; i++) {
              const s = inp + i * 48, o = outp + i * 32;
              v2.setBigUint64(o, v2.getBigUint64(s, true), true);
              v2.setUint16(o + 8, 0, true);
              v2.setUint8(o + 10, v2.getUint8(s + 8));
            }
            v2.setUint32(nev, nsubs, true);
            return { done: true, value: 0 };
          });
        },
      };
      return new Proxy(w, { get(t, k) { return k in t ? t[k] : () => E.NOSYS; } });
    }

    function posixFor(p) {
      return {
        getpid() { return p.pid; },
        fork() {
          if (p.state === 'rewinding') { p.ex.asyncify_stop_rewind(); p.state = 'normal'; return p.forkResult; }
          p.forkPending = true;
          const v = view(p);
          v.setInt32(p.abuf, p.abuf + 8, true);
          v.setInt32(p.abuf + 4, p.abuf + p.abufSize, true);
          p.ex.asyncify_start_unwind(p.abuf);
          p.state = 'unwinding';
          return 0;
        },
        execve(pathPtr, argvPtr, envPtr) {
          const path = cstr(p, pathPtr);
          const abs = fs.resolve(p.cwdFn(), path);
          const n = fs.lookup(abs);
          if (!n) return -E.NOENT;
          if (n.type === 'dir') return -E.ACCES;
          if (!(n.mode & 0o111)) return -E.ACCES;
          if (!n.exec) return -E.NOEXEC;
          throw new ExecReq({ path: abs, node: n, argv: strArray(p, argvPtr), env: strArray(p, envPtr), cwd: p.cwdFn() });
        },
        waitpid(pid, statusPtr, options) {
          return blocking(p, () => {
            const kids = [...procs.values()].filter((c) => c.ppid === p.pid && (pid <= 0 || c.pid === pid));
            if (!kids.length) return { done: true, value: -E.CHILD };
            const z = kids.find((c) => c.status === 'zombie');
            if (z) {
              if (statusPtr) view(p).setInt32(statusPtr, z.exitStatus, true);
              procs.delete(z.pid);
              return { done: true, value: z.pid };
            }
            if (options & 1) return { done: true, value: 0 };
            return { done: false, wait: () => kids.some((c) => c.status === 'zombie') || p.killed };
          });
        },
        pipe(fdsPtr) {
          const pipe = new Pipe();
          pipe.r = new OFD('pipe-r', { pipe });
          pipe.w = new OFD('pipe-w', { pipe });
          const a = allocFd(p, pipe.r), b = allocFd(p, pipe.w);
          view(p).setInt32(fdsPtr, a, true); view(p).setInt32(fdsPtr + 4, b, true);
          return 0;
        },
        dup(fd) {
          const o = p.fds.get(fd);
          if (!o) return -E.BADF;
          return allocFd(p, o);
        },
        dup2(fd, fd2) {
          const o = p.fds.get(fd);
          if (!o) return -E.BADF;
          if (fd === fd2) return fd2;
          if (p.fds.has(fd2)) closeFd(p, fd2);
          p.fds.set(fd2, ref(o));
          return fd2;
        },
        kill(pid, sig) {
          const t = procs.get(pid);
          if (!t || t.status === 'zombie') return -E.SRCH;
          if (sig) queueMicrotask(() => kill(t, sig));
          return 0;
        },
        sigaction(sig, h) { p.sig[sig] = h === -1 ? 0 : h; return 0; },
        readline(promptPtr, buf, cap, donePtr) {
          return blocking(p, () => {
            const r = tty.reader;
            const doneFlag = view(p).getInt32(donePtr, true);
            if (r && r.proc === p && r.mode === 'readline' && (r.done || doneFlag)) {
              tty.reader = null;
              if (!r.done) tty.out('\r\n');
              if (r.eof) return { done: true, value: -1 };
              const line = enc.encode(r.buf).subarray(0, cap - 1);
              bytes(p).set(line, buf);
              return { done: true, value: line.length };
            }
            if (!r || r.proc !== p) tty.start(p, 'readline', cstr(p, promptPtr));
            return { done: false, wait: () => !tty.reader || tty.reader.done || view(p).getInt32(donePtr, true) !== 0 };
          });
        },
        rl_replace_line(textPtr) {
          const r = tty.reader;
          if (r && r.mode === 'readline') { r.buf = cstr(p, textPtr); r.pos = r.buf.length; }
        },
        rl_redisplay() { tty.redraw(); },
        ...netFor(p),
        add_history(ptr) { const s = cstr(p, ptr); if (tty.history[tty.history.length - 1] !== s) tty.history.push(s); },
        clear_history() { tty.history = []; },
      };
    }

    // ---------------- virtual network
    const ports = new Map();   // port -> listening socket OFD
    let nextEphemeral = 49152;
    function closeSock(o) {
      if (o.state === 'listen') {
        if (ports.get(o.port) === o) ports.delete(o.port);
        for (const c of o.queue) { c.tx.wclosed = true; c.rx.rclosed = true; }
        o.queue = [];
      } else if (o.state === 'conn') { o.tx.wclosed = true; o.rx.rclosed = true; }
      o.state = 'closed';
      notify();
    }
    function readiness(p, o) {
      let ev = 0;
      if (o.kind === 'sock') {
        if (o.state === 'listen') { if (o.queue.length) ev |= EP.IN; }
        else if (o.state === 'conn') {
          if (o.rx.size > 0 || o.rx.wclosed) ev |= EP.IN;
          if (o.rx.wclosed) ev |= EP.RDHUP;
          if (o.tx.rclosed) ev |= EP.ERR | EP.HUP | EP.OUT;
          else if (o.tx.size < SOCK_CAP) ev |= EP.OUT;
          if (o.rx.wclosed && (o.tx.rclosed || o.tx.wclosed)) ev |= EP.HUP;
        } else ev |= EP.HUP;
      } else if (o.kind === 'pipe-r') {
        if (o.pipe.size > 0) ev |= EP.IN;
        if (o.pipe.writers === 0) ev |= EP.IN | EP.HUP;
      } else if (o.kind === 'pipe-w') {
        if (o.pipe.readers === 0) ev |= EP.OUT | EP.ERR;
        else if (o.pipe.size < PIPE_CAP) ev |= EP.OUT;
      } else if (o.kind === 'tty') {
        ev |= EP.OUT;
        if (tty.reader && tty.reader.proc === p && tty.reader.done) ev |= EP.IN;
      } else ev |= EP.IN | EP.OUT;
      return ev;
    }
    function epollReady(p, ep) {
      const out = [];
      for (const [fd, it] of ep.items) {
        const o = p.fds.get(fd);
        if (!o) continue;
        const ev = readiness(p, o) & (it.events | EP.ERR | EP.HUP);
        if (ev) out.push({ ev, it });
      }
      return out;
    }
    function netFor(p) {
      const sockOf = (fd) => { const o = p.fds.get(fd); return !o ? -E.BADF : o.kind !== 'sock' ? -E.NOTSOCK : o; };
      return {
        socket(domain, type) {
          return allocFd(p, new OFD('sock', { state: 'new', domain, nonblock: !!(type & NONBLOCK) }));
        },
        bind(fd, port) {
          const o = sockOf(fd); if (typeof o === 'number') return o;
          if (o.state !== 'new' || o.port) return -E.INVAL;
          if (port && ports.has(port)) return -E.ADDRINUSE;
          o.port = port || nextEphemeral++;
          return 0;
        },
        listen(fd) {
          const o = sockOf(fd); if (typeof o === 'number') return o;
          if (o.state === 'listen') return 0;
          if (o.state !== 'new') return -E.INVAL;
          if (!o.port) o.port = nextEphemeral++;
          if (ports.has(o.port)) return -E.ADDRINUSE;
          o.state = 'listen'; o.queue = [];
          ports.set(o.port, o);
          if (opts.onListen) opts.onListen(o.port, p.pid);
          return 0;
        },
        accept(fd, flags) {
          return blocking(p, () => {
            const o = sockOf(fd); if (typeof o === 'number') return { done: true, value: o };
            if (o.state !== 'listen') return { done: true, value: -E.INVAL };
            if (o.queue.length) {
              const c = o.queue.shift();
              const conn = new OFD('sock', { state: 'conn', rx: c.c2s, tx: c.s2c, port: o.port, peerPort: c.peerPort, nonblock: !!(flags & NONBLOCK) });
              c.accepted = true;
              notify();
              return { done: true, value: allocFd(p, conn) };
            }
            if (o.nonblock) return { done: true, value: -E.AGAIN };
            return { done: false, wait: () => o.queue.length > 0 || o.state !== 'listen' };
          });
        },
        recv(fd, buf, len, flags) {
          return blocking(p, () => {
            const o = sockOf(fd); if (typeof o === 'number') return { done: true, value: o };
            const r = tryRead(p, o, len);
            if (!r.done) return (o.nonblock || (flags & MSG.DONTWAIT)) ? { done: true, value: -E.AGAIN } : r;
            if (r.error) return { done: true, value: -r.error };
            bytes(p).set(r.value, buf);
            return { done: true, value: r.value.length };
          });
        },
        send(fd, buf, len, flags) {
          return blocking(p, () => {
            const o = sockOf(fd); if (typeof o === 'number') return { done: true, value: o };
            const r = tryWrite(p, o, bytes(p).slice(buf, buf + len));
            if (!r.done) return (o.nonblock || (flags & MSG.DONTWAIT)) ? { done: true, value: -E.AGAIN } : r;
            if (r.sigpipe && !(flags & MSG.NOSIGNAL)) { kill(p, SIG.PIPE); if (p.status === 'zombie') throw new ProcExit(p.exitStatus); }
            if (r.error) return { done: true, value: -r.error };
            return { done: true, value: r.value };
          });
        },
        shutdown(fd, how) {
          const o = sockOf(fd); if (typeof o === 'number') return o;
          if (o.state !== 'conn') return -E.NOTCONN;
          if (how & 1) o.rdShut = true;          // SHUT_RD
          if (how & 2) { o.tx.wclosed = true; notify(); } // SHUT_WR
          return 0;
        },
        sock_port(fd, peer) {
          const o = sockOf(fd); if (typeof o === 'number') return o;
          return (peer ? o.peerPort : o.port) || 0;
        },
        epoll_create() { return allocFd(p, new OFD('epoll', { items: new Map() })); },
        epoll_ctl(epfd, op, fd, evPtr) {
          const ep = p.fds.get(epfd);
          if (!ep || ep.kind !== 'epoll' || !p.fds.has(fd)) return -E.BADF;
          if (fd === epfd) return -E.INVAL;
          const has = ep.items.has(fd);
          if (op === 2) { if (!has) return -E.NOENT; ep.items.delete(fd); return 0; }
          if (op === 1 && has) return -E.EXIST;
          if (op === 3 && !has) return -E.NOENT;
          if (op !== 1 && op !== 3) return -E.INVAL;
          const v = view(p);
          ep.items.set(fd, { events: v.getUint32(evPtr, true), lo: v.getUint32(evPtr + 8, true), hi: v.getUint32(evPtr + 12, true) });
          notify();
          return 0;
        },
        epoll_wait(epfd, evs, max, timeout) {
          if (p.state !== 'rewinding' || !p.epollDeadline) p.epollDeadline = timeout < 0 ? Infinity : performance.now() + timeout;
          return blocking(p, () => {
            const ep = p.fds.get(epfd);
            if (!ep || ep.kind !== 'epoll') { p.epollDeadline = 0; return { done: true, value: -E.BADF }; }
            const ready = epollReady(p, ep);
            const deadline = p.epollDeadline;
            if (ready.length || performance.now() >= deadline) {
              p.epollDeadline = 0;
              const v = view(p), n = Math.min(max, ready.length);
              for (let i = 0; i < n; i++) {
                const { ev, it } = ready[i], o = evs + i * 16;
                v.setUint32(o, ev, true); v.setUint32(o + 8, it.lo, true); v.setUint32(o + 12, it.hi, true);
              }
              return { done: true, value: n };
            }
            if (deadline !== Infinity) setTimeout(notify, Math.max(0, deadline - performance.now()) + 1);
            return { done: false, wait: () => epollReady(p, ep).length > 0 || performance.now() >= deadline };
          });
        },
      };
    }
    // The page's side of a connection to a listening port.
    const net = {
      ports,
      connect(port) {
        const l = ports.get(port);
        if (!l || l.state !== 'listen') throw Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
        const c = { c2s: new Stream(), s2c: new Stream(), peerPort: nextEphemeral++, accepted: false };
        l.queue.push(c);
        notify();
        return {
          write(data) { if (!c.c2s.wclosed) { c.c2s.push(typeof data === 'string' ? enc.encode(data) : data); notify(); } },
          async read() {
            await until(null, () => c.s2c.size > 0 || c.s2c.wclosed);
            return c.s2c.size > 0 ? c.s2c.take(c.s2c.size) : null;
          },
          hasData: () => c.s2c.size > 0,
          get closed() { return c.s2c.wclosed && c.s2c.size === 0; },
          end() { c.c2s.wclosed = true; notify(); },
          close() { c.c2s.wclosed = true; c.s2c.rclosed = true; c.s2c.chunks = []; c.s2c.size = 0; notify(); },
        };
      },
    };

    function putStrings(p, list, ptrs, buf) {
      const v = view(p), b = bytes(p);
      list.forEach((s, i) => {
        const e = enc.encode(s);
        v.setUint32(ptrs + i * 4, buf, true);
        b.set(e, buf); b[buf + e.length] = 0; buf += e.length + 1;
      });
      return 0;
    }
    function writeStat(p, o, n, kind) {
      const v = view(p);
      for (let i = 0; i < 64; i += 8) v.setBigUint64(o + i, 0n, true);
      const type = n ? (n.type === 'dir' ? 3 : 4) : kind === 'tty' ? 2 : 6;
      v.setBigUint64(o + 8, BigInt(n ? n.ino : 0), true);
      v.setUint8(o + 16, type);
      v.setBigUint64(o + 24, 1n, true);
      v.setBigUint64(o + 32, BigInt(n && n.data ? n.data.length : 0), true);
      const t = BigInt(Math.round((n ? n.mtime : Date.now()) * 1e6));
      v.setBigUint64(o + 40, t, true); v.setBigUint64(o + 48, t, true); v.setBigUint64(o + 56, t, true);
    }
    function concat(parts) {
      const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
      let off = 0; for (const a of parts) { out.set(a, off); off += a.length; }
      return out;
    }

    // ---------------- running wasm processes
    async function instantiate(p, module) {
      const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasiFor(p), posix: posixFor(p) });
      p.inst = inst; p.ex = inst.exports; p.mem = p.ex.memory;
      p.abufSize = 64 * 1024;
      p.cwdFn = () => cstr(p, p.ex.mlxweb_cwd());
    }

    async function startWasm(p, module, argv, env) {
      p.kind = 'wasm'; p.module = module; p.argv = argv; p.env = env;
      p.state = 'normal'; p.started = false;
      await instantiate(p, module);
      p.abuf = p.ex.mlxweb_async_buf();
      p.status = 'blocked';
      p.wait = () => true;
      notify();
    }

    async function doFork(parent) {
      const child = newProc(parent.pid, parent.fds, parent.cwd);
      child.kind = 'wasm'; child.module = parent.module; child.argv = parent.argv; child.env = parent.env;
      child.sig = { ...parent.sig };
      child.status = 'forking';
      await instantiate(child, parent.module);
      const need = parent.mem.buffer.byteLength - child.mem.buffer.byteLength;
      if (need > 0) child.mem.grow(need / 65536);
      new Uint8Array(child.mem.buffer).set(new Uint8Array(parent.mem.buffer));
      child.ex.__stack_pointer.value = parent.ex.__stack_pointer.value;
      child.abuf = parent.abuf; child.abufSize = parent.abufSize;
      child.state = 'normal'; child.started = true;
      child.forkResult = 0;
      parent.forkResult = child.pid;
      child.status = 'blocked'; child.wait = () => true;
      parent.status = 'blocked'; parent.wait = () => true;
      notify();
    }

    async function runWasm(p) {
      if (p.status === 'zombie') return;
      p.status = 'running';
      try {
        if (p.started) { p.ex.asyncify_start_rewind(p.abuf); p.state = 'rewinding'; }
        p.started = true;
        p.ex._start();
      } catch (e) {
        p.state = 'normal';
        if (p.status === 'zombie') return;
        if (e instanceof ProcExit) return exitProc(p, e.status);
        if (e instanceof ExecReq) return doExec(p, e.req);
        console.error('[posix] pid ' + p.pid + ' crashed:', e);
        tty.out('\r\n[segmentation fault]\r\n');
        return exitProc(p, 11);
      }
      if (p.status === 'zombie') return;
      if (p.state === 'unwinding') {
        p.ex.asyncify_stop_unwind();
        p.state = 'normal';
        if (p.forkPending) { p.forkPending = false; p.status = 'forking'; await doFork(p); return; }
        p.status = 'blocked';
        return;
      }
      exitProc(p, 0);
    }

    async function doExec(p, req) {
      const n = req.node;
      p.argv = req.argv; p.env = req.env; p.cwd = req.cwd;
      p.inst = p.ex = p.mem = null; p.sig = {};
      if (n.exec.startsWith('wasm:')) {
        const module = programs[n.exec.slice(5)];
        return startWasm(p, module, req.argv, req.env);
      }
      const cmd = commands[n.exec];
      p.kind = 'js';
      p.status = 'running';
      runJs(p, cmd, req);
    }

    // ---------------- JS commands
    function jsApi(p, req) {
      const envObj = {};
      for (const kv of req.env) { const i = kv.indexOf('='); if (i > 0) envObj[kv.slice(0, i)] = kv.slice(i + 1); }
      const api = {
        argv: req.argv, env: envObj, cwd: req.cwd, fs, FS, pid: p.pid,
        resolve: (path) => fs.resolve(req.cwd, path),
        async read(fd, n = 65536) {
          const o = p.fds.get(fd);
          if (!o) throw new Error('bad fd');
          for (;;) {
            const r = tryRead(p, o, n);
            if (r.done) { if (r.error) throw new Error('read error'); return r.value; }
            await until(p, r.wait);
          }
        },
        async write(fd, s) {
          let data = typeof s === 'string' ? enc.encode(s) : s;
          const o = p.fds.get(fd);
          if (!o) return;
          while (data.length) {
            const r = tryWrite(p, o, data);
            if (r.done) {
              if (r.sigpipe) { terminate(p, SIG.PIPE); throw new Killed(SIG.PIPE); }
              if (r.error) return;
              data = data.subarray(r.value);
            } else await until(p, r.wait);
          }
        },
        out(s) { return api.write(1, s); },
        err(s) { return api.write(2, s); },
        async readAll(fd = 0) {
          const parts = [];
          for (;;) { const c = await api.read(fd); if (!c.length) break; parts.push(c); }
          return dec.decode(concat(parts));
        },
        async sleep(ms) { const t = performance.now() + ms; setTimeout(notify, ms + 1); await until(p, () => performance.now() >= t); },
        isTty: (fd) => (p.fds.get(fd) || {}).kind === 'tty',
        decode: (b) => dec.decode(b),
      };
      return api;
    }
    async function runJs(p, cmd, req) {
      let code = 0;
      try {
        code = await cmd(jsApi(p, req));
      } catch (e) {
        if (e instanceof Killed) return; // already terminated
        console.error(e);
        code = 1;
      }
      exitProc(p, ((code | 0) & 0xff) << 8);
    }

    // ---------------- boot
    async function spawnRoot(name, argv, env, cwd, stdio) {
      // stdio: optional { stdout(bytes), stderr(bytes) } instead of the terminal
      const sink = (f) => (f ? new OFD('sink', { sink: f }) : tty.ttyOfd);
      const fds = new Map([[0, stdio ? new OFD('dev', { dev: 'null' }) : tty.ttyOfd],
        [1, sink(stdio && stdio.stdout)], [2, sink(stdio && stdio.stderr)]]);
      const p = newProc(0, fds, cwd);
      p.root = true;
      await startWasm(p, programs[name], argv, env);
      return p;
    }

    return {
      fs, tty, procs, spawnRoot, net,
      input: (d) => tty.input(d),
      killAll() { for (const p of [...procs.values()]) { p.killed = SIG.KILL; exitProc(p, SIG.KILL); } procs.clear(); tty.reader = null; },
      set onSessionEnd(f) { onSessionEnd = f; },
    };
  }

  global.Posix = { create, FS, Node };
})(typeof window !== 'undefined' ? window : globalThis);
