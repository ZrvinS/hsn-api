/**
 * FTS5 query builder (SEC-40). User text never reaches MATCH raw: it is NFKC-normalised,
 * split into [\p{L}\p{N}]+ tokens, FTS keywords dropped, each token double-quoted, at most
 * 10 tokens, joined by space (implicit AND) or " OR ". The result is bound as a parameter.
 */
const FTS_KEYWORDS = new Set(['and', 'or', 'not', 'near']);
export const MAX_FTS_TOKENS = 10;

/** NFKC, lowercase, strip control characters, collapse whitespace. */
export function normaliseQueryText(input: string): string {
  return input
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function ftsTokens(input: string): string[] {
  const norm = normaliseQueryText(input);
  const raw = norm.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (FTS_KEYWORDS.has(t)) continue;
    if (t.length > 64) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_FTS_TOKENS) break;
  }
  return out;
}

/** Build a safe MATCH expression from pre-split tokens. Returns null if no usable token. */
export function buildFtsQueryFromTokens(tokens: readonly string[], mode: 'and' | 'or'): string | null {
  const safe: string[] = [];
  for (const t of tokens) {
    // re-validate: only letters/digits survive; quotes are impossible
    const clean = (t.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
    if (clean.length === 0 || clean.length > 64 || FTS_KEYWORDS.has(clean)) continue;
    safe.push(`"${clean}"`);
    if (safe.length >= MAX_FTS_TOKENS) break;
  }
  if (safe.length === 0) return null;
  return safe.join(mode === 'and' ? ' ' : ' OR ');
}

export function buildFtsQuery(input: string, mode: 'and' | 'or'): string | null {
  return buildFtsQueryFromTokens(ftsTokens(input), mode);
}
