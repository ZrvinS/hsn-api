/**
 * Shared route helpers and JSON schemas. Query values arrive as strings (Ajv coerceTypes is off,
 * SEC-25), so numeric query params are declared as anchored digit patterns and parsed here.
 * Response schemas list every serialised field: anything not declared is never sent (SEC-03).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeEtag, ifNoneMatchHits, secondsUntilNextIstMidnight } from '../lib/etag.js';
import { AppError, validationError } from '../lib/problem.js';
import { checkAsOfDate, todayIst, type IsoDate } from '../lib/dates.js';
import { parseRupees } from '../lib/money.js';
import type { Clock } from '../lib/clock.js';

export const CACHE_LOOKUP_MAX_AGE = 3600;
export const CACHE_POLL = 'private, no-cache';
export const CACHE_NONE = 'no-store';

/** Lookup caching: max-age never extends past the next IST midnight (ruling 4). */
export function cacheLookup(clock: Clock): string {
  return `private, max-age=${Math.min(CACHE_LOOKUP_MAX_AGE, secondsUntilNextIstMidnight(clock.now()))}, must-revalidate`;
}

/** Build the body, then send 304 or 200 with an ETag over (dataset version, as-of date, body). */
export function withEtag<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  datasetVersion: string,
  asOf: string,
  cacheControl: string,
  build: () => T,
): T | FastifyReply {
  const body = build();
  const etag = makeEtag(datasetVersion, asOf, body);
  reply.header('ETag', etag);
  reply.header('Cache-Control', cacheControl);
  const inm = request.headers['if-none-match'];
  if (ifNoneMatchHits(typeof inm === 'string' ? inm : undefined, etag)) return reply.code(304).send();
  return body;
}

export function asOfDate(raw: string | undefined, clock: Clock, pointer = '/date'): IsoDate {
  if (raw === undefined) return todayIst(clock);
  const problem = checkAsOfDate(raw, clock);
  if (problem) throw validationError([{ pointer, code: 'date', message: problem }]);
  return raw as IsoDate;
}

/** INR (number or decimal string) → paise, > 0 and ≤ ₹1e9 for unit prices. */
export function unitPricePaise(raw: number | string | undefined, pointer: string): number | null {
  if (raw === undefined) return null;
  const p = parseRupees(raw);
  if (p === null || p <= 0 || p > 100_000_000_000) {
    throw validationError([{ pointer, code: 'amount', message: 'Must be a positive INR amount (≤ 1,000,000,000) with at most 2 decimals' }]);
  }
  return p;
}

export function intParam(raw: string | undefined, def: number, min: number, max: number, pointer: string): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw validationError([{ pointer, code: 'range', message: `Must be an integer between ${min} and ${max}` }]);
  }
  return n;
}

export function requireAuthActor(request: FastifyRequest): { actor: string; actorId: string; keyId: string; keyPrefix: string } {
  const a = request.auth;
  if (!a || !a.actor || !a.actorId) throw new AppError('forbidden_scope', 'Admin actions need an admin key bound to an admin actor.');
  return { actor: a.actor, actorId: a.actorId, keyId: a.keyId, keyPrefix: a.prefix };
}

/** HSN/SAC code: 2, 4, 6 or 8 digits; 5 digits only for SAC groups 99xxx (ruling 6). */
export const HSN_CODE_PATTERN = '^([0-9]{2}|[0-9]{4}|99[0-9]{3}|[0-9]{6}|[0-9]{8})$';

// ------------------------------------------------------------------------------------- schemas

export const S = {
  str: { type: 'string' },
  strN: { type: ['string', 'null'] },
  num: { type: 'number' },
  numN: { type: ['number', 'null'] },
  int: { type: 'integer' },
  intN: { type: ['integer', 'null'] },
  bool: { type: 'boolean' },
} as const;

export const digitsQ = (maxLen: number) => ({ type: 'string', pattern: `^[0-9]{1,${maxLen}}$` });
export const dateQ = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } as const;
export const moneyQ = { type: 'string', pattern: '^[0-9]{1,10}(\\.[0-9]{1,2})?$' } as const;
/** money in a JSON body: number or decimal string; ≤ 2 decimals checked by parseRupees */
export const moneyB = { type: ['number', 'string'], maxLength: 20 } as const;

export const sourceSchema = { type: 'object', properties: { notification: S.str, url: S.str } } as const;
export const ruleSourceSchema = {
  type: 'object',
  properties: { notification: S.str, url: S.str, pdf_sha256: S.strN, schedule_serial: S.strN },
} as const;

export const rateRuleSchema = {
  type: 'object',
  properties: {
    rule_id: S.str,
    hsn_prefix: S.str,
    igst_rate_bp: S.int,
    igst_rate_percent: S.num,
    cgst_rate_percent: S.num,
    sgst_rate_percent: S.num,
    utgst_rate_percent: S.num,
    cess: { type: 'object', properties: { rate_bp: S.int, specific_amount: S.numN, specific_unit: S.strN } },
    condition: { type: 'object', properties: { kind: S.str, code: S.strN, text: S.strN, min_unit_price: S.numN, max_unit_price: S.numN } },
    effective_from: S.str,
    effective_to: S.strN,
    source: ruleSourceSchema,
    last_verified_at: S.strN,
    reverify_due_at: S.strN,
    verified_by: S.strN,
    verification_status: S.str,
    warning: S.strN,
    citation_note: S.strN,
    dataset_version: S.str,
  },
} as const;

export const rateResolutionSchema = {
  type: 'object',
  // ruling 13: coverage (and the fields clients branch on) are always present
  required: ['hsn_queried', 'as_of', 'ambiguous', 'coverage', 'matched_at_level', 'applicable_rule', 'default_rule_id', 'rules', 'warnings'],
  properties: {
    hsn_queried: S.str,
    as_of: S.str,
    unit_price: S.numN,
    ambiguous: S.bool,
    ambiguity_reason: S.str,
    coverage: { type: 'string', enum: ['ok', 'no_rate_rule', 'ambiguous'] },
    matched_at_level: S.intN,
    applicable_rule: { ...rateRuleSchema, type: ['object', 'null'] },
    default_rule_id: S.strN,
    rule_selected_by: S.strN,
    rules: { type: 'array', items: rateRuleSchema },
    verification_status: S.strN,
    warnings: { type: 'array', items: S.str },
    disclaimer: S.str,
  },
} as const;

export const problemNote = 'Errors are application/problem+json (RFC 9457).';
