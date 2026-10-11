import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/problem.js';
import { normaliseQueryText } from '../lib/fts.js';
import { asOfDate, cacheLookup, dateQ, HSN_CODE_PATTERN, intParam, moneyQ, rateResolutionSchema, S, unitPricePaise, withEtag } from './common.js';
import { RATE_DISCLAIMER } from '../services/disclaimer.js';
import type { HsnType } from '../repositories/types.js';
import { todayIst } from '../lib/dates.js';
import { nearestKnownAncestor } from '../services/tax.js';

const summarySchema = { type: 'object', properties: { code: S.str, level: S.int, description: S.str } } as const;

export function registerHsnRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Registered before /:code; codes are digits only so there is no collision.
  app.get<{ Querystring: { q: string; limit?: string; type?: HsnType; level?: string } }>(
    '/v1/hsn/search',
    {
      config: { scope: 'read', quota: true },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 100 },
            limit: { type: 'string', pattern: '^[0-9]{1,2}$' },
            type: { type: 'string', enum: ['goods', 'service'] },
            level: { type: 'string', enum: ['2', '4', '5', '6', '8'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              query: S.str,
              results: {
                type: 'array',
                items: { type: 'object', properties: { code: S.str, level: S.int, type: S.str, chapter: S.str, description: S.str, score: S.num, highlight: S.str } },
              },
              dataset_version: S.str,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const q = normaliseQueryText(request.query.q).slice(0, 100);
      const limit = intParam(request.query.limit, 10, 1, 50, '/limit');
      const level = request.query.level === undefined ? undefined : Number(request.query.level);
      const type = request.query.type;
      return withEtag(request, reply, ds.current_version, todayIst(ctx.clock), cacheLookup(ctx.clock), () => {
        const { hits } = ctx.storage.read.hsn.search(q, { limit, type, levels: level === undefined ? undefined : [level] });
        const best = hits.reduce((m, h) => Math.min(m, h.bm25), 0);
        return {
          query: q,
          results: hits.map((h) => ({
            code: h.code,
            level: h.level,
            type: h.type,
            chapter: h.chapter,
            description: h.description,
            score: best < 0 && h.bm25 < 0 ? Math.round((h.bm25 / best) * 100) / 100 : 1,
            highlight: h.highlight,
          })),
          dataset_version: ds.current_version,
        };
      });
    },
  );

  app.get<{ Params: { code: string }; Querystring: { date?: string; unit_price?: string } }>(
    '/v1/hsn/:code',
    {
      config: { scope: 'read' },
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', pattern: HSN_CODE_PATTERN } } },
        querystring: { type: 'object', additionalProperties: false, properties: { date: dateQ, unit_price: moneyQ } },
        response: {
          200: {
            type: 'object',
            properties: {
              code: S.str,
              level: S.int,
              type: S.str,
              chapter: S.str,
              description: S.str,
              // validator R3: false when the code is not in the master and was resolved via its nearest known parent
              code_in_master: S.bool,
              resolved_via: S.strN,
              ancestors: { type: 'array', items: summarySchema },
              rate: rateResolutionSchema,
              dataset_version: S.str,
              disclaimer: S.str,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const code = request.params.code;
      const date = asOfDate(request.query.date, ctx.clock);
      const price = unitPricePaise(request.query.unit_price, '/unit_price');
      return withEtag(request, reply, ds.current_version, date, cacheLookup(ctx.clock), () => {
        const row = ctx.storage.read.hsn.get(code);
        // R3: a well-formed code missing from the master resolves under its nearest known parent (never 404
        // while its chapter exists); the response says so (code_in_master false, warning code_not_in_master)
        const via = row ? null : nearestKnownAncestor(ctx.storage.read.hsn, code);
        if (!row && !via) {
          throw new AppError('hsn_not_found', `No HSN/SAC "${code}" in dataset ${ds.current_version}, and chapter ${code.slice(0, 2)} does not exist. Try GET /v1/hsn/search?q=….`);
        }
        const base = (row ?? via)!;
        const { dto } = ctx.rates.resolve(code, date, price);
        if (via) dto.warnings.push('code_not_in_master');
        const ancestors = row ? ctx.storage.read.hsn.ancestors(code) : [...ctx.storage.read.hsn.ancestors(via!.code), via!];
        return {
          code,
          level: row ? row.level : code.length,
          type: base.type,
          chapter: base.chapter,
          description: row ? row.description : `${code} is not in the HSN master; shown under ${via!.code}: ${via!.description}`,
          code_in_master: row !== null,
          resolved_via: via ? via.code : null,
          ancestors: ancestors.map((a) => ({ code: a.code, level: a.level, description: a.description })),
          rate: dto,
          dataset_version: ds.current_version,
          disclaimer: dto.disclaimer || RATE_DISCLAIMER,
        };
      });
    },
  );
}
