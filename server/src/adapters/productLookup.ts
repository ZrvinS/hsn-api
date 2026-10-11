/**
 * Product lookup port: barcode (validated GTIN) → product name / brand / category tags.
 * Everything an adapter returns is untrusted third-party text (AI-10..AI-16): it is sanitised
 * and length-capped here and only ever tokenised by the classifier.
 */
import { sanitiseUntrusted } from '../classify/normalise.js';

export type ProductSource = 'open_food_facts' | 'open_beauty_facts';

export type LookupResult =
  | {
      status: 'found';
      source: ProductSource;
      name: string | null;
      brand: string | null;
      /** taxonomy tags, general → specific, e.g. ["en:snacks", "en:biscuits"] */
      categories: string[];
      /** product page URL built by us from the validated digits, never taken from the response */
      sourceRef: string;
    }
  | { status: 'not_found'; source: ProductSource }
  | { status: 'error'; source: ProductSource; cause: string };

export interface ProductLookup {
  readonly source: ProductSource;
  /** @param code digits only (8, 13 or 14), already check-digit validated */
  /** @param partition caller partition (API key id) for the per-key share of the outbound budget */
  lookup(code: string, partition?: string): Promise<LookupResult>;
}

const TAG_RE = /^[a-z]{2,3}:[\p{L}\p{N}-]{1,100}$/u;

export function cleanText(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitiseUntrusted(v, max);
  return s.length === 0 ? null : s;
}

export function cleanTags(tags: readonly string[] | null | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const t of tags.slice(0, 50)) {
    const s = t.normalize('NFKC').toLowerCase().trim();
    if (TAG_RE.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 30) break;
  }
  return out;
}
