/**
 * Imitation / plating qualifier (classifier rules-fts-2.1+).
 *
 * Chapter 71 distinguishes articles of precious metal (7113, 7114) from imitation jewellery
 * (7117): jewellery of base metal that is only plated with precious metal, or that imitates
 * precious stones, is imitation jewellery. Names such as "gold plated brass bangles", "one gram
 * gold chain", "american diamond earrings" and "oxidised german silver jhumka" contain the words
 * "gold", "silver" or "diamond", so the text signals point at precious headings. When the name
 * carries an imitation qualifier, this rule:
 *   - lowers the text evidence for every other Chapter 71 heading (x0.4) and never lets it be high;
 *   - moves the jewellery evidence of 7113 to 7117 (synonym capped at 0.7, so at most medium);
 *   - adds a review hint saying why.
 * It only ever lowers confidence for precious headings and never produces a rate.
 *
 * Gold-plated *silver* (e.g. "gold plated 925 silver ring") is still silver jewellery, so a
 * plating word followed by a precious substrate, or "sterling" / "925", turns the rule off.
 */
import type { SignalInput } from './fusion.js';

const SINGLE = new Set(['plated', 'plating', 'imitation', 'artificial', 'fake', 'oxidised', 'oxidized', 'alloy', 'brass', 'fashion']);
const PAIRS: readonly [string, string][] = [['german', 'silver'], ['american', 'diamond'], ['one', 'gram'], ['1', 'gram'], ['1', 'g'], ['one', 'g']];
const PRECIOUS_SUBSTRATE = new Set(['silver', 'gold', 'platinum']);

export const IMITATION_TARGET = '7117';
export const IMITATION_HINT =
  'The name says plated / imitation / alloy (or similar). Jewellery of base metal that is only plated with precious metal, or with imitation stones, is imitation jewellery (7117), not 7113. Check the metal.';

/** @param tokens all normalised tokens of the caller's name */
export function imitationQualified(tokens: readonly string[]): boolean {
  const t = tokens.flatMap((x) => x.split('-')).filter((x) => x.length > 0);
  if (t.includes('sterling') || t.includes('925')) return false;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!;
    if ((w === 'plated' || w === 'plating') && PRECIOUS_SUBSTRATE.has(t[i + 1] ?? '')) return false;
  }
  if (t.some((w) => SINGLE.has(w))) return true;
  return PAIRS.some(([a, b]) => t.some((w, i) => w === a && t[i + 1] === b));
}

const isOtherCh71 = (code: string): boolean => code.startsWith('71') && code.length >= 4 && !code.startsWith('7117') && !code.startsWith('7118');

/** Mutates nothing: returns adjusted inputs. `inputs` must already include 7117 when it is in the master. */
export function applyImitationQualifier(inputs: readonly SignalInput[]): SignalInput[] {
  const jewellery = inputs.filter((i) => i.code.startsWith('7113'));
  const bestSyn = Math.max(0, ...jewellery.map((i) => i.syn));
  const bestFts = Math.max(0, ...jewellery.map((i) => i.fts));
  return inputs.map((i) => {
    const extra = [...(i.extraReasons ?? []), { code: 'review_hint' as const, detail: IMITATION_HINT }];
    if (isOtherCh71(i.code)) return { ...i, syn: i.syn * 0.4, fts: i.fts * 0.4, highEligible: false, extraReasons: extra };
    if (i.code === IMITATION_TARGET) {
      const syn = Math.max(i.syn, Math.min(0.7, bestSyn));
      const fts = Math.max(i.fts, bestFts);
      return {
        ...i,
        syn,
        fts,
        highEligible: false,
        synDetail: syn > i.syn ? { code: 'synonym_partial' as const, detail: `Jewellery words in the name, with an imitation qualifier (scored ${syn})` } : i.synDetail,
        ftsDetail: fts > i.fts ? 'Jewellery description words, moved here by the imitation qualifier' : i.ftsDetail,
        extraReasons: extra,
      };
    }
    return i;
  });
}
