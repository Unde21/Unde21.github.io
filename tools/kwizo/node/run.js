// Runs the real Kwizo backend (compiled with tsc) in Node on PGlite.
// usage: node run.js DIST_DIR DATA_DIR PORT
const Module = require('module');
const path = require('path');
const fs = require('fs');
const [dist, dataDir, port = '8080'] = process.argv.slice(2);
const SHIMS = path.join(__dirname, '../shims');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '@prisma/adapter-pg') return path.join(SHIMS, 'adapter-pg.js');
  if (req === 'bcrypt' && process.env.KWIZO_BCRYPTJS) return require.resolve('bcryptjs');
  if (req.startsWith('src/')) return orig.call(this, path.join(dist, req), ...rest); // tsconfig paths
  return orig.call(this, req, ...rest);
};
Object.assign(process.env, require('../env.js'), { PORT: port });
(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  const db = new PGlite(dataDir);
  await db.waitReady;
  if (fresh) {
    const migDir = path.join(dist, 'prisma/migrations');
    for (const m of fs.readdirSync(migDir).filter((d) => /^\d/.test(d)).sort()) {
      await db.exec(fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8'));
      console.log('[kwizo] migration', m);
    }
  }
  globalThis.__kwizoPGlite = db;
  process.chdir(path.join(dataDir, '..'));
  require(path.join(dist, 'src/main.js'));
})().catch((e) => { console.error(e); process.exit(1); });
