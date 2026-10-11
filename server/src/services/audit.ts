/**
 * HMAC-chained audit log (ruling 18, SEC-53).
 * hash = hex(HMAC-SHA256(HSN_AUDIT_KEY, prev_hash + '\n' + canonical_json({id, at, actor, key_prefix, action, entity_type, entity_id, details})))
 * First row: prev_hash = '0' × 64. Must be called inside the caller's BEGIN IMMEDIATE transaction.
 * Without the key an attacker who can write the DB cannot recompute a consistent chain; truncation of
 * the newest rows is detected against an exported head (scripts/export-audit-head.ts, verify-audit.ts).
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../lib/canonicalJson.js';
import type { AuditEntry, AuditRepo } from '../repositories/types.js';

export const GENESIS_HASH = '0'.repeat(64);
/** filtered verification walks at most this many ids (SA-C-11) */
export const MAX_VERIFY_SPAN = 10_000;

export interface AuditInput {
  at: string;
  actor: string;
  key_prefix: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

export function computeAuditHash(auditKey: string, prevHash: string, e: Omit<AuditEntry, 'prev_hash' | 'hash'>): string {
  const payload = canonicalJson({
    id: e.id,
    at: e.at,
    actor: e.actor,
    key_prefix: e.key_prefix,
    action: e.action,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    details: e.details,
  });
  return createHmac('sha256', auditKey).update(prevHash).update('\n').update(payload).digest('hex');
}

export type ChainHeadLogger = (head: { id: number; hash: string; action: string }) => void;

export function appendAudit(repo: AuditRepo, auditKey: string, input: AuditInput, onHead?: ChainHeadLogger): AuditEntry {
  if (auditKey.length === 0) throw new Error('audit key is not configured');
  const head = repo.head();
  const id = (head?.id ?? 0) + 1;
  const prev = head?.hash ?? GENESIS_HASH;
  // round-trip details through JSON so the hashed form equals the stored form
  const details = JSON.parse(JSON.stringify(input.details)) as Record<string, unknown>;
  const base = { ...input, details, id };
  const entry: AuditEntry = { ...base, prev_hash: prev, hash: computeAuditHash(auditKey, prev, base) };
  repo.insert(entry);
  onHead?.({ id: entry.id, hash: entry.hash, action: entry.action });
  return entry;
}

export interface ChainVerification {
  ok: boolean;
  /** id of the first entry whose hash or link does not verify */
  broken_at: number | null;
}

/**
 * Verify a contiguous run of entries (ascending id). `expectedPrev` is the hash of the entry
 * before the first one (GENESIS for id 1). Detects edited rows and broken links.
 */
export function verifyChain(auditKey: string, entries: readonly AuditEntry[], expectedPrev: string | null): ChainVerification {
  let prev = expectedPrev;
  let prevId: number | null = null;
  for (const e of entries) {
    if (prev !== null && e.prev_hash !== prev) return { ok: false, broken_at: e.id };
    if (prevId !== null && e.id !== prevId + 1) return { ok: false, broken_at: e.id };
    const { prev_hash: _p, hash: _h, ...rest } = e;
    if (computeAuditHash(auditKey, e.prev_hash, rest) !== e.hash) return { ok: false, broken_at: e.id };
    prev = e.hash;
    prevId = e.id;
  }
  return { ok: true, broken_at: null };
}

/**
 * Verify the page of entries (filtered pages are verified against the full chain, walking at most
 * MAX_VERIFY_SPAN ids; a longer span returns ok=false with broken_at=null → use the CLI).
 */
export function verifyFromRepo(repo: AuditRepo, auditKey: string, entries: readonly AuditEntry[]): ChainVerification & { span_too_large?: boolean } {
  if (entries.length === 0) return { ok: true, broken_at: null };
  const first = entries[0]!;
  const prev = first.id === 1 ? GENESIS_HASH : repo.hashOf(first.id - 1);
  if (prev === null) return { ok: false, broken_at: first.id };
  const contiguous = entries.every((e, i) => i === 0 || e.id === entries[i - 1]!.id + 1);
  if (contiguous) return verifyChain(auditKey, entries, prev);
  const last = entries[entries.length - 1]!;
  const span = last.id - first.id + 1;
  if (span > MAX_VERIFY_SPAN) return { ok: false, broken_at: null, span_too_large: true };
  return verifyChain(auditKey, repo.list(first.id - 1, span), prev);
}

/** Full-chain verification in chunks (CLI / boot). */
export function verifyAll(repo: AuditRepo, auditKey: string, chunk = 5000): ChainVerification & { head: { id: number; hash: string } | null } {
  let after = 0;
  let prev = GENESIS_HASH;
  for (;;) {
    const page = repo.list(after, chunk);
    if (page.length === 0) break;
    if (page[0]!.id !== after + 1) return { ok: false, broken_at: page[0]!.id, head: repo.head() };
    const v = verifyChain(auditKey, page, prev);
    if (!v.ok) return { ...v, head: repo.head() };
    prev = page[page.length - 1]!.hash;
    after = page[page.length - 1]!.id;
  }
  return { ok: true, broken_at: null, head: repo.head() };
}
