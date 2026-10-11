/**
 * Storage-agnostic repository interfaces (07 §2). Only repositories/sqlite/* imports node:sqlite.
 * Money is integer paise, rates integer basis points, dates 'YYYY-MM-DD', timestamps RFC 3339 UTC.
 */
import type { Scope } from '../lib/apiKey.js';

export type HsnType = 'goods' | 'service';
export type ConditionKind = 'none' | 'price' | 'other';
export type VerificationStatus = 'verified' | 'unverified';

/** 2, 4, 6 or 8 digits; 5 only for SAC groups 99xxx (ruling 6) */
export type HsnLevel = 2 | 4 | 5 | 6 | 8;

export interface HsnRow {
  code: string;
  level: HsnLevel;
  parent: string | null;
  chapter: string;
  type: HsnType;
  description: string;
  keywords: string;
  added_in_version: string;
}

export interface HsnSearchHit {
  code: string;
  level: number;
  type: HsnType;
  chapter: string;
  description: string;
  keywords: string;
  /** SQLite bm25 (negative; lower = better) */
  bm25: number;
  highlight: string;
}

export interface HsnSearchOptions {
  limit: number;
  type?: HsnType | undefined;
  levels?: readonly number[] | undefined;
}

export interface HsnRepo {
  get(code: string): HsnRow | null;
  getMany(codes: readonly string[]): HsnRow[];
  /** chain from chapter down to the direct parent (excluding the code itself) */
  ancestors(code: string): HsnRow[];
  /** Free-text search: sanitised to quoted tokens; AND first, OR fallback when AND finds nothing. */
  search(text: string, opts: HsnSearchOptions): { hits: HsnSearchHit[]; mode: 'and' | 'or' | 'none' };
  /** Search with already-normalised tokens (classifier). Tokens are re-sanitised. */
  searchTokens(tokens: readonly string[], mode: 'and' | 'or', opts: HsnSearchOptions): HsnSearchHit[];
  /** seed path (empty database) */
  insert(row: HsnRow): void;
  /** after the seed: only for an approved refdata_change add_code proposal naming this code (trigger-enforced) */
  insertApproved(row: HsnRow, proposalId: string): void;
  /** description/keywords change through an approved refdata_change proposal only (trigger-enforced) */
  updateDescription(code: string, description: string, keywords: string, proposalId: string): void;
  counts(): { goods: number; services: number };
}

export interface RateRuleRow {
  rule_id: string;
  hsn_prefix: string;
  igst_rate_bp: number;
  cess_rate_bp: number;
  cess_specific_paise: number | null;
  cess_specific_unit: string | null;
  condition_kind: ConditionKind;
  condition_text: string | null;
  /** machine-readable condition key for classifier hints (ruling 5), e.g. 'nil_rate_list' */
  condition_code: string | null;
  min_unit_price_paise: number | null;
  max_unit_price_paise: number | null;
  effective_from: string;
  effective_to: string | null;
  notification_ref: string;
  source_url: string;
  /** ruling 12: required for publish/verify, nullable on the seed path */
  source_pdf_sha256: string | null;
  schedule_serial: string | null;
  /** null exactly while unverified (ruling 17) */
  verified_by: string | null;
  last_verified_at: string | null;
  verification_status: VerificationStatus;
  /** ruling 1: voided rules are kept for audit and excluded from resolution */
  status: RuleStatus;
  voided_at: string | null;
  voided_in_version: string | null;
  voided_by_rule: string | null;
  retroactive_reason: string | null;
  created_in_version: string;
  end_dated_in_version: string | null;
  superseded_by: string | null;
  proposal_id: string | null;
  seed_batch_id: string | null;
  /** seed caveat (FORMAT `citation_note`); set only on the seed path, cleared by a verify approval */
  citation_note: string | null;
}

export type RuleStatus = 'active' | 'voided';

