/**
 * Off-host anchoring of the audit chain (ruling 18, SA-C-11). The operator exports the chain head and
 * the dataset sha256 daily (scripts/export-audit-head.ts) and stores it off the host;
 * scripts/verify-audit.ts checks a database against such an export. This detects edits (HMAC chain),
 * truncation of newest rows and rewritten dataset hashes, as long as the attacker lacks HSN_AUDIT_KEY.
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../lib/canonicalJson.js';
import type { Repos } from '../repositories/types.js';
import { verifyAll } from './audit.js';
import { crossCheckState } from './integrity.js';

export const HEAD_FORMAT = 'hsn-audit-head/1';

export interface AuditHeadExport {
  format: typeof HEAD_FORMAT;
  exported_at: string;
  audit_head_id: number;
  audit_head_hash: string | null;
  dataset_version: string | null;
  dataset_sha256: string | null;
  feed_epoch: string | null;
  /** HMAC-SHA256(HSN_AUDIT_KEY, canonical JSON of the other fields) */
  mac: string;
}

const macOf = (auditKey: string, body: Omit<AuditHeadExport, 'mac'>): string => createHmac('sha256', auditKey).update(canonicalJson(body)).digest('hex');

export function exportAuditHead(repos: Repos, auditKey: string, exportedAt: string): AuditHeadExport {
  const head = repos.audit.head();
  const ds = repos.dataset.current();
  const body: Omit<AuditHeadExport, 'mac'> = {
    format: HEAD_FORMAT,
    exported_at: exportedAt,
    audit_head_id: head?.id ?? 0,
    audit_head_hash: head?.hash ?? null,
    dataset_version: ds?.current_version ?? null,
    dataset_sha256: ds?.content_hash ?? null,
    feed_epoch: ds?.feed_epoch ?? null,
  };
  return { ...body, mac: macOf(auditKey, body) };
}

export interface AuditCheckResult {
  ok: boolean;
  problems: string[];
  /** SA-C2-02: state approved before content hashes were audited (checked by name only) */
  legacy: string[];
  head: { id: number; hash: string } | null;
}

export function verifyAgainstHead(repos: Repos, auditKey: string, exported: AuditHeadExport | null): AuditCheckResult {
  const problems: string[] = [];
  const chain = verifyAll(repos.audit, auditKey);
  if (!chain.ok) problems.push(`audit chain does not verify at entry ${chain.broken_at ?? '?'} (edited row, wrong HSN_AUDIT_KEY or broken link)`);
  // SA-C2-02: the published state must be explained by the (verified) audit log
  let legacy: string[] = [];
  if (chain.ok) {
    const x = crossCheckState(repos);
    problems.push(...x.problems.map((m) => `state without matching audit entry: ${m}`));
    legacy = x.legacy;
  }
  const ds = repos.dataset.current();
  if (ds) {
    const recomputed = repos.dataset.computeContentHash();
    if (recomputed !== ds.content_hash) problems.push(`dataset ${ds.current_version}: stored content hash does not match the data (recomputed ${recomputed})`);
  }
  if (exported) {
    const { mac, ...body } = exported;
    if (exported.format !== HEAD_FORMAT) problems.push('export: unknown format');
    else if (macOf(auditKey, body) !== mac) problems.push('export: MAC does not verify (file edited or a different HSN_AUDIT_KEY)');
    const headNow = chain.head;
    if ((headNow?.id ?? 0) < exported.audit_head_id) problems.push(`audit log is shorter than the exported head (${headNow?.id ?? 0} < ${exported.audit_head_id}): rows were removed`);
    if (exported.audit_head_id > 0 && repos.audit.hashOf(exported.audit_head_id) !== exported.audit_head_hash) {
      problems.push(`audit entry ${exported.audit_head_id} differs from the exported head hash`);
    }
    if (exported.dataset_version !== null && exported.dataset_sha256 !== null) {
      const h = repos.dataset.versionHash(exported.dataset_version);
      if (h === null) problems.push(`dataset version ${exported.dataset_version} from the export is missing`);
      else if (h !== exported.dataset_sha256) problems.push(`dataset version ${exported.dataset_version}: hash differs from the export`);
    }
    if (ds && exported.feed_epoch !== null && ds.feed_epoch !== exported.feed_epoch) {
      problems.push(`feed_epoch changed since the export (${exported.feed_epoch} → ${ds.feed_epoch}): the database was restored or replaced`);
    }
  }
  return { ok: problems.length === 0, problems, legacy, head: chain.head };
}
