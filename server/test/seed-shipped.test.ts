/**
 * Checks against the shipped data/seed (not the test fixture): the rates a reviewer relies on, and the
 * R3 behaviour (8-digit codes outside the HSN master resolve under their nearest known parent).
 * If data/seed is being regenerated these tests may fail transiently; rerun.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearer, makeEnv, type TestEnv } from './helpers.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
type RuleDto = { rule_id: string; hsn_prefix: string; igst_rate_bp: number; condition: { kind: string; code: string | null }; verification_status: string };

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ seedDir: SEED }); // loaded exactly as scripts/seed.ts does (allowVerified false)
});
afterAll(async () => env.close());
const get = async (url: string) => env.app.inject({ method: 'GET', url, headers: bearer(env.keys.read!) });
const tax = async (payload: object) => env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(env.keys.read!), payload });

describe('shipped seed: key rates (as of 2026-10-10)', () => {
  it('every shipped rule is unverified', async () => {
    const n = env.storage.readDb.prepare(`SELECT COUNT(*) AS n FROM rate_rules WHERE verification_status <> 'unverified'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('3004 is ambiguous: 5% default rule and a 0% nil_rate_list rule', async () => {
    const r = await get('/v1/hsn/3004?date=2026-10-10');
    expect(r.statusCode).toBe(200);
    const rate = r.json().rate as { ambiguous: boolean; default_rule_id: string | null; rules: RuleDto[]; warnings: string[] };
    expect(rate.ambiguous).toBe(true);
    const def = rate.rules.find((x) => x.rule_id === rate.default_rule_id)!;
    expect(def).toMatchObject({ igst_rate_bp: 500, condition: { kind: 'none' } });
    expect(rate.rules.find((x) => x.condition.code === 'nil_rate_list')).toMatchObject({ igst_rate_bp: 0, condition: { kind: 'other' } });
    expect(rate.warnings).toEqual(expect.arrayContaining(['ambiguous', 'rate_unverified']));
  });

  it('7113 is 3%', async () => {
    const rate = (await get('/v1/hsn/7113?date=2026-10-10')).json().rate;
    expect(rate.ambiguous).toBe(false);
    expect(rate.applicable_rule).toMatchObject({ igst_rate_bp: 300, igst_rate_percent: 3 });
  });

  it('6109 is resolved by unit_price at the ₹2,500 boundary (5% at ≤ ₹2,500, 18% above)', async () => {
    const at = (await get('/v1/hsn/6109?date=2026-10-10&unit_price=2500')).json().rate;
    expect(at.applicable_rule).toMatchObject({ igst_rate_bp: 500 });
    const above = (await get('/v1/hsn/6109?date=2026-10-10&unit_price=2500.01')).json().rate;
    expect(above.applicable_rule).toMatchObject({ igst_rate_bp: 1800 });
    const none = (await get('/v1/hsn/6109?date=2026-10-10')).json().rate;
    expect(none.ambiguous).toBe(true);
  });

  it('999721 (hairdressing) is 5% via its SAC group 99972', async () => {
    const r = (await get('/v1/hsn/999721?date=2026-10-10')).json();
    expect(r.code_in_master).toBe(true);
    expect(r.rate.matched_at_level).toBe(5);
    expect(r.rate.applicable_rule).toMatchObject({ hsn_prefix: '99972', igst_rate_bp: 500 });
  });
});

describe('R3: codes outside the HSN master resolve under the nearest known parent', () => {
  it('30049099 → under 3004 (ambiguous, as 3004)', async () => {
    const r = await get('/v1/hsn/30049099?date=2026-10-10');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ code: '30049099', code_in_master: false, resolved_via: '3004' });
    expect(b.rate.ambiguous).toBe(true);
    expect(b.rate.warnings).toContain('code_not_in_master');
  });

  it('61091000 with unit_price → under 6109, matched at the chapter-61 price rules', async () => {
    const b = (await get('/v1/hsn/61091000?date=2026-10-10&unit_price=999')).json();
    expect(b).toMatchObject({ code_in_master: false, resolved_via: '6109' });
    expect(b.rate.matched_at_level).toBe(2);
    expect(b.rate.applicable_rule).toMatchObject({ hsn_prefix: '61', igst_rate_bp: 500 });
    expect(b.rate.warnings).toContain('code_not_in_master');
  });

  it('85171300 → under 8517 at 18%', async () => {
    const b = (await get('/v1/hsn/85171300?date=2026-10-10')).json();
    expect(b).toMatchObject({ code_in_master: false, resolved_via: '8517' });
    expect(b.rate.matched_at_level).toBe(4);
    expect(b.rate.applicable_rule).toMatchObject({ hsn_prefix: '8517', igst_rate_bp: 1800 });
  });

  it('a code whose chapter does not exist is still 404', async () => {
    const r = await get('/v1/hsn/0099');
    expect(r.statusCode).toBe(404);
    expect(r.json().detail).toMatch(/chapter 00/);
  });

  it('tax/calculate: lines with codes outside the master are computed (with the warning), not 422; totals are partial while a line needs input', async () => {
    const r = await tax({
      invoice_date: '2026-10-10', accept_unverified: true,
      lines: [
        { line_id: 'a', hsn: '61091000', taxable_value: 1998, quantity: 2, supply_type: 'intra' },
        { line_id: 'b', hsn: '85171300', taxable_value: 10000, supply_type: 'inter' },
        { line_id: 'c', hsn: '30049099', taxable_value: 100, supply_type: 'intra' },
      ],
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.lines[0]).toMatchObject({ code_in_master: false, resolved_via: '6109', igst_rate_percent: 5 });
    expect(b.lines[0].tax.total_tax).toBe(99.9);
    expect(b.lines[0].notes.join(' ')).toMatch(/code_not_in_master/);
    expect(b.lines[1]).toMatchObject({ code_in_master: false, resolved_via: '8517' });
    expect(b.lines[1].tax.igst).toBe(1800);
    expect(b.lines[2].tax).toBeNull();
    expect(b.lines[2].needs_input.length).toBeGreaterThan(0);
    expect(b.totals).toBeNull();
    expect(b.partial_totals).toMatchObject({ complete: false, included_line_ids: ['a', 'b'], excluded_line_ids: ['c'] });
    expect(b.partial_totals.totals.total_tax).toBe(1899.9);

    const unknown = await tax({ invoice_date: '2026-10-10', accept_unverified: true, lines: [{ hsn: '0099', taxable_value: 10, supply_type: 'intra' }] });
    expect(unknown.statusCode).toBe(422);
  });
});
