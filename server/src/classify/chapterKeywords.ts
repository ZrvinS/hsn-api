/**
 * Chapter keyword signal → s_chap (architecture.md §5.3): 1 if any token (including unit
 * tokens such as "mg") maps via the curated `chapter_keywords` table to the candidate's chapter.
 */
import type { SynonymRepo } from '../repositories/types.js';

export interface ChapterSignals {
  /** chapter → keywords that pointed at it */
  byChapter: Map<string, string[]>;
}

export function chapterSignals(repo: Pick<SynonymRepo, 'chaptersForKeywords'>, tokens: readonly string[]): ChapterSignals {
  const uniq = [...new Set(tokens.filter((t) => t.length > 0 && t.length <= 64))].slice(0, 40);
  const byChapter = new Map<string, string[]>();
  if (uniq.length === 0) return { byChapter };
  // simple plural fold so "biscuit" also finds the curated keyword "biscuits" and vice versa
  const variants = new Set<string>(uniq);
  for (const t of uniq) {
    if (t.length > 3) variants.add(`${t}s`);
    if (t.length > 4 && t.endsWith('s')) variants.add(t.slice(0, -1));
  }
  for (const { keyword, chapter } of repo.chaptersForKeywords([...variants].slice(0, 120))) {
    const list = byChapter.get(chapter) ?? [];
    if (!list.includes(keyword)) list.push(keyword);
    byChapter.set(chapter, list);
  }
  for (const list of byChapter.values()) list.sort();
  return { byChapter };
}

export function chapterScore(sig: ChapterSignals, code: string): { score: number; detail?: string } {
  const ch = code.slice(0, 2);
  const kws = sig.byChapter.get(ch);
  if (kws === undefined || kws.length === 0) return { score: 0 };
  const quoted = kws.map((k) => `"${k}"`).join(', ');
  return { score: 1, detail: `${kws.length > 1 ? 'Keywords' : 'Keyword'} ${quoted} ${kws.length > 1 ? 'indicate' : 'indicates'} chapter ${ch}` };
}
