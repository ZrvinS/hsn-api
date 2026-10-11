/**
 * State-to-audit cross-check (SA-C2-02, ruling 18). The HMAC chain proves the audit log was written by
 * someone holding HSN_AUDIT_KEY; this module proves the PUBLISHED STATE is explained by that log:
 *
 *   - every dataset version has its `dataset.seeded` / `rate_proposal.approved` entry naming it, and (for
 *     versions published since round 4) the same content hash;
 *   - every proposal has its `rate_proposal.created` entry (same content_sha256) and every decided one its
 *     decision entry; an approval entry names the same version, rule and checker;
 *   - every rule from a proposal matches the rule snapshot in its approval entry; every voided, end-dated,
 *     superseded or re-verified rule has the approval entry of the proposal that did it;
 *   - every proposal's content_sha256 is recomputed from its stored content, and the content in its HMAC'd
 *     created entry equals what was stored and (for approvals) what was published (SA-C3-01);
 *   - every API key and admin actor has its creation entry; a revoked key stays revoked with its audited
 *     expiry, a disabled actor stays disabled, a decided proposal stays decided as audited (SA-C3-02);
 *   - a seed rule's citation_note is the audited seed caveat, or null after a verify (SA-C3-07);
 *   - an API key's tenant, LLM opt-out, rate limit and quota are the audited ones (SA-C4-01);
 *   - a watched notification's state and prefixes are explained by its audit history (SA-C4-02).
 *
 * Together with the boot content-hash check this detects a database writer WITHOUT the audit key (stolen
 * or replaced DB file, tampered backup, shared volume) who forges proposals, rules, versions, keys or
 * actors. It does NOT detect someone holding BOTH the database and HSN_AUDIT_KEY: they can write matching
 * entries. That is the documented residual risk (ruling 17/18); keep the audit key off the DB host's backups
 * and anchor the head off-host (export-audit-head / verify-audit --head).
 *
 * Call only after verifyAll() succeeded: entries are trusted because the chain verified.
 */
import type { AuditEntry, ProposalAction, Repos, RuleInput } from '../repositories/types.js';
import { canonicalJson } from '../lib/canonicalJson.js';
import { proposalContentSha256 } from './proposals.js';

const MAX_PROBLEMS = 50;

/** Rule fields that never change after insert (compared with the approval's rule snapshot). */
const IMMUTABLE_RULE_FIELDS = [
  'hsn_prefix', 'igst_rate_bp', 'cess_rate_bp', 'cess_specific_paise', 'cess_specific_unit', 'condition_kind', 'condition_text',
  'condition_code', 'min_unit_price_paise', 'max_unit_price_paise', 'effective_from', 'notification_ref', 'source_url',
  'created_in_version', 'proposal_id', 'seed_batch_id', 'retroactive_reason',
] as const;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

export interface CrossCheckResult {
  ok: boolean;
  problems: string[];
  /** state that predates the round-4 audit details and can only be checked by name (not by hash) */
  legacy: string[];
}

