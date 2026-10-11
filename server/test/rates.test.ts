import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from './helpers.js';
import { resolveRules } from '../src/services/rates.js';
import type { RateRuleRow } from '../src/repositories/types.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const get = (url: string) => env.app.inject({ method: 'GET', url, headers: bearer(env.keys.read!) });

describe('rate resolution over HTTP (data-model §3)', () => {
  it('single rule: 7113 → 300 bp, matched_at_level 4, honesty fields present', async () => {
    const res = await get('/v1/hsn/7113');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.rate.ambiguous).toBe(false);
    expect(b.rate.applicable_rule.igst_rate_bp).toBe(300);
    expect(b.rate.applicable_rule.cgst_rate_percent).toBe(1.5);
    expect(b.rate.matched_at_level).toBe(4);
    expect(b.rate.applicable_rule.effective_from).toBe('2017-07-01');
    expect(b.rate.applicable_rule.effective_to).toBeNull();
    expect(b.rate.applicable_rule.source.url).toMatch(/^https:\/\//);
    expect(b.rate.applicable_rule.last_verified_at).toBe('2026-10-03T09:12:00Z');
    expect(b.rate.applicable_rule.verification_status).toBe('verified');
    expect(b.rate.applicable_rule.warning).toBeNull();
    expect(b.rate.warnings).toEqual([]);
    expect(b.disclaimer).toMatch(/not an official/i);
    expect(b.ancestors.map((a: { code: string }) => a.code)).toEqual(['71']);
    expect(b.rate.as_of).toBe('2026-10-10');
  });

  it('longest prefix: 8-digit code under 7113 inherits the 7113 rule', async () => {
    const b = (await get('/v1/hsn/71131910')).json();
    expect(b.rate.applicable_rule.hsn_prefix).toBe('7113');
    expect(b.ancestors.map((a: { code: string }) => a.code)).toEqual(['71', '7113', '711319']);
  });

  it('longest prefix beats a shorter one: 710231 → 150 bp, not the 7102 25 bp rule', async () => {
    const b = (await get('/v1/hsn/710231')).json();
    expect(b.rate.applicable_rule.igst_rate_bp).toBe(150);
    expect(b.rate.matched_at_level).toBe(6);
  });

  it('25 bp (0.25%) rule shows CGST/SGST as 0.125%', async () => {
    const b = (await get('/v1/hsn/710210')).json();
    expect(b.rate.applicable_rule.igst_rate_bp).toBe(25);
    expect(b.rate.applicable_rule.igst_rate_percent).toBe(0.25);
    expect(b.rate.applicable_rule.cgst_rate_percent).toBe(0.125);
  });

  it('descendant differs: 7102 is ambiguous and names the more specific code', async () => {
    const b = (await get('/v1/hsn/7102')).json();
    expect(b.rate.ambiguous).toBe(true);
    expect(b.rate.applicable_rule).toBeNull();
    expect(b.rate.ambiguity_reason).toContain('710231');
    expect(b.rate.rules.map((r: { igst_rate_bp: number }) => r.igst_rate_bp).sort()).toEqual([150, 25]);
  });

  it('date boundaries are inclusive: 3004 on 2025-09-21 → 1200, on 2025-09-22 → 500', async () => {
    const a = (await get('/v1/hsn/3004?date=2025-09-21')).json();
    const b = (await get('/v1/hsn/3004?date=2025-09-22')).json();
    expect(a.rate.applicable_rule.igst_rate_bp).toBe(1200);
    expect(a.rate.applicable_rule.effective_to).toBe('2025-09-21');
    // ruling 5: from 2025-09-22 the general 5% rule sits alongside the nil-rate-list 0% rule
    expect(b.rate.coverage).toBe('ambiguous');
    expect(b.rate.applicable_rule).toBeNull();
    const def = b.rate.rules.find((r: { rule_id: string }) => r.rule_id === b.rate.default_rule_id);
    expect(def.igst_rate_bp).toBe(500);
  });

  it('unverified rule carries verification_status, warning and rate_unverified', async () => {
    const b = (await get('/v1/hsn/3004')).json();
    const r = b.rate.rules.find((x: { rule_id: string }) => x.rule_id === b.rate.default_rule_id);
    expect(r.verification_status).toBe('unverified');
    expect(r.last_verified_at).toBeNull();
    expect(r.verified_by).toBeNull();
    expect(r.warning).toMatch(/unverified/i);
    expect(b.rate.warnings).toContain('rate_unverified');
    expect(b.rate.verification_status).toBe('unverified');
    expect(b.rate.disclaimer).toMatch(/not yet been checked/);
  });

  it('future-dated rule switches on effective_from (1905: 1800 → 500 on 2027-01-01)', async () => {
    expect((await get('/v1/hsn/1905?date=2026-12-31')).json().rate.applicable_rule.igst_rate_bp).toBe(1800);
    expect((await get('/v1/hsn/1905?date=2027-01-01')).json().rate.applicable_rule.igst_rate_bp).toBe(500);
  });

  it('price thresholds: no unit_price → ambiguous with both rules', async () => {
    const b = (await get('/v1/hsn/6109')).json();
    expect(b.rate.ambiguous).toBe(true);
    expect(b.rate.rules).toHaveLength(2);
    expect(b.rate.ambiguity_reason).toMatch(/unit price/);
  });

  it('price thresholds inclusive: 2500.00 → 500 bp, 2500.01 → 1800 bp, 0.01 → 500 bp', async () => {
    expect((await get('/v1/hsn/6109?unit_price=2500.00')).json().rate.applicable_rule.igst_rate_bp).toBe(500);
    expect((await get('/v1/hsn/6109?unit_price=2500')).json().rate.applicable_rule.igst_rate_bp).toBe(500);
    expect((await get('/v1/hsn/6109?unit_price=2500.01')).json().rate.applicable_rule.igst_rate_bp).toBe(1800);
    expect((await get('/v1/hsn/6109?unit_price=0.01')).json().rate.applicable_rule.igst_rate_bp).toBe(500);
  });

  it('non-price conditions → ambiguous, a human must choose (0406)', async () => {
    const b = (await get('/v1/hsn/0406')).json();
    expect(b.rate.ambiguous).toBe(true);
    expect(b.rate.ambiguity_reason).toMatch(/human must choose/);
  });

  it('identical rate tuples → not ambiguous; latest last_verified_at wins (2924)', async () => {
    const b = (await get('/v1/hsn/2924')).json();
    expect(b.rate.ambiguous).toBe(false);
    expect(b.rate.applicable_rule.condition.text).toBe('Condition B');
  });

  it('HSN with no rule → coverage no_rate_rule and no invented rate', async () => {
    const b = (await get('/v1/hsn/8517')).json();
    expect(b.rate.coverage).toBe('no_rate_rule');
    expect(b.rate.applicable_rule).toBeNull();
    expect(b.rate.rules).toEqual([]);
  });

  it('unknown code whose chapter does not exist → 404 hsn-not-found problem (R3: a known chapter resolves instead)', async () => {
    const r3 = await get('/v1/hsn/7199');
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toMatchObject({ code: '7199', code_in_master: false, resolved_via: '71' });
    expect(r3.json().rate.warnings).toContain('code_not_in_master');
    const res = await get('/v1/hsn/7799');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().type).toBe('https://hsn-api.example/problems/hsn-not-found');
  });

  it.each(['2017-06-30', '2024-02-30', '2016-01-01', '2027-10-12', '20250101'])('invalid date %s → 400', async (d) => {
    const res = await get(`/v1/hsn/3004?date=${d}`);
    expect(res.statusCode).toBe(400);
  });

  it.each(['../7113', '7113%00', '71131910123', '711', 'abcd', '71-13'])('invalid code %s → 400 or 404 before DB', async (c) => {
    const res = await get(`/v1/hsn/${c}`);
    expect([400, 404]).toContain(res.statusCode);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it.each(['0', '-1', '1.234', 'abc', '1e5'])('invalid unit_price %s → 400', async (p) => {
    expect((await get(`/v1/hsn/6109?unit_price=${p}`)).statusCode).toBe(400);
  });

  it('ETag + If-None-Match → 304', async () => {
    const a = await get('/v1/hsn/7113');
    const etag = a.headers.etag as string;
    expect(etag).toMatch(/^W\/"ds-\d{4}\.\d{2}\.\d{2}-\d+-[0-9a-f]+"$/);
    expect(a.headers['cache-control']).toContain('private');
    const b = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { ...bearer(env.keys.read!), 'if-none-match': etag } });
    expect(b.statusCode).toBe(304);
    expect(b.body).toBe('');
  });
});

