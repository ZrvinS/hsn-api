import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from './helpers.js';
import { computeLineTax, parseQuantity } from '../src/services/tax.js';
import { parseRupees, paiseToRupeeString, roundHalfUp } from '../src/lib/money.js';

describe('tax maths (paise, bp, half-up per line per component)', () => {
  it.each([
    // [taxable paise, bp, supply, cgst, sgst, igst]
    [6_850_000, 300, 'intra', 102_750, 102_750, 0], // ₹68,500 @3% → 1027.50 each
    [6_850_000, 300, 'inter', 0, 0, 205_500],
    [100_001, 25, 'intra', 125, 125, 0], // 0.25%: 100001×25/20000 = 125.00125 → 125
    [100_001, 25, 'inter', 0, 0, 250], // 250.0025 → 250
    [10_000, 25, 'intra', 13, 13, 0], // 12.5 → 13 (half-up)
    [10_000, 500, 'intra', 250, 250, 0], // 5%
    [12_345, 500, 'inter', 0, 0, 617], // 617.25 → 617
    [100_000, 1800, 'intra', 9_000, 9_000, 0], // 18%
    [99_999, 1800, 'inter', 0, 0, 18_000], // 17999.82 → 18000
    [100_000, 4000, 'intra', 20_000, 20_000, 0], // 40%
    [333, 4000, 'inter', 0, 0, 133], // 133.2 → 133
    [1, 300, 'intra', 0, 0, 0], // 0.015 → 0
    [17, 300, 'intra', 0, 0, 0], // 0.255 → 0 each, igst 0.51 → 1
    [17, 300, 'inter', 0, 0, 1],
    [0, 1800, 'intra', 0, 0, 0],
  ] as const)('taxable %i @ %i bp %s', (t, bp, supply, cgst, sgst, igst) => {
    const r = computeLineTax(t, bp, 0, supply);
    expect([r.cgst, r.sgst, r.igst]).toEqual([cgst, sgst, igst]);
    expect(r.total_tax).toBe(cgst + sgst + igst);
  });

  it('half-up rounding boundary: exactly .5 paise rounds up', () => {
    // 50 paise @ 1% inter = 0.5 paise → 1
    expect(computeLineTax(50, 100, 0, 'inter').igst).toBe(1);
    expect(computeLineTax(49, 100, 0, 'inter').igst).toBe(0);
    expect(roundHalfUp(5n, 10n)).toBe(1n);
    expect(roundHalfUp(4n, 10n)).toBe(0n);
    expect(roundHalfUp(15n, 10n)).toBe(2n);
  });

  it('ad-valorem cess is computed separately and added', () => {
    const r = computeLineTax(100_000, 2800, 1200, 'inter');
    expect(r.igst).toBe(28_000);
    expect(r.cess).toBe(12_000);
    expect(r.total_tax).toBe(40_000);
  });

  it('property: cgst == sgst, |cgst+sgst−igst| ≤ 1, monotonic, integers (2000 runs)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const slabs = [0, 10, 25, 100, 150, 300, 500, 600, 1200, 1800, 2800, 4000];
    for (let i = 0; i < 2000; i++) {
      const t = Math.floor(rnd() * 1e12);
      const bp = slabs[Math.floor(rnd() * slabs.length)]!;
      const intra = computeLineTax(t, bp, 0, 'intra');
      const inter = computeLineTax(t, bp, 0, 'inter');
      expect(intra.cgst).toBe(intra.sgst);
      expect(Math.abs(intra.cgst + intra.sgst - inter.igst)).toBeLessThanOrEqual(1);
      expect(Number.isSafeInteger(intra.total_tax)).toBe(true);
      expect(computeLineTax(t + 1, bp, 0, 'inter').igst).toBeGreaterThanOrEqual(inter.igst);
    }
    expect(computeLineTax(123_456, 10000, 0, 'inter').igst).toBe(123_456);
  });

  it('money parsing never uses float maths', () => {
    expect(parseRupees('1234.50')).toBe(123450);
    expect(parseRupees(0.07)).toBe(7);
    expect(parseRupees(1027.5)).toBe(102750);
    expect(parseRupees(0.1 + 0.2)).toBeNull(); // 0.30000000000000004 has > 2 decimals
    expect(parseRupees(1.234)).toBeNull();
    expect(parseRupees(-1)).toBeNull();
    expect(parseRupees(1e21)).toBeNull();
    expect(parseRupees('10000000000')).toBe(1_000_000_000_000);
    for (const p of [0, 1, 99, 100, 123456789, 1_000_000_000_000]) expect(parseRupees(paiseToRupeeString(p))).toBe(p);
    expect(parseQuantity(2)?.milli).toBe(2000n);
    expect(parseQuantity(1.5)?.milli).toBe(1500n);
    expect(parseQuantity(0)).toBeNull();
  });
});

