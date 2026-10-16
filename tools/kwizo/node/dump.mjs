// dump.mjs DATA_DIR OUT.tar.gz: the seeded PGlite database as one archive.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const [dir, out] = process.argv.slice(2);
const db = new PGlite(dir);
await db.waitReady;
const n = await db.query('select (select count(*) from "user") users, (select count(*) from "quiz") quizzes, (select count(*) from "question") questions, (select count(*) from "group") groups');
console.log(n.rows[0]);
await db.exec('VACUUM FULL'); await db.exec('CHECKPOINT');
const blob = await db.dumpDataDir('gzip');
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
console.log('dump', fs.statSync(out).size);
await db.close();
