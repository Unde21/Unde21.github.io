// @prisma/client for the demo: Prisma's edge client, with longer default
// transaction limits. PGlite has a single connection, so transactions that a
// Postgres pool would run side by side wait for each other here.
const edge = require('PRISMA_EDGE_CLIENT');
class PrismaClient extends edge.PrismaClient {
  constructor(options = {}) {
    super({ ...options, transactionOptions: { maxWait: 60000, timeout: 60000, ...(options.transactionOptions || {}) } });
  }
}
module.exports = { ...edge, PrismaClient, default: { ...edge, PrismaClient } };
