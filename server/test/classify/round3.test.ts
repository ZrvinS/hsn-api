/**
 * Round-3 regression tests: security findings SA-K2-01..06.
 * Test data is illustrative (see helpers.ts); it carries no rates.
 */
// "examplomab" is a fictional fixture drug name. The nil-rate hint fixtures are illustrative and say nothing about any real drug's rate.
import { describe, expect, it, vi } from 'vitest';
import { ClassifierPipeline, MESSAGES } from '../../src/classify/pipeline.js';
import type { Reranker } from '../../src/classify/rerank.js';
import { SynonymMatcher, type SynonymInput } from '../../src/classify/synonyms.js';
import { normaliseName, tokenEq } from '../../src/classify/normalise.js';
import { hasNegation } from '../../src/classify/ruleHint.js';
import type { ClassifyInput, ClassifyResult } from '../../src/classify/types.js';
import type { LookupResult, ProductLookup } from '../../src/adapters/productLookup.js';
import type { Repos, SynonymRepo } from '../../src/repositories/types.js';
import { captureLogger, clock, ctx, input, makeRepos } from './helpers.js';

const top = (r: ClassifyResult) => r.candidates[0]!;

function make(repos: Repos, extra: Partial<ConstructorParameters<typeof ClassifierPipeline>[0]> = {}) {
  return new ClassifierPipeline({ hsn: repos.hsn, synonyms: repos.synonyms, products: repos.products, clock: clock(), log: captureLogger(), adapters: [], ...extra });
}
function withHint(repos: Repos): Pick<SynonymRepo, 'allActive' | 'chaptersForKeywords' | 'categoryPrefix'> {
  return {
    allActive: () => [
      ...repos.synonyms.allActive(),
      { id: 999, phrase: 'examplomab injection', hsn_code: '3004', strength: 'primary', note: null, created_by: 'test', created_at: '2026-10-01T00:00:00Z', active: true, rule_hint: 'nil_rate_list' } as ReturnType<SynonymRepo['allActive']>[number],
    ],
    chaptersForKeywords: (k) => repos.synonyms.chaptersForKeywords(k),
    categoryPrefix: (s, c) => repos.synonyms.categoryPrefix(s, c),
  };
}
function adapter(fn: (code: string, partition?: string) => LookupResult): ProductLookup & { calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  return { source: 'open_food_facts', calls, lookup: vi.fn(async (c: string, p?: string) => (calls.push([c, p]), fn(c, p))) };
}

describe('SA-K2-01: rule hint only when the name IS the synonym product; always with review', () => {
  const repos = makeRepos();
  const p = make(repos, { synonyms: withHint(repos) });

  it.each(['Not examplomab injection, vitamin B12 syrup', 'non-examplomab injection', 'examplomab injection pen needles 100 pcs'])(
    'probe "%s" → no rule_hint on any candidate',
    async (name) => {
      const r = await p.classify(input({ name }), ctx());
      for (const c of r.candidates) expect(c.rule_hint).toBeUndefined();
    },
  );

  it.each([
    'sugar-free examplomab injection',
    'examplomab injection free',
    'examplomab injection without needle',
    'no examplomab injection',
    'examplomab injection बिना',
    'examplomab injection नहीं',
    'बिना examplomab injection',
  ])('negation "%s" → no hint, never high, negation review hint', async (name) => {
    const r = await p.classify(input({ name }), ctx());
    for (const c of r.candidates) {
      expect(c.rule_hint).toBeUndefined();
      expect(c.confidence_band).not.toBe('high');
    }
    expect(r.needs_review).toBe(true);
    expect(r.candidates.some((c) => c.reasons.some((x) => x.code === 'review_hint' && x.detail === MESSAGES.negation))).toBe(true);
  });

  it('"Examplomab injection 10 ml" → hint, but needs_review true, not high, with a review_hint reason', async () => {
    const r = await p.classify(input({ name: 'Examplomab injection 10 ml' }), ctx());
    expect(top(r).hsn).toBe('3004');
    expect(top(r).rule_hint).toEqual({ condition: 'nil_rate_list', synonym: 'examplomab injection' });
    expect(top(r).needs_review).toBe(true);
    expect(r.needs_review).toBe(true);
    expect(top(r).confidence_band).not.toBe('high');
    expect(top(r).reasons.some((x) => x.code === 'review_hint' && x.detail === MESSAGES.ruleHintAssumed('nil_rate_list', 'examplomab injection'))).toBe(true);
  });

  it('form/quantity words do not block the hint: "examplomab injections 10 ml vial"', async () => {
    const r = await p.classify(input({ name: 'examplomab injections 10 ml vial' }), ctx());
    expect(top(r).rule_hint).toEqual({ condition: 'nil_rate_list', synonym: 'examplomab injection' });
  });

  it('invariant over many names: a set hint always comes with needs_review and a review_hint', async () => {
    const names = ['examplomab injection', 'Examplomab Injection 40 IU', 'examplomab injection pen', 'examplomab injection cartridge 3 ml', 'human examplomab injection', 'examplomab injection syringe', 'paracetamol 500mg tablet', '22K gold ring'];
    for (const name of names) {
      const r = await p.classify(input({ name }), ctx());
      for (const c of r.candidates) {
        if (c.rule_hint === undefined) continue;
        expect(c.needs_review).toBe(true);
        expect(r.needs_review).toBe(true);
        expect(c.reasons.some((x) => x.code === 'review_hint')).toBe(true);
      }
    }
    // extra product words → no hint
    for (const name of ['human examplomab injection', 'examplomab injection syringe']) {
      const r = await p.classify(input({ name }), ctx());
      for (const c of r.candidates) expect(c.rule_hint).toBeUndefined();
    }
  });

  it('negation also removes high on ordinary curated synonyms: "not 22k gold ring"', async () => {
    const r = await make(makeRepos()).classify(input({ name: 'not 22k gold ring' }), ctx());
    for (const c of r.candidates) expect(c.confidence_band).not.toBe('high');
  });

  it('Devanagari negation words survive normalisation (combining marks kept)', () => {
    expect(normaliseName('इंसुलिन बिना').tokens).toContain('बिना');
    expect(hasNegation(normaliseName('इंसुलिन नहीं').tokens)).toBe(true);
    expect(hasNegation(normaliseName('sugar-free biscuits').tokens)).toBe(true);
    expect(hasNegation(normaliseName('glucose biscuits').tokens)).toBe(false);
  });
});

