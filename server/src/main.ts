/**
 * Boot: loadConfig (fail closed) → open DB (rw + read-only) → migrate → buildApp ×2 (public listener and a
 * separate admin listener, ruling 25; they share limiter state) → listen.
 */
import { loadConfig, ConfigError } from './config.js';
import { openDb, openReadDb, openCacheDb, migrate } from './db/migrate.js';
import { createStorage } from './repositories/sqlite/index.js';
import { buildApp, createSharedState } from './app.js';
import { systemClock } from './lib/clock.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Classifier, CreateClassifier } from './classify/types.js';
import { classifierDeps } from './classifierDeps.js';
import { watcherDeps } from './watcherDeps.js';
import { startWatcherInterval } from './services/watcher.js';

async function loadCreateClassifier(): Promise<CreateClassifier | undefined> {
  // Resolved at runtime so the core builds and runs without the classifier module.
  const path = './classify/index.js';
  try {
    const mod = (await import(path)) as { createClassifier?: CreateClassifier };
    if (typeof mod.createClassifier === 'function') return mod.createClassifier;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  return undefined;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const writeDb = openDb(config.dbPath);
  migrate(writeDb);
  const readDb = openReadDb(config.dbPath);
  const storage = createStorage(writeDb, readDb, { productCacheMaxRows: config.productCacheMaxRows, cacheDb: config.dbPath === ':memory:' ? undefined : openCacheDb(config.dbPath) });
  const clock = systemClock;
  const create = await loadCreateClassifier();
  const shared = createSharedState(config, clock);
  const classifierFactory = create ? (log: FastifyBaseLogger): Classifier => create(classifierDeps(storage, config, log)) : undefined;
  const app = await buildApp({ config, storage, clock, shared, surface: 'public', ...(classifierFactory ? { classifierFactory } : {}) });
  const adminApp = await buildApp({ config, storage, clock, shared, surface: 'admin' });
  if (!create) app.log.warn({ event: 'classifier.unavailable' }, 'no classifier module found; POST /v1/classify will return 503');
  const head = storage.read.audit.head();
  app.log.info({ event: 'audit.chain_head', audit_id: head?.id ?? 0, audit_hash: head?.hash ?? null }, 'audit chain head at boot');

  // CBIC notification watcher (default off; production normally runs scripts/watch-cbic.ts from cron)
  const watcher = config.watcher.enabled
    ? startWatcherInterval(watcherDeps(config, storage, clock, app.log.child({ component: 'cbic-watcher' })), config.watcher.intervalMin * 60_000)
    : null;
  if (watcher) app.log.info({ event: 'watcher.enabled', interval_min: config.watcher.intervalMin, pages: config.watcher.pages.map((p) => p.url) }, 'CBIC watcher interval enabled');

  // SA-C2-06: keep the restore-detection high-water mark moving forward (also written after each audited admin write)
  const hwmTimer = setInterval(() => shared.restoreGuard?.record(), 60_000);
  hwmTimer.unref();

  const shutdown = async (sig: string) => {
    app.log.info({ event: 'shutdown', signal: sig }, 'shutting down');
    clearInterval(hwmTimer);
    shared.restoreGuard?.record();
    watcher?.stop();
    await Promise.all([app.close(), adminApp.close()]);
    storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ port: config.port, host: config.host });
  await adminApp.listen({ port: config.adminPort, host: config.adminHost });
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${(e as Error).name}: ${(e as Error).message}\n`);
  process.exit(1);
});
