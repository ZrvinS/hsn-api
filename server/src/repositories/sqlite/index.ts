import type { DatabaseSync } from 'node:sqlite';
import type { Repos, TxRunner } from '../types.js';
import { Stmts } from './base.js';
import { SqliteHsnRepo } from './hsn.js';
import { SqliteRateRuleRepo } from './rateRules.js';
import { SqliteDatasetRepo } from './dataset.js';
import { SqliteApiKeyRepo } from './apiKeys.js';
import { SqliteAuditRepo } from './audit.js';
import { SqliteProposalRepo } from './proposals.js';
import { SqliteProductRepo } from './products.js';
import { SqliteSynonymRepo } from './synonyms.js';
import { SqliteAdminActorRepo } from './actors.js';
import { SqliteIdempotencyRepo } from './idempotency.js';
import { SqliteWatchedRepo, SqliteWatcherRunRepo } from './watched.js';
import { SqliteIntegrityRepo } from './integrity.js';

export interface StorageOptions {
  /** HSN_PRODUCT_CACHE_MAX_ROWS (ruling 30); default 50,000 */
  productCacheMaxRows?: number;
  /** SEC-91: the cache-writer connection (openCacheDb); defaults to the write connection (in-memory, scripts) */
  cacheDb?: DatabaseSync | undefined;
}

export function createSqliteRepos(db: DatabaseSync, opts: StorageOptions = {}): Repos {
  const q = new Stmts(db);
  return {
    hsn: new SqliteHsnRepo(q),
    rules: new SqliteRateRuleRepo(q),
    dataset: new SqliteDatasetRepo(q),
    keys: new SqliteApiKeyRepo(q),
    audit: new SqliteAuditRepo(q),
    proposals: new SqliteProposalRepo(q),
    products: new SqliteProductRepo(q, opts.productCacheMaxRows),
    synonyms: new SqliteSynonymRepo(q),
    actors: new SqliteAdminActorRepo(q),
    idempotency: new SqliteIdempotencyRepo(q),
    watched: new SqliteWatchedRepo(q),
    watcherRuns: new SqliteWatcherRunRepo(q),
    integrity: new SqliteIntegrityRepo(q),
  };
}

/** BEGIN IMMEDIATE transaction runner over the write connection. */
export function createTxRunner(db: DatabaseSync, repos: Repos): TxRunner {
  return <T>(fn: (r: Repos) => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(repos);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  };
}

export interface Storage {
  /** read connection repos (read-only connection when backed by a file) */
  read: Repos;
  /** admin-writer connection repos (proposals, seed, scripts) */
  write: Repos;
  /** SEC-91: cache-writer repos for request-path writes (products, api_keys.last_used_at, idempotency_keys only) */
  cache: Repos;
  cacheDb: DatabaseSync;
  tx: TxRunner;
  writeDb: DatabaseSync;
  readDb: DatabaseSync;
  close(): void;
}

export function createStorage(writeDb: DatabaseSync, readDb: DatabaseSync = writeDb, opts: StorageOptions = {}): Storage {
  const write = createSqliteRepos(writeDb, opts);
  const read = readDb === writeDb ? write : createSqliteRepos(readDb, opts);
  const cacheDb = opts.cacheDb ?? writeDb;
  const cache = cacheDb === writeDb ? write : createSqliteRepos(cacheDb, opts);
  return {
    read,
    write,
    cache,
    cacheDb,
    tx: createTxRunner(writeDb, write),
    writeDb,
    readDb,
    close() {
      if (readDb !== writeDb) readDb.close();
      if (cacheDb !== writeDb) cacheDb.close();
      writeDb.close();
    },
  };
}