describe('SA-K2-02: plural parity between the synonym index and tokenEq', () => {
  it('"bags" / "boxes" / "glucometers" find singular phrases, and singular names find plural phrases', () => {
    const m = new SynonymMatcher([
      { phrase: 'jute bag', hsn_code: '6305', strength: 'primary', note: null, active: true },
      { phrase: 'gift box', hsn_code: '4819', strength: 'primary', note: null, active: true },
      { phrase: 'glucometer', hsn_code: '9027', strength: 'primary', note: null, active: true },
      { phrase: 'biscuits', hsn_code: '1905', strength: 'primary', note: null, active: true },
    ]);
    const hit = (name: string) => [...m.match(normaliseName(name).matchTokens).keys()].sort();
    expect(hit('jute bags')).toEqual(['6305']);
    expect(hit('gift boxes')).toEqual(['4819']);
    expect(hit('glucometers')).toEqual(['9027']);
    expect(hit('biscuit')).toEqual(['1905']);
  });

  it('property: indexed match agrees with a brute-force tokenEq scan', () => {
    const stems = ['bag', 'box', 'case', 'glass', 'dress', 'bus', 'tie', 'ring', 'jar', 'pen', 'set', 'kit', 'mat', 'cup', 'lid'];
    const forms = (s: string) => [s, `${s}s`, `${s}es`];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const pick = () => {
      const f = forms(stems[rnd(stems.length)]!);
      return f[rnd(f.length)]!;
    };
    const rows: SynonymInput[] = Array.from({ length: 60 }, (_, i) => ({ phrase: Array.from({ length: 1 + rnd(2) }, pick).join(' '), hsn_code: String(1000 + i), strength: 'primary', note: null, active: true }));
    const m = new SynonymMatcher(rows);
    for (let k = 0; k < 400; k++) {
      const name = Array.from({ length: 1 + rnd(3) }, pick).join(' ');
      const toks = normaliseName(name).matchTokens;
      const got = new Set(m.match(toks).keys());
      for (const r of rows) {
        const phraseToks = normaliseName(r.phrase).matchTokens;
        const brute = phraseToks.length > 0 && phraseToks.every((pt) => toks.some((t) => tokenEq(t, pt)));
        expect(got.has(r.hsn_code), `${name} vs ${r.phrase}`).toBe(brute);
      }
    }
  });
});

