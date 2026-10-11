/** Composition root for the CBIC watcher (used by main.ts and scripts/watch-cbic.ts). */
import type { AppConfig } from './config.js';
import type { Clock } from './lib/clock.js';
import type { Storage } from './repositories/sqlite/index.js';
import { CbicWatcherAdapter } from './adapters/cbicWatcher.js';
import type { WatcherDeps, WatcherLogger } from './services/watcher.js';

export function watcherDeps(config: AppConfig, storage: Storage, clock: Clock, log: WatcherLogger): WatcherDeps {
  const source = new CbicWatcherAdapter({
    pages: config.watcher.pages,
    allowlist: config.watcher.hosts,
    linkHosts: config.sourceHosts,
    userAgent: config.watcher.userAgent,
    now: () => clock.now().getTime(),
    // SA-C2-01: parse the untrusted listing off the main thread, 2 s hard limit, fail closed
    isolateParse: { timeoutMs: 2000 },
  });
  return { tx: storage.tx, read: storage.write, clock, auditKey: config.auditKey.reveal(), source, log, notBefore: config.watcher.notBefore };
}