export function crossCheckState(repos: Repos, chunk = 5000): CrossCheckResult {
  const problems: string[] = [];
  const legacy: string[] = [];
  let total = 0;
  const problem = (m: string): void => {
    total++;
    if (problems.length < MAX_PROBLEMS) problems.push(m);
  };

  // index the (already HMAC-verified) entries we need
  const created = new Map<string, AuditEntry>();
  const decided = new Map<string, AuditEntry[]>();
  const approvalsByVersion = new Map<string, AuditEntry[]>();
  const approvalsByTarget = new Map<string, AuditEntry[]>();
  const seeded = new Map<string, AuditEntry>();
  const keysCreated = new Map<string, AuditEntry>();
  const bootstrapped = new Set<string>();
  const granted = new Map<string, AuditEntry[]>();
  const revoked = new Set<string>();
  const disabled = new Set<string>();
  const watchedLog = new Map<string, AuditEntry[]>();
  const push = <K>(m: Map<K, AuditEntry[]>, k: K, e: AuditEntry) => {
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };
  for (let after = 0; ; ) {
    const page = repos.audit.list(after, chunk);
    if (page.length === 0) break;
    for (const e of page) {
      const d = e.details;
      switch (e.action) {
        case 'rate_proposal.created':
          created.set(e.entity_id, e);
          break;
        case 'rate_proposal.approved': {
          push(decided, e.entity_id, e);
          const v = str(d['dataset_version']);
          if (v !== null) push(approvalsByVersion, v, e);
          const t = str(d['target_rule_id']);
          if (t !== null) push(approvalsByTarget, t, e);
          break;
        }
        case 'rate_proposal.rejected':
        case 'rate_proposal.withdrawn':
          push(decided, e.entity_id, e);
          break;
        case 'dataset.seeded':
          seeded.set(e.entity_id, e);
          break;
        case 'api_key.created':
          keysCreated.set(e.entity_id, e);
          break;
        case 'admin.bootstrapped':
          for (const id of e.entity_id.split(',')) bootstrapped.add(id);
          break;
        case 'admin.granted':
          push(granted, e.entity_id, e);
          break;
        case 'api_key.revoked':
          revoked.add(e.entity_id);
          break;
        case 'admin.disabled':
          disabled.add(e.entity_id);
          break;
        case 'watched_notification.detected':
        case 'watched_notification.triaged':
        case 'watched_notification.dismissed':
        case 'watched_notification.published':
          push(watchedLog, e.entity_id, e);
          break;
        default:
          break;
      }
    }
    after = page[page.length - 1]!.id;
  }

  const snap = repos.integrity.snapshot();
  const seedVersions = new Map(snap.seedBatches.map((b) => [b.dataset_version, b.id]));

  // dataset versions
  for (const v of snap.versions) {
    if (seedVersions.has(v.version)) {
      const s = seeded.get(v.version);
      if (!s) problem(`dataset version ${v.version}: seed version without a dataset.seeded audit entry`);
      else if (s.details['content_hash'] !== v.content_hash) problem(`dataset version ${v.version}: content hash differs from its dataset.seeded audit entry`);
      continue;
    }
    const apps = approvalsByVersion.get(v.version) ?? [];
    if (apps.length === 0) {
      problem(`dataset version ${v.version}: no rate_proposal.approved audit entry published it (forged or inserted version?)`);
      continue;
    }
    const hashed = apps.filter((a) => typeof a.details['dataset_content_hash'] === 'string');
    if (hashed.length === 0) legacy.push(`dataset version ${v.version}: approved before content hashes were audited (checked by name only)`);
    else if (!hashed.some((a) => a.details['dataset_content_hash'] === v.content_hash)) {
      problem(`dataset version ${v.version}: content hash differs from the one recorded in its approval audit entry`);
    }
  }

  // proposals
  const proposalById = new Map(snap.proposals.map((p) => [p.id, p]));
  const canon = (v: unknown): string => canonicalJson(v ?? null);
  for (const p of snap.proposals) {
    const rule = p.rule_json === null ? null : (JSON.parse(p.rule_json) as RuleInput);
    const payload = p.payload_json === null ? null : (JSON.parse(p.payload_json) as Record<string, unknown>);
    // SA-C3-01: the stored hash must be the hash of the stored content (a swapped pending proposal fails here)
    const recomputed = proposalContentSha256({
      action: p.action as ProposalAction, supersedes_rule_id: p.supersedes_rule_id, end_date: p.end_date, rule, payload,
      rationale: p.rationale, retroactive_reason: p.retroactive_reason, target_sha256: p.target_sha256,
    });
    if (recomputed !== p.content_sha256) problem(`proposal ${p.id}: stored content does not hash to its content_sha256 (content edited after creation?)`);
    const c = created.get(p.id);
    if (!c) problem(`proposal ${p.id}: no rate_proposal.created audit entry (inserted directly?)`);
    else {
      if (c.details['content_sha256'] !== p.content_sha256) problem(`proposal ${p.id}: content_sha256 differs from its rate_proposal.created audit entry`);
      if (canon(c.details['rule']) !== canon(rule) || canon(c.details['payload']) !== canon(payload)) {
        problem(`proposal ${p.id}: stored rule/payload differs from its rate_proposal.created audit entry`);
      }
    }
    // SA-C2-02 / SA-C3-02: the current status is the latest audited decision (none while pending)
    const decisions = decided.get(p.id) ?? [];
    const latest = decisions[decisions.length - 1];
    if (p.status === 'pending') {
      if (latest) problem(`proposal ${p.id}: pending, but the audit log records ${latest.action} (decision reversed?)`);
      continue;
    }
    if (latest && latest.action !== `rate_proposal.${p.status}`) problem(`proposal ${p.id}: status ${p.status} but the latest audited decision is ${latest.action}`);
    const ds = decisions.filter((e) => e.action === `rate_proposal.${p.status}`);
    if (ds.length === 0) {
      problem(`proposal ${p.id}: status ${p.status} without a rate_proposal.${p.status} audit entry`);
      continue;
    }
    if (p.status === 'approved') {
      const ok = ds.some(
        (e) =>
          e.details['content_sha256'] === p.content_sha256 && same(e.details['dataset_version'], p.resulting_version) &&
          same(e.details['rule_id'], p.resulting_rule_id) && same(e.details['actor_id'], p.decided_by_actor_id),
      );
      if (!ok) problem(`proposal ${p.id}: approval audit entry does not match the stored decision (version, rule, checker or content)`);
      // SA-C3-01: what was published is what was proposed (the created entry is HMAC'd at creation time)
      if (c) {
        const createdRule = c.details['rule'] as Record<string, unknown> | null | undefined;
        const snapRules = ds.map((e) => e.details['rule'] as Record<string, unknown> | null | undefined);
        if (createdRule && !snapRules.some((sr) => sr && Object.keys(createdRule).every((k) => same(sr[k], createdRule[k])))) {
          problem(`proposal ${p.id}: the published rule differs from the rule in its rate_proposal.created audit entry`);
        }
        if (!ds.some((e) => canon(e.details['payload']) === canon(c.details['payload']))) {
          problem(`proposal ${p.id}: the approved payload differs from the payload in its rate_proposal.created audit entry`);
        }
      }
    }
  }

  // rules
  const approvalOf = (proposalId: string): AuditEntry | null =>
    (decided.get(proposalId) ?? []).find((e) => e.action === 'rate_proposal.approved') ?? null;
  for (const r of snap.rules) {
    const ruleId = String(r['rule_id']);
    const proposalId = str(r['proposal_id']);
    let creation: AuditEntry | null = null;
    if (proposalId !== null) {
      creation = approvalOf(proposalId);
      const snapRule = creation?.details['rule'] as Record<string, unknown> | null | undefined;
      if (!creation || creation.details['rule_id'] !== ruleId || !snapRule) {
        problem(`rule ${ruleId}: no approval audit entry of ${proposalId} creates it (forged rule?)`);
      } else {
        const diff = IMMUTABLE_RULE_FIELDS.filter((f) => !same(snapRule[f], r[f]));
        if (r['end_dated_in_version'] === null && !same(snapRule['effective_to'], r['effective_to'])) diff.push('effective_to' as never);
        if (diff.length > 0) problem(`rule ${ruleId}: differs from its approval audit snapshot in ${diff.join(', ')}`);
      }
      if (!proposalById.has(proposalId)) problem(`rule ${ruleId}: names unknown proposal ${proposalId}`);
    } else {
      const batch = str(r['seed_batch_id']);
      const s = seeded.get(String(r['created_in_version']));
      if (batch === null || !s || s.details['seed_batch_id'] !== batch) problem(`rule ${ruleId}: neither from an audited approval nor from the audited seed batch`);
    }
    const byTarget = approvalsByTarget.get(ruleId) ?? [];
    if (r['status'] === 'voided') {
      const ok = byTarget.some(
        (e) => e.details['action'] === 'correct' && e.details['rule_id'] === r['voided_by_rule'] && e.details['dataset_version'] === r['voided_in_version'],
      );
      if (!ok) problem(`rule ${ruleId}: voided without the approval audit entry of the correcting proposal`);
    }
    if (r['end_dated_in_version'] !== null) {
      const ok = byTarget.some(
        (e) =>
          (e.details['action'] === 'end_date' || e.details['action'] === 'supersede') && e.details['dataset_version'] === r['end_dated_in_version'] &&
          (e.details['action'] === 'end_date' || e.details['rule_id'] === r['superseded_by']),
      );
      if (!ok) problem(`rule ${ruleId}: end-dated without the approval audit entry of the end_date/supersede proposal`);
    }
    // SA-C3-07: citation_note is outside the content hash but bound to the audited seed caveat
    const note = r['citation_note'] ?? null;
    if (proposalId !== null) {
      if (note !== null) problem(`rule ${ruleId}: a rule published by a proposal carries a citation_note`);
    } else {
      const seedEntry = seeded.get(String(r['created_in_version']));
      const notes = seedEntry?.details['citation_notes'] as Record<string, string> | undefined;
      const audited = notes?.[ruleId] ?? null;
      if (notes === undefined) {
        if (note !== null) legacy.push(`rule ${ruleId}: citation_note seeded before notes were audited (not checked)`);
      } else if (note !== null && note !== audited) problem(`rule ${ruleId}: citation_note differs from the seed caveat in its dataset.seeded audit entry`);
      else if (note === null && audited !== null && (r['last_verified_at'] ?? null) === null) {
        problem(`rule ${ruleId}: seed citation_note removed without a verify`);
      }
    }
    // ruling 36: a citation replaced by a verify must be exactly the one in the latest verify approval's snapshot
    const verifies = byTarget.filter((e) => e.details['action'] === 'verify');
    const lastVerify = verifies[verifies.length - 1]?.details['rule'] as Record<string, unknown> | null | undefined;
    if (lastVerify && (!same(lastVerify['source_url'], r['source_url']) || !same(lastVerify['notification_ref'], r['notification_ref']))) {
      problem(`rule ${ruleId}: source_url/notification_ref differ from its latest verify approval audit entry`);
    }
    if (r['last_verified_at'] !== null && r['last_verified_at'] !== undefined) {
      const verifiedAt = r['last_verified_at'];
      const atCreation = (creation?.details['rule'] as Record<string, unknown> | undefined)?.['last_verified_at'] === verifiedAt;
      const byVerify = byTarget.some((e) => e.details['action'] === 'verify' && (e.details['rule'] as Record<string, unknown> | null)?.['last_verified_at'] === verifiedAt);
      const atSeed =
        proposalId === null &&
        ((seeded.get(String(r['created_in_version']))?.details['verified_rules'] as { rule_id?: string }[] | undefined) ?? []).some((x) => x.rule_id === ruleId);
      if (!atCreation && !byVerify && !atSeed) problem(`rule ${ruleId}: verified without an audited approval or seed attestation`);
    }
  }

  // keys and actors
  for (const k of snap.keys) {
    const e = keysCreated.get(k.id);
    if (!e) {
      problem(`api key ${k.id} (${k.prefix}): no api_key.created audit entry (inserted directly?)`);
      continue;
    }
    if (e.details['prefix'] !== k.prefix || !same(e.details['actor_id'], k.actor_id) || !same(e.details['admin_grant_id'], k.admin_grant_id)
      || JSON.stringify(e.details['scopes']) !== k.scopes) {
      problem(`api key ${k.id}: differs from its api_key.created audit entry`);
    }
    // SA-C3-02: revocation and expiry cannot be undone or extended behind the audit log's back
    if ('expires_at' in e.details && !same(e.details['expires_at'], k.expires_at)) problem(`api key ${k.id} (${k.prefix}): expires_at differs from its api_key.created audit entry`);
    if (revoked.has(k.id) && k.revoked_at === null) problem(`api key ${k.id} (${k.prefix}): revoked in the audit log but usable in the database (un-revoked?)`);
    if (!revoked.has(k.id) && k.revoked_at !== null) problem(`api key ${k.id} (${k.prefix}): revoked without an api_key.revoked audit entry`);
    // SA-C4-01: policy columns (compared when the created entry records them; keys from before round 7 by tenant only)
    const policy: [string, unknown][] = [['tenant', k.tenant], ['llm_opt_out', k.llm_opt_out === 1], ['rate_limit_per_min', k.rate_limit_per_min], ['daily_quota', k.daily_quota]];
    const changed = policy.filter(([f, v]) => f in e.details && !same(e.details[f], v)).map(([f]) => f);
    if (changed.length > 0) problem(`api key ${k.id} (${k.prefix}): ${changed.join(', ')} differ from its api_key.created audit entry`);
  }
  for (const a of snap.actors) {
    if (a.created_via === 'bootstrap') {
      if (!bootstrapped.has(a.id)) problem(`admin actor ${a.handle}: bootstrap actor without an admin.bootstrapped audit entry`);
    } else if (!(granted.get(a.handle) ?? []).some((e) => e.details['proposal_id'] === a.grant_proposal_id && e.details['new_actor'] === true)) {
      problem(`admin actor ${a.handle}: no admin.granted audit entry for grant ${a.grant_proposal_id ?? '?'}`);
    }
    if (disabled.has(a.id) && a.disabled_at === null) problem(`admin actor ${a.handle}: disabled in the audit log but active in the database (re-enabled?)`);
    if (!disabled.has(a.id) && a.disabled_at !== null) problem(`admin actor ${a.handle}: disabled without an admin.disabled audit entry`);
  }

  // SA-C4-02: watched notifications
  const prefixSet = (v: unknown): string => JSON.stringify([...((Array.isArray(v) ? v : []) as string[])].sort());
  for (const w of snap.watched) {
    const log = watchedLog.get(w.id) ?? [];
    const det = log.find((e) => e.action === 'watched_notification.detected');
    if (!det) {
      problem(`watched notification ${w.id}: no watched_notification.detected audit entry (inserted directly?)`);
      continue;
    }
    const lastSet = [...log].reverse().find((e) => e.action === 'watched_notification.triaged' || e.action === 'watched_notification.detected')!;
    const audited = lastSet.action === 'watched_notification.triaged' ? lastSet.details['affected_prefixes'] : (lastSet.details['affected_prefixes'] ?? []);
    let current: unknown = [];
    try {
      current = JSON.parse(w.affected_prefixes);
    } catch {
      current = null;
    }
    if (prefixSet(audited) !== prefixSet(current)) problem(`watched notification ${w.id}: affected_prefixes differ from its last detected/triaged audit entry`);
    const resolved = log.filter((e) => e.action === 'watched_notification.dismissed' || e.action === 'watched_notification.published');
    if (w.state === 'detected') {
      if (resolved.length > 0) problem(`watched notification ${w.id}: still detected, but the audit log records ${resolved[0]!.action}`);
    } else {
      const r = resolved.find((e) => e.action === `watched_notification.${w.state}`);
      if (!r) problem(`watched notification ${w.id}: ${w.state} without a watched_notification.${w.state} audit entry`);
      else if ((w.source === 'cbic_watcher' || w.notification_key !== null) && (typeof r.details['requested_by'] !== 'string' || typeof r.details['confirmed_by'] !== 'string')) {
        problem(`watched notification ${w.id}: keyed row ${w.state} without a two-admin confirmation in its audit entry`);
      }
    }
  }

  if (total > problems.length) problems.push(`… and ${total - problems.length} more`);
  return { ok: total === 0, problems, legacy };
}
