/**
 * Tax maths in integer paise and basis points (07 §6).
 * Per line, per component, round half-up to the paisa:
 *   intra: cgst = sgst = roundHalfUp(taxable × rate_bp, 20000)  (each computed independently)
 *   intra_ut: cgst = utgst = roundHalfUp(taxable × rate_bp, 20000) (UT without legislature, ruling 15)
 *   inter: igst = roundHalfUp(taxable × rate_bp, 10000)
 *   cess (ad valorem): roundHalfUp(taxable × cess_bp, 10000)
 * Invoice totals are sums of rounded line values (no re-rounding).
 */
import { roundHalfUp, paiseToRupees, bpToPercent } from '../lib/money.js';
import type { RateService } from './rates.js';
import type { HsnRepo, HsnRow, VerificationStatus } from '../repositories/types.js';
import { AppError, type FieldError } from '../lib/problem.js';
import { TAX_DISCLAIMER, UNVERIFIED_RATE_WARNING } from './disclaimer.js';

export type SupplyType = 'intra' | 'intra_ut' | 'inter';

/**
 * Validator R3: the nearest code of the HSN master above `code` (6 → 5 for SAC 99 → 4 → 2 digits), for a
 * well-formed code that is not itself in the master. null when not even its chapter exists.
 */
export function nearestKnownAncestor(hsn: Pick<HsnRepo, 'get'>, code: string): HsnRow | null {
  for (const len of [6, 5, 4, 2]) {
    if (len >= code.length) continue;
    if (len === 5 && !code.startsWith('99')) continue;
    const row = hsn.get(code.slice(0, len));
    if (row) return row;
  }
  return null;
}

export interface TaxAmountsPaise {
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
  cess: number;
  total_tax: number;
}

export function computeLineTax(taxablePaise: number, igstRateBp: number, cessRateBp: number, supply: SupplyType): TaxAmountsPaise {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) throw new RangeError('taxable must be a non-negative safe integer (paise)');
  if (!Number.isInteger(igstRateBp) || igstRateBp < 0 || !Number.isInteger(cessRateBp) || cessRateBp < 0) throw new RangeError('rates must be non-negative integers (bp)');
  const t = BigInt(taxablePaise);
  let cgst = 0n;
  let sgst = 0n;
  let utgst = 0n;
  let igst = 0n;
  if (supply === 'intra') {
    cgst = roundHalfUp(t * BigInt(igstRateBp), 20000n);
    sgst = roundHalfUp(t * BigInt(igstRateBp), 20000n);
  } else if (supply === 'intra_ut') {
    cgst = roundHalfUp(t * BigInt(igstRateBp), 20000n);
    utgst = roundHalfUp(t * BigInt(igstRateBp), 20000n);
  } else {
    igst = roundHalfUp(t * BigInt(igstRateBp), 10000n);
  }
  const cess = roundHalfUp(t * BigInt(cessRateBp), 10000n);
  const total = cgst + sgst + utgst + igst + cess;
  return { cgst: Number(cgst), sgst: Number(sgst), utgst: Number(utgst), igst: Number(igst), cess: Number(cess), total_tax: Number(total) };
}

export interface ScaledQuantity {
  /** quantity × 1000 as an integer (qty_milli, ruling 7) */
  milli: bigint;
  text: string;
}

/**
 * Parse a positive quantity with at most 3 decimals (ruling 7) without floating-point maths.
 * Informational in v1: tax is on taxable_value; quantity only derives a unit price for price-threshold rules.
 */
export function parseQuantity(v: number | string): ScaledQuantity | null {
  if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return null;
  const s = typeof v === 'number' ? String(v) : v.trim();
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const milli = BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
  if (milli === 0n) return null;
  return { milli, text: s };
}

/** unit_paise = roundHalfUp(taxable_paise × 1000, qty_milli) (ruling 7) */
export function deriveUnitPricePaise(taxablePaise: number, q: ScaledQuantity): number {
  return Number(roundHalfUp(BigInt(taxablePaise) * 1000n, q.milli));
}

export interface TaxLineInput {
  line_id: string;
  hsn: string;
  taxable_paise: number;
  quantity: ScaledQuantity | null;
  unit_price_paise: number | null;
  supply_type: SupplyType;
  /** explicit rule choice for an ambiguous line (ruling 5) */
  rule_id: string | null;
  /** 'general' selects the default (general) rule of an ambiguous result */
  condition: 'general' | null;
}

interface MoneyDto {
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
  cess: number;
  total_tax: number;
}

