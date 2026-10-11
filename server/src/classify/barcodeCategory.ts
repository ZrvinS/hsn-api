/**
 * Barcode category signal → s_bar (architecture.md §5.3). Available only when the barcode
 * resolved to a product whose category tag is in the curated `category_map`.
 *   1.0 candidate starts with the mapped prefix (same heading or deeper)
 *   0.5 same chapter only
 *   0   otherwise
 */
import type { SynonymRepo } from '../repositories/types.js';

export interface BarcodeCategory {
  source: string;
  category: string;
  hsnPrefix: string;
}

const TAG_RE = /^[a-z]{2,3}:[\p{L}\p{N}-]{1,100}$/u;
const MAX_TAGS = 30;

/**
 * Pick the most specific mapped tag. Product databases list tags general → specific, so the
 * last tag that has a mapping wins. Tags are untrusted: anything not matching `xx:slug` is ignored.
 */
export function resolveCategory(repo: Pick<SynonymRepo, 'categoryPrefix'>, source: string, tags: readonly string[]): BarcodeCategory | null {
  const clean = tags
    .slice(0, MAX_TAGS)
    .map((t) => t.normalize('NFKC').toLowerCase().trim())
    .filter((t) => TAG_RE.test(t));
  let found: BarcodeCategory | null = null;
  for (const tag of clean) {
    const prefix = repo.categoryPrefix(source, tag);
    if (prefix !== null && /^\d{2,8}$/.test(prefix)) found = { source, category: tag, hsnPrefix: prefix };
  }
  return found;
}

export function barcodeScore(cat: BarcodeCategory, code: string): { score: number; detail?: string } {
  const level = cat.hsnPrefix.length === 2 ? 'chapter' : cat.hsnPrefix.length === 4 ? 'heading' : 'code';
  if (code.startsWith(cat.hsnPrefix)) return { score: 1, detail: `Product category "${cat.category}" maps to ${level} ${cat.hsnPrefix}` };
  if (code.slice(0, 2) === cat.hsnPrefix.slice(0, 2)) return { score: 0.5, detail: `Product category "${cat.category}" maps to ${level} ${cat.hsnPrefix} (same chapter only)` };
  return { score: 0 };
}
