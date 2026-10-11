import type { PendingWatchAction, WatchedNotificationRepo, WatchedNotificationRow, WatchedState, WatcherRunRepo, WatcherRunRow } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<WatchedNotificationRow, 'affected_prefixes' | 'expedite' | 'pending_action'> & { affected_prefixes: string; expedite: number; pending_action: string | null };
const COLS_INSERT =
  'id, notification_ref, source_url, affected_prefixes, effective_from, detected_at, state, expedite, note, created_by, resolved_at, resolved_by, source, notification_key, title, notification_date';
const COLS = `${COLS_INSERT}, pending_action`;

function toRow(r: Raw | null): WatchedNotificationRow | null {
  if (!r) return null;
  let prefixes: string[] = [];
  try {
    const p: unknown = JSON.parse(r.affected_prefixes);
    if (Array.isArray(p)) prefixes = p.filter((x): x is string => typeof x === 'string');
  } catch {
    prefixes = [];
  }
  let pending: PendingWatchAction | null = null;
  if (r.pending_action !== null) {
    try {
      pending = JSON.parse(r.pending_action) as PendingWatchAction;
    } catch {
      pending = null;
    }
  }
  return { ...r, affected_prefixes: prefixes, expedite: r.expedite === 1, pending_action: pending };
}

export class SqliteWatchedRepo implements WatchedNotificationRepo {
  constructor(private readonly q: Stmts) {}
  insert(w: WatchedNotificationRow): void {
    this.q.run(
      `INSERT INTO watched_notifications(${COLS_INSERT}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      w.id, w.notification_ref, w.source_url, JSON.stringify(w.affected_prefixes), w.effective_from, w.detected_at, w.state,
      w.expedite ? 1 : 0, w.note, w.created_by, w.resolved_at, w.resolved_by, w.source, w.notification_key, w.title, w.notification_date,
    );
  }
  get(id: string): WatchedNotificationRow | null {
    return toRow(this.q.get<Raw>(`SELECT ${COLS} FROM watched_notifications WHERE id = ?`, id));
  }
  byKey(key: string): WatchedNotificationRow | null {
    return toRow(this.q.get<Raw>(`SELECT ${COLS} FROM watched_notifications WHERE notification_key = ?`, key));
  }
  triage(id: string, prefixes: readonly string[], effectiveFrom: string | null): boolean {
    return (
      this.q.run(
        `UPDATE watched_notifications SET affected_prefixes = ?, effective_from = COALESCE(?, effective_from), pending_action = NULL WHERE id = ? AND state = 'detected'`,
        JSON.stringify(prefixes), effectiveFrom, id,
      ).changes > 0
    );
  }
  setPending(id: string, action: PendingWatchAction | null): boolean {
    return (
      this.q.run(`UPDATE watched_notifications SET pending_action = ? WHERE id = ? AND state = 'detected'`, action === null ? null : JSON.stringify(action), id)
        .changes > 0
    );
  }
  pending(): WatchedNotificationRow[] {
    return this.q.all<Raw>(`SELECT ${COLS} FROM watched_notifications WHERE state = 'detected' ORDER BY detected_at, id LIMIT 200`).map((r) => toRow(r)!);
  }
  resolve(id: string, state: Exclude<WatchedState, 'detected'>, at: string, by: string): boolean {
    return this.q.run(`UPDATE watched_notifications SET state = ?, resolved_at = ?, resolved_by = ?, pending_action = NULL WHERE id = ? AND state = 'detected'`, state, at, by, id).changes > 0;
  }
  pendingTag(): string {
    const r = this.q.get<{ n: number; m: string | null }>(`SELECT COUNT(*) AS n, MAX(id) AS m FROM watched_notifications WHERE state = 'detected'`);
    return `${r?.n ?? 0}:${r?.m ?? ''}`;
  }
}

type RunRaw = Omit<WatcherRunRow, 'details'> & { details_json: string };
const COLS_RUN = 'id, source, started_at, finished_at, status, items_seen, items_new, error, details_json';

function toRun(r: RunRaw | null): WatcherRunRow | null {
  if (!r) return null;
  let details: Record<string, unknown> = {};
  try {
    const d: unknown = JSON.parse(r.details_json);
    if (d !== null && typeof d === 'object' && !Array.isArray(d)) details = d as Record<string, unknown>;
  } catch {
    details = {};
  }
  const { details_json: _ignored, ...rest } = r;
  return { ...rest, details };
}

/** Append-only log of watcher runs (freshness alert, 00b ruling 27). */
export class SqliteWatcherRunRepo implements WatcherRunRepo {
  constructor(private readonly q: Stmts) {}
  insert(r: Omit<WatcherRunRow, 'id'>): number {
    return this.q.run(
      `INSERT INTO watcher_runs(source, started_at, finished_at, status, items_seen, items_new, error, details_json) VALUES (?,?,?,?,?,?,?,?)`,
      r.source, r.started_at, r.finished_at, r.status, r.items_seen, r.items_new, r.error, JSON.stringify(r.details),
    ).lastInsertRowid;
  }
  last(source: 'cbic'): WatcherRunRow | null {
    return toRun(this.q.get<RunRaw>(`SELECT ${COLS_RUN} FROM watcher_runs WHERE source = ? ORDER BY id DESC LIMIT 1`, source));
  }
  lastSuccess(source: 'cbic'): WatcherRunRow | null {
    return toRun(this.q.get<RunRaw>(`SELECT ${COLS_RUN} FROM watcher_runs WHERE source = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`, source));
  }
  recent(source: 'cbic', limit: number): WatcherRunRow[] {
    return this.q
      .all<RunRaw>(`SELECT ${COLS_RUN} FROM watcher_runs WHERE source = ? ORDER BY id DESC LIMIT ?`, source, Math.max(1, Math.min(100, Math.trunc(limit))))
      .map((r) => toRun(r)!);
  }
}
