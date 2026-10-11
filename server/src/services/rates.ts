/**
 * Rate resolution (data-model.md §3). The pure function `resolveRules` implements the
 * algorithm; `RateService` fetches rows and maps them to API DTOs. No AI or heuristics.
 */
import type { RateRuleRepo, RateRuleRow, VerificationStatus } from '../repositories/types.js';
import { bpToPercent, paiseToRupees } from '../lib/money.js';
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import { RATE_DISCLAIMER, UNVERIFIED_DISCLAIMER_SUFFIX, UNVERIFIED_RATE_WARNING } from './disclaimer.js';

export interface ResolveOutcome {
  ambiguous: boolean;
  ambiguityReason: string | null;
  applicable: RateRuleRow | null;
  /** candidate rules when ambiguous; [] otherwise */
  rules: RateRuleRow[];
  /** ruling 13: required, ok | no_rate_rule | ambiguous */
  coverage: Coverage;
  /** ruling 5: the general (condition 'none') rule when the ambiguity is general-vs-conditional exceptions */
  defaultRule: RateRuleRow | null;
  /** length of the matched hsn_prefix (2/4/6/8) when an applicable rule exists */
  matchedAtLevel: number | null;
  /** step 6 data-integrity guard tripped */
  overlap: boolean;
  /** true if price rules were present but unit_price was not given */
  needsUnitPrice: boolean;
}

export type Coverage = 'ok' | 'no_rate_rule' | 'ambiguous';

const tupleKey = (r: RateRuleRow): string => `${r.igst_rate_bp}|${r.cess_rate_bp}|${r.cess_specific_paise ?? ''}`;

function priceMatches(r: RateRuleRow, p: number): boolean {
  if (r.condition_kind !== 'price') return true;
  if (r.min_unit_price_paise !== null && p < r.min_unit_price_paise) return false;
  if (r.max_unit_price_paise !== null && p > r.max_unit_price_paise) return false;
  return true;
}

/** Latest last_verified_at wins (NULL = never verified = oldest); tie → smallest rule_id. */
function pickLatestVerified(rs: RateRuleRow[]): RateRuleRow {
  return [...rs].sort((a, b) => {
    const av = a.last_verified_at ?? '';
    const bv = b.last_verified_at ?? '';
    if (av !== bv) return av > bv ? -1 : 1;
    return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
  })[0]!;
}

/**
 * @param code queried HSN (2–8 digits)
 * @param unitPricePaise P, or null
 * @param inForce rules already filtered to those in force on the as-of date
 */
export function resolveRules(
  code: string,
  unitPricePaise: number | null,
  inForce: { ancestorOrSelf: RateRuleRow[]; descendants: RateRuleRow[] },
): ResolveOutcome {
  // 2. Longest prefix among ancestor-or-self.
  const anc = inForce.ancestorOrSelf.filter((r) => code.startsWith(r.hsn_prefix));
  const maxLen = anc.reduce((m, r) => Math.max(m, r.hsn_prefix.length), 0);
  let R = anc.filter((r) => r.hsn_prefix.length === maxLen);

  // 3. Descendant check.
  const desc = inForce.descendants.filter((r) => r.hsn_prefix.startsWith(code) && r.hsn_prefix.length > code.length);
  if (desc.length > 0) {
    const rKeys = new Set(R.map(tupleKey));
    const differs = R.length === 0 || desc.some((d) => !rKeys.has(tupleKey(d)));
    if (differs) {
      const example = [...desc].sort((a, b) => b.hsn_prefix.length - a.hsn_prefix.length || (a.hsn_prefix < b.hsn_prefix ? -1 : 1))[0]!;
      return {
        ambiguous: true,
        ambiguityReason: `Rate differs at a more specific code (e.g. ${example.hsn_prefix}); query the ${example.hsn_prefix.length}-digit code.`,
        applicable: null,
        rules: [...R, ...desc],
        coverage: 'ambiguous',
        defaultRule: null,
        matchedAtLevel: null,
        overlap: false,
        needsUnitPrice: false,
      };
    }
  }

  const hadPriceRules = R.some((r) => r.condition_kind === 'price');
  // 4. Price filter.
  if (unitPricePaise !== null) R = R.filter((r) => priceMatches(r, unitPricePaise));

  // 5. Decide.
  if (R.length === 0) {
    return { ambiguous: false, ambiguityReason: null, applicable: null, rules: [], coverage: 'no_rate_rule', defaultRule: null, matchedAtLevel: null, overlap: false, needsUnitPrice: false };
  }
  if (R.length === 1) {
    return { ambiguous: false, ambiguityReason: null, applicable: R[0]!, rules: [], coverage: 'ok', defaultRule: null, matchedAtLevel: R[0]!.hsn_prefix.length, overlap: false, needsUnitPrice: false };
  }
  const keys = new Set(R.map(tupleKey));
  if (keys.size === 1) {
    const pick = pickLatestVerified(R);
    return { ambiguous: false, ambiguityReason: null, applicable: pick, rules: [], coverage: 'ok', defaultRule: null, matchedAtLevel: pick.hsn_prefix.length, overlap: false, needsUnitPrice: false };
  }
  const allPrice = R.every((r) => r.condition_kind === 'price');
  if (allPrice && unitPricePaise === null) {
    return {
      ambiguous: true,
      ambiguityReason: 'Several rules apply; they differ by unit price. Pass unit_price to resolve.',
      applicable: null,
      rules: R,
      coverage: 'ambiguous',
      defaultRule: null,
      matchedAtLevel: null,
      overlap: false,
      needsUnitPrice: true,
    };
  }
  if (allPrice) {
    // 6. Price given and still >1 differing price rule: overlapping bounds = data error.
    return {
      ambiguous: true,
      ambiguityReason: 'Overlapping price rules in the dataset (data error reported); a human must choose.',
      applicable: null,
      rules: R,
      coverage: 'ambiguous',
      defaultRule: null,
      matchedAtLevel: null,
      overlap: true,
      needsUnitPrice: false,
    };
  }
  // General rule + conditional exceptions (e.g. 3004 at 5% plus the nil-rate drug list at 0%, ruling 5):
  // ambiguous, with the general rule as default_rule_id. Clients choose via rule_id or condition "general".
  const general = R.filter((r) => r.condition_kind === 'none');
  const defaultRule = general.length === 1 ? general[0]! : null;
  return {
    ambiguous: true,
    ambiguityReason: defaultRule
      ? `A general rule and conditional rules apply; the general rule (${defaultRule.rule_id}) applies unless a listed condition is met. Choose the rule.`
      : 'Several rules apply and they have non-price conditions; a human must choose.',
    applicable: null,
    rules: R,
    coverage: 'ambiguous',
    defaultRule,
    matchedAtLevel: null,
    overlap: false,
    needsUnitPrice: hadPriceRules && unitPricePaise === null,
  };
}