describe('POST /v1/tax/calculate', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());
  const post = (payload: unknown) => env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(env.keys.read!), payload: payload as object });

  it('matches the openapi example: 7113 intra, 6109 by quantity, 6109 ambiguous', async () => {
    const res = await post({
      invoice_date: '2026-10-10',
      lines: [
        { line_id: '1', hsn: '7113', taxable_value: 68500.0, supply_type: 'intra' },
        { line_id: '2', hsn: '6109', taxable_value: 3600.0, quantity: 2, supply_type: 'intra' },
        { line_id: '3', hsn: '6109', taxable_value: 3600.0, supply_type: 'inter' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const b = res.json();
    expect(b.complete).toBe(false);
    expect(b.lines[0].tax).toEqual({ cgst: 1027.5, sgst: 1027.5, utgst: 0, igst: 0, cess: 0, total_tax: 2055 });
    expect(b.lines[0].tax_paise.cgst).toBe(102750);
    expect(b.lines[0].verification_status).toBe('verified');
    expect(b.lines[1].tax).toEqual({ cgst: 90, sgst: 90, utgst: 0, igst: 0, cess: 0, total_tax: 180 });
    expect(b.lines[1].notes[0]).toMatch(/1800\.00/);
    expect(b.lines[2].ambiguous).toBe(true);
    expect(b.lines[2].tax).toBeNull();
    expect(b.lines[2].candidate_rules).toHaveLength(2);
    expect(b.lines[2].needs_input).toEqual(['unit_price']);
    // R13: incomplete invoice → no invoice totals; the resolved lines are summed in partial_totals
    expect(b.totals).toBeNull();
    expect(b.totals_paise).toBeNull();
    expect(b.partial_totals).toMatchObject({ complete: false, included_line_ids: ['1', '2'], excluded_line_ids: ['3'] });
    expect(b.partial_totals.totals).toEqual({ cgst: 1117.5, sgst: 1117.5, utgst: 0, igst: 0, cess: 0, total_tax: 2235, taxable_value: 72100 });
    expect(b.disclaimer).toMatch(/Not an official/);
  });

  it('25 bp line (0.25%): CGST = SGST = round_half_up(taxable × 25 / 20000)', async () => {
    const b = (await post({ lines: [{ hsn: '710210', taxable_value: 1000.01, supply_type: 'intra' }] })).json();
    expect(b.lines[0].tax_paise).toEqual({ cgst: 125, sgst: 125, utgst: 0, igst: 0, cess: 0, total_tax: 250 });
    expect(b.lines[0].igst_rate_percent).toBe(0.25);
  });

  it('inter-state IGST, 18% on 6109 with unit_price above threshold', async () => {
    const b = (await post({ lines: [{ hsn: '6109', taxable_value: '2500.01', unit_price: 2500.01, supply_type: 'inter' }] })).json();
    expect(b.lines[0].tax_paise.igst).toBe(45_000);
    // R13: a complete invoice keeps totals; partial_totals is null
    expect(b.complete).toBe(true);
    expect(b.partial_totals).toBeNull();
    expect(b.totals.total_tax).toBe(450);
    expect(b.complete).toBe(true);
  });

  it('unverified rule (ruling 24): accepted explicitly, tax computed, line flagged rate_unverified', async () => {
    const b = (await post({ accept_unverified: true, lines: [{ hsn: '3004', condition: 'general', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(b.lines[0].unverified_accepted).toBe(true);
    expect(b.lines[0].tax.total_tax).toBe(5);
    expect(b.lines[0].verification_status).toBe('unverified');
    expect(b.lines[0].warning).toMatch(/Unverified/);
    expect(b.lines[0].notes.join(' ')).toMatch(/rate_unverified/);
  });

  it('specific cess is returned as a note, not computed', async () => {
    const b = (await post({ lines: [{ hsn: '2402', taxable_value: 100, supply_type: 'inter' }] })).json();
    expect(b.lines[0].tax.cess).toBe(0);
    expect(b.lines[0].notes.join(' ')).toMatch(/specific_cess_not_computed/);
  });

  it('no rule → tax null, complete false, never a zero rate', async () => {
    const b = (await post({ lines: [{ hsn: '8517', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(b.lines[0].tax).toBeNull();
    expect(b.complete).toBe(false);
    expect(b.totals).toBeNull();
    expect(b.partial_totals.totals.total_tax).toBe(0);
    expect(b.partial_totals.excluded_line_ids).toEqual(['0']);
  });

  it('nearest_rupee rounding adds round_off_paise and grand_total_paise', async () => {
    const b = (await post({ invoice_rounding: 'nearest_rupee', lines: [{ hsn: '7113', taxable_value: 100.33, supply_type: 'intra' }] })).json();
    // taxable 10033 + tax (150.495→150, ×2 = 300) = 10333 → 10300
    expect(b.grand_total_paise).toBe(10300);
    expect(b.round_off_paise).toBe(-33);
  });

  it('unknown HSN → 422 unknown-hsn with pointer', async () => {
    const res = await post({ lines: [{ hsn: '7113', taxable_value: 1, supply_type: 'intra' }, { hsn: '7799', taxable_value: 1, supply_type: 'intra' }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].pointer).toBe('/lines/1/hsn');
  });

  it('money with > 2 decimals → 400 with pointer, value not echoed', async () => {
    const res = await post({ lines: [{ hsn: '7113', taxable_value: 10.123, supply_type: 'intra' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].pointer).toBe('/lines/0/taxable_value');
    expect(res.body).not.toContain('10.123');
  });

  it('501 lines → 400; above max taxable → 400', async () => {
    const line = { hsn: '7113', taxable_value: 1, supply_type: 'intra' };
    expect((await post({ lines: Array(501).fill(line) })).statusCode).toBe(400);
    expect((await post({ lines: [{ ...line, taxable_value: 10000000000.01 }] })).statusCode).toBe(400);
    expect((await post({ lines: [{ ...line, taxable_value: 10000000000 }] })).statusCode).toBe(200);
  });
});