export interface RateRuleRepo {
  get(ruleId: string): RateRuleRow | null;
  /** Active (not voided) rules in force on `date` whose prefix is an ancestor-or-self of code, or a strict descendant of it. */
  rulesInForce(code: string, date: string): { ancestorOrSelf: RateRuleRow[]; descendants: RateRuleRow[] };
  /** All active (not voided) rules (any date) with exactly this prefix. */
  byPrefix(prefix: string): RateRuleRow[];
  insert(row: RateRuleRow): void;
  endDate(ruleId: string, effectiveTo: string, version: string, supersededBy: string | null): void;
  /** unverified -> verified, or a forward-only refresh of last_verified_at (trigger-enforced) */
  /** ruling 36: citation.url / citation.notification replace the citation in the same update (first verify only) */
  markVerified(ruleId: string, verifiedBy: string, at: string, pdfSha256: string, scheduleSerial: string, citation?: { url: string | null; notification: string | null }): void;
  void(ruleId: string, at: string, version: string, replacementRuleId: string): void;
  /** verified rules whose last_verified_at is before `cutoff` (in force today) */
  overdueCount(today: string, cutoff: string): number;
  /** master codes (level >= 4) with no rule in force on `today` at, above or below them */
  codesWithoutRules(today: string): number;
  stats(today: string, verifiedSince: string): {
    active: number;
    activeUnverified: number;
    activeVerified: number;
    chaptersWithRules: number;
    verifiedRecentlyPercent: number;
    oldestLastVerifiedAt: string | null;
    sources: { notification: string; url: string; rule_count: number; verified_count: number }[];
  };
}

export interface DatasetVersionRow {
  version: string;
  parent_version: string | null;
  published_at: string;
  published_by: string;
  reason: string;
  rule_count: number;
  content_hash: string;
}

export interface DatasetState {
  current_version: string;
  last_change_seq: number;
  published_at: string;
  content_hash: string;
  signature: string | null;
  /** changes when the database is restored; clients resync from since=0 (ruling 25) */
  feed_epoch: string;
}

export type ChangeType =
  | 'rule_added'
  | 'rule_end_dated'
  | 'rule_verified'
  | 'rule_corrected'
  | 'hsn_added'
  | 'hsn_updated'
  | 'synonym_changed'
  | 'refdata_changed';

export interface ChangeRow {
  seq: number;
  dataset_version: string;
  published_at: string;
  change_type: ChangeType;
  hsn_prefix: string;
  /** ruling 3: invalidate cached code c when c.startsWith(p) || p.startsWith(c) */
  affected_prefix: string;
  rule_id: string | null;
  /** rule_corrected: the voided rule (rule_id is the replacement) */
  related_rule_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  /** effect starts before the IST publish date (ruling 25) */
  retroactive: boolean;
  summary: string;
}

export type ChangeInput = Omit<ChangeRow, 'seq' | 'affected_prefix' | 'related_rule_id' | 'retroactive'> & {
  affected_prefix?: string;
  related_rule_id?: string | null;
  retroactive?: boolean;
};

export interface DatasetRepo {
  current(): DatasetState | null;
  versionsOn(datePrefix: string): string[];
  insertVersion(row: DatasetVersionRow): void;
  updateVersionStats(version: string, ruleCount: number, contentHash: string, signature: string | null): void;
  /** version's stored content hash (null if unknown) */
  versionHash(version: string): string | null;
  setState(version: string, lastChangeSeq: number, feedEpoch?: string): void;
  rotateFeedEpoch(epoch: string): void;
  insertSeedBatch(b: { id: string; dataset_version: string; created_at: string; files: Record<string, string | null> }): void;
  appendChange(c: ChangeInput): number;
  changes(since: number, limit: number): ChangeRow[];
  minSeq(): number | null;
  maxSeq(): number;
  /** sha256 over a canonical dump of hsn_codes, rate_rules and active reference data (SEC-54, ruling 11) */
  computeContentHash(): string;
  activeRuleCount(today: string): number;
}

