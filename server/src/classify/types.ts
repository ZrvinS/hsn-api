/**
 * Classifier contract between routes/classify.ts (core) and the classifier implementation
 * (src/classify/*, src/adapters/*).
 *
 * Contract:
 *  - `src/classify/index.ts` exports `createClassifier(deps: ClassifierDeps): Classifier`.
 *    main.ts loads it at boot; if it is missing, a stub answering 503 is used.
 *  - The classifier returns HSN candidates only. It never computes, reads or returns a rate:
 *    routes/classify.ts attaches `rate` (RateResolution) to each candidate via the RateService
 *    (architecture invariant 1, SEC-56).
 *  - Invalid barcodes (GTIN check digit) → throw `ClassifyInputError` → 422 problem+json,
 *    before any outbound call.
 *  - Candidates: at most `maxCandidates` (≤ 5, ruling 24), sorted by confidence desc.
 *  - `needs_review` is true unless the top candidate is band `high`; always true when empty.
 */
import type { AppConfig } from '../config.js';
import type { Clock } from '../lib/clock.js';
import type { HsnRepo, ProductRepo, SynonymRepo } from '../repositories/types.js';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type ReasonCode =
  | 'synonym_exact'
  | 'synonym_partial'
  | 'synonym_related'
  | 'fts_match'
  | 'chapter_keyword'
  | 'barcode_resolved'
  | 'barcode_category'
  | 'barcode_conflict'
  | 'close_runner_up'
  | 'llm_rerank'
  | 'review_hint'
  | 'no_signal';

/** ruling 4: {code, detail, weight} */
export interface ClassifyReason {
  code: ReasonCode;
  detail: string;
  /** signal weight that this reason contributed (0 for informational reasons) */
  weight: number;
}

export interface ClassifySignals {
  synonym: number;
  fts: number;
  chapter_keyword: number;
  /** null = no barcode category available for this request */
  barcode_category: number | null;
  margin_penalty: number;
}

export interface ClassifyCandidate {
  hsn: string;
  description: string;
  confidence: number;
  confidence_band: ConfidenceBand;
  needs_review: boolean;
  signals: ClassifySignals;
  reasons: ClassifyReason[];
  /**
   * Ruling 5 (round 2): set only when a curated EXACT synonym carrying a rule hint matched the
   * name the caller sent, e.g. { condition: 'nil_rate_list', synonym: 'examplomab injection' }.
   * The route may use it to pick the matching rule of an ambiguous rate resolution. Never set
   * from third-party product data.
   */
  rule_hint?: { condition: string; synonym: string } | null;
}

export interface ClassifyProduct {
  gtin: string;
  gtin_valid: boolean;
  name: string | null;
  brand: string | null;
  category: string | null;
  /** lookup_failed: the external lookup errored or was refused by a budget (SA-K-04) — not the same as not_found */
  source: 'local_cache' | 'open_food_facts' | 'open_beauty_facts' | 'not_found' | 'lookup_failed';
  /** informational notes about the barcode (e.g. GS1 prefix 890 = India-registered, not origin) */
  hints?: string[];
  fetched_at: string | null;
}

export interface ClassifyInput {
  /** raw product name as sent (≤ 200 chars, schema-validated); never logged raw */
  name: string | null;
  /** digits only, length 8/12/13/14 (schema-validated); check digit NOT yet verified */
  barcode: string | null;
  /** as-of date (IST) the route will resolve rates for */
  date: string;
  /** 1..5 */
  maxCandidates: number;
  /** request allow_llm && !key.llm_opt_out && config.llm.enabled */
  allowLlm: boolean;
  /**
   * Calling API key id, for the per-key outbound caps (ruling 25). Required (SA-K2-05): null
   * (no authenticated key) is treated as one shared bucket, never as "uncapped".
   */
  keyId: string | null;
  /**
   * SA-K3-03 (additive): the calling key's tenant (key owner). When present, the outbound
   * minute-budget share is partitioned per tenant, so one owner's several keys share one slice.
   * Absent/null → partition by keyId (or the shared no-key bucket).
   */
  tenantId?: string | null;
}

export interface ClassifyResult {
  normalized_name: string | null;
  product: ClassifyProduct | null;
  needs_review: boolean;
  candidates: ClassifyCandidate[];
  /** optional human message, e.g. when no confident match exists (ruling 6) */
  message?: string | null;
  classifier: { version: string; llm_rerank: boolean };
  /** ruling 8: whether an LLM was actually consulted for this response */
  llm_used: boolean;
  /** which signals entered the confidence denominator for this request (ruling 2) */
  scoring?: { applicable: { synonym: boolean; fts: boolean; chapter_keyword: boolean; barcode_category: boolean }; denominator: number };
  /** non-response fields for the single classify.decision log line written by the route (SA-K-11) */
  diagnostics?: ClassifyDiagnostics;
}

export interface ClassifyDiagnostics {
  product_source: ClassifyProduct['source'] | null;
  /** adapter / budget cause when product_source = lookup_failed */
  lookup_cause: string | null;
  /** re-ranker fallback cause (AI-31), null when not attempted or used */
  llm_fallback: string | null;
  /** AI-51: deterministic and final top codes (equal unless the re-ranker changed the top) */
  det_top: string | null;
  final_top: string | null;
  latency_ms: number;
}

export interface ClassifyContext {
  requestId: string;
  log: ClassifierLogger;
}

export interface ClassifierLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface Classifier {
  classify(input: ClassifyInput, ctx: ClassifyContext): Promise<ClassifyResult>;
}

/** Thrown for semantically invalid input (→ 422). */
export class ClassifyInputError extends Error {
  constructor(
    public readonly problem: 'invalid_gtin',
    public readonly detail: string,
    public readonly errors: { pointer: string; code: string; message: string }[],
  ) {
    super(detail);
    this.name = 'ClassifyInputError';
  }
}

export interface ClassifierDeps {
  /** read-only connection repos */
  hsn: HsnRepo;
  synonyms: SynonymRepo;
  /** product cache on the WRITE connection (upserts allowed) */
  products: ProductRepo;
  config: AppConfig;
  clock: Clock;
  log: ClassifierLogger;
  /** current dataset version; caches (synonym matcher, reference tokens) refresh when it changes */
  datasetVersion?: () => string;
}

export type CreateClassifier = (deps: ClassifierDeps) => Classifier;
