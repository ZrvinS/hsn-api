import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { validationError, type FieldError } from '../lib/problem.js';
import { MAX_LINE_PAISE, parseRupees } from '../lib/money.js';
import { parseQuantity, type InvoiceRounding, type SupplyType, type TaxLineInput } from '../services/tax.js';
import { asOfDate, CACHE_NONE, dateQ, HSN_CODE_PATTERN, moneyB, S, sourceSchema } from './common.js';

/** ruling 25 / SA-C-07: token cost = 1 + floor(lines / 50) */
export const TAX_LINES_PER_EXTRA_TOKEN = 50;
export const taxCost = (lines: number): number => 1 + Math.floor(lines / TAX_LINES_PER_EXTRA_TOKEN);
/** max unit_price on a tax line: ₹1,000,000,000 (validator 18) */
const MAX_UNIT_PRICE_PAISE = 100_000_000_000;

interface LineBody {
  line_id?: string;
  hsn: string;
  taxable_value: number | string;
  quantity?: number | string;
  unit_price?: number | string;
  supply_type: SupplyType;
  rule_id?: string;
  condition?: 'general';
}
interface TaxBody {
  invoice_date?: string;
  invoice_rounding?: InvoiceRounding;
  accept_unverified?: boolean;
  lines: LineBody[];
}

const amounts = { type: 'object', properties: { cgst: S.num, sgst: S.num, utgst: S.num, igst: S.num, cess: S.num, total_tax: S.num } } as const;
const amountsPaise = { type: 'object', properties: { cgst: S.int, sgst: S.int, utgst: S.int, igst: S.int, cess: S.int, total_tax: S.int } } as const;

export function registerTaxRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: TaxBody }>(
    '/v1/tax/calculate',
    {
      // 256 KiB (documented deviation from the 64 KiB global limit: 500 fully populated lines exceed 64 KiB)
      // SA-C5-01: charged before validation from the raw array length (an oversized body pays for its size)
      config: { scope: 'read', extraCost: (body: unknown) => { const l = (body as { lines?: unknown } | null | undefined)?.lines; return taxCost(Array.isArray(l) ? l.length : 0) - 1; } },
      bodyLimit: 256 * 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: {
            invoice_date: dateQ,
            invoice_rounding: { type: 'string', enum: ['none', 'nearest_rupee'] },
            accept_unverified: { type: 'boolean' },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['hsn', 'taxable_value', 'supply_type'],
                properties: {
                  line_id: { type: 'string', minLength: 1, maxLength: 64 },
                  hsn: { type: 'string', pattern: HSN_CODE_PATTERN },
                  taxable_value: moneyB,
                  quantity: { type: ['number', 'string'], maxLength: 12 },
                  unit_price: moneyB,
                  supply_type: { type: 'string', enum: ['intra', 'intra_ut', 'inter'] },
                  rule_id: { type: 'string', pattern: '^rr_[0-9A-Za-z_]{1,60}$' },
                  condition: { type: 'string', enum: ['general'] },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              invoice_date: S.str,
              complete: S.bool,
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    line_id: S.str,
                    hsn: S.str,
                    supply_type: S.str,
                    taxable_value: S.num,
                    ambiguous: S.bool,
                    rule_id: S.strN,
                    rule_selected_by: S.strN,
                    default_rule_id: S.strN,
                    unverified_accepted: S.bool,
                    igst_rate_bp: S.intN,
                    igst_rate_percent: S.numN,
                    tax: { ...amounts, type: ['object', 'null'] },
                    tax_paise: { ...amountsPaise, type: ['object', 'null'] },
                    effective_from: S.strN,
                    effective_to: S.strN,
                    source: { ...sourceSchema, type: ['object', 'null'] },
                    last_verified_at: S.strN,
                    verification_status: S.strN,
                    warning: S.strN,
                    candidate_rules: { type: 'array', items: S.str },
                    code_in_master: S.bool,
                    warnings: { type: 'array', items: S.str },
                    resolved_via: S.strN,
                    needs_input: { type: 'array', items: S.str },
                    notes: { type: 'array', items: S.str },
                  },
                },
              },
              totals: { type: ['object', 'null'], properties: { ...amounts.properties, taxable_value: S.num } },
              totals_paise: { type: ['object', 'null'], properties: { ...amountsPaise.properties, taxable_value: S.int } },
              // validator R13: sums over resolved lines only, when complete is false
              partial_totals: {
                type: ['object', 'null'],
                properties: {
                  complete: S.bool,
                  included_line_ids: { type: 'array', items: S.str },
                  excluded_line_ids: { type: 'array', items: S.str },
                  totals: { type: 'object', properties: { ...amounts.properties, taxable_value: S.num } },
                  totals_paise: { type: 'object', properties: { ...amountsPaise.properties, taxable_value: S.int } },
                },
              },
              invoice_rounding: S.str,
              round_off_paise: S.intN,
              grand_total_paise: S.intN,
              dataset_version: S.str,
              warnings: { type: 'array', items: S.str },
              disclaimer: S.str,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ds = ctx.dataset();
      const body = request.body;
      const invoiceDate = asOfDate(body.invoice_date, ctx.clock, '/invoice_date');
      const errs: FieldError[] = [];
      const lines: TaxLineInput[] = body.lines.map((l, i) => {
        const taxable = parseRupees(l.taxable_value);
        if (taxable === null || taxable > MAX_LINE_PAISE) {
          errs.push({ pointer: `/lines/${i}/taxable_value`, code: 'amount', message: 'Must be an INR amount 0–10,000,000,000 with at most 2 decimals' });
        }
        let unit: number | null = null;
        if (l.unit_price !== undefined) {
          unit = parseRupees(l.unit_price);
          if (unit === null || unit <= 0 || unit > MAX_UNIT_PRICE_PAISE) {
            errs.push({ pointer: `/lines/${i}/unit_price`, code: 'amount', message: 'Must be a positive INR amount (≤ 1,000,000,000) with at most 2 decimals' });
          }
        }
        const qty = l.quantity === undefined ? null : parseQuantity(l.quantity);
        if (l.quantity !== undefined && qty === null) errs.push({ pointer: `/lines/${i}/quantity`, code: 'quantity', message: 'Must be > 0 (≤ 9,999,999) with at most 3 decimals' });
        if (l.rule_id !== undefined && l.condition !== undefined) errs.push({ pointer: `/lines/${i}/condition`, code: 'exclusive', message: 'Send rule_id or condition, not both' });
        return {
          // default line_id: zero-based index as a string (validator 7)
          line_id: l.line_id ?? String(i),
          rule_id: l.rule_id ?? null,
          condition: l.condition ?? null,
          hsn: l.hsn,
          taxable_paise: taxable ?? 0,
          quantity: qty,
          unit_price_paise: unit,
          supply_type: l.supply_type,
        };
      });
      if (errs.length > 0) throw validationError(errs);
      reply.header('Cache-Control', CACHE_NONE);
      return ctx.tax.calculate(invoiceDate, lines, ds.current_version, body.invoice_rounding ?? 'none', body.accept_unverified === true);
    },
  );
}
