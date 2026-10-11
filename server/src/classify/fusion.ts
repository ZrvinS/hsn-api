/**
 * Score fusion — the confidence formula of architecture.md §5.4 as amended by coordinator
 * rulings 00b-5/6 and 00c-2/22 (classifier version rules-fts-2.3: R2 whole-name coverage, SA-K3-01/04, accessory qualifier). Pure and deterministic
 * (AI-32): same signals in, byte-identical output.
 *
 *   A        = {fts, chap}
 *              ∪ {syn} if any curated synonym matched this request (ruling 2: weights are
 *                renormalised over the signals applicable to the request)
 *              ∪ {bar} if the barcode resolved to a product whose category is in category_map
 *   raw_c    = Σ_{i∈A} w_i · s_i(c) / Σ_{i∈A} w_i          (denominator 0.35, 0.50, 0.85 or 1.00)
 *   gap      = raw_top − raw_second                        (raw_second = 0 if one candidate)
 *   penalty  = max(0, 0.10 − gap) / 2                      (top candidate only; ≤ 0.05)
 *   conf_c   = clamp(raw_c − penalty_c, 0, 1)
 *   gate     : unless c has a curated EXACT synonym hit (s_syn = 1.0) on the name the caller
 *              sent, conf_c = min(conf_c, 0.84)  (rulings 2 + 22: `high` requires a curated
 *              synonym; FTS + chapter or external OFF/OBF data alone reach at most medium)
 *   close    : gap < 0.10 (≥ 2 candidates) → top capped at medium (0.84) + reason
 *              close_runner_up (ruling 5). Because the penalty can push the top below the
 *              runner-up, the cap is applied to every candidate within 0.10 of raw_top, so
 *              whichever ends up first after re-sorting is never `high`.
 *   confidence = round(conf_c, 2); band high ≥ 0.85, medium ≥ 0.60, else low
 *   drop conf < 0.10; if best < 0.30 keep the rest, all low, needs_review (ruling 6)
 *
 * Every non-zero term becomes a reason whose `weight` is its contribution to raw
 * (w_i·s_i / Σw), and the penalty is a reason with a negative weight, so confidence can be
 * recomputed by hand from the response.
 */

export const CLASSIFIER_VERSION = 'rules-fts-2.3';

export const WEIGHTS = Object.freeze({ syn: 0.5, fts: 0.2, chap: 0.15, bar: 0.15 });
export const HIGH_THRESHOLD = 0.85;
export const MEDIUM_THRESHOLD = 0.6;
/** Highest confidence that is still `medium` (gate and caps). */
export const MEDIUM_CAP = 0.84;
export const CLOSE_GAP = 0.1;
export const DROP_BELOW = 0.1;
export const WEAK_BEST_BELOW = 0.3;
export const MAX_CANDIDATES = 5;

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

export interface Reason {
  code: ReasonCode;
  detail: string;
  /** contribution to the score (0 for informational reasons, negative for penalties) */
  weight: number;
}

export interface SignalInput {
  code: string;
  /** s_syn, s_fts, s_chap ∈ [0,1] */
  syn: number;
  fts: number;
  chap: number;
  /** s_bar ∈ [0,1], or null when no barcode category is available for this request */
  bar: number | null;
  /** explanation for each non-zero signal (weight is filled in by fusion) */
  synDetail?: { code: 'synonym_exact' | 'synonym_partial' | 'synonym_related'; detail: string } | undefined;
  ftsDetail?: string | undefined;
  chapDetail?: string | undefined;
  barDetail?: string | undefined;
  /**
   * true only when a curated exact synonym (score 1.0, primary, contiguous, uncontested) hit
   * this code on the product name the caller sent. Defaults to false → capped at medium.
   */
  highEligible?: boolean | undefined;
  /**
   * Optional ceiling on the final confidence (e.g. the accessory qualifier caps the main-article
   * heading at low). Applied after the medium cap; it can only lower a score.
   */
  capAt?: number | undefined;
  /** informational reasons (review_hint, barcode_resolved, ...) carried through with weight 0 */
  extraReasons?: readonly { code: ReasonCode; detail: string }[] | undefined;
}

export interface Signals {
  synonym: number;
  fts: number;
  chapter_keyword: number;
  barcode_category: number | null;
  margin_penalty: number;
}

export interface ScoredCandidate {
  code: string;
  raw: number;
  confidence: number;
  confidence_band: ConfidenceBand;
  needs_review: boolean;
  signals: Signals;
  reasons: Reason[];
}

