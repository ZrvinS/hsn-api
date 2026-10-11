/**
 * Accessory / packaging qualifier (classifier rules-fts-2.3).
 *
 * Retail names often put the article an accessory belongs to before the accessory itself:
 * "mobile phone stand", "phone case", "tv wall mount", "laptop sleeve", "watch strap". The text
 * signals then point at the main article (8517, 8528, 8471, 9102), but the product is the
 * accessory, which is classified on its own (by material or as a part), not as the article.
 *
 * Rule: when the name has an accessory word that is NOT part of a candidate's own evidence (its
 * curated synonym phrase or the description/keyword words FTS matched) and that word follows the
 * evidence ("phone stand") or is linked to it by "for" ("stand for mobile phone"), the candidate is
 * capped at low (ACCESSORY_CAP) with a review hint. "phone charger" keeps 8504 because "charger" is
 * 8504's own evidence. The rule only lowers scores; it never adds a candidate or a rate.
 * ("sleeve" is deliberately not an accessory word: "half sleeve" / "full sleeve" describe garments
 * far more often than laptop sleeves; the eval caught that.)
 *
 * Packaging words ("gift box", "hamper", "container") are different: a box of dry fruits is
 * classified by its contents, so the contents' candidates are kept (not capped) and get a review
 * hint saying so; the packaging itself is never proposed from the name.
 */
import type { SignalInput } from './fusion.js';
import { tokenEq } from './normalise.js';

export const ACCESSORY_CAP = 0.45;

export const ACCESSORY_WORDS: ReadonlySet<string> = new Set([
  'stand', 'holder', 'cover', 'case', 'pouch', 'charger', 'cable', 'strap', 'mount', 'guard', 'protector', 'skin',
  'clip', 'hanger', 'rack', 'organiser', 'organizer', 'tripod', 'bracket', 'dock', 'cradle', 'remote',
]);
const ACCESSORY_PAIRS: readonly [string, string][] = [['screen', 'guard'], ['tempered', 'glass'], ['back', 'cover']];
export const PACKAGING_WORDS: ReadonlySet<string> = new Set(['box', 'hamper', 'packaging', 'container', 'basket']);

export const ACCESSORY_HINT = (word: string): string =>
  `The name describes a "${word}" for this article, not the article itself. Accessories and parts are classified on their own (by material or as parts), so this heading is capped at low. Check what is actually sold.`;
export const PACKAGING_HINT = (word: string): string =>
  `The name includes packaging ("${word}"). Goods packed for sale are classified by their contents unless the packaging itself is the product (e.g. an empty gift box). Confirm which is sold.`;

const split = (tokens: readonly string[]): string[] => tokens.flatMap((t) => t.split('-')).filter((t) => t.length > 0);

/** Positions of accessory words (pairs count at the position of their second word). */
function accessoryPositions(t: readonly string[]): { word: string; pos: number }[] {
  const out: { word: string; pos: number }[] = [];
  t.forEach((w, i) => {
    if (ACCESSORY_WORDS.has(w)) out.push({ word: w, pos: i });
  });
  for (const [a, b] of ACCESSORY_PAIRS) t.forEach((w, i) => {
    if (w === a && t[i + 1] === b) out.push({ word: `${a} ${b}`, pos: i + 1 });
  });
  return out;
}

/**
 * @param tokens all normalised tokens of the name
 * @param evidence per candidate code: the name words that produced its text evidence
 */
export function applyAccessoryQualifier(tokens: readonly string[], inputs: readonly SignalInput[], evidence: ReadonlyMap<string, readonly string[]>): SignalInput[] {
  const t = split(tokens);
  const acc = accessoryPositions(t);
  const pack = t.map((w, i) => ({ w, i })).filter((x) => PACKAGING_WORDS.has(x.w));
  if (acc.length === 0 && pack.length === 0) return [...inputs];
  const forAt = t.indexOf('for');
  return inputs.map((inp) => {
    const ev = evidence.get(inp.code) ?? [];
    if (ev.length === 0) return inp;
    const evPos = t.map((w, i) => ({ w, i })).filter((x) => ev.some((e) => tokenEq(e, x.w))).map((x) => x.i);
    if (evPos.length === 0) return inp;
    const own = (w: string): boolean => w.split(' ').some((p) => ev.some((e) => tokenEq(e, p)));
    const hit = acc.find((a) => !own(a.word) && (a.pos > Math.min(...evPos) || (forAt >= 0 && a.pos < forAt && evPos.some((p) => p > forAt))));
    if (hit !== undefined) {
      return { ...inp, highEligible: false, capAt: Math.min(inp.capAt ?? 1, ACCESSORY_CAP), extraReasons: [...(inp.extraReasons ?? []), { code: 'review_hint' as const, detail: ACCESSORY_HINT(hit.word) }] };
    }
    const p = pack.find((x) => !ev.some((e) => tokenEq(e, x.w)) && x.i > Math.min(...evPos));
    if (p !== undefined) {
      return { ...inp, highEligible: false, extraReasons: [...(inp.extraReasons ?? []), { code: 'review_hint' as const, detail: PACKAGING_HINT(p.w) }] };
    }
    return inp;
  });
}
