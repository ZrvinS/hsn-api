import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/problem.js';
import { CACHE_POLL, digitsQ, intParam, S, withEtag } from './common.js';
import { rfc3339 } from '../lib/clock.js';
import { todayIst } from '../lib/dates.js';

export function registerRatesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { since: string; limit?: string } }>(
    '/v1/rates/changes',
    {
      config: { scope: 'read' },
      schema: {
        querystring: { type: 'object', additionalProperties: false, required: ['since'], properties: { since: digitsQ(15), limit: digitsQ(4) } },
        response: {
          200: {
            type: 'object',
            properties: {
              since: S.int,
              next_since: S.int,
              has_more: S.bool,
              current_dataset_version: S.str,
              feed_epoch: S.str,
              changes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    seq: S.int,
                    change_type: S.str,
                    dataset_version: S.str,
                    published_at: S.str,
                    hsn_prefix: S.str,
                    affected_prefix: S.str,
                    rule_id: S.strN,
                    related_rule_id: S.strN,
                    effective_from: S.strN,
                    effective_to: S.strN,
                    retroactive: S.bool,
                    summary: S.str,
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const since = intParam(request.query.since, 0, 0, Number.MAX_SAFE_INTEGER, '/since');
      const limit = intParam(request.query.limit, 500, 1, 500, '/limit');
      const maxSeq = ctx.storage.read.dataset.maxSeq();
      if (since > maxSeq) {
        throw new AppError('feed_cursor_expired', `since=${since} is ahead of the feed (latest seq ${maxSeq}); the dataset may have been restored. Resync with since=0.`);
      }
      if (ctx.config.feedRetentionDays !== null && since > 0) {
        const cutoff = rfc3339(new Date(ctx.clock.now().getTime() - ctx.config.feedRetentionDays * 86_400_000));
        const first = ctx.storage.read.dataset.changes(since, 1)[0];
        if (first && first.published_at < cutoff) {
          throw new AppError('feed_cursor_expired', `since=${since} is older than the retained feed window (${ctx.config.feedRetentionDays} days). Resync with since=0.`);
        }
      }
      return withEtag(request, reply, ds.current_version, todayIst(ctx.clock), CACHE_POLL, () => {
        const rows = ctx.storage.read.dataset.changes(since, limit + 1);
        const page = rows.slice(0, limit);
        return {
          since,
          next_since: page.length > 0 ? page[page.length - 1]!.seq : since,
          has_more: rows.length > limit,
          current_dataset_version: ds.current_version,
          feed_epoch: ds.feed_epoch,
          changes: page,
        };
      });
    },
  );
}
