/** Shared CLI boot: config (fail closed) + migrated write connection. */
import { loadConfig, ConfigError, type AppConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/migrate.js';
import { createStorage, type Storage } from '../src/repositories/sqlite/index.js';

export function cliBoot(env: Record<string, string | undefined> = process.env): { config: AppConfig; storage: Storage } | null {
  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return null;
    }
    throw e;
  }
  const db = openDb(config.dbPath);
  migrate(db);
  return { config, storage: createStorage(db, db, { productCacheMaxRows: config.productCacheMaxRows }) };
}