// ---------------------------------------------------------------------------------- DTOs

export interface RateRuleDto {
  rule_id: string;
  hsn_prefix: string;
  igst_rate_bp: number;
  igst_rate_percent: number;
  cgst_rate_percent: number;
  sgst_rate_percent: number;
  cess: { rate_bp: number; specific_amount: number | null; specific_unit: string | null };
  utgst_rate_percent: number;
  condition: { kind: string; code: string | null; text: string | null; min_unit_price: number | null; max_unit_price: number | null };
  effective_from: string;
  effective_to: string | null;
  source: { notification: string; url: string; pdf_sha256: string | null; schedule_serial: string | null };
  last_verified_at: string | null;
  /** last_verified_at + 12 months (ruling 9); null while unverified */
  reverify_due_at: string | null;
  verified_by: string | null;
  verification_status: VerificationStatus;
  /** non-null only when verification_status = unverified */
  warning: string | null;
  /** seed caveat (e.g. "gazette not read"); null once a verify approval has checked the rule against the source */
  citation_note: string | null;
  /** dataset version in which this rule was published */
  dataset_version: string;
}

export interface RateResolutionDto {
  hsn_queried: string;
  as_of: string;
  unit_price: number | null;
  ambiguous: boolean;
  ambiguity_reason?: string;
  coverage: Coverage;
  matched_at_level: number | null;
  applicable_rule: RateRuleDto | null;
  /** ruling 5: general rule to use when no listed condition applies; null otherwise */
  default_rule_id: string | null;
  rules: RateRuleDto[];
  /** null, or how applicable_rule was chosen among ambiguous candidates, e.g. "rule_hint:nil_rate_list" (ruling 5) */
  rule_selected_by: string | null;
  /** verification status of the applicable rule; for ambiguous results 'unverified' if any listed rule is */
  verification_status: VerificationStatus | null;
  /** machine codes: rate_unverified, no_rate_rule, ambiguous, verification_overdue, pending_change_detected, selected_by_hint */
  warnings: string[];
  disclaimer: string;
}

/** last_verified_at + 12 calendar months (RFC 3339), or null */
export function reverifyDueAt(lastVerifiedAt: string | null): string | null {
  if (lastVerifiedAt === null) return null;
  const d = new Date(lastVerifiedAt);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + 12);
  return rfc3339(d);
}

