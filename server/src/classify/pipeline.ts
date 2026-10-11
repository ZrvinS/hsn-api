/**
 * Classification pipeline (architecture §2.2/§2.3, 06-ai-restrictions A.1):
 *
 *   barcode → GTIN check → product cache → enabled adapters → product name/category ─┐
 *   name ──────────────────────────────────────────────────────────────────────────────▶ normalise
 *     → synonyms + FTS5 + chapter keywords (+ barcode category) → fusion → [optional re-rank]
 *     → candidates (≤ 5, no rates: routes/classify.ts attaches rates via RateService)
 *
 * All product text (request name, adapter output, cached adapter output) is untrusted and is
 * only tokenised and compared with curated data. Nothing here reads or writes a rate.
 *
 * Trust (rulings 00c-2 and 00c-22, SA-K-03): `high` needs a curated exact synonym on the name
 * the CALLER sent. Text or categories from Open Food Facts / Open Beauty Facts (crowd-edited)
 * can contribute signals but never lift a candidate above medium, and add a review hint.
 */
import type { HsnRepo, ProductRepo, ProductRow, SynonymRepo } from '../repositories/types.js';
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import type { ProductLookup, ProductSource } from '../adapters/productLookup.js';
import { cleanTags, cleanText } from '../adapters/productLookup.js';
import { DailyCounter, type CallBudget } from '../adapters/budget.js';
import {
  ClassifyInputError,
  type ClassifierLogger,
  type ClassifyCandidate,
  type ClassifyContext,
  type ClassifyInput,
  type ClassifyProduct,
  type ClassifyResult,
  type Classifier,
} from './types.js';
import { gs1PrefixHint, lookupCode, validateGtin } from './gtin.js';
import { normaliseName, referenceTokens } from './normalise.js';
import { hasNegation, hintAllowed } from './ruleHint.js';
import { applyImitationQualifier, IMITATION_TARGET, imitationQualified } from './qualifiers.js';
import { applyAccessoryQualifier } from './accessory.js';
import { SynonymMatcher } from './synonyms.js';
import { ftsRetrieve } from './fts.js';
import { chapterScore, chapterSignals } from './chapterKeywords.js';
import { barcodeScore, resolveCategory, type BarcodeCategory } from './barcodeCategory.js';
import { CLASSIFIER_VERSION, DROP_BELOW, fuse, MAX_CANDIDATES, WEAK_BEST_BELOW, type SignalInput } from './fusion.js';
import { buildRerankPayload, DisabledReranker, maybeRerank, type Reranker } from './rerank.js';

/** Ruling 22: cached external product data lives 7 days, stored with source + fetch time. */
export const FOUND_TTL_MS = 7 * 24 * 3600 * 1000;
export const NOT_FOUND_TTL_MS = 24 * 3600 * 1000;
/** SA-K-04: failed lookups are cached briefly (not as "not found"). */
export const ERROR_TTL_MS = 15 * 60 * 1000;
/** A response that fails our schema is deterministic for that record: cache it longer. */
export const SCHEMA_ERROR_TTL_MS = 24 * 3600 * 1000;
/** Without a dataset version source, the synonym matcher is rebuilt at most this often. */
const SYNONYM_REFRESH_MS = 60_000;
/** SEC-77: at most 20 retrieved candidates are scored. */
const MAX_RETRIEVED = 20;
const MAX_ERROR_CACHE = 10_000;
const MAX_REF_CACHE = 20_000;

/** SA-K2-03: our own capacity refusals describe us, not the product: never cached per barcode. */
const CAPACITY_CAUSES = new Set(['rate_budget', 'busy', 'circuit_open', 'key_daily_cap']);
/** Daily-cap / budget partition for requests without an API key (SA-K2-05). */
export const SHARED_PARTITION = 'shared:no-key';

