/**
 * POST /v1/classify. The classifier (src/classify, another module) returns candidates only;
 * this route attaches the rate resolution for each candidate from the versioned rate table,
 * so classification can never produce or alter a rate (architecture invariant 1, SEC-56).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/problem.js';
import { ClassifyInputError, type ClassifyCandidate } from '../classify/types.js';
import { nameHmac } from '../classify/fingerprint.js';
import { CLASSIFY_DISCLAIMER } from '../services/disclaimer.js';
import { asOfDate, CACHE_NONE, dateQ, moneyB, rateResolutionSchema, S, unitPricePaise } from './common.js';
import { paiseToRupees } from '../lib/money.js';

interface ClassifyBody {
  name?: string;
  barcode?: string;
  unit_price?: number | string;
  date?: string;
  max_candidates?: number;
  allow_llm?: boolean;
}

/** HSN/SAC code shapes (ruling 00c-6): 2, 4, 5 (SAC groups 99xxx), 6 or 8 digits. */
const CODE_RE = /^([0-9]{2}|[0-9]{4}|99[0-9]{3}|[0-9]{6}|[0-9]{8})$/;
const BANDS = ['high', 'medium', 'low'] as const;
const REASON_CODES = [
  'synonym_exact', 'synonym_partial', 'synonym_related', 'fts_match', 'chapter_keyword', 'barcode_resolved',
  'barcode_category', 'barcode_conflict', 'close_runner_up', 'llm_rerank', 'review_hint', 'no_signal',
] as const;
const RULE_HINTS = new Set(['nil_rate_list']);

const candidateSchema = {
  type: 'object',
  required: ['hsn', 'description', 'confidence', 'confidence_band', 'needs_review', 'signals', 'reasons', 'rate'],
  properties: {
    hsn: S.str,
    description: S.str,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    confidence_band: { type: 'string', enum: BANDS },
    needs_review: S.bool,
    signals: {
      type: 'object',
      required: ['synonym', 'fts', 'chapter_keyword', 'barcode_category', 'margin_penalty'],
      properties: { synonym: S.num, fts: S.num, chapter_keyword: S.num, barcode_category: S.numN, margin_penalty: S.num },
    },
    reasons: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', required: ['code', 'detail', 'weight'], properties: { code: { type: 'string', enum: REASON_CODES }, detail: S.str, weight: S.num } },
    },
    rule_hint: { type: ['object', 'null'], properties: { condition: S.str, synonym: S.str } },
    rate: rateResolutionSchema,
  },
} as const;

/**
 * SA-K-12 / AI-03 / AI-04: the serializer does not enforce minItems/enums, so every candidate
 * is checked here and a malformed one is a server error, never a silent answer.
 */
export function assertCandidate(c: ClassifyCandidate): void {
  const bad = (why: string): never => {
    throw new Error(`classifier returned an invalid candidate (${why})`);
  };
  if (!CODE_RE.test(c.hsn)) bad('code');
  if (!(c.confidence >= 0 && c.confidence <= 1)) bad('confidence');
  if (!(BANDS as readonly string[]).includes(c.confidence_band)) bad('band');
  const expected = c.confidence >= 0.85 ? 'high' : c.confidence >= 0.6 ? 'medium' : 'low';
  if (c.confidence_band !== expected) bad('band/confidence mismatch');
  if (c.needs_review !== (c.confidence_band !== 'high')) bad('needs_review');
  if (!Array.isArray(c.reasons) || c.reasons.length === 0) bad('empty reasons');
  for (const r of c.reasons) if (!(REASON_CODES as readonly string[]).includes(r.code) || typeof r.detail !== 'string' || typeof r.weight !== 'number') bad('reason');
  if (c.rule_hint && !RULE_HINTS.has(c.rule_hint.condition)) bad('rule_hint');
}

