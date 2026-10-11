/**
 * Round-5 regression tests: SA-K3-01 (third-party brand cannot establish exactness),
 * SA-K3-03 (outbound partition per tenant), SA-K3-04 (quantity allow-list).
 * Test data is illustrative (see helpers.ts); it carries no rates.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifierPipeline } from '../../src/classify/pipeline.js';
import { isQuantityLike } from '../../src/classify/coverage.js';
import type { ClassifyResult } from '../../src/classify/types.js';
import type { LookupResult, ProductLookup } from '../../src/adapters/productLookup.js';
import type { Repos } from '../../src/repositories/types.js';
import { captureLogger, clock, ctx, input, makeRepos } from './helpers.js';

const top = (r: ClassifyResult) => r.candidates[0]!;
function make(repos: Repos, extra: Partial<ConstructorParameters<typeof ClassifierPipeline>[0]> = {}) {
  return new ClassifierPipeline({ hsn: repos.hsn, synonyms: repos.synonyms, products: repos.products, clock: clock(), log: captureLogger(), adapters: [], ...extra });
}
function adapter(fn: () => LookupResult): ProductLookup & { calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  return { source: 'open_food_facts', calls, lookup: vi.fn(async (c: string, p?: string) => (calls.push([c, p]), fn())) };
}
const found = (brand: string | null): LookupResult => ({
  status: 'found', source: 'open_food_facts', name: 'Strips', brand, categories: [], sourceRef: 'https://world.openfoodfacts.org/product/8901234012345',
});

describe('SA-K3-01: a crowd-edited brand never makes a synonym exact', () => {
  it('auditor probe: "glucometer test strips" + OFF brand "Test Strips" is not high and needs review', async () => {
    const withBrand = await make(makeRepos(), { adapters: [adapter(() => found('Test Strips'))] }).classify(input({ name: 'glucometer test strips', barcode: '8901234012345', keyId: 'k' }), ctx());
    const noBrand = await make(makeRepos(), { adapters: [adapter(() => found(null))] }).classify(input({ name: 'glucometer test strips', barcode: '8901234012345', keyId: 'k' }), ctx());
    for (const c of withBrand.candidates) expect(c.confidence_band).not.toBe('high');
    expect(withBrand.needs_review).toBe(true);
    expect(top(withBrand).signals.synonym).toBeLessThan(1);
    // the brand has no effect on scoring at all
    expect(withBrand.candidates.map((c) => [c.hsn, c.confidence])).toEqual(noBrand.candidates.map((c) => [c.hsn, c.confidence]));
  });
  it('a cached product brand is ignored too', async () => {
    const repos = makeRepos();
    repos.products.upsert({ gtin: '08901234012345', name: 'Strips', brand: 'Test Strips', category: null, source: 'open_food_facts', source_ref: null, found: true, fetched_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-20T00:00:00Z' });
    const r = await make(repos).classify(input({ name: 'glucometer test strips', barcode: '8901234012345', keyId: 'k' }), ctx());
    for (const c of r.candidates) expect(c.confidence_band).not.toBe('high');
  });
});

describe('SA-K3-04: only number + known unit is a quantity', () => {
  it('"22k gold ring 1toy" is not high; "22k gold ring 10 gm" still is', async () => {
    const p = make(makeRepos());
    const glued = await p.classify(input({ name: '22k gold ring 1toy' }), ctx());
    for (const c of glued.candidates) expect(c.confidence_band).not.toBe('high');
    const ok = await p.classify(input({ name: '22k gold ring 10gm' }), ctx());
    expect([top(ok).hsn, top(ok).confidence_band]).toEqual(['7113', 'high']);
  });
  it.each([
    ['500mg', true], ['10gm', true], ['1.5l', true], ['64gb', true], ['3x', true], ['22k', true], ['916', true],
    ['1toy', false], ['2abc', false], ['7k', false], ['5kt', false], ['1box', false], ['99zz', false],
  ])('isQuantityLike(%s) = %s', (t, want) => {
    expect(isQuantityLike(t)).toBe(want);
  });
});

describe('SA-K3-03: outbound partition is the key owner (tenant)', () => {
  it('two keys of one tenant use one partition; no tenant falls back to the key; no key to the shared bucket', async () => {
    const a = adapter(() => ({ status: 'not_found', source: 'open_food_facts' }) as LookupResult);
    const p = make(makeRepos(), { adapters: [a] });
    await p.classify(input({ barcode: '8901234012345', keyId: 'k1', tenantId: 'acme' }), ctx());
    await p.classify(input({ barcode: '8901234012352', keyId: 'k2', tenantId: 'acme' }), ctx());
    await p.classify(input({ barcode: '8901234012369', keyId: 'k3' }), ctx());
    await p.classify(input({ barcode: '8901234012376', keyId: null }), ctx());
    expect(a.calls.map(([, part]) => part)).toEqual(['tenant:acme', 'tenant:acme', 'k3', 'shared:no-key']);
  });
});
