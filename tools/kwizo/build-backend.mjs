// Bundles the compiled backend (tsc output in ./be) for the browser.
import * as esbuild from 'esbuild';
import path from 'path';
const here = path.dirname(new URL(import.meta.url).pathname);
const be = path.join(here, 'be');
const s = (f) => path.join(here, 'shims', f);
const prismaClient = path.join(be, 'node_modules/.prisma/client');
const P = (m) => path.join(here, 'node_modules', m);
const poly = { stream: 'stream-browserify', events: 'events', util: 'util', buffer: 'buffer', path: 'path-browserify',
  crypto: 'crypto-browserify', zlib: 'browserify-zlib', os: 'os-browserify/browser.js', url: 'url', querystring: 'querystring-es3',
  string_decoder: 'string_decoder', assert: 'assert', process: 'process/browser.js', timers: 'timers-browserify',
  constants: 'constants-browserify', vm: 'vm-browserify', tty: 'tty-browserify', punycode: 'punycode' };
const alias = {
  'http': s('http.js'), 'https': s('http.js'), 'node:http': s('http.js'), 'node:https': s('http.js'),
  'net': s('net.js'), 'tls': s('net.js'), 'node:net': s('net.js'), 'node:tls': s('net.js'),
  'fs': s('fs.js'), 'node:fs': s('fs.js'), 'fs/promises': s('fs-promises.js'), 'node:fs/promises': s('fs-promises.js'),
  'bcrypt': path.join(here, 'node_modules/bcryptjs'),
  '@prisma/adapter-pg': s('adapter-pg.js'),
  '@prisma/client': s('prisma-client.js'),
  'PRISMA_EDGE_CLIENT': path.join(prismaClient, 'edge.js'),
  '#wasm-compiler-loader': s('prisma-wasm-loader.js'),
  'PRISMA_WASM_B64': path.join(prismaClient, 'query_compiler_fast_bg.wasm-base64.js'),
  'dotenv/config': s('empty.js'), 'dotenv': s('empty.js'),
  'ws': s('ws.js'), 'child_process': s('empty.js'), 'node:child_process': s('empty.js'),
  'worker_threads': s('empty.js'), 'async_hooks': s('async_hooks.js'), 'node:async_hooks': s('async_hooks.js'),
  'repl': s('empty.js'), 'node:repl': s('empty.js'), 'http2': s('empty.js'), 'node:http2': s('empty.js'), 'dgram': s('empty.js'),
  'perf_hooks': s('perf_hooks.js'), 'node:perf_hooks': s('perf_hooks.js'), 'readline': s('empty.js'), 'module': s('empty.js'),
  'v8': s('empty.js'), 'inspector': s('empty.js'), 'diagnostics_channel': s('empty.js'), 'node:diagnostics_channel': s('empty.js'), 'cluster': s('empty.js'), 'dns': s('empty.js'),
};
for (const [k, v] of Object.entries(poly)) { alias[k] = alias['node:' + k] = P(v); }
alias.crypto = alias['node:crypto'] = s('crypto.js');
alias.timers = alias['node:timers'] = s('timers.js');
alias['timers/promises'] = alias['node:timers/promises'] = s('timers-promises.js');
alias['stream/promises'] = alias['node:stream/promises'] = s('stream-promises.js');
alias['util/types'] = alias['node:util/types'] = s('util-types.js');
alias['path/posix'] = alias['node:path/posix'] = P('path-browserify');
const srcAlias = {
  name: 'aliases',
  setup(b) {
    b.onResolve({ filter: /^src\// }, (a) => ({ path: path.join(be, a.path + '.js') }));
    b.onResolve({ filter: /.*/ }, (a) => {
      const t = alias[a.path];
      if (!t) return undefined;
      return { path: /\.m?js$/.test(t) ? t : requireFrom(t) };
    });
  },
};
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
function requireFrom(t) { return req.resolve(t); }
await esbuild.build({
  entryPoints: [path.join(here, 'browser-entry.js')],
  bundle: true, format: 'esm',
  external: ['@nestjs/microservices', '@nestjs/microservices/*', 'class-transformer/storage', '@grpc/*', 'kafkajs', 'mqtt', 'nats', 'ioredis', 'amqplib', 'amqp-connection-manager', '@fastify/*'], platform: 'browser', target: 'es2022',
  outfile: process.argv[2] || path.join(here, 'out/backend.js'),
  mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'default'],
  plugins: [srcAlias],
  inject: [s('globals.js')],
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  loader: { '.wasm': 'file', '.data': 'file' },
  logLevel: 'warning', logLimit: 30,
  keepNames: true, minify: true, sourcemap: false, metafile: true,
}).then((r) => console.log('ok', Object.values(r.metafile.outputs).map((o) => o.bytes)));
