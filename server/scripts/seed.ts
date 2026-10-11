/**
 * Load data/seed/*.json into an EMPTY database (format: data/seed/FORMAT.md). Every seeded rule is
 * `unverified` (SA-C-17); reviewers verify them through maker–checker `verify` proposals.
 * Usage: NODE_ENV=development HSN_DB_PATH=./hsn.db npm run seed [-- --dir data/seed] [--db path]
 * Refused when NODE_ENV=production: production rate changes go through maker–checker proposals (SEC-55).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSeed, SeedError } from '../src/db/seed.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, db: { type: 'string' } }, allowPositionals: false });
  const env = { ...process.env };
  if (values.db) env['HSN_DB_PATH'] = values.db;
  if (env['NODE_ENV'] === 'production') {
    console.error('Refusing to seed with NODE_ENV=production. Use rate proposals (maker–checker) instead.');
    return 1;
  }
  const boot = cliBoot(env);
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const summary = loadSeed(storage.tx, {
      dir: resolve(values.dir ?? 'data/seed'),
      allowedRatesBp: config.allowedRatesBp,
      sourceHosts: config.sourceHosts,
      now: new Date(),
      auditKey: config.auditKey.reveal(),
      signingKey: config.datasetSigningKey,
      allowVerified: false,
      warn: (m) => console.warn(`warn: ${m}`),
    });
    console.log(JSON.stringify({ seeded: summary }, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof SeedError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
