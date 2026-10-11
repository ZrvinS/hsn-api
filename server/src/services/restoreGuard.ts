/**
 * Automatic restore detection (SA-C2-06, ruling 25). A small sidecar file OUTSIDE the database
 * (HSN_STATE_HWM_FILE) records the highest state this server has seen: audit head (id + hash), change-feed
 * sequence and feed epoch, MAC'd with HSN_AUDIT_KEY. At boot the database is compared with it:
 *
 *   - audit head id lower than recorded, or the recorded head entry now has a different hash, or the feed
 *     sequence lower within the same epoch  =>  the database went backwards (restored backup, replaced file).
 *
 * On regression the feed epoch is rotated at once (clients see 410 and resync from since=0), a
 * `dataset.restore_detected` audit entry and an alert log line are written, and readiness FAILS until an
 * operator acknowledges the restore (scripts/ack-restore.ts rewrites the sidecar) and restarts.
 * A sidecar whose MAC does not verify also fails readiness (edited, or a different audit key).
 * SA-C3-04: the first time a sidecar is created, a `dataset.hwm_initialised` entry goes into the audit log.
 * A MISSING sidecar for a database whose log has that entry (or a restore acknowledgement) is treated as a
 * possible restore (deleted or not-restored sidecar): alert `dataset.hwm_missing`, epoch rotated, readiness
 * fails until ack-restore. Only a database that never had a sidecar initialises one silently.
 * While running, the sidecar only ever moves forward (written after audit appends and on an interval).
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonicalJson.js';
import { rfc3339, type Clock } from '../lib/clock.js';
import type { Repos, TxRunner } from '../repositories/types.js';
import { appendAudit } from './audit.js';
import { newFeedEpoch } from './dataset.js';

export const HWM_FORMAT = 'hsn-hwm/1';

export interface HwmState {
  format: typeof HWM_FORMAT;
  written_at: string;
  audit_head_id: number;
  audit_head_hash: string | null;
  last_change_seq: number;
  feed_epoch: string | null;
  dataset_version: string | null;
  /** set by scripts/ack-restore.ts */
  acknowledged?: { by: string; note: string; at: string };
  mac: string;
}

export interface RestoreCheck {
  status: 'disabled' | 'ok' | 'initialised' | 'restore_detected' | 'hwm_invalid' | 'hwm_missing';
  detail: string | null;
  /** readiness: false until acknowledged */
  ok: boolean;
}

interface Log {
  info(o: Record<string, unknown>, m: string): void;
  error(o: Record<string, unknown>, m: string): void;
}

const macOf = (auditKey: string, body: Omit<HwmState, 'mac'>): string => createHmac('sha256', auditKey).update(canonicalJson(body)).digest('hex');

function current(repos: Repos, at: string): Omit<HwmState, 'mac'> {
  const head = repos.audit.head();
  const ds = repos.dataset.current();
  return {
    format: HWM_FORMAT,
    written_at: at,
    audit_head_id: head?.id ?? 0,
    audit_head_hash: head?.hash ?? null,
    last_change_seq: ds?.last_change_seq ?? 0,
    feed_epoch: ds?.feed_epoch ?? null,
    dataset_version: ds?.current_version ?? null,
  };
}

export function readHwm(path: string, auditKey: string): HwmState | 'missing' | 'invalid' {
  if (!existsSync(path)) return 'missing';
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as HwmState;
    const { mac, ...body } = h;
    if (h.format !== HWM_FORMAT || typeof mac !== 'string' || macOf(auditKey, body) !== mac) return 'invalid';
    return h;
  } catch {
    return 'invalid';
  }
}

/** Atomic write (temp file + rename). */
export function writeHwm(path: string, auditKey: string, body: Omit<HwmState, 'mac'>): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...body, mac: macOf(auditKey, body) }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Why the database is behind the recorded high-water mark, or null when it is not. */
export function regression(repos: Repos, h: HwmState): string | null {
  const head = repos.audit.head();
  const ds = repos.dataset.current();
  const headId = head?.id ?? 0;
  if (headId < h.audit_head_id) return `audit log head ${headId} < recorded ${h.audit_head_id}`;
  if (h.audit_head_id > 0 && repos.audit.hashOf(h.audit_head_id) !== h.audit_head_hash) return `audit entry ${h.audit_head_id} differs from the recorded head (database replaced?)`;
  if (ds && h.feed_epoch !== null && ds.feed_epoch === h.feed_epoch && ds.last_change_seq < h.last_change_seq) {
    return `change feed seq ${ds.last_change_seq} < recorded ${h.last_change_seq} in the same epoch`;
  }
  return null;
}

export class RestoreGuard {
  private ok = false;
  private result: RestoreCheck | null = null;
  constructor(
    private readonly path: string | null,
    private readonly auditKey: string,
    private readonly read: Repos,
    private readonly tx: TxRunner,
    private readonly clock: Clock,
  ) {}

  /** Boot check (once per process; later calls return the first result). Rotates the feed epoch and fails readiness when the database went backwards. */
  check(log: Log): RestoreCheck {
    this.result ??= this.runCheck(log);
    return this.result;
  }

