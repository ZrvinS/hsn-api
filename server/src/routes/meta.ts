import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { CACHE_POLL, S, sourceSchema, withEtag } from './common.js';
import { todayIst } from '../lib/dates.js';
import { rfc3339 } from '../lib/clock.js';
import { RATE_DISCLAIMER } from '../services/disclaimer.js';
import { loadKnownGaps } from '../services/knownGaps.js';

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  // validator r3: curated known data gaps (fail closed on a malformed file; read once)
  const knownGaps = loadKnownGaps(ctx.config.knownGapsFile);
  // SA-C5-02: codes_without_rules changes only with the dataset version and the date; computed once per pair
  let coverageCache: { key: string; value: number } | null = null;
  const codesWithoutRules = (version: string, today: string): number => {
    const key = `${version}|${today}`;
    if (coverageCache?.key !== key) coverageCache = { key, value: ctx.storage.read.rules.codesWithoutRules(today) };
    return coverageCache.value;
  };
  app.get(
    '/v1/meta/dataset',
    {
      config: { scope: 'read' },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              dataset_version: S.str,
              published_at: S.str,
              content_sha256: S.str,
              sha256: S.str,
              signature: S.strN,
              signature_alg: S.strN,
              feed_epoch: S.str,
              last_change_seq: S.int,
              oldest_last_verified_at: S.strN,
              freshness_sla_business_days: S.int,
              /** finished_at of the last successful CBIC watcher run (null: never) */
              sources_checked_at: S.strN,
              /** detected notifications whose affected prefixes an admin has not set yet */
              untriaged_notifications: S.int,
              pending_notifications: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: S.str,
                    notification: S.str,
                    url: S.str,
                    affected_prefixes: { type: 'array', items: S.str },
                    effective_from: S.strN,
                    detected_at: S.str,
                    expedite: S.bool,
                  },
                },
              },
              coverage: {
                type: 'object',
                properties: {
                  hsn_codes: S.int,
                  sac_codes: S.int,
                  rate_rules_active: S.int,
                  rate_rules_verified: S.int,
                  rate_rules_unverified: S.int,
                  rate_rules_verification_overdue: S.int,
                  hsn_chapters_with_rules: S.int,
                  rules_verified_last_90_days_percent: S.num,
                  /** master codes (4+ digits) with no rule in force at, above or below them today */
                  codes_without_rules: S.int,
                },
              },
              /** curated gaps: a code listed here is "not yet curated", not "no rate exists" */
              known_data_gaps: {
                type: 'array',
                items: { type: 'object', properties: { prefix: S.strN, kind: S.str, reason: S.str } },
              },
              /** in-force citations; rule_count / verified_count show how much of each has been checked */
              sources: { type: 'array', items: { type: 'object', properties: { ...sourceSchema.properties, rule_count: S.int, verified_count: S.int } } },
              classifier: {
                type: 'object',
                properties: {
                  llm_configured: S.bool,
                  llm_provider: S.strN,
                  external_lookups: { type: 'array', items: S.str },
                },
              },
              disclaimer: S.str,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const today = todayIst(ctx.clock);
      return withEtag(request, reply, ds.current_version, today, CACHE_POLL, () => {
        const now = ctx.clock.now();
        const overdueCutoff = new Date(now.getTime());
        overdueCutoff.setUTCMonth(overdueCutoff.getUTCMonth() - 12);
        const since = rfc3339(new Date(now.getTime() - 90 * 86_400_000));
        const st = ctx.storage.read.rules.stats(today, since);
        const counts = ctx.storage.read.hsn.counts();
        const pending = ctx.storage.read.watched.pending();
        const lookups: string[] = [];
        if (ctx.config.offEnabled) lookups.push('open_food_facts');
        if (ctx.config.obfEnabled) lookups.push('open_beauty_facts');
        return {
          dataset_version: ds.current_version,
          published_at: ds.published_at,
          content_sha256: ds.content_hash,
          sha256: ds.content_hash,
          signature: ds.signature,
          signature_alg: ds.signature === null ? null : 'ed25519',
          feed_epoch: ds.feed_epoch,
          last_change_seq: ds.last_change_seq,
          oldest_last_verified_at: st.oldestLastVerifiedAt,
          freshness_sla_business_days: 2,
          sources_checked_at: ctx.storage.read.watcherRuns.lastSuccess('cbic')?.finished_at ?? null,
          untriaged_notifications: pending.filter((w) => w.affected_prefixes.length === 0).length,
          pending_notifications: pending.filter((w) => w.affected_prefixes.length > 0).map((w) => ({
            id: w.id,
            notification: w.notification_ref,
            url: w.source_url,
            affected_prefixes: w.affected_prefixes,
            effective_from: w.effective_from,
            detected_at: w.detected_at,
            expedite: w.expedite,
          })),
          coverage: {
            hsn_codes: counts.goods,
            sac_codes: counts.services,
            rate_rules_active: st.active,
            rate_rules_verified: st.activeVerified,
            rate_rules_unverified: st.activeUnverified,
            rate_rules_verification_overdue: ctx.storage.read.rules.overdueCount(today, rfc3339(overdueCutoff)),
            hsn_chapters_with_rules: st.chaptersWithRules,
            rules_verified_last_90_days_percent: st.verifiedRecentlyPercent,
            codes_without_rules: codesWithoutRules(ds.current_version, today),
          },
          known_data_gaps: knownGaps,
          sources: st.sources,
          classifier: { llm_configured: ctx.config.llm.enabled, llm_provider: ctx.config.llm.enabled ? ctx.config.llm.provider : null, external_lookups: lookups },
          disclaimer: RATE_DISCLAIMER,
        };
      });
    },
  );
}