export function ruleToDto(r: RateRuleRow): RateRuleDto {
  return {
    rule_id: r.rule_id,
    hsn_prefix: r.hsn_prefix,
    igst_rate_bp: r.igst_rate_bp,
    igst_rate_percent: bpToPercent(r.igst_rate_bp),
    cgst_rate_percent: bpToPercent(r.igst_rate_bp / 2),
    sgst_rate_percent: bpToPercent(r.igst_rate_bp / 2),
    utgst_rate_percent: bpToPercent(r.igst_rate_bp / 2),
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
    last_verified_at: r.last_verified_at,
    reverify_due_at: reverifyDueAt(r.last_verified_at),
    verified_by: r.verified_by,
    verification_status: r.verification_status,
    warning: r.verification_status === 'unverified' ? UNVERIFIED_RATE_WARNING : null,
    citation_note: r.citation_note ?? null,
    dataset_version: r.created_in_version,
  };
}

export interface RateLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RateServiceDeps {
  clock?: Clock;
  /** affected prefixes of watched notifications in state `detected` (ruling 10) */
  pendingPrefixes?: () => readonly string[];
}

export interface ResolveOptions {
  /** classifier hint (ruling 5): select the one candidate rule carrying this condition_code */
  conditionCode?: string | null | undefined;
}

/** ruling 3 matching in both directions */
export const prefixRelated = (code: string, prefix: string): boolean => code.startsWith(prefix) || prefix.startsWith(code);

export class RateService {
  constructor(
    private readonly rules: RateRuleRepo,
    private readonly log?: RateLogger,
    private readonly deps: RateServiceDeps = {},
  ) {}

  /** Resolve and return both the raw outcome and the API DTO. */
  resolve(code: string, asOf: string, unitPricePaise: number | null, opts: ResolveOptions = {}): { outcome: ResolveOutcome; dto: RateResolutionDto } {
    const inForce = this.rules.rulesInForce(code, asOf);
    let outcome = resolveRules(code, unitPricePaise, inForce);
    const warnings: string[] = [];
    let selectedBy: string | null = null;
    if (outcome.ambiguous && opts.conditionCode) {
      const hits = outcome.rules.filter((r) => r.condition_code === opts.conditionCode);
      if (hits.length === 1) {
        const pick = hits[0]!;
        // SA-K2-01: the hint picks the rule, but every candidate and the general default stay visible
        // so a client (or a human) can see what the hint overrode.
        outcome = { ...outcome, ambiguous: false, ambiguityReason: null, applicable: pick, coverage: 'ok', matchedAtLevel: pick.hsn_prefix.length, overlap: false, needsUnitPrice: false };
        selectedBy = `rule_hint:${opts.conditionCode}`;
        warnings.push('selected_by_hint');
      }
    }
    if (outcome.overlap) this.log?.warn({ event: 'rate_rule_overlap', hsn: code, as_of: asOf, rule_ids: outcome.rules.map((r) => r.rule_id) }, 'rate_rule_overlap');
    if (outcome.ambiguous) this.log?.warn({ event: 'rate.resolved_ambiguous', hsn: code }, 'rate.resolved_ambiguous');
    const listed = outcome.applicable ? [outcome.applicable] : outcome.rules;
    const anyUnverified = listed.some((r) => r.verification_status === 'unverified');
    if (anyUnverified) warnings.push('rate_unverified');
    if (outcome.coverage === 'no_rate_rule') warnings.push('no_rate_rule');
    if (outcome.ambiguous) warnings.push('ambiguous');
    const now = this.deps.clock ? rfc3339(this.deps.clock.now()) : null;
    if (now !== null && listed.some((r) => { const due = reverifyDueAt(r.last_verified_at); return due !== null && due < now; })) {
      warnings.push('verification_overdue');
    }
    const pending = this.deps.pendingPrefixes?.() ?? [];
    if (pending.some((p) => prefixRelated(code, p))) warnings.push('pending_change_detected');
    const dto: RateResolutionDto = {
      hsn_queried: code,
      as_of: asOf,
      unit_price: unitPricePaise === null ? null : paiseToRupees(unitPricePaise),
      ambiguous: outcome.ambiguous,
      coverage: outcome.coverage,
      matched_at_level: outcome.matchedAtLevel,
      applicable_rule: outcome.applicable ? ruleToDto(outcome.applicable) : null,
      default_rule_id: outcome.defaultRule?.rule_id ?? null,
      rule_selected_by: selectedBy,
      rules: outcome.rules.map(ruleToDto),
      verification_status: listed.length === 0 ? null : anyUnverified ? 'unverified' : 'verified',
      warnings,
      disclaimer: anyUnverified ? `${RATE_DISCLAIMER} ${UNVERIFIED_DISCLAIMER_SUFFIX}` : RATE_DISCLAIMER,
    };
    if (outcome.ambiguityReason !== null) dto.ambiguity_reason = outcome.ambiguityReason;
    return { outcome, dto };
  }
}
