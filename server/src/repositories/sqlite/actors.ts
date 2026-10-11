import type { AdminActorRepo, AdminActorRow } from '../types.js';
import type { Stmts } from './base.js';

const COLS = 'id, handle, display_name, created_at, created_via, grant_proposal_id, disabled_at';

export class SqliteAdminActorRepo implements AdminActorRepo {
  constructor(private readonly q: Stmts) {}
  insert(a: AdminActorRow): void {
    this.q.run(`INSERT INTO admin_actors(${COLS}) VALUES (?,?,?,?,?,?,?)`, a.id, a.handle, a.display_name, a.created_at, a.created_via, a.grant_proposal_id, a.disabled_at);
  }
  get(id: string): AdminActorRow | null {
    return this.q.get<AdminActorRow>(`SELECT ${COLS} FROM admin_actors WHERE id = ?`, id);
  }
  byHandle(handle: string): AdminActorRow | null {
    return this.q.get<AdminActorRow>(`SELECT ${COLS} FROM admin_actors WHERE handle = ?`, handle);
  }
  count(): number {
    return this.q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_actors`)?.n ?? 0;
  }
  activeCount(): number {
    return this.q.get<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_actors WHERE disabled_at IS NULL`)?.n ?? 0;
  }
  all(): AdminActorRow[] {
    return this.q.all<AdminActorRow>(`SELECT ${COLS} FROM admin_actors ORDER BY created_at, id`);
  }
  disable(id: string, at: string): boolean {
    return this.q.run(`UPDATE admin_actors SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`, at, id).changes > 0;
  }
}
