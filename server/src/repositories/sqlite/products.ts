import type { ProductRepo, ProductRow } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<ProductRow, 'found'> & { found: number };
const COLS = 'gtin, name, brand, category, source, source_ref, found, fetched_at, expires_at';

export const DEFAULT_PRODUCT_CACHE_MAX_ROWS = 50_000;

export class SqliteProductRepo implements ProductRepo {
  constructor(
    private readonly q: Stmts,
    /** ruling 30: bound on cached rows; the oldest fetched_at rows are evicted first */
    private readonly maxRows = DEFAULT_PRODUCT_CACHE_MAX_ROWS,
  ) {}
  get(gtin14: string): ProductRow | null {
    const r = this.q.get<Raw>(`SELECT ${COLS} FROM products WHERE gtin = ?`, gtin14);
    return r ? { ...r, found: r.found === 1 } : null;
  }
  upsert(p: ProductRow): void {
    this.q.run(
      `INSERT INTO products(${COLS}) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(gtin) DO UPDATE SET name = excluded.name, brand = excluded.brand, category = excluded.category,
         source = excluded.source, source_ref = excluded.source_ref, found = excluded.found,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      p.gtin, p.name, p.brand, p.category, p.source, p.source_ref, p.found ? 1 : 0, p.fetched_at, p.expires_at,
    );
    this.evict(p.gtin);
  }
  /** Oldest-first eviction down to maxRows; never evicts the row just written. Returns rows removed. */
  evict(keep: string | null = null): number {
    const n = this.q.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n ?? 0;
    const excess = n - this.maxRows;
    if (excess <= 0) return 0;
    return this.q.run(
      `DELETE FROM products WHERE gtin IN (
         SELECT gtin FROM products WHERE gtin IS NOT ? ORDER BY fetched_at ASC, gtin ASC LIMIT ?)`,
      keep, excess,
    ).changes;
  }
  count(): number {
    return this.q.get<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n ?? 0;
  }
  delete(gtin14: string): boolean {
    return this.q.run('DELETE FROM products WHERE gtin = ?', gtin14).changes > 0;
  }
}
