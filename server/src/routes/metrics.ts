/**
 * GET /metrics (ruling 30): Prometheus text format, ADMIN LISTENER ONLY (never registered on the public
 * listener; the admin listener binds 127.0.0.1 by default). It needs no key so a local scraper can read it,
 * but HSN_ADMIN_IP_ALLOWLIST, when set, applies. Only counts and timestamps: no keys, names or codes.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Metrics, GaugeSample } from '../lib/metrics.js';
import { AppError } from '../lib/problem.js';
import { ipAllowed } from '../lib/ip.js';
import { istDate } from '../lib/dates.js';
import { rfc3339 } from '../lib/clock.js';

export function registerMetricsRoute(app: FastifyInstance, ctx: AppContext, metrics: Metrics): void {
  app.get('/metrics', { config: { scope: 'public' } }, async (request, reply) => {
    if (ctx.config.adminIpAllowlist.length > 0 && !ipAllowed(request.ip, ctx.config.adminIpAllowlist)) {
      throw new AppError('forbidden_ip', 'Metrics may only be scraped from allow-listed addresses.');
    }
    const read = ctx.storage.read;
    const now = ctx.clock.now();
    const gauges: GaugeSample[] = [];
    const lastOk = read.watcherRuns.lastSuccess('cbic');
    gauges.push({
      name: 'hsn_watcher_last_success_timestamp_seconds',
      help: 'Unix time the CBIC watcher last finished a successful run (0 = never).',
      value: lastOk ? Math.floor(Date.parse(lastOk.finished_at) / 1000) : 0,
    });
    const ds = read.dataset.current();
    if (ds) {
      const st = read.rules.stats(istDate(now), rfc3339(new Date(now.getTime() - 90 * 86_400_000)));
      gauges.push({ name: 'hsn_rate_rules_unverified', help: 'Active rate rules (in force today, IST) that are not verified.', value: st.activeUnverified });
      gauges.push({ name: 'hsn_rate_rules_active', help: 'Active rate rules in force today (IST).', value: st.active });
      gauges.push({ name: 'hsn_dataset_info', help: 'Current dataset version (value is always 1).', value: 1, labels: { version: ds.current_version } });
    }
    gauges.push({ name: 'hsn_product_cache_rows', help: 'Rows in the barcode product cache.', value: ctx.storage.read.products.count() });
    gauges.push({ name: 'hsn_product_cache_max_rows', help: 'HSN_PRODUCT_CACHE_MAX_ROWS.', value: ctx.config.productCacheMaxRows });
    reply.header('Cache-Control', 'no-store');
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.render(gauges);
  });
}
