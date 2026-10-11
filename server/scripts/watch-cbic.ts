/**
 * One CBIC notification watcher run (for cron). Fetches the Central Tax (Rate) and Integrated Tax (Rate)
 * listing pages, queues unseen notifications as watched_notifications (state `detected`), records the
 * run, and checks the freshness alert (00b ruling 27). Never changes a rate.
 *
 *   npx tsx scripts/watch-cbic.ts            # or: npm run watch-cbic (scripts run through tsx, like the other operator scripts)
 *
 * Exit codes: 0 run ok and no freshness alert; 2 run failed (page unreachable or its layout changed);
 * 3 run ok but the freshness alert fires (e.g. a notification unreviewed past 2 business days);
 * 1 configuration error. Log lines are JSON on stdout/stderr; alert lines carry "alert": true.
 */
import { systemClock } from '../src/lib/clock.js';
import { runCbicWatch, checkFreshness, type WatcherLogger } from '../src/services/watcher.js';
import { watcherDeps } from '../src/watcherDeps.js';
import { cliBoot } from './_common.js';

const line = (level: string, obj: Record<string, unknown>, msg: string): string => `${JSON.stringify({ level, time: new Date().toISOString(), ...obj, msg })}\n`;
const log: WatcherLogger = {
  info: (o, m) => void process.stdout.write(line('info', o, m)),
  warn: (o, m) => void process.stderr.write(line('warn', o, m)),
  error: (o, m) => void process.stderr.write(line('error', o, m)),
};

async function main(): Promise<number> {
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    if (config.watcher.pages.length === 0) {
      log.error({ event: 'watcher.failed', alert: true }, 'no watcher pages configured (HSN_WATCHER_CT_RATE_URL / HSN_WATCHER_IT_RATE_URL)');
      return 1;
    }
    const res = await runCbicWatch(watcherDeps(config, storage, systemClock, log));
    const fresh = checkFreshness(storage.write, systemClock, log);
    process.stdout.write(`${JSON.stringify({ run_id: res.run_id, status: res.status, items_seen: res.items_seen, items_new: res.items_new, new: res.new_keys, freshness_alert: fresh.alert, reasons: fresh.reasons })}\n`);
    if (res.status === 'failed') return 2;
    return fresh.alert ? 3 : 0;
  } finally {
    storage.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`fatal: ${(e as Error).name}: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
