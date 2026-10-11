/**
 * Maker–checker maintenance (data-model.md §4, architecture §2.4, SEC-50/51/52; rulings 1, 9, 12, 17–20,
 * 23, 25 of 00c).
 * - A proposal is created by one admin actor (maker) and decided by a different actor (checker).
 *   Actors are compared by admin_actors.id (ruling 17), never by a free-text name.
 * - approve/reject must quote `expected_sha256` = the proposal's content_sha256 (ruling 20); the target
 *   rule must be unchanged since the proposal was made (target_sha256).
 * - Approval runs in one BEGIN IMMEDIATE transaction: decision → rule writes (DB triggers require the
 *   approved proposal to name the rule) → overlap check → dataset version → change feed → HMAC audit
 *   entry carrying the full canonical rule and its sha256 (ruling 18).
 * - Retroactive effects (before today IST) need `retroactive_reason` and are flagged in the feed (25).
 */
import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import { addDays, GST_START, isRealDate, istDate, type IsoDate } from '../lib/dates.js';
import { newId } from '../lib/ids.js';
import { canonicalJson } from '../lib/canonicalJson.js';
import { bpToPercent, paiseToRupees, parseRupees } from '../lib/money.js';
import { AppError, validationError, type FieldError } from '../lib/problem.js';
import type { ProposalAction, ProposalRow, ProposalStatus, RateRuleRow, Repos, RuleInput, TxRunner } from '../repositories/types.js';
import { appendAudit, type ChainHeadLogger } from './audit.js';
import { beginPublish, finishPublish } from './dataset.js';
import { normaliseHandle, KeyInputError } from './apiKeys.js';
import { runIdempotent, type IdempotencyContext } from './idempotency.js';

export interface Actor {
  /** admin actor handle */
  actor: string;
  actorId: string;
  keyId: string;
  keyPrefix: string;
}

export const CONDITION_CODES = ['nil_rate_list'] as const;
export const RULE_PREFIX_RE = /^(\d{2}|\d{4}|99\d{3}|\d{6}|\d{8})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** API shape of RateRuleInput (INR numbers, openapi). */
export interface RuleInputApi {
  hsn_prefix: string;
  igst_rate_bp: number;
  cess?: { rate_bp: number; specific_amount?: number | null; specific_unit?: string | null } | undefined;
  condition: { kind: 'none' | 'price' | 'other'; code?: string | null; text?: string | null; min_unit_price?: number | null; max_unit_price?: number | null };
  effective_from: string;
  effective_to?: string | null | undefined;
  source: { notification: string; url: string; pdf_sha256: string; schedule_serial: string };
}

export type RefdataChangeApi =
  | { table: 'synonym'; op: 'add'; phrase: string; hsn_code: string; strength?: 'primary' | 'related'; note?: string | null; rule_hint?: string | null }
  | { table: 'synonym' | 'category_map' | 'chapter_keyword'; op: 'deactivate'; id: number }
  | { table: 'category_map'; op: 'add'; source: string; category: string; hsn_prefix: string }
  | { table: 'chapter_keyword'; op: 'add'; keyword: string; chapter: string }
  | { table: 'hsn_description'; op: 'update'; code: string; description: string; keywords?: string }
  | { table: 'hsn_code'; op: 'add_code'; code: string; description: string; keywords?: string; type?: 'goods' | 'service' };

/** Nearest existing ancestor at a valid shorter length (8→6→5(SAC)→4→2), as the seed computes it. */
export function nearestParent(code: string, exists: (c: string) => boolean): string | null {
  for (const len of [6, 5, 4, 2]) {
    if (len >= code.length) continue;
    if (len === 5 && !code.startsWith('99')) continue;
    const p = code.slice(0, len);
    if (exists(p)) return p;
  }
  return null;
}

export interface AdminGrantApi {
  handle: string;
  display_name?: string;
  /** true: create this actor; false: an existing actor gets one more admin key */
  new_actor: boolean;
}

/** SA-C2-04: disable an admin actor (their keys stop working; their pending proposals are withdrawn). */
export interface DisableActorApi {
  handle: string;
}

/**
 * API actions; disable_actor is stored as an admin_grant row with payload.op = "disable_actor", and
 * dataset_import (scripts/import-dataset.ts only, round 5) as a refdata_change row with payload.op = "dataset_import".
 */
export type ProposalApiAction = ProposalAction | 'disable_actor' | 'dataset_import';

export interface ProposalCreateApi {
  action: ProposalApiAction;
  supersedes_rule_id?: string | undefined;
  end_date?: string | undefined;
  rule?: RuleInputApi | undefined;
  /**
   * verify only: the PDF the checker compares against (ruling 12); ruling 36: the notification document URL
   * (required when the rule cites an index/listing page) and optionally the canonical notification reference
   */
  source?: { pdf_sha256: string; schedule_serial: string; url?: string | undefined; notification?: string | undefined } | undefined;
  grant?: AdminGrantApi | undefined;
  disable?: DisableActorApi | undefined;
  refdata?: RefdataChangeApi | undefined;
  rationale: string;
  retroactive_reason?: string | undefined;
}

export interface TargetRuleSummary {
  rule_id: string;
  hsn_prefix: string;
  igst_rate_bp: number;
  igst_rate_percent: number;
  condition_kind: string;
  condition_text: string | null;
  effective_from: string;
  effective_to: string | null;
  status: string;
  verification_status: string;
  notification: string;
  /** seed caveat on the target (e.g. "gazette not read"): what a verify proposal is checking; null once verified */
  citation_note: string | null;
}

export interface ProposalDto {
  id: string;
  status: ProposalStatus;
  action: ProposalApiAction;
  supersedes_rule_id: string | null;
  /** what the proposal changes, as currently published (SA-C-02: the checker sees what is ended) */
  target_rule: TargetRuleSummary | null;
  end_date: string | null;
  rule: RuleInputApi | null;
  payload: Record<string, unknown> | null;
  rationale: string;
  retroactive: boolean;
  retroactive_reason: string | null;
  content_sha256: string;
  proposed_by: string;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  resulting_rule_id: string | null;
  resulting_dataset_version: string | null;
}

export function ruleInputToApi(r: RuleInput): RuleInputApi {
  return {
    hsn_prefix: r.hsn_prefix,
    igst_rate_bp: r.igst_rate_bp,
    cess: {
      rate_bp: r.cess_rate_bp,
      specific_amount: r.cess_specific_paise === null ? null : paiseToRupees(r.cess_specific_paise),
      specific_unit: r.cess_specific_unit,
    },
    condition: {
      kind: r.condition_kind,
      code: r.condition_code,
      text: r.condition_text,
      min_unit_price: r.min_unit_price_paise === null ? null : paiseToRupees(r.min_unit_price_paise),
      max_unit_price: r.max_unit_price_paise === null ? null : paiseToRupees(r.max_unit_price_paise),
    },
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    source: { notification: r.notification_ref, url: r.source_url, pdf_sha256: r.source_pdf_sha256, schedule_serial: r.schedule_serial },
  };
}

function targetSummary(r: RateRuleRow): TargetRuleSummary {
  return {
    rule_id: r.rule_id,
    hsn_prefix: r.hsn_prefix,
    igst_rate_bp: r.igst_rate_bp,
    igst_rate_percent: bpToPercent(r.igst_rate_bp),
    condition_kind: r.condition_kind,
    condition_text: r.condition_text,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    status: r.status,
    verification_status: r.verification_status,
    notification: r.notification_ref,
    citation_note: r.citation_note ?? null,
  };
}

