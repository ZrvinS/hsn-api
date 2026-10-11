import type { Scope } from '../../lib/apiKey.js';
import { canonicalScopes } from '../../lib/apiKey.js';
import type { ApiKeyRepo, ApiKeyRow } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<ApiKeyRow, 'scopes' | 'llm_opt_out' | 'actor_disabled'> & { scopes: string; llm_opt_out: number; actor_disabled: number };
const SELECT = `SELECT k.id, k.prefix, k.key_hash, k.scopes, k.tenant, k.actor_id, a.handle AS actor,
  CASE WHEN a.disabled_at IS NOT NULL THEN 1 ELSE 0 END AS actor_disabled, k.admin_grant_id, k.pepper_id, k.label,
  k.rate_limit_per_min, k.daily_quota, k.llm_opt_out, k.created_at, k.expires_at, k.revoked_at, k.last_used_at
  FROM api_keys k LEFT JOIN admin_actors a ON a.id = k.actor_id`;

/** Parse stored scopes strictly: anything unexpected → null (row refused, SA-D-10). */
function parseScopes(s: string): Scope[] | null {
  try {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((x) => x === 'read' || x === 'classify' || x === 'admin')) return null;
    return parsed as Scope[];
  } catch {
    return null;
  }
}

function toRow(r: Raw | null): ApiKeyRow | null {
  if (!r) return null;
  const scopes = parseScopes(r.scopes);
  return { ...r, scopes: scopes ?? [], llm_opt_out: r.llm_opt_out === 1, actor_disabled: r.actor_disabled === 1 };
}

export class SqliteApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly q: Stmts) {}
  insert(k: Omit<ApiKeyRow, 'actor' | 'actor_disabled'>): void {
    this.q.run(
      `INSERT INTO api_keys(id, prefix, key_hash, scopes, tenant, actor_id, admin_grant_id, pepper_id, label, rate_limit_per_min,
         daily_quota, llm_opt_out, created_at, expires_at, revoked_at, last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      k.id, k.prefix, k.key_hash, canonicalScopes(k.scopes), k.tenant, k.actor_id, k.admin_grant_id, k.pepper_id, k.label, k.rate_limit_per_min,
      k.daily_quota, k.llm_opt_out ? 1 : 0, k.created_at, k.expires_at, k.revoked_at, k.last_used_at,
    );
  }
  getByPrefix(prefix: string): ApiKeyRow | null {
    return toRow(this.q.get<Raw>(`${SELECT} WHERE k.prefix = ?`, prefix));
  }
  getById(id: string): ApiKeyRow | null {
    return toRow(this.q.get<Raw>(`${SELECT} WHERE k.id = ?`, id));
  }
  revoke(id: string, at: string): boolean {
    return this.q.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, at, id).changes > 0;
  }
  touchLastUsed(id: string, at: string): void {
    this.q.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, at, id);
  }
}
