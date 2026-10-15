/*
 * commands.js — the programs in /bin for posix.js, written in JS.
 * Each command gets `sys` (argv, env, cwd, fs, read/write/out/err...) and
 * returns its exit code. Output and errors follow GNU coreutils closely
 * enough for a shell project.
 */
(function (global) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // split "-abc" style options; returns { flags:Set, args:[], values:{} }
  function opts(argv, withValue = '') {
    const flags = new Set(), args = [], values = {};
    let i = 1;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { i++; break; }
      if (a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const f = a[j];
          if (withValue.includes(f)) {
            values[f] = a.slice(j + 1) || argv[++i];
            break;
          }
          flags.add(f);
        }
      } else args.push(a);
    }
    return { flags, args: args.concat(argv.slice(i)), values };
  }

  function lookup(sys, path) {
    const abs = sys.resolve(path);
    return { abs, node: sys.fs.lookup(abs) };
  }

  async function textOf(sys, files, name) {
    if (!files.length) return { ok: true, text: await sys.readAll(0) };
    let text = '', ok = true;
    for (const f of files) {
      if (f === '-') { text += await sys.readAll(0); continue; }
      const { node } = lookup(sys, f);
      if (!node) { await sys.err(`${name}: ${f}: No such file or directory\n`); ok = false; continue; }
      if (node.type === 'dir') { await sys.err(`${name}: ${f}: Is a directory\n`); ok = false; continue; }
      text += sys.decode(node.data);
    }
    return { ok, text };
  }

  const splitLines = (t) => { const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

  function modeString(n) {
    const t = n.type === 'dir' ? 'd' : '-';
    const m = n.mode;
    let s = '';
    for (let i = 8; i >= 0; i--) s += (m >> i) & 1 ? 'rwx'[(8 - i) % 3] : '-';
    return t + s;
  }
  function dateString(ms) {
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const cmds = {
    async true() { return 0; },
    async false() { return 1; },

    async echo(sys) {
      let a = sys.argv.slice(1), nl = true;
      while (a.length && /^-n+$/.test(a[0])) { nl = false; a = a.slice(1); }
      await sys.out(a.join(' ') + (nl ? '\n' : ''));
      return 0;
    },

    async cat(sys) {
      const { args, flags } = opts(sys.argv);
      let code = 0, n = 1;
      const deco = (l) => (flags.has('n') ? String(n++).padStart(6) + '\t' : '') + l + (flags.has('e') ? '$' : '');
      if (!args.length) {
        let buf = '';
        for (;;) {
          const c = await sys.read(0);
          if (!c.length) break;
          if (!flags.has('n') && !flags.has('e')) { await sys.write(1, c); continue; }
          buf += sys.decode(c);
          const parts = buf.split('\n');
          buf = parts.pop();
          if (parts.length) await sys.out(parts.map((l) => deco(l) + '\n').join(''));
        }
        if (buf) await sys.out(deco(buf));
        return 0;
      }
      for (const f of args) {
        if (f === '-') { await sys.out(await sys.readAll(0)); continue; }
        const { node } = lookup(sys, f);
        if (!node) { await sys.err(`cat: ${f}: No such file or directory\n`); code = 1; continue; }
        if (node.type === 'dir') { await sys.err(`cat: ${f}: Is a directory\n`); code = 1; continue; }
        if (flags.has('n') || flags.has('e')) {
          const lines = splitLines(sys.decode(node.data));
          await sys.out(lines.map((l) => deco(l) + '\n').join(''));
        } else await sys.write(1, node.data);
      }
      return code;
    },

    async ls(sys) {
      const { flags, args } = opts(sys.argv);
      const all = flags.has('a'), long = flags.has('l'), one = flags.has('1') || !sys.isTty(1);
      const targets = args.length ? args : ['.'];
      let code = 0;
      const files = [], dirs = [];
      for (const t of targets) {
        const { node } = lookup(sys, t);
        if (!node) { await sys.err(`ls: cannot access '${t}': No such file or directory\n`); code = 2; continue; }
        (node.type === 'dir' && !flags.has('d') ? dirs : files).push([t, node]);
      }
      const fmt = (entries) => {
        if (long) {
          const w = Math.max(1, ...entries.map(([, n]) => String(n.data ? n.data.length : 4096).length));
          return entries.map(([name, n]) => `${modeString(n)} 1 samaouch 2024 ${String(n.data ? n.data.length : 4096).padStart(w)} ${dateString(n.mtime)} ${color(name, n)}`).join('\n') + (entries.length ? '\n' : '');
        }
        if (one) return entries.map(([name, n]) => color(name, n)).join('\n') + (entries.length ? '\n' : '');
        return entries.map(([name, n]) => color(name, n)).join('  ') + (entries.length ? '\n' : '');
      };
      const color = (name, n) => (!sys.isTty(1) ? name : n.type === 'dir' ? `\x1b[1;34m${name}\x1b[0m` : n.mode & 0o111 ? `\x1b[1;32m${name}\x1b[0m` : name);
      if (files.length) await sys.out(fmt(files));
      for (let i = 0; i < dirs.length; i++) {
        const [t, node] = dirs[i];
        if (dirs.length + files.length > 1) await sys.out((i || files.length ? '\n' : '') + t + ':\n');
        let entries = [...node.children.entries()].filter(([name]) => all || name[0] !== '.');
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        if (all) entries = [['.', node], ['..', node]].concat(entries);
        if (long) await sys.out('total ' + entries.length * 4 + '\n');
        await sys.out(fmt(entries));
      }
      return code;
    },

    async pwd(sys) { await sys.out(sys.cwd + '\n'); return 0; },

    async env(sys) {
      await sys.out(Object.entries(sys.env).map(([k, v]) => k + '=' + v).join('\n') + '\n');
      return 0;
    },
    async printenv(sys) {
      const names = sys.argv.slice(1);
      if (!names.length) return cmds.env(sys);
      let code = 0;
      for (const n of names) { if (n in sys.env) await sys.out(sys.env[n] + '\n'); else code = 1; }
      return code;
    },

    async grep(sys) {
      const { flags, args } = opts(sys.argv, 'e');
      let pattern = args.shift();
      if (pattern === undefined) { await sys.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n'); return 2; }
      let re;
      try { re = new RegExp(flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\|/g, '|'), flags.has('i') ? 'i' : ''); }
      catch { await sys.err('grep: invalid pattern\n'); return 2; }
      const files = [];
      const walk = (abs, shown) => {
        const n = sys.fs.lookup(abs);
        if (!n) return;
        if (n.type === 'dir') { for (const k of [...n.children.keys()].sort()) walk(abs + '/' + k, shown + '/' + k); }
        else files.push([shown, n]);
      };
      if (!args.length && !flags.has('r')) {
        const lines = splitLines(await sys.readAll(0));
        return emit(lines.map((l) => ['', l]), false);
      }
      for (const f of args.length ? args : ['.']) {
        const { abs, node } = lookup(sys, f);
        if (!node) { await sys.err(`grep: ${f}: No such file or directory\n`); continue; }
        if (node.type === 'dir') { if (flags.has('r')) walk(abs, f.replace(/\/$/, '')); else await sys.err(`grep: ${f}: Is a directory\n`); continue; }
        files.push([f, node]);
      }
      const many = files.length > 1 || flags.has('r');
      const all = [];
      for (const [name, n] of files) for (const l of splitLines(sys.decode(n.data))) all.push([name, l]);
      return emit(all, many);

      async function emit(lines, showName) {
        let count = 0, out = '', ln = {}; const counts = {};
        for (const [name, l] of lines) {
          ln[name] = (ln[name] || 0) + 1;
          if (re.test(l) === flags.has('v')) continue;
          count++; counts[name] = (counts[name] || 0) + 1;
          if (flags.has('c') || flags.has('l') || flags.has('q')) continue;
          const shown = sys.isTty(1) && !flags.has('v') ? l.replace(new RegExp(re.source, re.flags + 'g'), (m) => `\x1b[1;31m${m}\x1b[0m`) : l;
          out += (showName ? `\x1b[35m${name}\x1b[0m:` : '') + (flags.has('n') ? `\x1b[32m${ln[name]}\x1b[0m:` : '') + shown + '\n';
        }
        if (flags.has('c')) out = showName ? Object.keys(ln).map((k) => `${k}:${counts[k] || 0}`).join('\n') + '\n' : count + '\n';
        if (flags.has('l')) out = Object.keys(counts).join('\n') + (count ? '\n' : '');
        if (!sys.isTty(1)) out = out.replace(/\x1b\[[0-9;]*m/g, '');
        if (!flags.has('q')) await sys.out(out);
        return count ? 0 : 1;
      }
    },

    async wc(sys) {
      const { flags, args } = opts(sys.argv);
      const pick = flags.size ? ['l', 'w', 'c'].filter((f) => flags.has(f) || (f === 'c' && flags.has('m'))) : ['l', 'w', 'c'];
      const count = (t) => ({ l: (t.match(/\n/g) || []).length, w: (t.match(/\S+/g) || []).length, c: new TextEncoder().encode(t).length });
      const rows = [];
      if (!args.length) rows.push([count(await sys.readAll(0)), '']);
      for (const f of args) {
        const { node } = lookup(sys, f);
        if (!node || node.type === 'dir') { await sys.err(`wc: ${f}: ${node ? 'Is a directory' : 'No such file or directory'}\n`); continue; }
        rows.push([count(sys.decode(node.data)), f]);
      }
      if (rows.length > 1) rows.push([rows.reduce((t, [c]) => ({ l: t.l + c.l, w: t.w + c.w, c: t.c + c.c }), { l: 0, w: 0, c: 0 }), 'total']);
      const w = args.length ? Math.max(...rows.map(([c]) => Math.max(...pick.map((k) => String(c[k]).length)))) : 0;
      await sys.out(rows.map(([c, name]) => pick.map((k) => String(c[k]).padStart(w)).join(' ') + (name ? ' ' + name : '')).join('\n') + '\n');
      return 0;
    },

    async head(sys) {
      const { args, values } = opts(sys.argv, 'nc');
      const n = parseInt(values.n || '10', 10);
      if (!args.length || (args.length === 1 && args[0] === '-')) {
        // stream stdin and stop after n lines (so `yes | head` ends)
        let buf = '', count = 0;
        while (count < n) {
          const c = await sys.read(0);
          if (!c.length) break;
          buf += sys.decode(c);
          let i;
          while (count < n && (i = buf.indexOf('\n')) >= 0) {
            await sys.out(buf.slice(0, i + 1));
            buf = buf.slice(i + 1);
            count++;
          }
        }
        if (count < n && buf) await sys.out(buf);
        return 0;
      }
      const { text } = await textOf(sys, args, 'head');
      const lines = splitLines(text);
      await sys.out(lines.slice(0, n).map((l) => l + '\n').join(''));
      return 0;
    },
    async tail(sys) {
      const { args, values } = opts(sys.argv, 'n');
      const n = parseInt(values.n || '10', 10);
      const { text } = await textOf(sys, args, 'tail');
      const lines = splitLines(text);
      await sys.out(lines.slice(Math.max(0, lines.length - n)).map((l) => l + '\n').join(''));
      return 0;
    },

    async sort(sys) {
      const { flags, args } = opts(sys.argv);
      const { text } = await textOf(sys, args, 'sort');
      let lines = splitLines(text);
      lines.sort(flags.has('n') ? (a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b) : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (flags.has('r')) lines.reverse();
      if (flags.has('u')) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
      await sys.out(lines.map((l) => l + '\n').join(''));
      return 0;
    },

    async uniq(sys) {
      const { flags, args } = opts(sys.argv);
      const { text } = await textOf(sys, args, 'uniq');
      const groups = [];
      for (const l of splitLines(text)) {
        if (groups.length && groups[groups.length - 1][0] === l) groups[groups.length - 1][1]++;
        else groups.push([l, 1]);
      }
      await sys.out(groups.filter(([, c]) => !flags.has('d') || c > 1).map(([l, c]) => (flags.has('c') ? String(c).padStart(7) + ' ' : '') + l + '\n').join(''));
      return 0;
    },

    async rev(sys) {
      const { text } = await textOf(sys, sys.argv.slice(1), 'rev');
      await sys.out(splitLines(text).map((l) => [...l].reverse().join('') + '\n').join(''));
      return 0;
    },

    async tr(sys) {
      const { flags, args } = opts(sys.argv);
      const expand = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:digit:\]/g, '0-9').replace(/\[:space:\]/g, ' \t\n')
        .replace(/(.)-(.)/g, (m, a, b) => { let r = ''; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
      const set1 = expand(args[0] || ''), set2 = expand(args[1] || '');
      const text = await sys.readAll(0);
      let out = '';
      for (const ch of text) {
        const i = set1.indexOf(ch);
        if (flags.has('d')) { if (i < 0) out += ch; continue; }
        out += i < 0 ? ch : set2[Math.min(i, set2.length - 1)] ?? ch;
      }
      await sys.out(out);
      return 0;
    },

    async cut(sys) {
      const { args, values } = opts(sys.argv, 'df');
      const d = values.d ?? '\t';
      const fields = new Set();
      for (const part of String(values.f || '1').split(',')) {
        const [a, b] = part.split('-');
        const lo = parseInt(a || '1', 10), hi = b === undefined ? lo : parseInt(b || '999', 10);
        for (let i = lo; i <= hi; i++) fields.add(i);
      }
      const { text } = await textOf(sys, args, 'cut');
      await sys.out(splitLines(text).map((l) => l.split(d).filter((_, i) => fields.has(i + 1)).join(d) + '\n').join(''));
      return 0;
    },

    async tee(sys) {
      const { flags, args } = opts(sys.argv);
      const targets = args.map((f) => {
        const abs = sys.resolve(f);
        let n = sys.fs.lookup(abs);
        if (!n) n = sys.fs.writeFile(abs, '');
        else if (!flags.has('a')) n.data = new Uint8Array(0);
        return n;
      });
      for (;;) {
        const c = await sys.read(0);
        if (!c.length) break;
        for (const n of targets) { const g = new Uint8Array(n.data.length + c.length); g.set(n.data); g.set(c, n.data.length); n.data = g; n.mtime = Date.now(); }
        await sys.write(1, c);
      }
      return 0;
    },

    async touch(sys) {
      for (const f of sys.argv.slice(1)) {
        const abs = sys.resolve(f);
        const n = sys.fs.lookup(abs);
        if (n) { n.mtime = Date.now(); continue; }
        const { dir } = sys.fs.parent(abs);
        if (!dir) { await sys.err(`touch: cannot touch '${f}': No such file or directory\n`); return 1; }
        sys.fs.writeFile(abs, '');
      }
      return 0;
    },

    async mkdir(sys) {
      const { flags, args } = opts(sys.argv);
      let code = 0;
      for (const f of args) {
        const abs = sys.resolve(f);
        if (sys.fs.lookup(abs)) { if (!flags.has('p')) { await sys.err(`mkdir: cannot create directory '${f}': File exists\n`); code = 1; } continue; }
        if (flags.has('p')) { sys.fs.mkdirp(abs); continue; }
        const { dir, name } = sys.fs.parent(abs);
        if (!dir) { await sys.err(`mkdir: cannot create directory '${f}': No such file or directory\n`); code = 1; continue; }
        dir.children.set(name, new global.Posix.Node('dir', 0o755));
      }
      return code;
    },

    async rm(sys) {
      const { flags, args } = opts(sys.argv);
      let code = 0;
      for (const f of args) {
        const abs = sys.resolve(f);
        const { dir, name } = sys.fs.parent(abs);
        const n = dir && dir.children.get(name);
        if (!n) { if (!flags.has('f')) { await sys.err(`rm: cannot remove '${f}': No such file or directory\n`); code = 1; } continue; }
        if (n.type === 'dir' && !flags.has('r') && !flags.has('R')) { await sys.err(`rm: cannot remove '${f}': Is a directory\n`); code = 1; continue; }
        dir.children.delete(name);
      }
      return code;
    },
    async rmdir(sys) {
      let code = 0;
      for (const f of sys.argv.slice(1)) {
        const { dir, name } = sys.fs.parent(sys.resolve(f));
        const n = dir && dir.children.get(name);
        if (!n || n.type !== 'dir') { await sys.err(`rmdir: failed to remove '${f}': ${n ? 'Not a directory' : 'No such file or directory'}\n`); code = 1; continue; }
        if (n.children.size) { await sys.err(`rmdir: failed to remove '${f}': Directory not empty\n`); code = 1; continue; }
        dir.children.delete(name);
      }
      return code;
    },

    async cp(sys) {
      const { args } = opts(sys.argv);
      if (args.length < 2) { await sys.err('cp: missing file operand\n'); return 1; }
      const dest = args.pop();
      const d = sys.fs.lookup(sys.resolve(dest));
      for (const f of args) {
        const n = sys.fs.lookup(sys.resolve(f));
        if (!n) { await sys.err(`cp: cannot stat '${f}': No such file or directory\n`); return 1; }
        if (n.type === 'dir') { await sys.err(`cp: -r not specified; omitting directory '${f}'\n`); return 1; }
        const target = d && d.type === 'dir' ? sys.resolve(dest) + '/' + f.split('/').pop() : sys.resolve(dest);
        sys.fs.writeFile(target, n.data.slice(), n.mode);
      }
      return 0;
    },
    async mv(sys) {
      const { args } = opts(sys.argv);
      if (args.length < 2) { await sys.err('mv: missing file operand\n'); return 1; }
      const dest = args.pop();
      const d = sys.fs.lookup(sys.resolve(dest));
      for (const f of args) {
        const src = sys.fs.parent(sys.resolve(f));
        const n = src.dir && src.dir.children.get(src.name);
        if (!n) { await sys.err(`mv: cannot stat '${f}': No such file or directory\n`); return 1; }
        const target = d && d.type === 'dir' ? sys.resolve(dest) + '/' + src.name : sys.resolve(dest);
        const t = sys.fs.parent(target);
        if (!t.dir) { await sys.err(`mv: cannot move '${f}': No such file or directory\n`); return 1; }
        src.dir.children.delete(src.name);
        t.dir.children.set(t.name, n);
      }
      return 0;
    },

    async sleep(sys) {
      const s = parseFloat(sys.argv[1]);
      if (Number.isNaN(s)) { await sys.err('sleep: missing operand\n'); return 1; }
      await sys.sleep(s * 1000);
      return 0;
    },
    async yes(sys) {
      const line = (sys.argv.slice(1).join(' ') || 'y') + '\n';
      const block = line.repeat(Math.max(1, Math.floor(4096 / line.length)));
      for (;;) await sys.out(block);
    },
    async seq(sys) {
      const n = sys.argv.slice(1).map(Number);
      const [a, step, b] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
      let out = '';
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) out += i + '\n';
      await sys.out(out);
      return 0;
    },
    async date(sys) { await sys.out(new Date().toString().replace(/ \(.*\)$/, '') + '\n'); return 0; },
    async whoami(sys) { await sys.out((sys.env.USER || 'samaouch') + '\n'); return 0; },
    async uname(sys) { await sys.out(sys.argv.includes('-a') ? 'Linux minishell 6.1.0-wasm #42 SMP wasm32 GNU/Linux\n' : 'Linux\n'); return 0; },
    async hostname(sys) { await sys.out('minishell\n'); return 0; },
    async clear(sys) { await sys.out('\x1b[H\x1b[2J\x1b[3J'); return 0; },
    async basename(sys) { const a = sys.argv[1] || ''; let b = a.replace(/\/+$/, '').split('/').pop(); if (sys.argv[2] && b.endsWith(sys.argv[2])) b = b.slice(0, -sys.argv[2].length); await sys.out(b + '\n'); return 0; },
    async dirname(sys) { const a = (sys.argv[1] || '').replace(/\/+$/, ''); const i = a.lastIndexOf('/'); await sys.out((i < 0 ? '.' : i === 0 ? '/' : a.slice(0, i)) + '\n'); return 0; },
    async expr(sys) {
      const [a, op, b] = sys.argv.slice(1);
      const x = Number(a), y = Number(b);
      const r = { '+': x + y, '-': x - y, '*': x * y, '/': Math.trunc(x / y), '%': x % y }[op];
      if (r === undefined || Number.isNaN(r)) { await sys.err('expr: syntax error\n'); return 2; }
      await sys.out(r + '\n');
      return r === 0 ? 1 : 0;
    },
    async help(sys) {
      await sys.out('Available commands: ' + Object.keys(cmds).sort().join(' ') + '\n'
        + 'The builtins (cd, echo, export, unset, env, pwd, exit) are minishell\'s own.\n');
      return 0;
    },
  };

  global.PosixCommands = cmds;
})(typeof window !== 'undefined' ? window : globalThis);
