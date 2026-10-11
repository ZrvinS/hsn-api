/**
 * Validator R2: when is a curated synonym "exact" for a product name?
 *
 * Exact (1.0, and so eligible for `high`) only when the curated phrase IS the product name:
 * after the phrase's own tokens are taken out of the name, nothing is left except quantities,
 * units, pack words, dosage-form words and function words. Brand words from a barcode lookup
 * never count (SA-K3-01: that data is crowd-edited); `extraIgnore` is for a caller-supplied brand,
 * which the API does not have today. A phrase merely contained in a longer name is partial.
 *
 *   "22k gold ring"                 + "22k gold ring" → nothing left        → exact
 *   "paracetamol 500 mg tablet"     + "paracetamol"   → [tablet] (form)     → exact (contest rules still apply)
 *   "samsung galaxy tablet 10 inch" + "tablet"        → [samsung, galaxy]   → not exact
 *   "shirt button"                  + "shirt"         → [button]            → not exact
 *   "chocolate biscuit"             + "chocolate"     → [biscuit]           → not exact
 *
 * Single generic words (GENERIC_SINGLE) are never exact even alone: a bare "tablet" may be a
 * computer, a bare "monitor" a BP monitor, a bare "chocolate" white chocolate (1704).
 */
import { tokenEq } from './normalise.js';

/** Words that never change which product (heading) a name refers to. */
export const COVER_IGNORE: ReadonlySet<string> = new Set([
  // function words
  'a', 'an', 'the', 'of', 'for', 'with', 'and', 'in', 'on', 'by', 'x',
  // quantities, units and packs
  'ml', 'mg', 'mcg', 'g', 'gm', 'gms', 'gram', 'grams', 'kg', 'l', 'ltr', 'litre', 'liter', 'iu', 'inch', 'cm', 'mm',
  'pcs', 'pc', 'piece', 'pieces', 'nos', 'pack', 'packet', 'pouch', 'jar', 'tin', 'sachet', 'combo', 'set', 'pair',
  // dosage forms and pharmacopoeia marks
  'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps', 'injection', 'inj', 'syrup', 'suspension',
  'drops', 'ointment', 'vial', 'ampoule', 'ip', 'bp', 'usp',
  // grading words that never move a heading
  'hallmark', 'hallmarked', 'bis', 'premium', 'original', 'new',
]);

/** Single-word phrases that are ambiguous across headings on their own. */
export const GENERIC_SINGLE: ReadonlySet<string> = new Set([
  'tablet', 'tablets', 'capsule', 'capsules', 'syrup', 'injection', 'medicine', 'medicines', 'shirt', 'chocolate',
  'chocolates', 'monitor', 'mobile', 'cycle', 'register', 'mixer', 'mixture', 'needle', 'biscuit', 'biscuits', 'chips',
  'wafers', 'vest', 'cream', 'pant', 'pants', 'dress', 'cake', 'speaker', 'camera', 'shoes', 'footwear', 'jewellery',
  'jewelry', 'pearl', 'pearls', 'ring', 'chain', 'oil', 'stole', 'diary', 'charger', 'adapter',
]);

/**
 * SA-K3-04: a token is a quantity only when it is a number, optionally glued to a unit from this
 * explicit allow-list ("500mg", "64gb", "3x"). "1toy" is not a quantity. Karat tokens ("22k") are
 * produced by the normaliser only for real karat values, so "k" is accepted only for those.
 */
const QUANTITY_UNIT_SUFFIXES: ReadonlySet<string> = new Set([
  'g', 'gm', 'gms', 'kg', 'mg', 'mcg', 'ml', 'l', 'ltr', 'cm', 'mm', 'm', 'in', 'pcs', 'pc', 'x', 'iu',
  'w', 'kw', 'v', 'mah', 'gb', 'tb',
]);
const KARATS: ReadonlySet<number> = new Set([8, 9, 10, 12, 14, 15, 18, 20, 21, 22, 23, 24]);

export function isQuantityLike(t: string): boolean {
  const m = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(t);
  if (m === null) return false;
  const unit = m[2]!;
  if (unit === '') return true;
  if (unit === 'k') return KARATS.has(Number(m[1]));
  return QUANTITY_UNIT_SUFFIXES.has(unit);
}

/**
 * Tokens of `hay` (already hyphen-split) left after removing one occurrence of the contiguous
 * phrase run, ignorable words and `extraIgnore` (e.g. brand tokens).
 */
export function uncovered(hay: readonly string[], phrase: readonly string[], extraIgnore: ReadonlySet<string> = new Set()): string[] {
  let start = -1;
  outer: for (let i = 0; i + phrase.length <= hay.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (!tokenEq(hay[i + j]!, phrase[j]!)) continue outer;
    start = i;
    break;
  }
  const rest = start < 0 ? [...hay] : [...hay.slice(0, start), ...hay.slice(start + phrase.length)];
  return rest.filter((t) => !isQuantityLike(t) && !COVER_IGNORE.has(t) && !extraIgnore.has(t));
}

/** True when a single-token phrase is a generic word that may never be exact. */
export function isGenericSingle(phrase: readonly string[]): boolean {
  return phrase.length === 1 && GENERIC_SINGLE.has(phrase[0]!);
}

