/**
 * Curated synonym matching → s_syn (architecture.md §5.3).
 *
 *   1.0  primary phrase found as a contiguous token run that covers the whole name (validator R2:
 *        nothing left but quantities, units, pack/form words or known brand tokens — see
 *        coverage.ts), the phrase maps only to this code, and it is not a single generic word
 *   0.7  primary multi-word phrase that does not cover the whole name, whose tokens appear but not
 *        contiguously, a contested phrase (maps to more than one code), or a generic single word
 *        that is the whole name
 *   0.3  a `related` synonym, or a single-word primary phrase inside a longer name (e.g. "tablet"
 *        in "Samsung Galaxy tablet")
 *   max over matching synonyms.
 *
 * Synonym rows are curated, human-reviewed data. Product text is only compared with them.
 */
import type { SynonymRow } from '../repositories/types.js';
import { referenceTokens, tokenEq } from './normalise.js';
import { isGenericSingle, uncovered } from './coverage.js';

export interface SynonymHit {
  code: string;
  score: number;
  reasonCode: 'synonym_exact' | 'synonym_partial' | 'synonym_related';
  detail: string;
  /** curated reviewer notes for this code (surfaced as review_hint) */
  notes: string[];
  /** curated rule hint of the exact synonym that produced score 1.0 (ruling 5), e.g. 'nil_rate_list' */
  ruleHint: string | null;
  /** the curated phrase behind the best score */
  phrase: string;
}

/** Synonym row as the matcher needs it; `rule_hint` is optional until the column exists everywhere. */
export type SynonymInput = Pick<SynonymRow, 'phrase' | 'hsn_code' | 'strength' | 'note' | 'active'> & { rule_hint?: string | null };

interface Prepared {
  phrase: string;
  tokens: string[];
  code: string;
  strength: 'primary' | 'related';
  note: string | null;
  ruleHint: string | null;
  contested: boolean;
}

/**
 * Every phrase token p with tokenEq(t, p), derived from tokenEq's rules (SA-K2-02):
 * p = t; p = t+'s' (len > 3); t = p+'s' (t len > 3); p = t+'es' (len > 4); t = p+'es' (t len > 4).
 */
export function variants(t: string): string[] {
  const v = new Set<string>([t]);
  if (`${t}s`.length > 3) v.add(`${t}s`);
  if (t.length > 3 && t.endsWith('s')) v.add(t.slice(0, -1));
  if (`${t}es`.length > 4) v.add(`${t}es`);
  if (t.length > 4 && t.endsWith('es')) v.add(t.slice(0, -2));
  return [...v];
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (!tokenEq(hay[i + j]!, needle[j]!)) continue outer;
    return true;
  }
  return false;
}

function containsAll(hay: readonly string[], needle: readonly string[]): boolean {
  return needle.length > 0 && needle.every((n) => hay.some((h) => tokenEq(h, n)));
}

export class SynonymMatcher {
  private readonly prepared: Prepared[];
  /** phrase token → indices of prepared phrases containing it (SA-K-05: match is not O(rows)) */
  private readonly byToken = new Map<string, number[]>();

  /** Build once per dataset version (see SynonymCache); match() is then cheap per request. */
  constructor(rows: readonly SynonymInput[]) {
    const active = rows.filter((r) => r.active);
    const codesByPhrase = new Map<string, Set<string>>();
    const prepped = active.map((r) => {
      const tokens = referenceTokens(r.phrase);
      const key = tokens.join(' ');
      const set = codesByPhrase.get(key) ?? new Set<string>();
      set.add(r.hsn_code);
      codesByPhrase.set(key, set);
      return { phrase: r.phrase, tokens, key, code: r.hsn_code, strength: r.strength, note: r.note, ruleHint: r.rule_hint ?? null };
    });
    this.prepared = prepped
      .filter((p) => p.tokens.length > 0)
      .map((p) => ({ phrase: p.phrase, tokens: p.tokens, code: p.code, strength: p.strength, note: p.note, ruleHint: p.ruleHint, contested: (codesByPhrase.get(p.key)?.size ?? 0) > 1 }));
    this.prepared.forEach((p, i) => {
      for (const t of new Set(p.tokens)) {
        const list = this.byToken.get(t) ?? [];
        list.push(i);
        this.byToken.set(t, list);
      }
    });
  }

  get size(): number {
    return this.prepared.length;
  }

  /**
   * @param matchTokens normalised tokens with quantities removed
   * @param ignore extra tokens that do not count against whole-name coverage (known brand tokens)
   */
  match(matchTokens: readonly string[], ignore: ReadonlySet<string> = new Set()): Map<string, SynonymHit> {
    const hay = matchTokens.flatMap((t) => t.split('-')).filter((t) => t.length > 0);
    const out = new Map<string, SynonymHit>();
    const idx = new Set<number>();
    for (const h of hay) for (const v of variants(h)) for (const i of this.byToken.get(v) ?? []) idx.add(i);
    for (const i of [...idx].sort((a, b) => a - b)) {
      const p = this.prepared[i]!;
      const contiguous = containsRun(hay, p.tokens);
      if (!contiguous && !containsAll(hay, p.tokens)) continue;
      let score: number;
      let reasonCode: SynonymHit['reasonCode'];
      let detail: string;
      if (p.strength === 'related') {
        score = 0.3;
        reasonCode = 'synonym_related';
        detail = `Curated related synonym "${p.phrase}" → ${p.code} (scored 0.3)`;
      } else if (contiguous && !p.contested && uncovered(hay, p.tokens, ignore).length === 0 && !isGenericSingle(p.tokens)) {
        score = 1.0;
        reasonCode = 'synonym_exact';
        detail = `Curated synonym "${p.phrase}" → ${p.code}`;
      } else if (contiguous && !p.contested && p.tokens.length === 1 && uncovered(hay, p.tokens, ignore).length > 0) {
        // validator R2: one word inside a longer name says little ("tablet" in "Samsung Galaxy tablet")
        score = 0.3;
        reasonCode = 'synonym_partial';
        detail = `Curated one-word synonym "${p.phrase}" → ${p.code} appears inside a longer name (scored 0.3)`;
      } else if (contiguous && !p.contested) {
        score = 0.7;
        reasonCode = 'synonym_partial';
        detail = isGenericSingle(p.tokens)
          ? `Curated synonym "${p.phrase}" → ${p.code} is a generic word that can mean other products (scored 0.7)`
          : `Curated synonym "${p.phrase}" → ${p.code} found, but the name has other product words (scored 0.7)`;
      } else {
        score = 0.7;
        reasonCode = 'synonym_partial';
        detail = p.contested
          ? `Curated synonym "${p.phrase}" → ${p.code}, but the phrase also maps to other codes (contested synonym, scored 0.7)`
          : `Words of curated synonym "${p.phrase}" → ${p.code} found, but not as one phrase (scored 0.7)`;
      }
      const prev = out.get(p.code);
      const notes = prev?.notes ?? [];
      if (p.note !== null && p.note.length > 0 && !notes.includes(p.note)) notes.push(p.note);
      const ruleHint = score === 1 ? p.ruleHint : null;
      if (prev === undefined || score > prev.score) out.set(p.code, { code: p.code, score, reasonCode, detail, notes, ruleHint, phrase: p.phrase });
      else {
        prev.notes = notes;
        if (score === prev.score && prev.ruleHint === null && ruleHint !== null) prev.ruleHint = ruleHint;
      }
    }
    return out;
  }
}
