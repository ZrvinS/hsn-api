import type { SynonymInsert, SynonymRepo, SynonymRow } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<SynonymRow, 'active'> & { active: number };
const COLS = 'id, phrase, hsn_code, strength, note, rule_hint, created_by, created_at, active';
const toRow = (r: Raw): SynonymRow => ({ ...r, active: r.active === 1 });

export class SqliteSynonymRepo implements SynonymRepo {
  constructor(private readonly q: Stmts) {}
  byPhrases(phrases: readonly string[]): SynonymRow[] {
    if (phrases.length === 0) return [];
    return this.q
      .all<Raw>(`SELECT ${COLS} FROM synonyms WHERE active = 1 AND phrase IN (SELECT value FROM json_each(?)) ORDER BY id`, JSON.stringify(phrases))
      .map(toRow);
  }
  allActive(): SynonymRow[] {
    return this.q.all<Raw>(`SELECT ${COLS} FROM synonyms WHERE active = 1 ORDER BY id`).map(toRow);
  }
  getById(id: number): SynonymRow | null {
    const r = this.q.get<Raw>(`SELECT ${COLS} FROM synonyms WHERE id = ?`, id);
    return r ? toRow(r) : null;
  }
  insert(s: SynonymInsert): void {
    this.q.run(
      `INSERT INTO synonyms(phrase, hsn_code, strength, note, rule_hint, created_by, created_at, active, added_by_proposal) VALUES (?,?,?,?,?,?,?,?,?)`,
      s.phrase, s.hsn_code, s.strength, s.note, s.rule_hint ?? null, s.created_by, s.created_at, s.active ? 1 : 0, s.added_by_proposal ?? null,
    );
  }
  deactivate(id: number, proposalId: string): boolean {
    return this.q.run(`UPDATE synonyms SET active = 0, deactivated_by_proposal = ? WHERE id = ? AND active = 1`, proposalId, id).changes > 0;
  }
  chaptersForKeywords(keywords: readonly string[]): { keyword: string; chapter: string }[] {
    if (keywords.length === 0) return [];
    return this.q.all<{ keyword: string; chapter: string }>(
      `SELECT keyword, chapter FROM chapter_keywords WHERE active = 1 AND keyword IN (SELECT value FROM json_each(?)) ORDER BY keyword, chapter`,
      JSON.stringify(keywords),
    );
  }
  insertChapterKeyword(keyword: string, chapter: string, addedByProposal: string | null = null): void {
    this.q.run(`INSERT INTO chapter_keywords(keyword, chapter, added_by_proposal) VALUES (?, ?, ?)`, keyword, chapter, addedByProposal);
  }
  getChapterKeyword(id: number) {
    const r = this.q.get<{ id: number; keyword: string; chapter: string; active: number }>(`SELECT id, keyword, chapter, active FROM chapter_keywords WHERE id = ?`, id);
    return r ? { ...r, active: r.active === 1 } : null;
  }
  deactivateChapterKeyword(id: number, proposalId: string): boolean {
    return this.q.run(`UPDATE chapter_keywords SET active = 0, deactivated_by_proposal = ? WHERE id = ? AND active = 1`, proposalId, id).changes > 0;
  }
  categoryPrefix(source: string, category: string): string | null {
    return this.q.get<{ p: string }>(`SELECT hsn_prefix AS p FROM category_map WHERE active = 1 AND source = ? AND category = ?`, source, category)?.p ?? null;
  }
  insertCategory(source: string, category: string, hsnPrefix: string, addedByProposal: string | null = null): void {
    this.q.run(`INSERT INTO category_map(source, category, hsn_prefix, added_by_proposal) VALUES (?,?,?,?)`, source, category, hsnPrefix, addedByProposal);
  }
  getCategory(id: number) {
    const r = this.q.get<{ id: number; source: string; category: string; hsn_prefix: string; active: number }>(
      `SELECT id, source, category, hsn_prefix, active FROM category_map WHERE id = ?`, id,
    );
    return r ? { ...r, active: r.active === 1 } : null;
  }
  deactivateCategory(id: number, proposalId: string): boolean {
    return this.q.run(`UPDATE category_map SET active = 0, deactivated_by_proposal = ? WHERE id = ? AND active = 1`, proposalId, id).changes > 0;
  }
}
