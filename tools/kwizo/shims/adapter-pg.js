// @prisma/adapter-pg replacement: the backend asks for PostgreSQL over TCP,
// this hands Prisma the PGlite database (PostgreSQL compiled to WebAssembly).
const { PrismaPGlite } = require('pglite-prisma-adapter');
class PrismaPg {
  constructor() {
    if (!globalThis.__kwizoPGlite) throw new Error('PGlite not started');
    return new PrismaPGlite(globalThis.__kwizoPGlite);
  }
}
module.exports = { PrismaPg };