export const MESSAGES = {
  noConfident: 'No confident match: the best candidate scored below 0.30. All candidates are low confidence and need review; try a more specific product name.',
  noCandidate: 'No HSN candidate matched this product. Send a more specific product name.',
  barcodeNotFound: (gtin: string): string =>
    `Barcode ${gtin} was not found in the local product cache or the enabled product databases. Send the product name to get HSN suggestions.`,
  barcodeLookupFailed: (gtin: string): string =>
    `The product lookup for barcode ${gtin} is temporarily unavailable (the external database failed or a lookup limit was reached). This does not mean the product does not exist. Send the product name, or retry later.`,
  barcodeNoText: (gtin: string): string =>
    `Barcode ${gtin} was found but has no usable product name or mapped category. Send the product name to get HSN suggestions.`,
  externalText: (where: string): string =>
    `The product name comes from ${where}, a crowd-edited third-party database; it is not verified. A reviewer should confirm this code (confidence is capped at medium).`,
  negation: 'The name contains a negation word (e.g. "not", "non", "free", "without"); curated synonyms may not apply as written, so confidence is capped at medium for review.',
  ruleHintAssumed: (condition: string, phrase: string): string =>
    `A rate condition ("${condition}") was assumed because the name matches the curated synonym "${phrase}". Confirm the product qualifies (e.g. is on the notified list) before using that rule.`,
  externalCategory: (where: string): string =>
    `This candidate is supported by a product category from ${where}, a crowd-edited third-party database; capped at medium until a reviewer confirms.`,
} as const;

const SOURCE_LABEL: Record<ProductSource, string> = { open_food_facts: 'Open Food Facts', open_beauty_facts: 'Open Beauty Facts' };

export interface PipelineDeps {
  hsn: Pick<HsnRepo, 'searchTokens' | 'getMany'>;
  synonyms: Pick<SynonymRepo, 'allActive' | 'chaptersForKeywords' | 'categoryPrefix'>;
  products: Pick<ProductRepo, 'get' | 'upsert'>;
  clock: Clock;
  log: ClassifierLogger;
  /** enabled adapters only, in priority order */
  adapters: readonly ProductLookup[];
  reranker?: Reranker;
  /** LLM call budget (ruling 25) */
  llmBudget?: Pick<CallBudget, 'take'>;
  /** cache-miss outbound lookups per API key per day (ruling 25); default 500 */
  perKeyDailyLookups?: number;
  /** current dataset version; caches refresh when it changes (SA-K-05) */
  datasetVersion?: () => string;
}

interface ProductInfo {
  product: ClassifyProduct;
  name: string | null;
  categories: string[];
  /** category_map source to look up categories in */
  mapSource: string | null;
  /** where the product data came from; null when nothing was resolved */
  resolvedFrom: ProductSource | 'manual' | null;
  viaCache: boolean;
  lookupCause: string | null;
}

export class ClassifierPipeline implements Classifier {
  private readonly reranker: Reranker;
  private readonly perKey: DailyCounter;
  private readonly errorCache = new Map<string, { until: number; cause: string }>();
  private syn: { key: string; at: number; matcher: SynonymMatcher } | null = null;
  private refCache: { key: string; map: Map<string, readonly string[]> } = { key: '', map: new Map() };

  constructor(private readonly d: PipelineDeps) {
    this.reranker = d.reranker ?? new DisabledReranker();
    this.perKey = new DailyCounter(d.perKeyDailyLookups ?? 500, () => d.clock.now().getTime());
  }

  // ------------------------------------------------------------------ caches (SA-K-05)

  private versionKey(): string | null {
    try {
      return this.d.datasetVersion ? this.d.datasetVersion() : null;
    } catch {
      return null;
    }
  }

  /** Synonym matcher built once per dataset version (or once a minute without a version source). */
  private matcher(v: string | null): SynonymMatcher {
    const now = this.d.clock.now().getTime();
    const fresh = this.syn !== null && (v !== null ? this.syn.key === v : now - this.syn.at < SYNONYM_REFRESH_MS);
    if (!fresh) this.syn = { key: v ?? '', at: now, matcher: new SynonymMatcher(this.d.synonyms.allActive()) };
    return this.syn!.matcher;
  }

  /** SA-K2-06: the dataset version is read once per request and bound here. */
  private refTokensFor = (version: string | null) => (code: string, text: string): readonly string[] => {
    const v = version ?? 'unversioned';
    if (this.refCache.key !== v) this.refCache = { key: v, map: new Map() };
    const k = `${code}\u0000${text}`;
    let t = this.refCache.map.get(k);
    if (t === undefined) {
      t = referenceTokens(text);
      if (this.refCache.map.size >= MAX_REF_CACHE) this.refCache.map.clear();
      this.refCache.map.set(k, t);
    }
    return t;
  };