export interface FusionResult {
  /** which signals entered the denominator for this request (explainability) */
  applicable: Applicable;
  denominator: number;
  candidates: ScoredCandidate[];
  needs_review: boolean;
  /** 'no_confident_match' when the best candidate is < 0.30 or nothing survived */
  message: string | null;
  weak: boolean;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_THRESHOLD) return 'high';
  if (confidence >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/** raw_c of the formula, plus each term's contribution. */
export interface Applicable {
  syn: boolean;
  bar: boolean;
}

export function denominator(a: Applicable): number {
  return (a.syn ? WEIGHTS.syn : 0) + WEIGHTS.fts + WEIGHTS.chap + (a.bar ? WEIGHTS.bar : 0);
}

export function rawScore(s: SignalInput, barAvailable: boolean, synApplicable = true): { raw: number; parts: { syn: number; fts: number; chap: number; bar: number } } {
  const denom = denominator({ syn: synApplicable, bar: barAvailable });
  const syn = synApplicable ? (WEIGHTS.syn * clamp01(s.syn)) / denom : 0;
  const fts = (WEIGHTS.fts * clamp01(s.fts)) / denom;
  const chap = (WEIGHTS.chap * clamp01(s.chap)) / denom;
  const bar = barAvailable ? (WEIGHTS.bar * clamp01(s.bar ?? 0)) / denom : 0;
  return { raw: syn + fts + chap + bar, parts: { syn, fts, chap, bar } };
}

function byRawDesc(a: { raw: number; code: string }, b: { raw: number; code: string }): number {
  if (b.raw !== a.raw) return b.raw - a.raw;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * Fuse per-candidate signals into ranked, banded candidates.
 * @param barAvailable true only when the barcode resolved to a product whose category is in category_map
 * The synonym signal is applicable when any input has s_syn > 0.
 */
export function fuse(inputs: readonly SignalInput[], barAvailable: boolean, maxCandidates: number = MAX_CANDIDATES): FusionResult {
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(maxCandidates)));
  const synApplicable = inputs.some((i) => i.syn > 0);
  const applicable: Applicable = { syn: synApplicable, bar: barAvailable };
  const scored = inputs.map((s) => ({ s, code: s.code, ...rawScore(s, barAvailable, synApplicable) }));
  scored.sort(byRawDesc);

  // §5.2: if an 8-digit code and its heading are both candidates, keep the higher-scoring one
  // (on a tie the shorter, more general code is kept). Applied before the gap is measured.
  const kept: typeof scored = [];
  for (const c of scored) {
    if (kept.some((k) => k.code.startsWith(c.code) || c.code.startsWith(k.code))) continue;
    kept.push(c);
  }
  // (ties sort by code, so a heading '7113' precedes '71131910' and is the one kept)

  const top = kept[0];
  if (top === undefined) return { applicable, denominator: denominator(applicable), candidates: [], needs_review: true, message: 'no_confident_match', weak: true };
  const second = kept[1];
  const gap = top.raw - (second?.raw ?? 0);
  const close = second !== undefined && gap < CLOSE_GAP;

  const out: ScoredCandidate[] = kept.map((c, idx) => {
    const isTop = idx === 0;
    const penalty = isTop ? Math.max(0, CLOSE_GAP - gap) / 2 : 0;
    let conf = clamp01(c.raw - penalty);
    const reasons: Reason[] = [];
    const s = c.s;

    if (c.parts.syn > 0) {
      const d = s.synDetail ?? { code: s.syn >= 1 ? ('synonym_exact' as const) : s.syn >= 0.7 ? ('synonym_partial' as const) : ('synonym_related' as const), detail: `Curated synonym (s_syn ${r2(s.syn)})` };
      reasons.push({ code: d.code, detail: d.detail, weight: r4(c.parts.syn) });
    }
    if (c.parts.fts > 0) reasons.push({ code: 'fts_match', detail: s.ftsDetail ?? `Full-text match (s_fts ${r2(s.fts)})`, weight: r4(c.parts.fts) });
    if (c.parts.chap > 0) reasons.push({ code: 'chapter_keyword', detail: s.chapDetail ?? `Keyword indicates chapter ${c.code.slice(0, 2)}`, weight: r4(c.parts.chap) });
    if (c.parts.bar > 0) reasons.push({ code: 'barcode_category', detail: s.barDetail ?? 'Barcode product category maps here', weight: r4(c.parts.bar) });
    for (const x of s.extraReasons ?? []) reasons.push({ code: x.code, detail: x.detail, weight: 0 });

    if (s.highEligible !== true) conf = Math.min(conf, MEDIUM_CAP);
    if (s.capAt !== undefined) conf = Math.min(conf, s.capAt);

    const withinClose = close && top.raw - c.raw < CLOSE_GAP;
    if (withinClose) {
      conf = Math.min(conf, MEDIUM_CAP);
      const other = isTop ? second! : top;
      reasons.push({
        code: 'close_runner_up',
        detail: `Score is within ${CLOSE_GAP.toFixed(2)} of ${other.code} (raw ${r2(c.raw)} vs ${r2(other.raw)}); capped at medium, review needed.`,
        weight: isTop ? -r4(penalty) : 0,
      });
    } else if (penalty > 0) {
      // single candidate with raw < 0.10 (raw_second = 0): the formula still applies a penalty
      reasons.push({ code: 'close_runner_up', detail: `Margin penalty ${r2(penalty)} (top score only ${r2(gap)} above the next candidate).`, weight: -r4(penalty) });
    }

    const confidence = r2(conf);
    const band = bandFor(confidence);
    if (reasons.length === 0) reasons.push({ code: 'no_signal', detail: 'Retrieved but no scoring signal fired.', weight: 0 });
    return {
      code: c.code,
      raw: r4(c.raw),
      confidence,
      confidence_band: band,
      needs_review: band !== 'high',
      signals: {
        synonym: r2(clamp01(s.syn)),
        fts: r2(clamp01(s.fts)),
        chapter_keyword: r2(clamp01(s.chap)),
        barcode_category: barAvailable ? r2(clamp01(s.bar ?? 0)) : null,
        margin_penalty: r4(penalty),
      },
      reasons,
    };
  });

  // Order by final confidence (the penalty may move the runner-up ahead), then raw, then code.
  out.sort((a, b) => b.confidence - a.confidence || b.raw - a.raw || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const surviving = out.filter((c) => c.confidence >= DROP_BELOW).slice(0, limit);
  if (surviving.length === 0) return { applicable, denominator: denominator(applicable), candidates: [], needs_review: true, message: 'no_confident_match', weak: true };

  const best = surviving[0]!;
  const weak = best.confidence < WEAK_BEST_BELOW;
  return {
    applicable,
    denominator: denominator(applicable),
    candidates: surviving,
    needs_review: best.confidence_band !== 'high',
    message: weak ? 'no_confident_match' : null,
    weak,
  };
}
