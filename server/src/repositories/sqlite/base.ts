import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';

/** Prepared-statement cache per connection. All SQL is static text; values are always bound. */
export class Stmts {
  private readonly cache = new Map<string, StatementSync>();
  constructor(readonly db: DatabaseSync) {}
  s(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | null {
    const r = this.s(sql).get(...params);
    return (r as T | undefined) ?? null;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.s(sql).all(...params) as unknown as T[];
  }
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.s(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
}
