// Starts the real Kwizo backend (NestJS + Prisma + Socket.io) inside the page.
import { PGlite } from '@electric-sql/pglite';
import env from './env.js';
const fs = require('fs'); // the in-memory file system of shims/fs.js (uploads)

Object.assign(process.env, env, { PORT: '80' });

// Uploaded files (avatars, quiz images) are kept in IndexedDB next to the database.
function idb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function walk(dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const p = dir + '/' + n;
    if (fs.statSync(p).isDirectory()) walk(p, out); else out[p] = fs.readFileSync(p);
  }
  return out;
}
async function persistFiles(name) {
  const db = await idb(name);
  const all = await new Promise((resolve) => {
    const q = db.transaction('files').objectStore('files').get('upload');
    q.onsuccess = () => resolve(q.result || {}); q.onerror = () => resolve({});
  });
  for (const [p, data] of Object.entries(all)) {
    fs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(p, Buffer.from(data));
  }
  let sig = Object.keys(all).sort().join('|');
  const save = () => {
    const files = walk('/upload');
    const s = Object.keys(files).sort().join('|');
    if (s === sig) return;
    sig = s;
    const plain = {};
    for (const [p, b] of Object.entries(files)) plain[p] = new Uint8Array(b);
    db.transaction('files', 'readwrite').objectStore('files').put(plain, 'upload');
  };
  setInterval(save, 3000);
  addEventListener('pagehide', save);
}

export async function startBackend({ dataDir, loadDataDir, filesDb } = {}) {
  const db = new PGlite({ dataDir: dataDir || 'memory://', relaxedDurability: true, ...(loadDataDir ? { loadDataDir } : {}) });
  await db.waitReady;
  globalThis.__kwizoPGlite = db;
  if (filesDb) await persistFiles(filesDb).catch((e) => console.warn('[kwizo] uploads are not persisted', e));
  const listening = new Promise((resolve) => {
    const t = setInterval(() => { if (globalThis.__kwizoHttp && globalThis.__kwizoHttp.servers.size) { clearInterval(t); resolve(); } }, 20);
  });
  require('./be/src/main.js');
  await listening;
  return { db, request: globalThis.__kwizoHttp.request };
}