export function registerClassifyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: ClassifyBody }>(
    '/v1/classify',
    {
      config: { scope: 'classify', cost: 5, quota: true },
      bodyLimit: 16 * 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          anyOf: [{ required: ['name'] }, { required: ['barcode'] }],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 200 },
            barcode: { type: 'string', pattern: '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$' },
            unit_price: moneyB,
            date: dateQ,
            max_candidates: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
            allow_llm: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              input: { type: 'object', properties: { name: S.strN, barcode: S.strN, unit_price: S.numN } },
              normalized_name: S.strN,
              product: {
                type: ['object', 'null'],
                properties: {
                  gtin: S.str,
                  gtin_valid: S.bool,
                  name: S.strN,
                  brand: S.strN,
                  category: S.strN,
                  source: { type: 'string', enum: ['local_cache', 'open_food_facts', 'open_beauty_facts', 'not_found', 'lookup_failed'] },
                  fetched_at: S.strN,
                  hints: { type: 'array', items: S.str },
                },
              },
              needs_review: S.bool,
              message: S.strN,
              candidates: { type: 'array', items: candidateSchema },
              classifier: { type: 'object', properties: { version: S.str, llm_rerank: S.bool } },
              scoring: {
                type: 'object',
                properties: {
                  applicable: { type: 'object', properties: { synonym: S.bool, fts: S.bool, chapter_keyword: S.bool, barcode_category: S.bool } },
                  denominator: S.num,
                },
              },
              llm_used: S.bool,
              dataset_version: S.str,
              disclaimer: S.str,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const b = request.body;
      const date = asOfDate(b.date, ctx.clock);
      const price = unitPricePaise(b.unit_price, '/unit_price');
      const allowLlm = (b.allow_llm ?? false) && !(request.auth?.llmOptOut ?? true) && ctx.config.llm.enabled;
      const started = Date.now();
      let result;
      try {
        result = await ctx.classifier.classify(
          { name: b.name ?? null, barcode: b.barcode ?? null, date, maxCandidates: Math.min(5, b.max_candidates ?? 5), allowLlm, keyId: request.auth?.keyId ?? null, tenantId: request.auth?.tenant ?? null },
          { requestId: request.id, log: request.log },
        );
      } catch (e) {
        if (e instanceof ClassifyInputError) throw new AppError(e.problem, e.detail, e.errors);
        throw e;
      }
      const candidates = result.candidates.slice(0, Math.min(5, b.max_candidates ?? 5)).map((c) => {
        assertCandidate(c);
        // ruling 00c-5: a curated exact synonym with a rule hint (e.g. a nil-rated drug) lets the
        // rate service pick the matching rule of an otherwise ambiguous resolution
        const opts = c.rule_hint ? { conditionCode: c.rule_hint.condition } : undefined;
        return { ...c, rule_hint: c.rule_hint ?? null, rate: ctx.rates.resolve(c.hsn, date, price, opts).dto };
      });
      const top = candidates[0];
      // AI-50 / SA-K-11: one classify.decision line; the name only as a keyed HMAC (SA-K-08)
      const d = result.diagnostics;
      request.log.info(
        {
          event: 'classify.decision',
          request_id: request.id,
          key_id: request.auth?.keyId ?? null,
          dataset_version: ds.current_version,
          classifier_version: result.classifier.version,
          name_length: b.name?.length ?? 0,
          name_hmac: result.normalized_name ? nameHmac(ctx.config.logKey.reveal(), result.normalized_name) : null,
          barcode_present: b.barcode !== undefined,
          product_source: d?.product_source ?? null,
          lookup_cause: d?.lookup_cause ?? null,
          llm_used: result.llm_used,
          llm_model: result.llm_used ? ctx.config.llm.model : null,
          llm_fallback: d?.llm_fallback ?? null,
          det_top: d?.det_top ?? null,
          final_top: d?.final_top ?? null,
          candidates: candidates.map((c) => ({ hsn: c.hsn, confidence: c.confidence, band: c.confidence_band })),
          needs_review: top === undefined || top.confidence_band !== 'high' || result.needs_review,
          latency_ms: Date.now() - started,
        },
        'classify.decision',
      );
      reply.header('Cache-Control', CACHE_NONE);
      return {
        input: { name: b.name ?? null, barcode: b.barcode ?? null, unit_price: price === null ? null : paiseToRupees(price) },
        normalized_name: result.normalized_name,
        product: result.product,
        // needs_review is recomputed here so it can never be false without a high-band top candidate
        needs_review: top === undefined || top.confidence_band !== 'high' || result.needs_review,
        message: result.message ?? null,
        candidates,
        classifier: result.classifier,
        ...(result.scoring ? { scoring: result.scoring } : {}),
        llm_used: result.llm_used,
        dataset_version: ds.current_version,
        disclaimer: CLASSIFY_DISCLAIMER,
      };
    },
  );
}