  private runCheck(log: Log): RestoreCheck {
    if (this.path === null) return { status: 'disabled', detail: null, ok: true };
    const h = readHwm(this.path, this.auditKey);
    const at = rfc3339(this.clock.now());
    if (h === 'missing') {
      const hadSidecar = this.read.audit.hasAction('dataset.hwm_initialised') || this.read.audit.hasAction('dataset.restore_acknowledged');
      if (hadSidecar) {
        const why = 'high-water-mark file is missing, but this database had one (deleted, or a restore without it?)';
        this.rotateAndAudit(at, why, null);
        log.error(
          { event: 'dataset.hwm_missing', alert: true, path: this.path },
          'state high-water-mark file is missing for a database that had one: treated as a possible restore; feed epoch rotated; readiness fails until scripts/ack-restore.ts is run',
        );
        return { status: 'hwm_missing', detail: why, ok: false };
      }
      this.tx((repos) =>
        appendAudit(repos.audit, this.auditKey, {
          at, actor: 'system', key_prefix: null, action: 'dataset.hwm_initialised', entity_type: 'dataset_version', entity_id: repos.dataset.current()?.current_version ?? '-',
          details: { path: this.path },
        }),
      );
      writeHwm(this.path, this.auditKey, current(this.read, at));
      this.ok = true;
      log.info({ event: 'dataset.hwm_initialised', path: this.path }, 'state high-water-mark file created');
      return { status: 'initialised', detail: null, ok: true };
    }
    if (h === 'invalid') {
      log.error({ event: 'dataset.hwm_invalid', alert: true, path: this.path }, 'state high-water-mark file does not verify (edited, or a different HSN_AUDIT_KEY); readiness fails until scripts/ack-restore.ts rewrites it');
      return { status: 'hwm_invalid', detail: 'high-water-mark MAC does not verify', ok: false };
    }
    const why = regression(this.read, h);
    if (why === null) {
      this.ok = true;
      this.record();
      return { status: 'ok', detail: null, ok: true };
    }
    const { epoch, old } = this.rotateAndAudit(at, why, { audit_head_id: h.audit_head_id, last_change_seq: h.last_change_seq, feed_epoch: h.feed_epoch, written_at: h.written_at });
    log.error(
      { event: 'dataset.restore_detected', alert: true, reason: why, old_feed_epoch: old, new_feed_epoch: epoch },
      'database is behind the recorded high-water mark (restored or replaced?): feed epoch rotated; readiness fails until scripts/ack-restore.ts is run',
    );
    return { status: 'restore_detected', detail: why, ok: false };
  }

  private rotateAndAudit(at: string, why: string, recorded: Record<string, unknown> | null): { epoch: string; old: string | null } {
    const epoch = newFeedEpoch();
    const old = this.read.dataset.current()?.feed_epoch ?? null;
    this.tx((repos) => {
      const ds = repos.dataset.current();
      if (ds) repos.dataset.rotateFeedEpoch(epoch);
      appendAudit(repos.audit, this.auditKey, {
        at, actor: 'system', key_prefix: null, action: 'dataset.restore_detected', entity_type: 'dataset_version', entity_id: ds?.current_version ?? '-',
        details: { reason: why, old_feed_epoch: old, new_feed_epoch: ds ? epoch : null, recorded },
      });
    });
    return { epoch, old };
  }

  /** Move the sidecar forward to the current state (only after a passing boot check). Never throws. */
  record(): void {
    if (this.path === null || !this.ok) return;
    try {
      const h = readHwm(this.path, this.auditKey);
      const cur = current(this.read, rfc3339(this.clock.now()));
      if (h !== 'missing' && h !== 'invalid' && h.audit_head_id === cur.audit_head_id && h.last_change_seq === cur.last_change_seq && h.feed_epoch === cur.feed_epoch) return;
      if (h !== 'missing' && h !== 'invalid' && regression(this.read, h) !== null) return; // never move backwards at runtime
      writeHwm(this.path, this.auditKey, cur);
    } catch {
      // best effort; the next write or the interval retries
    }
  }
}

/** scripts/ack-restore.ts: accept the current database state as the new high-water mark (audited). */
export function acknowledgeRestore(path: string, auditKey: string, tx: TxRunner, clock: Clock, by: string, note: string): HwmState {
  const at = rfc3339(clock.now());
  return tx((repos) => {
    const before = readHwm(path, auditKey);
    appendAudit(repos.audit, auditKey, {
      at, actor: by, key_prefix: null, action: 'dataset.restore_acknowledged', entity_type: 'dataset_version', entity_id: repos.dataset.current()?.current_version ?? '-',
      details: { note, previous: typeof before === 'string' ? before : { audit_head_id: before.audit_head_id, last_change_seq: before.last_change_seq, feed_epoch: before.feed_epoch, written_at: before.written_at } },
    });
    const body = { ...current(repos, at), acknowledged: { by, note, at } };
    writeHwm(path, auditKey, body);
    return { ...body, mac: macOf(auditKey, body) };
  });
}
