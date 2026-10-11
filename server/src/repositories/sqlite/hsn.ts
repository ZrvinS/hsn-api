import type { HsnRepo, HsnRow, HsnSearchHit, HsnSearchOptions } from '../types.js';
import { buildFtsQuery, buildFtsQueryFromTokens, ftsTokens } from '../../lib/fts.js';
import type { Stmts } from './base.js';

const COLS = 'code, level, parent, chapter, type, description, keywords, added_in_version';

export class SqliteHsnRepo implements HsnRepo {
  constructor(private readonly q: Stmts) {}

  get(code: string): HsnRow | null {
    return this.q.get<HsnRow>(`SELECT ${COLS} FROM hsn_codes WHERE code = ?`, code);
  }

  getMany(codes: readonly string[]): HsnRow[] {
    if (codes.length === 0) return [];
    // json_each keeps the SQL static while binding an arbitrary list
    return this.q.all<HsnRow>(`SELECT ${COLS} FROM hsn_codes WHERE code IN (SELECT value FROM json_each(?)) ORDER BY code`, JSON.stringify(codes));
  }

  ancestors(code: string): HsnRow[] {
    const out: HsnRow[] = [];
    let cur = this.get(code);
    let guard = 0;
    while (cur?.parent && guard++ < 5) {
      const p = this.get(cur.parent);
      if (!p) break;
      out.unshift(p);
      cur = p;
    }
    return out;
  }

  private runMatch(match: string, opts: HsnSearchOptions): HsnSearchHit[] {
    const levels = opts.levels && opts.levels.length > 0 ? JSON.stringify(opts.levels) : null;
    return this.q.all<HsnSearchHit>(
      `SELECT h.code AS code, h.level AS level, h.type AS type, h.chapter AS chapter,
              h.description AS description, h.keywords AS keywords,
              bm25(hsn_fts, 0.0, 1.0, 0.5) AS bm25,
              highlight(hsn_fts, 1, '[', ']') AS highlight
         FROM hsn_fts JOIN hsn_codes h ON h.rowid = hsn_fts.rowid
        WHERE hsn_fts MATCH ?
          AND (? IS NULL OR h.type = ?)
          AND (? IS NULL OR h.level IN (SELECT value FROM json_each(?)))
        ORDER BY bm25 ASC, h.code ASC
        LIMIT ?`,
      match,
      opts.type ?? null,
      opts.type ?? null,
      levels,
      levels,
      Math.max(1, Math.min(100, Math.trunc(opts.limit))),
    );
  }

  search(text: string, opts: HsnSearchOptions): { hits: HsnSearchHit[]; mode: 'and' | 'or' | 'none' } {
    const andQ = buildFtsQuery(text, 'and');
    if (andQ === null) return { hits: [], mode: 'none' };
    const hits = this.runMatch(andQ, opts);
    if (hits.length > 0 || ftsTokens(text).length < 2) return { hits, mode: 'and' };
    const orQ = buildFtsQuery(text, 'or');
    return { hits: orQ === null ? [] : this.runMatch(orQ, opts), mode: 'or' };
  }

  searchTokens(tokens: readonly string[], mode: 'and' | 'or', opts: HsnSearchOptions): HsnSearchHit[] {
    const m = buildFtsQueryFromTokens(tokens, mode);
    return m === null ? [] : this.runMatch(m, opts);
  }

  insert(r: HsnRow): void {
    this.q.run(
      `INSERT INTO hsn_codes(${COLS}) VALUES (?,?,?,?,?,?,?,?)`,
      r.code, r.level, r.parent, r.chapter, r.type, r.description, r.keywords, r.added_in_version,
    );
  }

  insertApproved(r: HsnRow, proposalId: string): void {
    this.q.run(
      `INSERT INTO hsn_codes(${COLS}, added_by_proposal) VALUES (?,?,?,?,?,?,?,?,?)`,
      r.code, r.level, r.parent, r.chapter, r.type, r.description, r.keywords, r.added_in_version, proposalId,
    );
  }

  updateDescription(code: string, description: string, keywords: string, proposalId: string): void {
    this.q.run(`UPDATE hsn_codes SET description = ?, keywords = ?, changed_by_proposal = ? WHERE code = ?`, description, keywords, proposalId, code);
  }

  counts(): { goods: number; services: number } {
    const r = this.q.get<{ goods: number; services: number }>(
      `SELECT COALESCE(SUM(type = 'goods'),0) AS goods, COALESCE(SUM(type = 'service'),0) AS services FROM hsn_codes`,
    );
    return r ?? { goods: 0, services: 0 };
  }
}