  private errorCached(gtin14: string): string | null {
    const e = this.errorCache.get(gtin14);
    if (e === undefined) return null;
    if (e.until <= this.d.clock.now().getTime()) {
      this.errorCache.delete(gtin14);
      return null;
    }
    return e.cause;
  }

  private cacheError(gtin14: string, cause: string): void {
    if (CAPACITY_CAUSES.has(cause)) return;
    const ttl = cause === 'schema' ? SCHEMA_ERROR_TTL_MS : ERROR_TTL_MS;
    if (this.errorCache.size >= MAX_ERROR_CACHE) {
      const first = this.errorCache.keys().next().value;
      if (first !== undefined) this.errorCache.delete(first);
    }
    this.errorCache.set(gtin14, { until: this.d.clock.now().getTime() + ttl, cause });
  }

  // ------------------------------------------------------------------ product resolution

  private async resolveProduct(gtinInput: string, gtin14: string, code: string, hint: string | null, keyId: string | null, tenantId: string | null, ctx: ClassifyContext): Promise<ProductInfo> {
    const now = this.d.clock.now();
    const base = { gtin: gtinInput, gtin_valid: true } as const;
    const withHints = (p: ClassifyProduct): ClassifyProduct => (hint === null ? p : { ...p, hints: [hint] });
    const empty = (source: 'not_found' | 'lookup_failed', fetchedAt: string | null, cause: string | null): ProductInfo => ({
      product: withHints({ ...base, name: null, brand: null, category: null, source, fetched_at: fetchedAt }),
      name: null,
      categories: [],
      mapSource: null,
      resolvedFrom: null,
      viaCache: false,
      lookupCause: cause,
    });

    let cached: ProductRow | null = null;
    try {
      cached = this.d.products.get(gtin14);
    } catch {
      cached = null;
    }
    if (cached !== null && cached.expires_at > rfc3339(now)) {
      if (!cached.found) return empty('not_found', cached.fetched_at, null);
      // SA-K-09: everything read back from the cache is re-sanitised
      const name = cleanText(cached.name, 200);
      const brand = cleanText(cached.brand, 100);
      const category = cleanTags(cached.category === null ? [] : [cached.category])[0] ?? null;
      return {
        product: withHints({ ...base, name, brand, category, source: 'local_cache', fetched_at: cached.fetched_at }),
        name,
        categories: category === null ? [] : [category],
        mapSource: cached.source === 'manual' ? 'open_food_facts' : cached.source,
        resolvedFrom: cached.source,
        viaCache: true,
        lookupCause: null,
      };
    }

    if (this.d.adapters.length === 0) return empty('not_found', null, null);

    const recentError = this.errorCached(gtin14);
    if (recentError !== null) return empty('lookup_failed', null, recentError);

    // ruling 25: per-key daily cap on cache-miss lookups (counted per barcode lookup);
    // SA-K2-05: no key → one shared bucket, never uncapped
    const partition = keyId ?? SHARED_PARTITION;
    if (!this.perKey.take(partition)) {
      ctx.log.warn({ event: 'classify.outbound_key_cap', request_id: ctx.requestId }, 'classify.outbound_key_cap');
      return empty('lookup_failed', null, 'key_daily_cap');
    }

    // SA-K3-03: the outbound minute-budget share is per key owner (tenant), so one owner's
    // several keys cannot each take a share; without a tenant it falls back to the key partition
    const outboundPartition = tenantId !== null && tenantId.length > 0 ? `tenant:${tenantId}` : partition;
    let firstError: string | null = null;
    for (const a of this.d.adapters) {
      const r = await a.lookup(code, outboundPartition);
      if (r.status === 'error') {
        firstError ??= r.cause;
        ctx.log.warn({ event: 'classify.adapter_error', request_id: ctx.requestId, source: a.source, cause: r.cause }, 'classify.adapter_error');
        continue;
      }
      if (r.status === 'not_found') continue;
      const mapped = resolveCategory(this.d.synonyms, r.source, r.categories);
      const category = mapped?.category ?? r.categories[r.categories.length - 1] ?? null;
      const fetchedAt = rfc3339(now);
      this.safeUpsert(
        { gtin: gtin14, name: r.name, brand: r.brand, category, source: r.source, source_ref: r.sourceRef, found: true, fetched_at: fetchedAt, expires_at: rfc3339(new Date(now.getTime() + FOUND_TTL_MS)) },
        ctx,
      );
      return {
        product: withHints({ ...base, name: r.name, brand: r.brand, category, source: r.source, fetched_at: fetchedAt }),
        name: r.name,
        categories: r.categories,
        mapSource: r.source,
        resolvedFrom: r.source,
        viaCache: false,
        lookupCause: null,
      };
    }
    if (firstError !== null) {
      // SA-K-04: errors are cached briefly and reported as lookup_failed, never as not_found
      this.cacheError(gtin14, firstError);
      return empty('lookup_failed', null, firstError);
    }
    // SEC-38: negative cache only when every enabled adapter answered "not found"
    const first = this.d.adapters[0]!;
    this.safeUpsert(
      { gtin: gtin14, name: null, brand: null, category: null, source: first.source, source_ref: null, found: false, fetched_at: rfc3339(now), expires_at: rfc3339(new Date(now.getTime() + NOT_FOUND_TTL_MS)) },
      ctx,
    );
    return empty('not_found', rfc3339(now), null);
  }