export function proposalToDto(p: ProposalRow, repos?: Repos): ProposalDto {
  const target = p.supersedes_rule_id && repos ? repos.rules.get(p.supersedes_rule_id) : null;
  return {
    id: p.id,
    status: p.status,
    action: isDisableActor(p) ? 'disable_actor' : isDatasetImport(p) ? 'dataset_import' : p.action,
    supersedes_rule_id: p.supersedes_rule_id,
    target_rule: target ? targetSummary(target) : null,
    end_date: p.end_date,
    rule: p.rule === null ? null : ruleInputToApi(p.rule),
    payload: p.payload,
    rationale: p.rationale,
    retroactive: p.retroactive_reason !== null,
    retroactive_reason: p.retroactive_reason,
    content_sha256: p.content_sha256,
    proposed_by: p.proposed_by,
    proposed_at: p.proposed_at,
    decided_by: p.decided_by,
    decided_at: p.decided_at,
    decision_comment: p.decision_comment,
    resulting_rule_id: p.resulting_rule_id,
    resulting_dataset_version: p.resulting_version,
  };
}

export const isDisableActor = (p: Pick<ProposalRow, 'action' | 'payload'>): boolean => p.action === 'admin_grant' && p.payload?.['op'] === 'disable_actor';
/** A whole-dataset load into an empty production DB (R11); proposed and approved only with scripts/import-dataset.ts. */
export const isDatasetImport = (p: Pick<ProposalRow, 'action' | 'payload'>): boolean => p.action === 'refdata_change' && p.payload?.['op'] === 'dataset_import';

/** Admin grants not redeemed within this many hours of approval expire (SA-C2-05; the DB enforces ≤ 72 h). */
export const ADMIN_GRANT_TTL_HOURS = 72;

// ------------------------------------------------------------------ hashing helpers

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** sha256 of a published rule row as it stands (approval binding, ruling 20). */
export function ruleRowSha256(r: RateRuleRow): string {
  return sha256Hex(canonicalJson(r));
}

/** sha256 of the canonical proposal content: what the checker must have reviewed. */
export function proposalContentSha256(p: Pick<ProposalRow, 'action' | 'supersedes_rule_id' | 'end_date' | 'rule' | 'payload' | 'rationale' | 'retroactive_reason' | 'target_sha256'>): string {
  return sha256Hex(
    canonicalJson({
      action: p.action,
      supersedes_rule_id: p.supersedes_rule_id,
      end_date: p.end_date,
      rule: p.rule,
      payload: p.payload,
      rationale: p.rationale,
      retroactive_reason: p.retroactive_reason,
      target_sha256: p.target_sha256,
    }),
  );
}

// ------------------------------------------------------------------ validation helpers

export interface RuleValidationOptions {
  allowedRatesBp: readonly number[];
  sourceHosts: readonly string[];
  /** ruling 36: when given, a rule published by a proposal (verified) must cite a notification document */
  indexPages?: readonly string[] | undefined;
}

/**
 * Citation URL check (SEC-51, ruling 25, SA-D-17): parsed with URL; https; default port; no
 * credentials; ASCII hostname exactly in the allow-list (a trailing dot is refused, T-A07); a document path.
 */
export function sourceUrlProblem(url: string, hosts: readonly string[], requirePath = false): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Must be a valid absolute URL';
  }
  if (u.protocol !== 'https:') return 'Must use https';
  if (u.port !== '' && u.port !== '443') return 'Must use the default https port';
  if (u.username !== '' || u.password !== '') return 'Must not contain credentials';
  // T-A07: the citation is shown to clients as written, so it must be the canonical host (no trailing dot)
  if (u.hostname.endsWith('.')) return 'Host must not end with a dot';
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return 'Host must be plain ASCII';
  if (!hosts.includes(host)) return `Host must be one of: ${hosts.join(', ')}`;
  if (requirePath && (u.pathname === '/' || u.pathname === '')) return 'Must link the specific notification document, not a site root';
  if (requirePath && (url.includes('?') || url.includes('#'))) return 'Must not contain a query string or fragment (SA-C5-03)';
  return null;
}

/** Long series names accepted on input and rewritten to the canonical short form. */
const SERIES_LONG: readonly [RegExp, string][] = [
  [/-\s*Central Tax\s*\(Rate\)/gi, '-CT(Rate)'],
  [/-\s*Integrated Tax\s*\(Rate\)/gi, '-IT(Rate)'],
  [/-\s*Union Territory Tax\s*\(Rate\)/gi, '-UTT(Rate)'],
  [/-\s*(?:Compensation )?Cess\s*\(Rate\)/gi, '-Cess(Rate)'],
  [/-\s*(CT|IT|UTT)\s*\(Rate\)/g, '-$1(Rate)'],
];

/**
 * Canonical notification number: no zero padding ("01/2026-CT(Rate)" -> "1/2026-CT(Rate)"), trimmed, single
 * spaces, and the long series names ("Central Tax (Rate)") shortened to CT/IT/UTT/Cess. Applied to every rule
 * citation (proposals, verify, seed, import-dataset); the result must then pass notificationRefProblem.
 */
export function normaliseNotificationRef(ref: string): string {
  let s = ref.trim().replace(/\s+/g, ' ').replace(/(^|[^0-9])0+([1-9][0-9]*)\/((?:19|20)[0-9]{2})/g, '$1$2/$3');
  for (const [re, to] of SERIES_LONG) s = s.replace(re, to);
  return s;
}

/**
 * Validator round 4 N3: the canonical citation form (data-model §1, data/seed/FORMAT.md):
 * `<n>/<yyyy>-<CT|IT|UTT|Cess>(Rate)[, Schedule <roman>]`, e.g. "9/2025-CT(Rate), Schedule IV". The serial
 * number inside the schedule is schedule_serial, not part of the citation.
 */
export const NOTIFICATION_REF_RE = /^[1-9][0-9]{0,3}\/(19|20)[0-9]{2}-(CT|IT|UTT|Cess)\(Rate\)(, Schedule (I|II|III|IV|V|VI|VII))?$/;
export const NOTIFICATION_REF_HELP = 'Use the canonical form <n>/<yyyy>-<CT|IT|UTT|Cess>(Rate)[, Schedule <I–VII>], e.g. "9/2025-CT(Rate), Schedule IV"';

/** Problem with an already-normalised citation, or null when it is canonical. */
export function notificationRefProblem(normalised: string): string | null {
  return NOTIFICATION_REF_RE.test(normalised) ? null : `"${normalised.slice(0, 80)}" is not a notification citation. ${NOTIFICATION_REF_HELP}`;
}

/**
 * Ruling 36: whether a citation URL points at a notification document. Not a document: a configured
 * listing/index page, or a URL whose path neither contains /view-pdf/ nor ends in .pdf.
 */
export function isDocumentUrl(url: string, indexPages: readonly string[]): boolean {
  return documentUrlProblem(url, indexPages) === null;
}

/**
 * Comparison key for index pages (SA-C5-03): origin + lower-cased path with repeated slashes collapsed and a
 * trailing slash dropped; query and fragment ignored. Invalid URLs map to null.
 */
export function indexPageKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return `${u.origin.toLowerCase()}${path}`;
}

