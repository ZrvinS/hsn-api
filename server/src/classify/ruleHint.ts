/**
 * When may a curated synonym's rule hint (e.g. 'nil_rate_list', ruling 00c-5) be passed on?
 * SA-K2-01: only when the caller's name IS that product, not when it merely contains the phrase.
 *
 *  - Any negation word anywhere in the name blocks the hint ("not", "non", "no", "without",
 *    "free" as in "sugar-free", "except", Hindi "बिना" / "नहीं").
 *  - The name's match tokens, with quantities, bare numbers and dosage-form / pack words
 *    removed, must equal the synonym phrase's tokens with the same words removed.
 *    "examplomab injection 10 ml" → [examplomab] = [examplomab] ✓
 *    "examplomab injection pen needles 100 pcs" → [examplomab, needles] ≠ [examplomab] ✗
 */
import { tokenEq } from './normalise.js';

export const NEGATION_WORDS: ReadonlySet<string> = new Set(['not', 'non', 'no', 'without', 'free', 'except', 'excluding', 'nor', 'बिना', 'नहीं', 'रहित']);

/** Dosage-form and pack words that do not change which product a name refers to. */
export const FORM_WORDS: ReadonlySet<string> = new Set([
  'tablet', 'capsule', 'injection', 'inj', 'vial', 'pen', 'syrup', 'suspension', 'drop', 'drops', 'cream', 'ointment', 'gel',
  'solution', 'cartridge', 'ampoule', 'ampule', 'strip', 'bottle', 'pack', 'pcs', 'ml', 'mg', 'mcg', 'g', 'l', 'iu', 'unit',
  'units', 'dose', 'prefilled', 'refill', 'ip', 'bp', 'usp',
]);

const split = (tokens: readonly string[]): string[] => tokens.flatMap((t) => t.split('-')).filter((t) => t.length > 0);
const isForm = (t: string): boolean => [...FORM_WORDS].some((f) => tokenEq(f, t));
const residual = (tokens: readonly string[]): string[] => split(tokens).filter((t) => !/^\d+(?:\.\d+)?$/.test(t) && !isForm(t));

export function hasNegation(allTokens: readonly string[]): boolean {
  return split(allTokens).some((t) => NEGATION_WORDS.has(t));
}

/**
 * @param allTokens every normalised token of the caller's name (negation check)
 * @param matchTokens normalised tokens with quantity pairs removed
 * @param phraseTokens the curated synonym phrase's reference tokens
 */
export function hintAllowed(allTokens: readonly string[], matchTokens: readonly string[], phraseTokens: readonly string[]): boolean {
  if (hasNegation(allTokens)) return false;
  const a = residual(matchTokens);
  const b = residual(phraseTokens);
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((t, i) => tokenEq(t, b[i]!));
}