  private safeUpsert(row: ProductRow, ctx: ClassifyContext): void {
    try {
      this.d.products.upsert(row);
    } catch {
      ctx.log.warn({ event: 'classify.product_cache_write_failed', request_id: ctx.requestId }, 'classify.product_cache_write_failed');
    }
  }

  // ------------------------------------------------------------------ classify

  async classify(input: ClassifyInput, ctx: ClassifyContext): Promise<ClassifyResult> {
    const started = Date.now();
    const maxCandidates = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(input.maxCandidates || MAX_CANDIDATES)));

    // 1. barcode → GTIN check (before any outbound call)
    let info: ProductInfo | null = null;
    let barcodeReason: string | null = null;
    if (input.barcode !== null) {
      const g = validateGtin(input.barcode);
      if (!g.valid) {
        const code = g.reason === 'checksum' ? 'gtin_checksum' : g.reason === 'bad_length' ? 'gtin_length' : 'gtin_digits';
        const msg = g.reason === 'checksum' ? `Check digit should be ${g.expected}, got ${g.actual}` : g.message;
        throw new ClassifyInputError('invalid_gtin', `${g.message} Re-scan the barcode or send the product name instead.`, [{ pointer: '/barcode', code, message: msg }]);
      }
      const hint = gs1PrefixHint(g);
      info = await this.resolveProduct(g.input, g.gtin14, lookupCode(g), hint?.detail ?? null, input.keyId, input.tenantId ?? null, ctx);
      if (info.resolvedFrom !== null) {
        const where = info.viaCache ? 'local product cache' : SOURCE_LABEL[info.resolvedFrom as ProductSource] ?? 'product database';
        barcodeReason = `GTIN ${g.input} resolved from ${where}${hint ? '; GS1 prefix 890 (GS1 India) noted as a hint only' : ''}`;
      }
    }
    const externalLabel = info?.resolvedFrom && info.resolvedFrom !== 'manual' ? SOURCE_LABEL[info.resolvedFrom] : null;

    // 2. text: the caller's name wins for text signals; the barcode contributes the category signal
    const textFromCaller = input.name !== null;
    const text = input.name ?? info?.name ?? null;
    const norm = text === null ? null : normaliseName(text);
    const category: BarcodeCategory | null =
      info !== null && info.mapSource !== null ? resolveCategory(this.d.synonyms, info.mapSource, info.categories) : null;

    const diagnostics = (detTop: string | null, finalTop: string | null, llmFallback: string | null) => ({
      product_source: info?.product.source ?? null,
      lookup_cause: info?.lookupCause ?? null,
      llm_fallback: llmFallback,
      det_top: detTop,
      final_top: finalTop,
      latency_ms: Date.now() - started,
    });
    const base = (): Omit<ClassifyResult, 'needs_review' | 'candidates'> => ({
      normalized_name: norm?.text ?? null,
      product: info?.product ?? null,
      classifier: { version: CLASSIFIER_VERSION, llm_rerank: false },
      llm_used: false,
    });

    if ((norm === null || norm.tokens.length === 0) && category === null) {
      const message =
        info === null
          ? MESSAGES.noCandidate
          : info.product.source === 'lookup_failed'
            ? MESSAGES.barcodeLookupFailed(info.product.gtin)
            : info.product.source === 'not_found'
              ? MESSAGES.barcodeNotFound(info.product.gtin)
              : MESSAGES.barcodeNoText(info.product.gtin);
      return { ...base(), needs_review: true, candidates: [], message, diagnostics: diagnostics(null, null, null) };
    }

    // 3. retrieval
    const version = this.versionKey();
    const matchTokens = norm?.matchTokens ?? [];
    const allTokens = norm?.tokens ?? [];
    // SA-K3-01: brand words from a barcode lookup (crowd-edited Open Food/Beauty Facts data, or a
    // cache of it) never count towards whole-name exactness; the API has no caller-supplied brand.
    const synHits = this.matcher(version).match(matchTokens);
    const fts = ftsRetrieve(this.d.hsn, norm?.ftsTokens ?? [], this.refTokensFor(version));
    const negated = textFromCaller && hasNegation(allTokens);
    const chap = chapterSignals(this.d.synonyms, norm?.tokens ?? []);

    const codes: string[] = [];
    const add = (c: string): void => {
      if (!codes.includes(c) && codes.length < MAX_RETRIEVED) codes.push(c);
    };
    [...synHits.keys()].sort().forEach(add);
    fts.forEach((h) => add(h.code));
    if (category !== null) add(category.hsnPrefix);
    // imitation qualifier: "gold plated brass bangles" is 7117, not 7113 (see qualifiers.ts)
    const imitation = imitationQualified(allTokens) && codes.some((c) => c.startsWith('71'));
    if (imitation && !codes.includes(IMITATION_TARGET)) codes.push(IMITATION_TARGET);

    const rows = new Map(this.d.hsn.getMany(codes).map((r) => [r.code, r]));
    const ftsBy = new Map(fts.map((h) => [h.code, h]));
    let inputs: SignalInput[] = [];
    const hints = new Map<string, { condition: string; synonym: string }>();
    for (const code of codes) {
      const row = rows.get(code);
      if (row === undefined) continue; // only codes present in the HSN master can be candidates
      const syn = synHits.get(code);
      const f = ftsBy.get(code);
      const ch = chapterScore(chap, code);
      const bar = category === null ? null : barcodeScore(category, code);
      const exactOnCallerName = textFromCaller && syn !== undefined && syn.score === 1;
      // SA-K2-01: a rule hint only when the name IS the synonym's product (no negation, no extra product words)
      const hint =
        exactOnCallerName && syn.ruleHint !== null && hintAllowed(allTokens, matchTokens, referenceTokens(syn.phrase))
          ? { condition: syn.ruleHint, synonym: syn.phrase }
          : null;
      if (hint !== null) hints.set(code, hint);
      // a set hint or a negated name always needs review (capped at medium)
      const highEligible = exactOnCallerName && hint === null && !negated;
      const extra: { code: 'review_hint'; detail: string }[] = (syn?.notes ?? []).map((n) => ({ code: 'review_hint', detail: n }));
      if (hint !== null) extra.push({ code: 'review_hint', detail: MESSAGES.ruleHintAssumed(hint.condition, hint.synonym) });
      if (negated && syn !== undefined) extra.push({ code: 'review_hint', detail: MESSAGES.negation });
      if (!highEligible && externalLabel !== null) {
        if (!textFromCaller) extra.push({ code: 'review_hint', detail: MESSAGES.externalText(externalLabel) });
        else if (bar !== null && bar.score > 0) extra.push({ code: 'review_hint', detail: MESSAGES.externalCategory(externalLabel) });
      }
      inputs.push({
        code,
        syn: syn?.score ?? 0,
        fts: f?.score ?? 0,
        chap: ch.score,
        bar: bar === null ? null : bar.score,
        highEligible,
        synDetail: syn ? { code: syn.reasonCode, detail: syn.detail } : undefined,
        ftsDetail: f?.detail,
        chapDetail: ch.detail,
        barDetail: bar?.detail,
        extraReasons: extra,
      });
    }

    if (imitation) inputs = applyImitationQualifier(inputs);
    // accessory / packaging qualifier: "mobile phone stand" is not a phone (see accessory.ts)
    {
      const evidence = new Map<string, readonly string[]>();
      for (const i of inputs) {
        const syn = synHits.get(i.code);
        evidence.set(i.code, [...(syn ? referenceTokens(syn.phrase) : []), ...(ftsBy.get(i.code)?.matched ?? [])]);
      }
      inputs = applyAccessoryQualifier(allTokens, inputs, evidence);
    }

    // 4. fusion
    const fused = fuse(inputs, category !== null, maxCandidates);
    let ranked = fused.candidates;
    const detTop = ranked[0]?.code ?? null;

    // 5. optional re-rank (reorder only, may only lower confidence)
    let llmUsed = false;
    let fallback: string | null = null;
    if (ranked.length > 0) {
      const outcome = await maybeRerank(
        this.reranker,
        input.allowLlm,
        ranked,
        () => buildRerankPayload(norm?.text ?? '', info?.product.category ?? null, ranked.map((c) => ({ code: c.code, description: rows.get(c.code)?.description ?? '' }))),
        undefined,
        this.d.llmBudget,
      );
      if (outcome.used) {
        llmUsed = true;
        // SA-K2-04: the re-rank can only lower scores; re-apply the drop rule to the final list
        outcome.candidates = outcome.candidates.filter((c) => c.confidence >= DROP_BELOW);
        if (outcome.topChanged) {
          // AI-51: both orders' top codes; never model text
          ctx.log.info({ event: 'classify.llm_changed_top', request_id: ctx.requestId, det_top: outcome.detTop, final_top: outcome.finalTop }, 'classify.llm_changed_top');
        }
        ranked = outcome.candidates;
      } else if (outcome.cause !== null) {
        fallback = outcome.cause;
        // AI-01/AI-31: rejected or failed output → deterministic order, logged with the cause only
        const event = ['unknown_code', 'missing_code', 'duplicate_code', 'rate_text', 'rate_field', 'schema', 'not_json', 'too_long'].includes(outcome.cause) ? 'ai.rejected_output' : 'ai.fallback';
        ctx.log.warn({ event, request_id: ctx.requestId, cause: outcome.cause }, event);
        if (event === 'ai.rejected_output') ctx.log.warn({ event: 'ai.fallback', request_id: ctx.requestId, cause: outcome.cause }, 'ai.fallback');
      }
    }

    const candidates: ClassifyCandidate[] = ranked.map((c, i) => {
      const reasons = c.reasons.map((r) => ({ code: r.code, detail: r.detail, weight: r.weight }));
      if (i === 0 && barcodeReason !== null) reasons.unshift({ code: 'barcode_resolved', detail: barcodeReason, weight: 0 });
      if (i === 0 && category !== null && textFromCaller && (c.signals.barcode_category ?? 0) === 0) {
        reasons.push({ code: 'barcode_conflict', detail: `The name points here, but the barcode's product category "${category.category}" maps to ${category.hsnPrefix}. Check which is right.`, weight: 0 });
      }
      const ruleHint = hints.get(c.code) ?? null;
      const cand: ClassifyCandidate = {
        hsn: c.code,
        description: rows.get(c.code)?.description ?? '',
        confidence: c.confidence,
        confidence_band: c.confidence_band,
        needs_review: c.needs_review,
        signals: { ...c.signals },
        reasons,
      };
      if (ruleHint !== null) cand.rule_hint = ruleHint;
      return cand;
    });

    const needsReview = candidates.length === 0 || candidates[0]!.confidence_band !== 'high';
    // SA-K2-04 / AI-05: weak-best is judged on the FINAL list (after any re-rank)
    const weak = candidates.length > 0 && candidates[0]!.confidence < WEAK_BEST_BELOW;
    const message = candidates.length === 0 ? MESSAGES.noCandidate : weak ? MESSAGES.noConfident : null;
    return {
      ...base(),
      classifier: { version: CLASSIFIER_VERSION, llm_rerank: llmUsed },
      llm_used: llmUsed,
      needs_review: needsReview,
      candidates,
      message,
      scoring: {
        applicable: { synonym: fused.applicable.syn, fts: true, chapter_keyword: true, barcode_category: fused.applicable.bar },
        denominator: Math.round(fused.denominator * 100) / 100,
      },
      diagnostics: diagnostics(detTop, candidates[0]?.hsn ?? null, fallback),
    };
  }
}