export interface TaxLineResultDto {
  line_id: string;
  hsn: string;
  supply_type: SupplyType;
  taxable_value: number;
  ambiguous: boolean;
  rule_id: string | null;
  /** how rule_id was chosen: resolver (unambiguous), rule_id or condition_general (client choice) */
  rule_selected_by: 'resolver' | 'rule_id' | 'condition_general' | null;
  default_rule_id: string | null;
  igst_rate_bp: number | null;
  igst_rate_percent: number | null;
  tax: MoneyDto | null;
  tax_paise: TaxAmountsPaise | null;
  effective_from: string | null;
  effective_to: string | null;
  source: { notification: string; url: string } | null;
  last_verified_at: string | null;
  verification_status: VerificationStatus | null;
  warning: string | null;
  /** true when an unverified rule was used because the request set accept_unverified (ruling 24) */
  unverified_accepted: boolean;
  candidate_rules: string[];
  /** validator R3: false when the code is not in the HSN master and was resolved via its nearest known parent */
  code_in_master: boolean;
  /** the master code the line was resolved under when code_in_master is false */
  resolved_via: string | null;
  /** inputs that would let the API resolve this line (any one suffices): unit_price, rule_id, condition ("general"), hsn, accept_unverified */
  needs_input: string[];
  /** machine-readable flags a client must surface even on a computed line (SA-C3-08): code_not_in_master */
  warnings: string[];
  notes: string[];
}

export type InvoiceRounding = 'none' | 'nearest_rupee';

/** Validator R13: sums over the resolved lines of an incomplete invoice only. Never an invoice total. */
export interface PartialTotalsDto {
  complete: false;
  included_line_ids: string[];
  excluded_line_ids: string[];
  totals: MoneyDto & { taxable_value: number };
  totals_paise: TaxAmountsPaise & { taxable_value: number };
}

export interface TaxResultDto {
  invoice_date: string;
  complete: boolean;
  lines: TaxLineResultDto[];
  /** null when any line is unresolved (needs_input, refused or no rule): see partial_totals (R13) */
  totals: (MoneyDto & { taxable_value: number }) | null;
  totals_paise: (TaxAmountsPaise & { taxable_value: number }) | null;
  /** null on a complete invoice */
  partial_totals: PartialTotalsDto | null;
  invoice_rounding: InvoiceRounding;
  /** with invoice_rounding = nearest_rupee: grand total (taxable + tax) rounded half-up to the rupee; null when incomplete */
  round_off_paise?: number | null;
  grand_total_paise?: number | null;
  dataset_version: string;
  /** invoice-level flags (SA-C3-08): code_not_in_master when any line's code is not in the HSN master */
  warnings: string[];
  disclaimer: string;
}

const toRupees = (a: TaxAmountsPaise): MoneyDto => ({
  cgst: paiseToRupees(a.cgst),
  sgst: paiseToRupees(a.sgst),
  utgst: paiseToRupees(a.utgst),
  igst: paiseToRupees(a.igst),
  cess: paiseToRupees(a.cess),
  total_tax: paiseToRupees(a.total_tax),
});

export class TaxService {
  constructor(
    private readonly hsn: HsnRepo,
    private readonly rates: RateService,
  ) {}