export interface ApiKeyRow {
  id: string;
  prefix: string;
  key_hash: string;
  scopes: Scope[];
  tenant: string;
  /** admin_actors.id (admin keys only) */
  actor_id: string | null;
  /** admin_actors.handle, joined (admin keys only) */
  actor: string | null;
  /** actor disabled → key unusable */
  actor_disabled: boolean;
  admin_grant_id: string | null;
  /** which HSN_KEY_PEPPERS entry hashed this key (ruling 29) */
  pepper_id: string;
  label: string;
  rate_limit_per_min: number;
  /** null = config default */
  daily_quota: number | null;
  llm_opt_out: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyRepo {
  insert(row: Omit<ApiKeyRow, 'actor' | 'actor_disabled'>): void;
  getByPrefix(prefix: string): ApiKeyRow | null;
  getById(id: string): ApiKeyRow | null;
  revoke(id: string, at: string): boolean;
  touchLastUsed(id: string, at: string): void;
}

export interface AdminActorRow {
  id: string;
  handle: string;
  display_name: string;
  created_at: string;
  created_via: 'bootstrap' | 'admin_grant';
  grant_proposal_id: string | null;
  disabled_at: string | null;
}

export interface AdminActorRepo {
  insert(a: AdminActorRow): void;
  get(id: string): AdminActorRow | null;
  byHandle(handle: string): AdminActorRow | null;
  count(): number;
  activeCount(): number;
  all(): AdminActorRow[];
  disable(id: string, at: string): boolean;
}

export interface IdempotencyRow {
  key_id: string;
  idem_key: string;
  route: string;
  request_sha256: string;
  status_code: number;
  response_json: string;
  created_at: string;
}

export interface IdempotencyRepo {
  get(keyId: string, idemKey: string, notBefore: string): IdempotencyRow | null;
  put(row: IdempotencyRow): void;
  purgeBefore(cutoff: string): number;
}

export type WatchedState = 'detected' | 'published' | 'dismissed';

export interface WatchedNotificationRow {
  id: string;
  notification_ref: string;
  source_url: string;
  affected_prefixes: string[];
  effective_from: string | null;
  detected_at: string;
  state: WatchedState;
  expedite: boolean;
  note: string | null;
  created_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  /** 'cbic_watcher' rows are inserted by the notification watcher with affected_prefixes [] until triaged */
  source: 'manual' | 'cbic_watcher';
  /** normalised identity, e.g. "central_tax_rate:1/2026"; unique when set (watcher idempotency) */
  notification_key: string | null;
  title: string | null;
  /** date of issue as listed (YYYY-MM-DD) */
  notification_date: string | null;
  /**
   * SA-C2-03: a request by one admin to resolve this watcher row (or remove prefixes from it), applied
   * only when a different admin repeats it. Absent/null when nothing is awaiting confirmation.
   */
  pending_action?: PendingWatchAction | null;
}

export interface PendingWatchAction {
  kind: 'triage' | 'published' | 'dismissed';
  affected_prefixes?: string[];
  effective_from?: string | null;
  by: string;
  by_actor_id: string;
  at: string;
}

export interface WatchedNotificationRepo {
  insert(w: WatchedNotificationRow): void;
  get(id: string): WatchedNotificationRow | null;
  byKey(key: string): WatchedNotificationRow | null;
  /** every row in state `detected` (triaged or not) */
  pending(): WatchedNotificationRow[];
  /** set affected prefixes / effective date while the row is still `detected`; false otherwise */
  triage(id: string, prefixes: readonly string[], effectiveFrom: string | null): boolean;
  resolve(id: string, state: 'published' | 'dismissed', at: string, by: string): boolean;
  /** store (or clear) the action awaiting a second admin's confirmation (SA-C2-03) */
  setPending(id: string, action: PendingWatchAction | null): boolean;
  /** cheap fingerprint of the pending set, for ETags */
  pendingTag(): string;
}

export type WatcherRunStatus = 'ok' | 'failed';

export interface WatcherRunRow {
  id: number;
  source: 'cbic';
  started_at: string;
  finished_at: string;
  status: WatcherRunStatus;
  items_seen: number;
  items_new: number;
  error: string | null;
  details: Record<string, unknown>;
}

export interface WatcherRunRepo {
  insert(r: Omit<WatcherRunRow, 'id'>): number;
  last(source: 'cbic'): WatcherRunRow | null;
  lastSuccess(source: 'cbic'): WatcherRunRow | null;
  recent(source: 'cbic', limit: number): WatcherRunRow[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  key_prefix: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditRepo {
  /** last entry (id, hash) or null for an empty log */
  head(): { id: number; hash: string } | null;
  insert(e: AuditEntry): void;
  list(afterId: number, limit: number, entityType?: string): AuditEntry[];
  /** hash of the entry with this id (to verify a page's first link) */
  hashOf(id: number): string | null;
  all(): AuditEntry[];
  /** whether any entry has this action (boot-time; full scan) */
  hasAction(action: string): boolean;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type ProposalAction = 'create' | 'supersede' | 'end_date' | 'verify' | 'correct' | 'admin_grant' | 'refdata_change';
export const RULE_ACTIONS: readonly ProposalAction[] = ['create', 'supersede', 'correct'];

/** Internal rule input (paise / bp), stored as rule_json. */
export interface RuleInput {
  hsn_prefix: string;
  igst_rate_bp: number;
  cess_rate_bp: number;
  cess_specific_paise: number | null;
  cess_specific_unit: string | null;
  condition_kind: ConditionKind;
  condition_text: string | null;
  condition_code: string | null;
  min_unit_price_paise: number | null;
  max_unit_price_paise: number | null;
  effective_from: string;
  effective_to: string | null;
  notification_ref: string;
  source_url: string;
  source_pdf_sha256: string;
  schedule_serial: string;
}

export interface ProposalRow {
  id: string;
  status: ProposalStatus;
  action: ProposalAction;
  supersedes_rule_id: string | null;
  end_date: string | null;
  rule: RuleInput | null;
  /** verify: {source:{pdf_sha256, schedule_serial}}; admin_grant / refdata_change: their payload */
  payload: Record<string, unknown> | null;
  rationale: string;
  retroactive_reason: string | null;
  /** sha256 of the canonical proposal content; approve/reject must quote it (ruling 20) */
  content_sha256: string;
  /** sha256 of the target rule as it was when proposed; approval fails if it changed */
  target_sha256: string | null;
  proposed_by: string;
  proposed_by_actor_id: string;
  proposed_key_id: string;
  proposed_at: string;
  decided_by: string | null;
  decided_by_actor_id: string | null;
  decided_key_id: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  resulting_rule_id: string | null;
  resulting_version: string | null;
}

export interface ProposalRepo {
  insert(p: ProposalRow): void;
  get(id: string): ProposalRow | null;
  /** cursor = id of last item of previous page (ids are time-ordered ULIDs) */
  list(status: ProposalStatus, limit: number, afterId: string | null): ProposalRow[];
  pending(): ProposalRow[];
  decide(
    id: string,
    d: {
      status: 'approved' | 'rejected' | 'withdrawn';
      decided_by: string;
      /** null only for 'withdrawn' (the proposer closes their own proposal; ruling 26) */
      decided_by_actor_id: string | null;
      /** null only for a withdrawal by scripts/disable-actor.ts (no API key involved) */
      decided_key_id: string | null;
      decided_at: string;
      decision_comment: string | null;
      resulting_rule_id: string | null;
      resulting_version: string | null;
    },
  ): void;
}

export interface ProductRow {
  gtin: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  source: 'manual' | 'open_food_facts' | 'open_beauty_facts';
  source_ref: string | null;
  found: boolean;
  fetched_at: string;
  expires_at: string;
}

export interface ProductRepo {
  get(gtin14: string): ProductRow | null;
  upsert(p: ProductRow): void;
  /** admin purge (SA-K-03); returns true when a row was removed */
  delete(gtin14: string): boolean;
  /** rows currently cached (metrics, ruling 30) */
  count(): number;
}

export interface SynonymRow {
  id: number;
  phrase: string;
  hsn_code: string;
  strength: 'primary' | 'related';
  note: string | null;
  /** links a curated synonym to a rule condition_code (ruling 5), e.g. 'nil_rate_list' */
  rule_hint: string | null;
  created_by: string;
  created_at: string;
  active: boolean;
}

export type SynonymInsert = Omit<SynonymRow, 'id' | 'rule_hint'> & { rule_hint?: string | null; added_by_proposal?: string | null };

export interface SynonymRepo {
  /** active synonyms whose phrase is in the list */
  byPhrases(phrases: readonly string[]): SynonymRow[];
  /** all active synonyms (small table; classifier may cache keyed by dataset version) */
  allActive(): SynonymRow[];
  getById(id: number): SynonymRow | null;
  /** seed (empty DB) or approved refdata_change (trigger-enforced) */
  insert(s: SynonymInsert): void;
  deactivate(id: number, proposalId: string): boolean;
  /** chapter_keywords lookup (active rows) */
  chaptersForKeywords(keywords: readonly string[]): { keyword: string; chapter: string }[];
  insertChapterKeyword(keyword: string, chapter: string, addedByProposal?: string | null): void;
  getChapterKeyword(id: number): { id: number; keyword: string; chapter: string; active: boolean } | null;
  deactivateChapterKeyword(id: number, proposalId: string): boolean;
  /** category_map lookup (active rows) */
  categoryPrefix(source: string, category: string): string | null;
  insertCategory(source: string, category: string, hsnPrefix: string, addedByProposal?: string | null): void;
  getCategory(id: number): { id: number; source: string; category: string; hsn_prefix: string; active: boolean } | null;
  deactivateCategory(id: number, proposalId: string): boolean;
}

export interface Repos {
  hsn: HsnRepo;
  rules: RateRuleRepo;
  dataset: DatasetRepo;
  keys: ApiKeyRepo;
  audit: AuditRepo;
  proposals: ProposalRepo;
  products: ProductRepo;
  synonyms: SynonymRepo;
  actors: AdminActorRepo;
  idempotency: IdempotencyRepo;
  watched: WatchedNotificationRepo;
  watcherRuns: WatcherRunRepo;
  integrity: IntegrityRepo;
}

/** SA-C2-02: published state that must be explained by HMAC'd audit entries. */
export interface IntegritySnapshot {
  versions: { version: string; content_hash: string }[];
  seedBatches: { id: string; dataset_version: string }[];
  proposals: {
    id: string; status: ProposalStatus; action: ProposalAction; content_sha256: string; decided_by_actor_id: string | null;
    resulting_rule_id: string | null; resulting_version: string | null; supersedes_rule_id: string | null;
    /** SA-C3-01: the stored content, so the cross-check can recompute content_sha256 */
    end_date: string | null; rule_json: string | null; payload_json: string | null; rationale: string;
    retroactive_reason: string | null; target_sha256: string | null;
  }[];
  rules: Record<string, unknown>[];
  keys: {
    id: string; prefix: string; scopes: string; actor_id: string | null; admin_grant_id: string | null; expires_at: string | null; revoked_at: string | null;
    tenant: string; llm_opt_out: number; rate_limit_per_min: number; daily_quota: number | null;
  }[];
  /** SA-C4-02 */
  watched: { id: string; state: string; affected_prefixes: string; source: string; notification_key: string | null }[];
  actors: { id: string; handle: string; created_via: string; grant_proposal_id: string | null; disabled_at: string | null }[];
}

export interface IntegrityRepo {
  snapshot(): IntegritySnapshot;
}

/** Runs fn inside an exclusive write transaction (BEGIN IMMEDIATE); rollback on throw. */
export interface TxRunner {
  <T>(fn: (repos: Repos) => T): T;
}