describe('SA-K2-03: capacity errors are not cached per barcode; lookups are partitioned by key', () => {
  it.each(['rate_budget', 'busy', 'circuit_open'])('%s is not cached: the next request retries the lookup', async (cause) => {
    let fail = true;
    const a = adapter(() => (fail ? ({ status: 'error', source: 'open_food_facts', cause } as LookupResult) : { status: 'found', source: 'open_food_facts', name: 'Glucose Biscuits', brand: null, categories: ['en:biscuits'], sourceRef: 'https://world.openfoodfacts.org/product/8901234012345' }));
    const p = make(makeRepos(), { adapters: [a] });
    const r1 = await p.classify(input({ barcode: '8901234012345', keyId: 'attacker' }), ctx());
    expect(r1.product?.source).toBe('lookup_failed');
    fail = false;
    const r2 = await p.classify(input({ barcode: '8901234012345', keyId: 'victim' }), ctx());
    expect(a.calls).toHaveLength(2);
    expect(top(r2).hsn).toBe('1905');
  });

  it('a transient network error is still cached briefly (SA-K-04 unchanged)', async () => {
    const a = adapter(() => ({ status: 'error', source: 'open_food_facts', cause: 'network' }));
    const p = make(makeRepos(), { adapters: [a] });
    await p.classify(input({ barcode: '8901234012345', keyId: 'k1' }), ctx());
    await p.classify(input({ barcode: '8901234012345', keyId: 'k2' }), ctx());
    expect(a.calls).toHaveLength(1);
  });

  it('the caller key is passed to the adapter as the budget partition', async () => {
    const a = adapter(() => ({ status: 'not_found', source: 'open_food_facts' }) as LookupResult);
    const p = make(makeRepos(), { adapters: [a] });
    await p.classify(input({ barcode: '8901234012345', keyId: 'key_A' }), ctx());
    expect(a.calls[0]).toEqual(['8901234012345', 'key_A']);
  });
});

describe('SA-K2-04: weak-best message is judged after the re-rank', () => {
  it('a re-rank that lowers the best below 0.30 yields the no-confident message', async () => {
    const name = 'bulk drug cookies'; // deterministic: 2924 ≈ 0.48, 1905 ≈ 0.22
    const det = await make(makeRepos()).classify(input({ name }), ctx());
    expect(det.message).toBeNull();
    expect(top(det).confidence).toBeGreaterThanOrEqual(0.3);
    const codes = det.candidates.map((c) => c.hsn);
    const weakCode = det.candidates.find((c) => c.confidence < 0.3)!.hsn;
    const ranking = [weakCode, ...codes.filter((c) => c !== weakCode)];
    const reranker: Reranker = { enabled: true, model: 'stub-model-1', rerank: async () => JSON.stringify({ ranking }) };
    const r = await make(makeRepos(), { reranker }).classify(input({ name, allowLlm: true }), ctx());
    expect(r.llm_used).toBe(true);
    expect(top(r).confidence).toBeLessThan(0.3);
    expect(r.message).toBe(MESSAGES.noConfident);
    expect(r.needs_review).toBe(true);
    for (const c of r.candidates) expect(c.confidence).toBeGreaterThanOrEqual(0.1);
  });
});

describe('SA-K2-05: keyId is required; no key means one shared, capped bucket', () => {
  it('ClassifyInput without keyId does not type-check', () => {
    // @ts-expect-error keyId is required (fail closed)
    const bad: ClassifyInput = { name: 'x', barcode: null, date: '2026-10-10', maxCandidates: 5, allowLlm: false };
    expect(bad.name).toBe('x');
  });

  it('keyless callers share one daily lookup bucket and use the shared partition', async () => {
    const a = adapter(() => ({ status: 'not_found', source: 'open_food_facts' }) as LookupResult);
    const p = make(makeRepos(), { adapters: [a], perKeyDailyLookups: 2 });
    const codes = ['8901234012345', '8901234012352', '8901234012369'];
    const out = [];
    for (const barcode of codes) out.push(await p.classify(input({ barcode, keyId: null }), ctx()));
    expect(a.calls).toHaveLength(2);
    expect(a.calls.every(([, part]) => part === 'shared:no-key')).toBe(true);
    expect(out[2]!.product?.source).toBe('lookup_failed');
    expect(out[2]!.diagnostics?.lookup_cause).toBe('key_daily_cap');
    // a keyed caller is unaffected
    await p.classify(input({ barcode: codes[2]!, keyId: 'key_B' }), ctx());
    expect(a.calls).toHaveLength(3);
  });
});

describe('SA-K2-06: datasetVersion is read once per classify', () => {
  it('one call per request, whatever the path', async () => {
    const repos = makeRepos();
    const dv = vi.fn(() => 'v1');
    const p = make(repos, { datasetVersion: dv, adapters: [adapter(() => ({ status: 'found', source: 'open_food_facts', name: 'Glucose Biscuits', brand: null, categories: ['en:biscuits'], sourceRef: 'https://world.openfoodfacts.org/product/8901234012345' }))] });
    await p.classify(input({ name: '22K gold ring' }), ctx());
    expect(dv).toHaveBeenCalledTimes(1);
    await p.classify(input({ name: 'glucose biscuits', barcode: '8901234012345' }), ctx());
    expect(dv).toHaveBeenCalledTimes(2);
  });
});
