/**
 * FTS5 retrieval → s_fts (architecture.md §5.3).
 *
 *   s_fts = 0.5 · (bm25_c / bm25_best) + 0.5 · coverage_c
 *
 * bm25 values are SQLite's (negative, lower = better) so the ratio is in (0, 1]; coverage_c is
 * the fraction of query tokens found in the code's description + curated keywords.
 * Query sanitisation (SEC-40) is done by the repository: tokens are re-validated to
 * [\p{L}\p{N}]+, quoted, capped at 10, and bound as a parameter.
 */
import type { HsnRepo, HsnSearchHit } from '../repositories/types.js';
import { referenceTokens, tokenEq } from './normalise.js';

export const FTS_TOP_N = 10;
export const FTS_LEVELS: readonly number[] = [4, 8];
const MAX_QUERY_TOKENS = 10;

export interface FtsSignal {
  code: string;
  description: string;
  score: number;
  bm25: number;
  coverage: number;
  matched: string[];
  detail: string;
}

/** Pre-tokenised curated reference text per code, cached per dataset version (SA-K-05). */
export type RefTokens = (code: string, text: string) => readonly string[];
const uncached: RefTokens = (_code, text) => referenceTokens(text);

export function ftsRetrieve(repo: Pick<HsnRepo, 'searchTokens'>, ftsTokens: readonly string[], refTokens: RefTokens = uncached): FtsSignal[] {
  const q = ftsTokens.slice(0, MAX_QUERY_TOKENS);
  if (q.length === 0) return [];
  let hits: HsnSearchHit[];
  try {
    hits = repo.searchTokens(q, 'or', { limit: FTS_TOP_N, levels: FTS_LEVELS });
  } catch {
    // A search failure must not turn into a 5xx or a fabricated match: no FTS signal.
    return [];
  }
  if (hits.length === 0) return [];
  const best = Math.min(...hits.map((h) => h.bm25));
  return hits.map((h) => {
    const ref = refTokens(h.code, `${h.description} ${h.keywords}`);
    const matched = q.filter((t) => ref.some((r) => tokenEq(r, t)));
    const coverage = matched.length / q.length;
    const ratio = best < 0 && h.bm25 < 0 ? Math.min(1, h.bm25 / best) : best === h.bm25 ? 1 : 0;
    const score = 0.5 * ratio + 0.5 * coverage;
    const words = matched.map((m) => `"${m}"`).join(', ');
    return {
      code: h.code,
      description: h.description,
      score,
      bm25: h.bm25,
      coverage,
      matched,
      detail: matched.length > 0 ? `FTS matched ${words} in the description/keywords of ${h.code} (s_fts ${score.toFixed(2)})` : `FTS ranked ${h.code} (s_fts ${score.toFixed(2)})`,
    };
  });
}
