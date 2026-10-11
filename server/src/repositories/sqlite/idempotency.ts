import type { IdempotencyRepo, IdempotencyRow } from '../types.js';
import type { Stmts } from './base.js';

const COLS = 'key_id, idem_key, route, request_sha256, status_code, response_json, created_at';

export class SqliteIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly q: Stmts) {}
  get(keyId: string, idemKey: string, notBefore: string): IdempotencyRow | null {
    return this.q.get<IdempotencyRow>(`SELECT ${COLS} FROM idempotency_keys WHERE key_id = ? AND idem_key = ? AND created_at >= ?`, keyId, idemKey, notBefore);
  }
  put(r: IdempotencyRow): void {
    // an expired row with the same key is replaced
    this.q.run(
      `INSERT INTO idempotency_keys(${COLS}) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(key_id, idem_key) DO UPDATE SET route = excluded.route, request_sha256 = excluded.request_sha256,
         status_code = excluded.status_code, response_json = excluded.response_json, created_at = excluded.created_at`,
      r.key_id, r.idem_key, r.route, r.request_sha256, r.status_code, r.response_json, r.created_at,
    );
  }
  purgeBefore(cutoff: string): number {
    return this.q.run(`DELETE FROM idempotency_keys WHERE created_at < ?`, cutoff).changes;
  }
}