  calculate(invoiceDate: string, lines: TaxLineInput[], datasetVersion: string, rounding: InvoiceRounding = 'none', acceptUnverified = false): TaxResultDto {
    // Codes not in the master resolve under their nearest known parent with a note (validator R3);
    // codes whose chapter does not exist -> 422 with a pointer per line (the API never guesses).
    const known = new Set(this.hsn.getMany([...new Set(lines.map((l) => l.hsn))]).map((r) => r.code));
    const via = new Map<string, string>();
    const unknown: FieldError[] = [];
    lines.forEach((l, i) => {
      if (known.has(l.hsn) || via.has(l.hsn)) return;
      const anc = nearestKnownAncestor(this.hsn, l.hsn);
      if (anc) via.set(l.hsn, anc.code);
      else unknown.push({ pointer: `/lines/${i}/hsn`, code: 'unknown_hsn', message: `HSN "${l.hsn}" not found (chapter ${l.hsn.slice(0, 2)} does not exist)` });
    });
    if (unknown.length > 0) {
      throw new AppError(
        'unknown_hsn',
        `${unknown.length} line(s) reference an HSN/SAC code that does not exist in dataset ${datasetVersion}. Use GET /v1/hsn/search to find the right code.`,
        unknown,
      );
    }

    const totals: TaxAmountsPaise & { taxable_value: number } = { cgst: 0, sgst: 0, utgst: 0, igst: 0, cess: 0, total_tax: 0, taxable_value: 0 };
    let complete = true;
    const choiceErrors: FieldError[] = [];
    // memoise resolution per (code, price) within a request (SA-C-07)
    const memo = new Map<string, ReturnType<RateService['resolve']>>();
    const resolve = (code: string, price: number | null) => {
      const k = `${code}|${price ?? ''}`;
      let r = memo.get(k);
      if (!r) {
        r = this.rates.resolve(code, invoiceDate, price);
        memo.set(k, r);
      }
      return r;
    };
    const out: TaxLineResultDto[] = lines.map((l, i) => {
      const notes: string[] = [];
      const resolvedVia = via.get(l.hsn) ?? null;
      if (resolvedVia !== null) {
        notes.push(`code_not_in_master: ${l.hsn} is not in the HSN master; rates resolved under its nearest known parent ${resolvedVia}. Check the code.`);
      }
      let unitPrice = l.unit_price_paise;
      if (unitPrice === null && l.quantity !== null) {
        unitPrice = deriveUnitPricePaise(l.taxable_paise, l.quantity);
        notes.push(`unit_price derived as taxable_value / quantity = ${paiseToRupees(unitPrice).toFixed(2)}`);
      }
      const { outcome } = resolve(l.hsn, unitPrice);
      const base: TaxLineResultDto = {
        line_id: l.line_id,
        hsn: l.hsn,
        supply_type: l.supply_type,
        taxable_value: paiseToRupees(l.taxable_paise),
        ambiguous: outcome.ambiguous,
        rule_id: null,
        rule_selected_by: null,
        default_rule_id: outcome.defaultRule?.rule_id ?? null,
        igst_rate_bp: null,
        igst_rate_percent: null,
        tax: null,
        tax_paise: null,
        effective_from: null,
        effective_to: null,
        source: null,
        last_verified_at: null,
        verification_status: null,
        warning: null,
        unverified_accepted: false,
        candidate_rules: outcome.rules.map((r) => r.rule_id),
        code_in_master: resolvedVia === null,
        resolved_via: resolvedVia,
        needs_input: [],
        // SA-C3-08: the line is computed at the parent's rate but the code itself is not in the master (mistyped?)
        warnings: resolvedVia === null ? [] : ['code_not_in_master'],
        notes,
      };
      // Rule selection: resolver result, or the client's explicit choice for an ambiguous line (ruling 5).
      let rule = outcome.applicable;
      let selectedBy: TaxLineResultDto['rule_selected_by'] = rule ? 'resolver' : null;
      if (l.rule_id !== null) {
        const pool = outcome.applicable ? [outcome.applicable] : outcome.rules;
        const hit = pool.find((r) => r.rule_id === l.rule_id);
        if (!hit) {
          choiceErrors.push({ pointer: `/lines/${i}/rule_id`, code: 'rule_choice', message: `Rule ${l.rule_id} does not apply to ${l.hsn} on ${invoiceDate}; candidates: ${pool.map((r) => r.rule_id).join(', ') || 'none'}` });
          return base;
        }
        rule = hit;
        selectedBy = outcome.applicable ? 'resolver' : 'rule_id';
      } else if (l.condition === 'general' && !outcome.applicable) {
        if (!outcome.defaultRule) {
          choiceErrors.push({ pointer: `/lines/${i}/condition`, code: 'rule_choice', message: `${l.hsn} has no general rule on ${invoiceDate}; send rule_id instead` });
          return base;
        }
        rule = outcome.defaultRule;
        selectedBy = 'condition_general';
      }
      if (!rule) {
        complete = false;
        if (outcome.ambiguous) {
          if (outcome.needsUnitPrice) {
            const desc = outcome.rules
              .map((r) => `${r.condition_text ?? 'price condition'} → ${bpToPercent(r.igst_rate_bp)}%`)
              .join('; ');
            base.needs_input.push('unit_price');
            notes.push(`needs_input: unit_price. Rate depends on unit price (${desc}). Send unit_price or quantity, or choose rule_id.`);
          } else if (outcome.ambiguityReason) {
            if (outcome.ambiguityReason.includes('more specific code')) base.needs_input.push('hsn');
            else {
              // validator r3: list every accepted input: rule_id always, condition ("general") when a default rule exists
              base.needs_input.push('rule_id');
              if (outcome.defaultRule) base.needs_input.push('condition');
            }
            const general = outcome.defaultRule ? ` Send condition "general" to use ${outcome.defaultRule.rule_id}, or rule_id for a listed condition.` : '';
            notes.push(`needs_input: ${base.needs_input.join(', ')}. ${outcome.ambiguityReason}${general}`);
          }
        } else {
          notes.push('no_rate_rule: no curated rate rule covers this code on this date; no tax computed and no rate inferred.');
        }
        return base;
      }
      // Unverified gate (ruling 24): refuse unless the request accepts unverified rates; then flag the line.
      if (rule.verification_status === 'unverified' && !acceptUnverified) {
        complete = false;
        base.needs_input.push('accept_unverified');
        base.rule_id = rule.rule_id;
        base.verification_status = 'unverified';
        base.warning = UNVERIFIED_RATE_WARNING;
        notes.push(`rate_unverified_refused: rule ${rule.rule_id} has not been verified against its notification; no tax computed. Set accept_unverified: true to calculate with it anyway.`);
        return base;
      }
      const amounts = computeLineTax(l.taxable_paise, rule.igst_rate_bp, rule.cess_rate_bp, l.supply_type);
      if (rule.cess_specific_paise !== null) {
        notes.push(
          `specific_cess_not_computed: a specific cess of ${paiseToRupees(rule.cess_specific_paise).toFixed(2)} per ${rule.cess_specific_unit ?? 'unit'} also applies and is NOT included in this calculation.`,
        );
      }
      if (rule.condition_kind === 'other' && rule.condition_text) notes.push(`Rate applies subject to condition: ${rule.condition_text}`);
      if (selectedBy === 'condition_general') notes.push(`general rule ${rule.rule_id} chosen by the client (condition "general"); the listed conditional rules were not applied`);
      if (selectedBy === 'rule_id') notes.push(`rule ${rule.rule_id} chosen by the client`);
      const accepted = rule.verification_status === 'unverified';
      if (accepted) notes.push(`rate_unverified_accepted: ${UNVERIFIED_RATE_WARNING}`);
      totals.cgst += amounts.cgst;
      totals.sgst += amounts.sgst;
      totals.utgst += amounts.utgst;
      totals.igst += amounts.igst;
      totals.cess += amounts.cess;
      totals.total_tax += amounts.total_tax;
      totals.taxable_value += l.taxable_paise;
      return {
        ...base,
        ambiguous: outcome.ambiguous,
        rule_id: rule.rule_id,
        rule_selected_by: selectedBy,
        igst_rate_bp: rule.igst_rate_bp,
        igst_rate_percent: bpToPercent(rule.igst_rate_bp),
        tax: toRupees(amounts),
        tax_paise: amounts,
        effective_from: rule.effective_from,
        effective_to: rule.effective_to,
        source: { notification: rule.notification_ref, url: rule.source_url },
        last_verified_at: rule.last_verified_at,
        verification_status: rule.verification_status,
        warning: accepted ? UNVERIFIED_RATE_WARNING : null,
        unverified_accepted: accepted,
        candidate_rules: outcome.ambiguous ? base.candidate_rules : [],
      };
    });
    if (choiceErrors.length > 0) {
      throw new AppError('rule_choice_invalid', `${choiceErrors.length} line(s) chose a rule that does not apply. See errors[].`, choiceErrors);
    }

    const sums = { totals: { ...toRupees(totals), taxable_value: paiseToRupees(totals.taxable_value) }, totals_paise: totals };
    // R13: an incomplete invoice never gets an invoice total; sums of the resolved lines go to partial_totals
    const resolved = out.filter((l) => l.tax_paise !== null).map((l) => l.line_id);
    const result: TaxResultDto = {
      invoice_date: invoiceDate,
      complete,
      lines: out,
      totals: complete ? sums.totals : null,
      totals_paise: complete ? sums.totals_paise : null,
      partial_totals: complete
        ? null
        : { complete: false, included_line_ids: resolved, excluded_line_ids: out.filter((l) => l.tax_paise === null).map((l) => l.line_id), ...sums },
      invoice_rounding: rounding,
      dataset_version: datasetVersion,
      warnings: out.some((l) => l.warnings.includes('code_not_in_master')) ? ['code_not_in_master'] : [],
      disclaimer: TAX_DISCLAIMER,
    };
    if (rounding === 'nearest_rupee') {
      if (complete) {
        const gross = BigInt(totals.taxable_value + totals.total_tax);
        const rounded = roundHalfUp(gross, 100n) * 100n;
        result.grand_total_paise = Number(rounded);
        result.round_off_paise = Number(rounded - gross);
      } else {
        result.grand_total_paise = null;
        result.round_off_paise = null;
      }
    }
    return result;
  }
}
