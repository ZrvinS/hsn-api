import type { AuditEntry, AuditRepo } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<AuditEntry, 'details'> & { details_json: string };
const COLS = 'id, at, actor, key_prefix, action, entity_type, entity_id, details_json, prev_hash, hash';

function toEntry(r: Raw): AuditEntry {
  const { details_json, ...rest } = r;
  let details: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(details_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) details = p as Record<string, unknown>;
  } catch {
    details = {};
  }
  return { ...rest, details };
}

export class SqliteAuditRepo implements AuditRepo {
  constructor(private readonly q: Stmts) {}
  head(): { id: number; hash: string } | null {
    return this.q.get<{ id: number; hash: string }>(`SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1`);
  }
  insert(e: AuditEntry): void {
    this.q.run(
      `INSERT INTO audit_log(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      e.id, e.at, e.actor, e.key_prefix, e.action, e.entity_type, e.entity_id, JSON.stringify(e.details), e.prev_hash, e.hash,
    );
  }
  list(afterId: number, limit: number, entityType?: string): AuditEntry[] {
    return this.q
      .all<Raw>(
        `SELECT ${COLS} FROM audit_log WHERE id > ? AND (? IS NULL OR entity_type = ?) ORDER BY id ASC LIMIT ?`,
        afterId, entityType ?? null, entityType ?? null, limit,
      )
      .map(toEntry);
  }
  hashOf(id: number): string | null {
    return this.q.get<{ hash: string }>(`SELECT hash FROM audit_log WHERE id = ?`, id)?.hash ?? null;
  }
  hasAction(action: string): boolean {
    return this.q.get<{ x: number }>(`SELECT 1 AS x FROM audit_log WHERE action = ? LIMIT 1`, action) !== null;
  }
  all(): AuditEntry[] {
    return this.q.all<Raw>(`SELECT ${COLS} FROM audit_log ORDER BY id ASC`).map(toEntry);
  }
}