const VIEW_PDF_PATH = /^\/view-pdf\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/?$/;
const PDF_PATH = /^(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\.pdf$/i;

/**
 * Ruling 36 / SA-C5-03: why a citation URL is not a notification document, or null when it is. A document URL
 * has no query, fragment or path parameters, a path that is exactly as written (no "..", "%2e", "%2f", "\\",
 * "//", ";"), and is either /view-pdf/<id>[/…] or a *.pdf file; and it is not a configured index page.
 */
export function documentUrlProblem(url: string, indexPages: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Must be a valid absolute URL';
  }
  if (url.includes('?') || url.includes('#')) return 'Must not contain a query string or fragment';
  const raw = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?$/i.exec(url)?.[1] ?? '/';
  if (raw !== u.pathname || /;|%2e|%2f|%5c|\/\//i.test(raw)) return 'Path must be plain (no ";", "..", "//" or encoded dots/slashes)';
  const key = indexPageKey(url);
  if (key !== null && indexPages.some((p) => indexPageKey(p) === key)) return 'Is a listing/index page, not the notification document';
  if (!VIEW_PDF_PATH.test(raw) && !PDF_PATH.test(raw)) return 'Must link the notification document: a /view-pdf/<id> or *.pdf URL';
  return null;
}

/** Convert + validate an API rule input into internal paise/bp form. Throws 400 with pointers. */
export function toRuleInput(api: RuleInputApi, opts: RuleValidationOptions, base = '/rule'): RuleInput {
  const errs: FieldError[] = [];
  const err = (pointer: string, code: string, message: string) => errs.push({ pointer: `${base}${pointer}`, code, message });

  if (!RULE_PREFIX_RE.test(api.hsn_prefix)) err('/hsn_prefix', 'pattern', 'Must be 2, 4, 6 or 8 digits (5 only for SAC groups 99xxx)');
  if (!opts.allowedRatesBp.includes(api.igst_rate_bp)) err('/igst_rate_bp', 'enum', `Must be an allowed slab (bp): ${opts.allowedRatesBp.join(', ')}`);

  const cessBp = api.cess?.rate_bp ?? 0;
  if (!Number.isInteger(cessBp) || cessBp < 0 || cessBp > 30000) err('/cess/rate_bp', 'range', 'Must be an integer 0–30000');
  let cessSpecific: number | null = null;
  const sa = api.cess?.specific_amount ?? null;
  const su = api.cess?.specific_unit ?? null;
  if ((sa === null) !== (su === null)) err('/cess', 'pair', 'specific_amount and specific_unit must both be set or both be null');
  if (sa !== null) {
    const p = parseRupees(sa);
    if (p === null || p <= 0) err('/cess/specific_amount', 'amount', 'Must be a positive INR amount with at most 2 decimals');
    else cessSpecific = p;
  }

  const c = api.condition;
  const minRaw = c.min_unit_price ?? null;
  const maxRaw = c.max_unit_price ?? null;
  let minP: number | null = null;
  let maxP: number | null = null;
  if (minRaw !== null) {
    minP = parseRupees(minRaw);
    if (minP === null) err('/condition/min_unit_price', 'amount', 'Must be a non-negative INR amount with at most 2 decimals');
  }
  if (maxRaw !== null) {
    maxP = parseRupees(maxRaw);
    if (maxP === null) err('/condition/max_unit_price', 'amount', 'Must be a non-negative INR amount with at most 2 decimals');
  }
  const text = c.text === null || c.text === undefined ? null : c.text.trim();
  const code = c.code ?? null;
  if (code !== null && !(CONDITION_CODES as readonly string[]).includes(code)) err('/condition/code', 'enum', `Must be one of: ${CONDITION_CODES.join(', ')}`);
  if (code !== null && c.kind !== 'other') err('/condition/code', 'kind', 'Only kind "other" rules carry a condition code');
  if (c.kind === 'none') {
    if (minRaw !== null || maxRaw !== null) err('/condition', 'kind', 'kind "none" must not carry price bounds');
  } else {
    if (text === null || text.length === 0) err('/condition/text', 'required', `kind "${c.kind}" requires the notification's condition text`);
    if (c.kind === 'price' && minRaw === null && maxRaw === null) err('/condition', 'bounds', 'kind "price" needs min_unit_price and/or max_unit_price');
    if (c.kind === 'other' && (minRaw !== null || maxRaw !== null)) err('/condition', 'kind', 'kind "other" must not carry price bounds; use kind "price"');
  }
  if (minP !== null && maxP !== null && minP > maxP) err('/condition', 'bounds', 'min_unit_price must be <= max_unit_price');

  if (!isRealDate(api.effective_from)) err('/effective_from', 'format', 'Must be a real date YYYY-MM-DD');
  else if (api.effective_from < GST_START) err('/effective_from', 'minimum', 'Must be on or after 2017-07-01');
  const to = api.effective_to ?? null;
  if (to !== null) {
    if (!isRealDate(to)) err('/effective_to', 'format', 'Must be a real date YYYY-MM-DD');
    else if (to < api.effective_from) err('/effective_to', 'minimum', 'Must be on or after effective_from');
  }
  const notification = normaliseNotificationRef(api.source.notification);
  const notifProblem = notificationRefProblem(notification);
  if (notifProblem) err('/source/notification', 'pattern', notifProblem);
  const urlProblem = sourceUrlProblem(api.source.url, opts.sourceHosts, true)
    ?? (opts.indexPages ? documentUrlProblem(api.source.url, opts.indexPages) : null);
  if (urlProblem) err('/source/url', 'source_url', urlProblem);
  if (!SHA256_RE.test(api.source.pdf_sha256 ?? '')) err('/source/pdf_sha256', 'pattern', 'sha256 of the notification PDF (64 lower-case hex)');
  const serial = (api.source.schedule_serial ?? '').trim();
  if (serial.length < 1 || serial.length > 100) err('/source/schedule_serial', 'required', 'Schedule and serial number, e.g. "Sch II Sr 46"');

  if (errs.length > 0) throw validationError(errs);
  return {
    hsn_prefix: api.hsn_prefix,
    igst_rate_bp: api.igst_rate_bp,
    cess_rate_bp: cessBp,
    cess_specific_paise: cessSpecific,
    cess_specific_unit: su,
    condition_kind: c.kind,
    condition_text: c.kind === 'none' ? null : text,
    condition_code: code,
    min_unit_price_paise: minP,
    max_unit_price_paise: maxP,
    effective_from: api.effective_from,
    effective_to: to,
    notification_ref: notification,
    source_url: api.source.url,
    source_pdf_sha256: api.source.pdf_sha256,
    schedule_serial: serial,
  };
}

type Interval = Pick<RuleInput, 'hsn_prefix' | 'condition_kind' | 'condition_text' | 'min_unit_price_paise' | 'max_unit_price_paise' | 'effective_from' | 'effective_to'>;

/**
 * Overlap (data-model §3, ruling 5): same prefix, overlapping inclusive date ranges, and overlapping
 * conditions: none–none and none–price overlap; price–price overlap when inclusive bounds intersect;
 * other–other only when the condition text is identical. A general (`none`) rule and `other`-condition
 * exceptions legitimately coexist and resolve as ambiguous with default_rule_id = the general rule.
 */
export function rulesOverlap(a: Interval, b: Interval): boolean {
  if (a.hsn_prefix !== b.hsn_prefix) return false;
  const aTo = a.effective_to ?? '9999-12-31';
  const bTo = b.effective_to ?? '9999-12-31';
  if (a.effective_from > bTo || b.effective_from > aTo) return false;
  if (a.condition_kind === 'other' || b.condition_kind === 'other') {
    return a.condition_kind === 'other' && b.condition_kind === 'other' && (a.condition_text ?? '') === (b.condition_text ?? '');
  }
  if (a.condition_kind === 'none' || b.condition_kind === 'none') return true;
  const aMin = a.min_unit_price_paise ?? 0;
  const bMin = b.min_unit_price_paise ?? 0;
  const aMax = a.max_unit_price_paise ?? Number.MAX_SAFE_INTEGER;
  const bMax = b.max_unit_price_paise ?? Number.MAX_SAFE_INTEGER;
  return aMin <= bMax && bMin <= aMax;
}

const describe = (r: Interval): string =>
  `${r.hsn_prefix} (${r.condition_kind === 'none' ? 'no condition' : r.condition_kind}) on ${r.effective_from}..${r.effective_to ?? 'open'}`;

/** Earliest date whose answer the proposal changes, or null (verify/admin/refdata). */
function effectStart(action: ProposalAction, rule: RuleInput | null, target: RateRuleRow | null, endDate: string | null): string | null {
  switch (action) {
    case 'create':
    case 'supersede':
      return rule?.effective_from ?? null;
    case 'correct': {
      const a = rule?.effective_from ?? '9999-12-31';
      const b = target?.effective_from ?? '9999-12-31';
      return a < b ? a : b;
    }
    case 'end_date':
      return endDate === null ? null : addDays(endDate as IsoDate, 1);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------- service

export interface ProposalServiceDeps {
  tx: TxRunner;
  read: Repos;
  clock: Clock;
  allowedRatesBp: readonly number[];
  sourceHosts: readonly string[];
  /** ruling 36: listing/index pages (config.sourceIndexPages) */
  sourceIndexPages?: readonly string[];
  auditKey: string;
  signingKey?: KeyObject | null;
  onAuditHead?: ChainHeadLogger;
  /** invoked after a successful publish (cache invalidation) */
  onPublish?: (version: string) => void;
  /**
   * Ruling 29: an approved admin_grant is a security event. v1 records an audit entry and calls this
   * (a warn-level log line the operator alerts on); an out-of-band notifier is deferred.
   */
  onAdminGrant?: (e: { proposal_id: string; handle: string; new_actor: boolean; proposed_by: string; approved_by: string; at: string }) => void;
  /** SA-C2-04: an approved disable_actor proposal (security event, warn line) */
  onActorDisabled?: (e: { handle: string; proposal_id: string; approved_by: string; withdrawn: string[] }) => void;
}

/**
 * SA-C2-04: disable an admin actor inside a write transaction: sets disabled_at (their keys stop
 * authenticating at once) and withdraws every pending proposal they made. Audited. Used by an approved
 * disable_actor proposal and by scripts/disable-actor.ts. Returns the withdrawn proposal ids.
 */
export function disableActorInTx(
  repos: Repos,
  auditKey: string,
  o: { handle: string; at: string; by: string; keyPrefix: string | null; note: string; proposalId: string | null },
): string[] {
  const actor = repos.actors.byHandle(o.handle);
  if (!actor) throw new AppError('not_found', `No admin actor "${o.handle}".`);
  if (!repos.actors.disable(actor.id, o.at)) throw new AppError('proposal_stale', `Actor "${o.handle}" is already disabled.`);
  const withdrawn: string[] = [];
  for (const q of repos.proposals.pending()) {
    if (q.proposed_by_actor_id !== actor.id) continue;
    repos.proposals.decide(q.id, {
      status: 'withdrawn', decided_by: o.by, decided_by_actor_id: null, decided_key_id: null, decided_at: o.at,
      decision_comment: `proposer disabled (${o.note})`.slice(0, 1000), resulting_rule_id: null, resulting_version: null,
    });
    appendAudit(repos.audit, auditKey, {
      at: o.at, actor: o.by, key_prefix: o.keyPrefix, action: 'rate_proposal.withdrawn', entity_type: 'rate_proposal', entity_id: q.id,
      details: { reason: 'proposer disabled', content_sha256: q.content_sha256, disabled_actor: actor.handle },
    });
    withdrawn.push(q.id);
  }
  appendAudit(repos.audit, auditKey, {
    at: o.at, actor: o.by, key_prefix: o.keyPrefix, action: 'admin.disabled', entity_type: 'admin_actor', entity_id: actor.id,
    details: { handle: actor.handle, proposal_id: o.proposalId, note: o.note, withdrawn },
  });
  return withdrawn;
}

/** Maker ≠ checker, pending, proposer active, quoted content hash (shared with scripts/import-dataset.ts). */
export function loadForDecision(repos: Repos, id: string, who: Pick<Actor, 'actorId'>, expected: string, verb: string): ProposalRow {
  const p = repos.proposals.get(id);
  if (!p) throw new AppError('proposal_not_found', `No rate proposal ${id}.`);
  if (p.proposed_by_actor_id === who.actorId) {
    throw new AppError('maker_checker_violation', `Proposal ${id} was created by actor "${p.proposed_by}"; it must be ${verb} by a different actor.`);
  }
  if (p.status !== 'pending') throw new AppError('proposal_not_pending', `Proposal ${id} is ${p.status}.`);
  // SA-C2-04: a disabled actor's proposals cannot be decided (disabling normally withdraws them)
  const proposer = repos.actors.get(p.proposed_by_actor_id);
  if (!proposer || proposer.disabled_at !== null) {
    throw new AppError('proposer_disabled', `Proposal ${id} was made by actor "${p.proposed_by}", who has been disabled; it can no longer be decided.`);
  }
  // SA-C3-01: the stored hash proves nothing about stored content a database writer may have swapped;
  // recompute it from what will actually be published.
  if (proposalContentSha256(p) !== p.content_sha256) {
    throw new AppError('proposal_hash_mismatch', `Proposal ${id}'s stored content no longer matches its content_sha256; it was altered after it was made. It cannot be decided; investigate (verify-audit) and re-propose.`);
  }
  if (expected !== p.content_sha256) {
    throw new AppError('proposal_hash_mismatch', `expected_sha256 does not match proposal ${id} (content_sha256 ${p.content_sha256}). Re-read the proposal before deciding.`);
  }
  return p;
}

export interface DecisionInput {
  expectedSha256: string;
  comment: string | null;
}

export class ProposalService {
  constructor(private readonly d: ProposalServiceDeps) {}

  private today(): string {
    return istDate(this.d.clock.now());
  }

  private validateAgainstPublished(repos: Repos, action: ProposalAction, rule: RuleInput | null, target: RateRuleRow | null, endDate: string | null, selfId: string | null): void {
    if (target) {
      if (target.status !== 'active') throw new AppError('rule_not_active', `${target.rule_id} is ${target.status}; it cannot be changed.`);
      if (rule && rule.hsn_prefix !== target.hsn_prefix) {
        // SA-C-02: a superseding or correcting rule must be for the same prefix as the rule it ends.
        throw validationError([{ pointer: '/rule/hsn_prefix', code: 'prefix_mismatch', message: `Must equal the target rule's prefix ${target.hsn_prefix}` }]);
      }
    }
    if (action === 'supersede' && target && rule) {
      if (target.superseded_by !== null) throw new AppError('rule_not_active', `${target.rule_id} is already superseded by ${target.superseded_by}.`);
      if (rule.effective_from <= target.effective_from) {
        throw new AppError('rule_not_active', `New rule must start after ${target.rule_id} starts (${target.effective_from}); use action "correct" to replace it from its first day.`);
      }
      if (target.effective_to !== null) {
        throw new AppError('rule_not_active', `${target.rule_id} already ends on ${target.effective_to}; use action "create" (or "correct").`);
      }
    }
    if (action === 'end_date' && target && endDate) {
      if (endDate < target.effective_from) throw validationError([{ pointer: '/end_date', code: 'minimum', message: `Must be on or after ${target.effective_from}` }]);
      if (target.effective_to !== null) throw new AppError('rule_not_active', `${target.rule_id} already ends on ${target.effective_to}; end dates are set once.`);
    }
    if (!rule) return;
    if (!repos.hsn.get(rule.hsn_prefix)) {
      throw validationError([{ pointer: '/rule/hsn_prefix', code: 'unknown_hsn', message: `HSN/SAC ${rule.hsn_prefix} does not exist in the dataset` }]);
    }
    for (const r of repos.rules.byPrefix(rule.hsn_prefix)) {
      if (action === 'correct' && target && r.rule_id === target.rule_id) continue; // voided by this proposal
      let eff: Interval = r;
      if (target && r.rule_id === target.rule_id && action === 'supersede') {
        eff = { ...r, effective_to: addDays(rule.effective_from as IsoDate, -1) };
      }
      if (rulesOverlap(rule, eff)) {
        throw new AppError(
          'overlapping_rule',
          `Rule for prefix ${describe(rule)} would overlap ${r.rule_id} (${describe(eff)}). Use action "supersede" or "correct" with supersedes_rule_id, or end-date it first.`,
        );
      }
    }
    for (const p of repos.proposals.pending()) {
      if (p.id === selfId || p.rule === null) continue;
      if (rulesOverlap(rule, p.rule)) throw new AppError('overlapping_rule', `Rule ${describe(rule)} overlaps pending proposal ${p.id}.`);
    }
  }

  private validateRefdata(repos: Repos, r: RefdataChangeApi): Record<string, unknown> {
    const bad = (pointer: string, code: string, message: string): never => {
      throw validationError([{ pointer: `/refdata${pointer}`, code, message }]);
    };
    if (r.op === 'deactivate') {
      if (!['synonym', 'category_map', 'chapter_keyword'].includes(r.table)) bad('/op', 'enum', `${r.table} rows cannot be deactivated`);
      const row =
        r.table === 'synonym' ? repos.synonyms.getById(r.id) : r.table === 'category_map' ? repos.synonyms.getCategory(r.id) : repos.synonyms.getChapterKeyword(r.id);
      if (!row) bad('/id', 'unknown', `No ${r.table} row ${r.id}`);
      if (!row!.active) bad('/id', 'inactive', `${r.table} row ${r.id} is already inactive`);
      return { table: r.table, op: 'deactivate', id: r.id };
    }
    switch (r.table) {
      case 'synonym': {
        if (r.op !== 'add') return bad('/op', 'enum', 'synonym ops: add, deactivate');
        const phrase = r.phrase.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
        if (phrase.length < 1 || phrase.length > 200) bad('/phrase', 'length', '1–200 characters');
        if (!repos.hsn.get(r.hsn_code)) bad('/hsn_code', 'unknown_hsn', `HSN/SAC ${r.hsn_code} does not exist`);
        const hint = r.rule_hint ?? null;
        if (hint !== null && !(CONDITION_CODES as readonly string[]).includes(hint)) bad('/rule_hint', 'enum', `Must be one of: ${CONDITION_CODES.join(', ')}`);
        if (repos.synonyms.byPhrases([phrase]).some((s) => s.hsn_code === r.hsn_code)) bad('/phrase', 'duplicate', 'An active synonym with this phrase and code exists; deactivate it first');
        return { table: 'synonym', op: 'add', phrase, hsn_code: r.hsn_code, strength: r.strength ?? 'primary', note: r.note ?? null, rule_hint: hint };
      }
      case 'category_map': {
        if (r.op !== 'add') return bad('/op', 'enum', 'category_map ops: add, deactivate');
        if (!RULE_PREFIX_RE.test(r.hsn_prefix) || !repos.hsn.get(r.hsn_prefix)) bad('/hsn_prefix', 'unknown_hsn', 'Must be an existing HSN/SAC code');
        if (repos.synonyms.categoryPrefix(r.source, r.category) !== null) bad('/category', 'duplicate', 'This category is already mapped; deactivate the mapping first');
        return { table: 'category_map', op: 'add', source: r.source, category: r.category, hsn_prefix: r.hsn_prefix };
      }
      case 'chapter_keyword': {
        if (r.op !== 'add') return bad('/op', 'enum', 'chapter_keyword ops: add, deactivate');
        if (!/^[\p{Ll}\p{N}][\p{Ll}\p{N}-]{0,63}$/u.test(r.keyword)) bad('/keyword', 'pattern', 'single lower-case token');
        if (!/^\d{2}$/.test(r.chapter) || !repos.hsn.get(r.chapter)) bad('/chapter', 'unknown_hsn', 'Must be an existing 2-digit chapter');
        if (repos.synonyms.chaptersForKeywords([r.keyword]).some((k) => k.chapter === r.chapter)) bad('/keyword', 'duplicate', 'Already active');
        return { table: 'chapter_keyword', op: 'add', keyword: r.keyword, chapter: r.chapter };
      }
      case 'hsn_code': {
        if (r.op !== 'add_code') return bad('/op', 'enum', 'hsn_code ops: add_code');
        if (!RULE_PREFIX_RE.test(r.code)) bad('/code', 'pattern', 'HSN/SAC codes have 2, 4, 6 or 8 digits (5 for SAC groups 99xxx)');
        if (repos.hsn.get(r.code)) bad('/code', 'duplicate', `HSN/SAC ${r.code} already exists; use hsn_description update to change its text`);
        const isService = r.code.startsWith('99');
        const type = r.type ?? (isService ? 'service' : 'goods');
        if ((type === 'service') !== isService) bad('/type', 'mismatch', 'Chapter 99 codes are services (SAC); every other chapter is goods');
        let parent: string | null = null;
        if (r.code.length > 2) {
          if (!repos.hsn.get(r.code.slice(0, 2))) bad('/code', 'unknown_parent', `Chapter ${r.code.slice(0, 2)} does not exist`);
          parent = nearestParent(r.code, (c) => repos.hsn.get(c) !== null);
          if (parent === null || (r.code.length >= 6 && parent.length < 4)) {
            bad('/code', 'unknown_parent', `No parent heading for ${r.code}: add the ${r.code.length >= 6 ? '4-digit heading' : 'chapter'} first`);
          }
        }
        const description = r.description.trim();
        if (description.length < 1 || description.length > 2000) bad('/description', 'length', '1–2000 characters');
        const keywords = (r.keywords ?? '').trim();
        if (keywords.length > 2000) bad('/keywords', 'length', 'at most 2000 characters');
        const clash = repos.proposals.pending().find((p) => p.action === 'refdata_change' && p.payload?.['op'] === 'add_code' && p.payload?.['code'] === r.code);
        if (clash) bad('/code', 'duplicate', `Proposal ${clash.id} already adds ${r.code}`);
        return { table: 'hsn_code', op: 'add_code', code: r.code, level: r.code.length, parent, type, description, keywords };
      }
      case 'hsn_description': {
        if (r.op !== 'update') return bad('/op', 'enum', 'hsn_description ops: update');
        const row = repos.hsn.get(r.code);
        if (!row) bad('/code', 'unknown_hsn', `HSN/SAC ${r.code} does not exist`);
        const description = r.description.trim();
        if (description.length < 1 || description.length > 2000) bad('/description', 'length', '1–2000 characters');
        return { table: 'hsn_description', op: 'update', code: r.code, description, keywords: (r.keywords ?? row!.keywords).trim() };
      }
      default:
        return bad('/table', 'enum', 'Unknown table');
    }
  }

  create(body: ProposalCreateApi, who: Actor, idem: IdempotencyContext | null): { proposal: ProposalDto; replayed: boolean } {
    const errs: FieldError[] = [];
    const disable = body.action === 'disable_actor';
    const a: ProposalAction = disable ? 'admin_grant' : (body.action as ProposalAction);
    const needsTarget = a === 'supersede' || a === 'end_date' || a === 'verify' || a === 'correct';
    const needsRule = a === 'create' || a === 'supersede' || a === 'correct';
    const allowed: Record<string, boolean> = {
      supersedes_rule_id: needsTarget,
      rule: needsRule,
      end_date: a === 'end_date',
      source: a === 'verify',
      grant: a === 'admin_grant' && !disable,
      disable,
      refdata: a === 'refdata_change',
    };
    for (const [field, ok] of Object.entries(allowed)) {
      const present = (body as unknown as Record<string, unknown>)[field] !== undefined;
      if (ok && !present) errs.push({ pointer: `/${field}`, code: 'required', message: `Required for action "${a}"` });
      if (!ok && present) errs.push({ pointer: `/${field}`, code: 'forbidden', message: `Not allowed for action "${a}"` });
    }
    if (body.end_date && !isRealDate(body.end_date)) errs.push({ pointer: '/end_date', code: 'format', message: 'Must be a real date YYYY-MM-DD' });
    if (body.source && (!SHA256_RE.test(body.source.pdf_sha256) || body.source.schedule_serial.trim().length === 0)) {
      errs.push({ pointer: '/source', code: 'source', message: 'pdf_sha256 (64 lower-case hex) and schedule_serial are required to verify (ruling 12)' });
    }
    if (errs.length > 0) throw validationError(errs);

    const rule = body.rule ? toRuleInput(body.rule, { allowedRatesBp: this.d.allowedRatesBp, sourceHosts: this.d.sourceHosts, indexPages: this.d.sourceIndexPages }) : null;

    return this.d.tx((repos) =>
      runIdempotent(repos, idem, this.d.clock, 201, () => {
        let target: RateRuleRow | null = null;
        if (body.supersedes_rule_id) {
          target = repos.rules.get(body.supersedes_rule_id);
          if (!target) throw validationError([{ pointer: '/supersedes_rule_id', code: 'unknown_rule', message: 'No such rate rule' }]);
        }
        this.validateAgainstPublished(repos, a, rule, target, body.end_date ?? null, null);

        let payload: Record<string, unknown> | null = null;
        if (a === 'verify') payload = { source: this.verifySource(body.source!, target!) };
        if (disable) {
          let handle: string;
          try {
            handle = normaliseHandle(body.disable!.handle);
          } catch (e) {
            throw validationError([{ pointer: '/disable/handle', code: 'pattern', message: (e as KeyInputError).message }]);
          }
          const target = repos.actors.byHandle(handle);
          if (!target || target.disabled_at !== null) throw validationError([{ pointer: '/disable/handle', code: 'unknown', message: `No active actor "${handle}"` }]);
          // maker–checker must stay possible afterwards: at least two active actors remain
          if (repos.actors.activeCount() - 1 < 2) {
            throw validationError([{ pointer: '/disable/handle', code: 'last_actors', message: 'Disabling this actor would leave fewer than two active admins; grant a third admin first (admin_grant), then disable. To cut off a leaked key now, revoke that key (create-key --revoke)' }]);
          }
          payload = { op: 'disable_actor', handle };
        } else if (a === 'admin_grant') {
          let handle: string;
          try {
            handle = normaliseHandle(body.grant!.handle);
          } catch (e) {
            throw validationError([{ pointer: '/grant/handle', code: 'pattern', message: (e as KeyInputError).message }]);
          }
          const existing = repos.actors.byHandle(handle);
          if (body.grant!.new_actor && existing) throw validationError([{ pointer: '/grant/handle', code: 'duplicate', message: `Actor "${handle}" already exists` }]);
          if (!body.grant!.new_actor && (!existing || existing.disabled_at !== null)) {
            throw validationError([{ pointer: '/grant/handle', code: 'unknown', message: `No active actor "${handle}"` }]);
          }
          // SA-C2-05: an extra key for an existing actor is requested by that actor (and approved by another)
          if (!body.grant!.new_actor && existing!.id !== who.actorId) {
            throw validationError([{ pointer: '/grant/handle', code: 'not_self', message: `Only "${handle}" may request an extra admin key for "${handle}"` }]);
          }
          payload = { handle, display_name: (body.grant!.display_name ?? '').trim().slice(0, 100), new_actor: body.grant!.new_actor };
        }
        if (a === 'refdata_change') payload = this.validateRefdata(repos, body.refdata!);

        // retroactive effects need an explicit reason (ruling 25, SA-C-02)
        const start = effectStart(a, rule, target, body.end_date ?? null);
        const retro = start !== null && start < this.today();
        const reason = body.retroactive_reason?.trim() ?? null;
        if (retro && (reason === null || reason.length < 10)) {
          throw validationError([
            { pointer: '/retroactive_reason', code: 'required', message: `This change takes effect from ${start}, before today (IST); explain why (≥ 10 characters)` },
          ]);
        }
        if (!retro && reason !== null) throw validationError([{ pointer: '/retroactive_reason', code: 'forbidden', message: 'Only for changes that take effect before today (IST)' }]);

        const now = this.d.clock.now();
        const base = {
          action: a,
          supersedes_rule_id: body.supersedes_rule_id ?? null,
          end_date: body.end_date ?? null,
          rule,
          payload,
          rationale: body.rationale,
          retroactive_reason: retro ? reason : null,
          target_sha256: target ? ruleRowSha256(target) : null,
        };
        const row: ProposalRow = {
          id: newId('rp', now.getTime()),
          status: 'pending',
          ...base,
          content_sha256: proposalContentSha256(base),
          proposed_by: who.actor,
          proposed_by_actor_id: who.actorId,
          proposed_key_id: who.keyId,
          proposed_at: rfc3339(now),
          decided_by: null,
          decided_by_actor_id: null,
          decided_key_id: null,
          decided_at: null,
          decision_comment: null,
          resulting_rule_id: null,
          resulting_version: null,
        };
        repos.proposals.insert(row);
        appendAudit(
          repos.audit,
          this.d.auditKey,
          {
            at: row.proposed_at,
            actor: who.actor,
            key_prefix: who.keyPrefix,
            action: 'rate_proposal.created',
            entity_type: 'rate_proposal',
            entity_id: row.id,
            details: { action: row.action, supersedes_rule_id: row.supersedes_rule_id, end_date: row.end_date, rule: row.rule, payload, content_sha256: row.content_sha256, actor_id: who.actorId },
          },
          this.d.onAuditHead,
        );
        return proposalToDto(row, repos);
      }),
    );
  }

  get(id: string): ProposalDto {
    const p = this.d.read.proposals.get(id);
    if (!p) throw new AppError('proposal_not_found', `No rate proposal ${id}.`);
    return proposalToDto(p, this.d.read);
  }

  list(status: ProposalStatus, limit: number, cursor: string | null): { proposals: ProposalDto[]; next_cursor: string | null } {
    const rows = this.d.read.proposals.list(status, limit + 1, cursor);
    const page = rows.slice(0, limit);
    return { proposals: page.map((p) => proposalToDto(p, this.d.read)), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /**
   * Ruling 36: a verify may also record the notification document URL and the canonical notification. The URL
   * is required when the rule still cites an index/listing page, allowed only on the first verification (from
   * the seed state), and must itself be a document on an allowed host.
   */
  private verifySource(src: NonNullable<ProposalCreateApi['source']>, target: RateRuleRow): Record<string, string> {
    const out: Record<string, string> = { pdf_sha256: src.pdf_sha256, schedule_serial: src.schedule_serial.trim() };
    const index = this.d.sourceIndexPages ?? [];
    const errs: FieldError[] = [];
    if (src.url !== undefined || src.notification !== undefined) {
      if (target.verification_status !== 'unverified') {
        errs.push({ pointer: '/source', code: 'forbidden', message: 'source.url and source.notification can only be set on the first verification of a seed rule; supersede or correct a verified rule instead' });
      }
    }
    if (src.url !== undefined) {
      const problem = sourceUrlProblem(src.url, this.d.sourceHosts, true) ?? documentUrlProblem(src.url, index);
      if (problem) errs.push({ pointer: '/source/url', code: 'source_url', message: problem });
      else out['url'] = src.url;
    } else if (target.verification_status === 'unverified' && !isDocumentUrl(target.source_url, index)) {
      throw new AppError(
        'source_url_not_document',
        `Rule ${target.rule_id} cites ${target.source_url}, a listing/index page, not the notification document. Send source.url (the notification PDF you checked) with this verify (ruling 36).`,
        [{ pointer: '/source/url', code: 'required', message: 'Required: the rule currently cites an index page' }],
      );
    }
    if (src.notification !== undefined) {
      const n = normaliseNotificationRef(src.notification);
      const np = notificationRefProblem(n);
      if (np) errs.push({ pointer: '/source/notification', code: 'pattern', message: np });
      else out['notification'] = n;
    }
    if (errs.length > 0) throw validationError(errs);
    return out;
  }

  private loadForDecision(repos: Repos, id: string, who: Actor, expected: string, verb: string): ProposalRow {
    return loadForDecision(repos, id, who, expected, verb);
  }

  approve(id: string, who: Actor, input: DecisionInput, idem: IdempotencyContext | null): { proposal: ProposalDto; replayed: boolean } {
    let published: string | null = null;
    let grantEvent: Parameters<NonNullable<ProposalServiceDeps['onAdminGrant']>>[0] | null = null;
    let disableEvent: Parameters<NonNullable<ProposalServiceDeps['onActorDisabled']>>[0] | null = null;
    const out = this.d.tx((repos) =>
      runIdempotent(repos, idem, this.d.clock, 200, () => {
        const p = this.loadForDecision(repos, id, who, input.expectedSha256, 'approved');
        if (isDatasetImport(p)) {
          throw new AppError('proposal_stale', `Proposal ${id} is a dataset_import; approve it with scripts/import-dataset.ts on the host (it re-reads and re-hashes the seed files).`);
        }
        const target = p.supersedes_rule_id ? repos.rules.get(p.supersedes_rule_id) : null;
        if (p.supersedes_rule_id) {
          if (!target) throw new AppError('rule_not_active', `Rule ${p.supersedes_rule_id} no longer exists.`);
          if (ruleRowSha256(target) !== p.target_sha256) {
            throw new AppError('rule_not_active', `Rule ${target.rule_id} changed after this proposal was made; it is no longer current. Reject and re-propose.`);
          }
        }
        this.validateAgainstPublished(repos, p.action, p.rule, target, p.end_date, p.id);
        const start = effectStart(p.action, p.rule, target, p.end_date);
        const retro = start !== null && start < this.today();
        if (retro && p.retroactive_reason === null) {
          throw new AppError('proposal_stale', `This change now takes effect before today (IST, from ${start}) but carries no retroactive_reason. Reject it and re-propose with a reason.`);
        }

        const now = this.d.clock.now();
        const at = rfc3339(now);
        const publishes = p.action !== 'admin_grant';
        const version = publishes ? beginPublish(repos, now, who.actor, `proposal ${p.id}`) : null;
        const newRuleId = p.rule ? newId('rr', now.getTime()) : null;
        const resultingRuleId = newRuleId ?? (target ? target.rule_id : null);

        // Decide first: rate_rules / refdata insert triggers require the approved proposal to name the row.
        repos.proposals.decide(p.id, {
          status: 'approved', decided_by: who.actor, decided_by_actor_id: who.actorId, decided_key_id: who.keyId, decided_at: at,
          decision_comment: input.comment, resulting_rule_id: resultingRuleId, resulting_version: version,
        });

        const feed = (c: Parameters<Repos['dataset']['appendChange']>[0]) => repos.dataset.appendChange({ ...c, retroactive: retro });
        let ruleRowForAudit: RateRuleRow | null = null;

        if (p.rule && newRuleId && version) {
          const r = p.rule;
          const row: RateRuleRow = {
            rule_id: newRuleId,
            ...r,
            // the checker attested verified_against_source + the PDF hash: rules published via maker–checker are verified
            verified_by: who.actor,
            last_verified_at: at,
            verification_status: 'verified',
            status: 'active',
            voided_at: null,
            voided_in_version: null,
            voided_by_rule: null,
            retroactive_reason: p.retroactive_reason,
            created_in_version: version,
            end_dated_in_version: null,
            superseded_by: null,
            proposal_id: p.id,
            seed_batch_id: null,
            citation_note: null,
          };
          repos.rules.insert(row);
          ruleRowForAudit = row;
        }
        if (p.action === 'verify' && target && version) {
          const src = (p.payload?.['source'] ?? {}) as { pdf_sha256?: string; schedule_serial?: string; url?: string; notification?: string };
          // ruling 36: the document URL / canonical notification replace the index-page citation in the same update
          repos.rules.markVerified(target.rule_id, who.actor, at, src.pdf_sha256 ?? '', src.schedule_serial ?? '', { url: src.url ?? null, notification: src.notification ?? null });
          const reverify = target.verification_status === 'verified';
          // N3: the summary names the citation as it stands after the approval (ruling 36 may have replaced it)
          const after = repos.rules.get(target.rule_id)!;
          feed({
            dataset_version: version, published_at: at, change_type: 'rule_verified', hsn_prefix: target.hsn_prefix,
            rule_id: target.rule_id, effective_from: target.effective_from, effective_to: target.effective_to,
            summary: `${target.hsn_prefix} ${bpToPercent(target.igst_rate_bp)}% rule ${reverify ? 're-verified' : 'verified'} against ${after.notification_ref}`,
          });
          ruleRowForAudit = after;
        }
        if ((p.action === 'supersede' || p.action === 'end_date') && target && version) {
          const to = p.action === 'supersede' ? addDays(p.rule!.effective_from as IsoDate, -1) : p.end_date!;
          repos.rules.endDate(target.rule_id, to, version, p.action === 'supersede' ? newRuleId : null);
          feed({
            dataset_version: version, published_at: at, change_type: 'rule_end_dated', hsn_prefix: target.hsn_prefix,
            rule_id: target.rule_id, effective_from: target.effective_from, effective_to: to,
            summary: `${target.hsn_prefix} ${bpToPercent(target.igst_rate_bp)}% rule end-dated ${to}`,
          });
          if (p.action === 'end_date') ruleRowForAudit = repos.rules.get(target.rule_id);
        }
        if (p.action === 'correct' && target && newRuleId && version) {
          repos.rules.void(target.rule_id, at, version, newRuleId);
        }
        if (p.rule && newRuleId && version) {
          const r = p.rule;
          for (const other of repos.rules.byPrefix(r.hsn_prefix)) {
            if (other.rule_id !== newRuleId && rulesOverlap(r, other)) {
              throw new AppError('overlapping_rule', `Rule ${describe(r)} would overlap ${other.rule_id} (${describe(other)}).`);
            }
          }
          if (p.action === 'correct' && target) {
            feed({
              dataset_version: version, published_at: at, change_type: 'rule_corrected', hsn_prefix: r.hsn_prefix,
              rule_id: newRuleId, related_rule_id: target.rule_id, effective_from: r.effective_from, effective_to: r.effective_to,
              summary: `${r.hsn_prefix}: rule ${target.rule_id} (${bpToPercent(target.igst_rate_bp)}%) voided and replaced by ${newRuleId} (${bpToPercent(r.igst_rate_bp)}% from ${r.effective_from}, ${r.notification_ref})`,
            });
          } else {
            feed({
              dataset_version: version, published_at: at, change_type: 'rule_added', hsn_prefix: r.hsn_prefix,
              rule_id: newRuleId, effective_from: r.effective_from, effective_to: r.effective_to,
              summary: `${r.hsn_prefix} ${bpToPercent(r.igst_rate_bp)}% from ${r.effective_from} (${r.notification_ref})`,
            });
          }
        }
        if (isDisableActor(p)) {
          const handle = p.payload!['handle'] as string;
          const actor = repos.actors.byHandle(handle);
          if (!actor || actor.disabled_at !== null) throw new AppError('proposal_stale', `Actor "${handle}" is no longer active.`);
          if (repos.actors.activeCount() - 1 < 2) throw new AppError('proposal_stale', 'Disabling this actor would leave fewer than two active admins.');
          const withdrawn = disableActorInTx(repos, this.d.auditKey, { handle, at, by: who.actor, keyPrefix: who.keyPrefix, note: `proposal ${p.id}`, proposalId: p.id });
          disableEvent = { handle, proposal_id: p.id, approved_by: who.actor, withdrawn };
        } else if (p.action === 'admin_grant') {
          const g = p.payload as { handle: string; display_name: string; new_actor: boolean };
          if (g.new_actor) {
            if (repos.actors.byHandle(g.handle)) throw new AppError('proposal_stale', `Actor "${g.handle}" was created meanwhile.`);
            repos.actors.insert({ id: newId('act', now.getTime()), handle: g.handle, display_name: g.display_name, created_at: at, created_via: 'admin_grant', grant_proposal_id: p.id, disabled_at: null });
          }
          appendAudit(repos.audit, this.d.auditKey, {
            at, actor: who.actor, key_prefix: who.keyPrefix, action: 'admin.granted', entity_type: 'admin_actor', entity_id: g.handle,
            details: { proposal_id: p.id, new_actor: g.new_actor, proposed_by: p.proposed_by, approved_by: who.actor, notifier: 'deferred (ruling 29): warn log only' },
          });
          grantEvent = { proposal_id: p.id, handle: g.handle, new_actor: g.new_actor, proposed_by: p.proposed_by, approved_by: who.actor, at };
        }
        if (p.action === 'refdata_change' && version) this.applyRefdata(repos, p, version, at, feed);

        const contentHash = version ? finishPublish(repos, version, now, this.d.signingKey).contentHash : null;
        const canonicalRule = ruleRowForAudit ? canonicalJson(ruleRowForAudit) : null;
        appendAudit(
          repos.audit,
          this.d.auditKey,
          {
            at, actor: who.actor, key_prefix: who.keyPrefix, action: 'rate_proposal.approved', entity_type: 'rate_proposal', entity_id: p.id,
            details: {
              dataset_version: version,
              // SA-C2-02: anchors the published version's content hash in the HMAC'd log (integrity cross-check)
              dataset_content_hash: contentHash,
              action: p.action,
              rule_id: resultingRuleId,
              target_rule_id: p.supersedes_rule_id,
              content_sha256: p.content_sha256,
              rule: ruleRowForAudit,
              rule_sha256: canonicalRule === null ? null : sha256Hex(canonicalRule),
              payload: p.payload,
              retroactive: retro,
              actor_id: who.actorId,
              verified_against_source: true,
            },
          },
          this.d.onAuditHead,
        );
        published = version;
        return proposalToDto(repos.proposals.get(p.id)!, repos);
      }),
    );
    if (published !== null && !out.replayed) this.d.onPublish?.(published);
    if (grantEvent !== null && !out.replayed) this.d.onAdminGrant?.(grantEvent);
    if (disableEvent !== null && !out.replayed) this.d.onActorDisabled?.(disableEvent);
    return out;
  }

  private applyRefdata(repos: Repos, p: ProposalRow, version: string, at: string, feed: (c: Parameters<Repos['dataset']['appendChange']>[0]) => number): void {
    const c = p.payload as Record<string, unknown> & { table: string; op: string };
    const change = (type: 'synonym_changed' | 'refdata_changed' | 'hsn_updated' | 'hsn_added', prefix: string, summary: string) =>
      feed({ dataset_version: version, published_at: at, change_type: type, hsn_prefix: prefix, rule_id: null, effective_from: null, effective_to: null, summary });
    const gone = (what: string): never => {
      throw new AppError('proposal_stale', `${what} changed after this proposal was made. Reject and re-propose.`);
    };
    if (c.op === 'deactivate') {
      const id = c['id'] as number;
      if (c.table === 'synonym') {
        const s = repos.synonyms.getById(id);
        if (!s || !repos.synonyms.deactivate(id, p.id)) gone(`synonym ${id}`);
        change('synonym_changed', s!.hsn_code, `synonym "${s!.phrase}" → ${s!.hsn_code} deactivated`);
      } else if (c.table === 'category_map') {
        const m = repos.synonyms.getCategory(id);
        if (!m || !repos.synonyms.deactivateCategory(id, p.id)) gone(`category_map ${id}`);
        change('refdata_changed', m!.hsn_prefix, `category ${m!.source}:${m!.category} → ${m!.hsn_prefix} deactivated`);
      } else {
        const k = repos.synonyms.getChapterKeyword(id);
        if (!k || !repos.synonyms.deactivateChapterKeyword(id, p.id)) gone(`chapter_keyword ${id}`);
        change('refdata_changed', k!.chapter, `chapter keyword "${k!.keyword}" → ${k!.chapter} deactivated`);
      }
      return;
    }
    if (c.table === 'synonym') {
      repos.synonyms.insert({
        phrase: c['phrase'] as string, hsn_code: c['hsn_code'] as string, strength: c['strength'] as 'primary' | 'related',
        note: (c['note'] as string | null) ?? null, rule_hint: (c['rule_hint'] as string | null) ?? null,
        created_by: p.proposed_by, created_at: at, active: true, added_by_proposal: p.id,
      });
      change('synonym_changed', c['hsn_code'] as string, `synonym "${String(c['phrase'])}" → ${String(c['hsn_code'])} added`);
    } else if (c.table === 'category_map') {
      repos.synonyms.insertCategory(c['source'] as string, c['category'] as string, c['hsn_prefix'] as string, p.id);
      change('refdata_changed', c['hsn_prefix'] as string, `category ${String(c['source'])}:${String(c['category'])} → ${String(c['hsn_prefix'])} added`);
    } else if (c.table === 'chapter_keyword') {
      repos.synonyms.insertChapterKeyword(c['keyword'] as string, c['chapter'] as string, p.id);
      change('refdata_changed', c['chapter'] as string, `chapter keyword "${String(c['keyword'])}" → ${String(c['chapter'])} added`);
    } else if (c.table === 'hsn_code' && c.op === 'add_code') {
      const code = c['code'] as string;
      const parent = (c['parent'] as string | null) ?? null;
      if (repos.hsn.get(code)) gone(`HSN/SAC ${code} (it exists now)`);
      if (parent !== null && !repos.hsn.get(parent)) gone(`parent ${parent}`);
      repos.hsn.insertApproved(
        {
          code, level: code.length as 2 | 4 | 5 | 6 | 8, parent, chapter: code.slice(0, 2), type: c['type'] as 'goods' | 'service',
          description: c['description'] as string, keywords: c['keywords'] as string, added_in_version: version,
        },
        p.id,
      );
      change('hsn_added', code, `${code} added: ${String(c['description']).slice(0, 120)}`);
    } else if (c.table === 'hsn_description') {
      repos.hsn.updateDescription(c['code'] as string, c['description'] as string, c['keywords'] as string, p.id);
      change('hsn_updated', c['code'] as string, `${String(c['code'])} description updated`);
    }
  }

  reject(id: string, who: Actor, input: DecisionInput & { comment: string }, idem: IdempotencyContext | null): { proposal: ProposalDto; replayed: boolean } {
    return this.d.tx((repos) =>
      runIdempotent(repos, idem, this.d.clock, 200, () => {
        const p = this.loadForDecision(repos, id, who, input.expectedSha256, 'decided');
        const at = rfc3339(this.d.clock.now());
        repos.proposals.decide(p.id, {
          status: 'rejected', decided_by: who.actor, decided_by_actor_id: who.actorId, decided_key_id: who.keyId, decided_at: at,
          decision_comment: input.comment, resulting_rule_id: null, resulting_version: null,
        });
        appendAudit(
          repos.audit,
          this.d.auditKey,
          { at, actor: who.actor, key_prefix: who.keyPrefix, action: 'rate_proposal.rejected', entity_type: 'rate_proposal', entity_id: p.id, details: { reason: input.comment, content_sha256: p.content_sha256, actor_id: who.actorId } },
          this.d.onAuditHead,
        );
        return proposalToDto(repos.proposals.get(p.id)!, repos);
      }),
    );
  }

  /** Ruling 26: the proposer closes their own pending proposal. Audited; nothing is published. */
  withdraw(id: string, who: Actor, input: { reason: string }, idem: IdempotencyContext | null): { proposal: ProposalDto; replayed: boolean } {
    return this.d.tx((repos) =>
      runIdempotent(repos, idem, this.d.clock, 200, () => {
        const p = repos.proposals.get(id);
        if (!p) throw new AppError('proposal_not_found', `No rate proposal ${id}.`);
        if (p.proposed_by_actor_id !== who.actorId) throw new AppError('not_proposer', `Proposal ${id} was created by actor "${p.proposed_by}"; only that actor may withdraw it.`);
        if (p.status !== 'pending') throw new AppError('proposal_not_pending', `Proposal ${id} is ${p.status}.`);
        const at = rfc3339(this.d.clock.now());
        repos.proposals.decide(p.id, {
          status: 'withdrawn', decided_by: who.actor, decided_by_actor_id: null, decided_key_id: who.keyId, decided_at: at,
          decision_comment: input.reason, resulting_rule_id: null, resulting_version: null,
        });
        appendAudit(
          repos.audit,
          this.d.auditKey,
          { at, actor: who.actor, key_prefix: who.keyPrefix, action: 'rate_proposal.withdrawn', entity_type: 'rate_proposal', entity_id: p.id, details: { reason: input.reason, content_sha256: p.content_sha256, actor_id: who.actorId } },
          this.d.onAuditHead,
        );
        return proposalToDto(repos.proposals.get(p.id)!, repos);
      }),
    );
  }
}