describe('resolveRules (pure) edge cases', () => {
  const base: RateRuleRow = {
    rule_id: 'rr_A', hsn_prefix: '61', igst_rate_bp: 500, cess_rate_bp: 0, cess_specific_paise: null, cess_specific_unit: null,
    condition_kind: 'none', condition_text: null, min_unit_price_paise: null, max_unit_price_paise: null,
    effective_from: '2017-07-01', effective_to: null, notification_ref: 'n', source_url: 'https://x', verified_by: null,
    last_verified_at: null, verification_status: 'unverified', created_in_version: 'v', end_dated_in_version: null, superseded_by: null, proposal_id: null,
    condition_code: null, source_pdf_sha256: null, schedule_serial: null, status: 'active', voided_at: null, voided_in_version: null, voided_by_rule: null, retroactive_reason: null, seed_batch_id: 'sb_x', citation_note: null,
  };
  it('overlapping price rules with a price given → ambiguous + overlap flag', () => {
    const a = { ...base, rule_id: 'rr_1', condition_kind: 'price' as const, condition_text: 't', max_unit_price_paise: 300000 };
    const b = { ...base, rule_id: 'rr_2', igst_rate_bp: 1800, condition_kind: 'price' as const, condition_text: 't', min_unit_price_paise: 200000 };
    const o = resolveRules('6109', 250000, { ancestorOrSelf: [a, b], descendants: [] });
    expect(o.ambiguous).toBe(true);
    expect(o.overlap).toBe(true);
  });
  it('price filters out all rules → no_rate_rule', () => {
    const a = { ...base, condition_kind: 'price' as const, condition_text: 't', min_unit_price_paise: 100, max_unit_price_paise: 200 };
    expect(resolveRules('6109', 201, { ancestorOrSelf: [a], descendants: [] }).coverage).toBe('no_rate_rule');
    expect(resolveRules('6109', 200, { ancestorOrSelf: [a], descendants: [] }).applicable?.rule_id).toBe('rr_A');
    expect(resolveRules('6109', 100, { ancestorOrSelf: [a], descendants: [] }).applicable?.rule_id).toBe('rr_A');
    expect(resolveRules('6109', 99, { ancestorOrSelf: [a], descendants: [] }).coverage).toBe('no_rate_rule');
  });
  it('descendant with the same rate does not make the result ambiguous', () => {
    const d = { ...base, rule_id: 'rr_D', hsn_prefix: '610910' };
    const o = resolveRules('6109', null, { ancestorOrSelf: [base], descendants: [d] });
    expect(o.ambiguous).toBe(false);
    expect(o.applicable?.rule_id).toBe('rr_A');
  });
  it('only descendant rules exist → ambiguous', () => {
    const d = { ...base, rule_id: 'rr_D', hsn_prefix: '610910' };
    expect(resolveRules('6109', null, { ancestorOrSelf: [], descendants: [d] }).ambiguous).toBe(true);
  });
});
