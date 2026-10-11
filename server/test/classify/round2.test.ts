/**
 * Round-2 regression tests: rulings 00c-2/5/6/22/25 and security findings SA-K-01..18.
 * Test data is illustrative (see helpers.ts); it carries no rates.
 */
// "examplomab" is a fictional fixture drug name. The nil-rate hint fixtures are illustrative and say nothing about any real drug's rate.
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClassifierPipeline, MESSAGES } from '../../src/classify/pipeline.js';
import { guardRerankOutput, type Reranker } from '../../src/classify/rerank.js';
import { SynonymMatcher, type SynonymInput } from '../../src/classify/synonyms.js';
import { normaliseName } from '../../src/classify/normalise.js';
import { nameHmac } from '../../src/classify/fingerprint.js';
import type { ClassifyResult } from '../../src/classify/types.js';
import type { LookupResult, ProductLookup } from '../../src/adapters/productLookup.js';
import type { Repos, SynonymRepo } from '../../src/repositories/types.js';
import { captureLogger, clock, ctx, input, makeRepos } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const top = (r: ClassifyResult) => r.candidates[0]!;
const MASTER = new Set(['7113', '7117', '3004', '2924', '9027', '1905']);

function adapter(result: LookupResult): ProductLookup & { calls: string[] } {
  const calls: string[] = [];
  return { source: 'open_food_facts', calls, lookup: vi.fn(async (c: string) => (calls.push(c), result)) };
}
function make(repos: Repos, extra: Partial<ConstructorParameters<typeof ClassifierPipeline>[0]> = {}) {
  return new ClassifierPipeline({ hsn: repos.hsn, synonyms: repos.synonyms, products: repos.products, clock: clock(), log: captureLogger(), adapters: [], ...extra });
}
const found = (name: string | null, categories: string[]): LookupResult => ({
  status: 'found', source: 'open_food_facts', name, brand: null, categories, sourceRef: 'https://world.openfoodfacts.org/product/8901234012345',
});

describe('ruling 00c-2/22: every band is reachable honestly, through each allowed path', () => {
  const repos = makeRepos();
  const p = make(repos);

  it('synonym path — high: "22K gold ring"', async () => {
    const r = await p.classify(input({ name: '22K gold ring' }), ctx());
    expect([top(r).hsn, top(r).confidence_band]).toEqual(['7113', 'high']);
    expect(r.scoring?.applicable.synonym).toBe(true);
  });
  it('synonym path — medium: "paracetamol 500mg tablet" (contested synonym)', async () => {
    const r = await p.classify(input({ name: 'paracetamol 500mg tablet' }), ctx());
    expect([top(r).hsn, top(r).confidence_band]).toEqual(['3004', 'medium']);
  });
  it('synonym path — low: bare "paracetamol" (contested, no dosage-form context)', async () => {
    const r = await p.classify(input({ name: 'paracetamol' }), ctx());
    expect(top(r).hsn).toBe('3004');
    expect(top(r).confidence_band).toBe('low');
    expect(r.needs_review).toBe(true);
  });

  it('FTS + chapter path — medium (capped 0.84): "silver bangle" (no synonym exists)', async () => {
    const r = await p.classify(input({ name: 'silver bangle' }), ctx());
    expect(r.scoring?.applicable.synonym).toBe(false);
    expect(r.scoring?.denominator).toBe(0.35);
    expect(top(r).hsn).toBe('7113');
    expect(top(r).confidence_band).toBe('medium');
    expect(top(r).confidence).toBeLessThanOrEqual(0.84);
  });
  it('FTS + chapter path — low: "fashion accessory"', async () => {
    const r = await p.classify(input({ name: 'fashion accessory' }), ctx());
    expect(top(r).hsn).toBe('7117');
    expect(top(r).confidence_band).toBe('low');
  });
  it('FTS + chapter path — never high', async () => {
    for (const name of ['silver bangle', 'gold chain necklace', 'medicine tablet', 'blood glucose analyser meter', 'cookies rusk']) {
      const r = await p.classify(input({ name }), ctx());
      for (const c of r.candidates) expect(c.confidence_band).not.toBe('high');
    }
  });

  it('barcode path — high only with a curated synonym on the caller name: "glucose biscuits" + barcode', async () => {
    const q = make(makeRepos(), { adapters: [adapter(found('Glucose Biscuits 250 g', ['en:biscuits']))] });
    const r = await q.classify(input({ name: 'glucose biscuits', barcode: '8901234012345' }), ctx());
    expect([top(r).hsn, top(r).confidence_band]).toEqual(['1905', 'high']);
    expect(r.scoring?.applicable.barcode_category).toBe(true);
    expect(r.scoring?.denominator).toBe(1);
  });
  it('barcode path — medium: barcode only, external name + category (capped, review hint)', async () => {
    const q = make(makeRepos(), { adapters: [adapter(found('Glucose Biscuits 250 g', ['en:biscuits']))] });
    const r = await q.classify(input({ barcode: '8901234012345' }), ctx());
    expect([top(r).hsn, top(r).confidence, top(r).confidence_band]).toEqual(['1905', 0.84, 'medium']);
    expect(top(r).reasons.some((x) => x.code === 'review_hint' && /crowd-edited/.test(x.detail))).toBe(true);
  });
  it('barcode path — low: barcode only, external category but no product name', async () => {
    const q = make(makeRepos(), { adapters: [adapter(found(null, ['en:biscuits']))] });
    const r = await q.classify(input({ barcode: '8901234012345' }), ctx());
    expect(top(r).hsn).toBe('1905');
    expect(top(r).confidence_band).toBe('low');
  });
});

describe('SA-K-03: crowd-edited product data cannot produce high', () => {
  it('a poisoned OFF name "Glucometer" (no request name) is capped at medium with a hint', async () => {
    const q = make(makeRepos(), { adapters: [adapter(found('Glucometer', []))] });
    const r = await q.classify(input({ barcode: '8901234012345' }), ctx());
    expect(top(r).hsn).toBe('9027');
    expect(top(r).confidence_band).toBe('medium');
    expect(r.needs_review).toBe(true);
    expect(top(r).reasons.some((x) => x.code === 'review_hint')).toBe(true);
    expect(r.diagnostics?.product_source).toBe('open_food_facts');
  });
  it('served from cache later, still capped', async () => {
    const repos = makeRepos();
    const q = make(repos, { adapters: [adapter(found('22k gold ring', ['en:biscuits']))] });
    await q.classify(input({ barcode: '8901234012345' }), ctx());
    const r = await q.classify(input({ barcode: '8901234012345' }), ctx());
    expect(r.product?.source).toBe('local_cache');
    for (const c of r.candidates) expect(c.confidence_band).not.toBe('high');
  });
});

describe('SA-K-09: cached brand/category are re-sanitised on read', () => {
  it('strips bidi / zero-width from cached fields', async () => {
    const repos = makeRepos();
    repos.products.upsert({ gtin: '08901234012345', name: 'Glucose​ Biscuits', brand: 'Br‮and', category: 'en:bis​cuits', source: 'manual', source_ref: null, found: true, fetched_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-20T00:00:00Z' });
    const r = await make(repos).classify(input({ barcode: '8901234012345' }), ctx());
    expect(r.product?.brand).toBe('Br and');
    expect(r.product?.name).toBe('Glucose Biscuits');
    expect(JSON.stringify(r.product)).not.toMatch(/[​‮]/i);
    expect(r.product?.category).toBeNull(); // not a valid tag after cleaning → dropped
  });
});

describe('SA-K-05: synonym matcher built once per dataset version; indexed match', () => {
  it('allActive() is read once per version, again after the version changes', async () => {
    const repos = makeRepos();
    let version = 'v1';
    const spy = vi.spyOn(repos.synonyms, 'allActive');
    const p = make(repos, { datasetVersion: () => version });
    for (let i = 0; i < 5; i++) await p.classify(input({ name: '22K gold ring' }), ctx());
    expect(spy).toHaveBeenCalledTimes(1);
    version = 'v2';
    await p.classify(input({ name: '22K gold ring' }), ctx());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('5,000 synonyms: build is one-off and a match is cheap', () => {
    const rows: SynonymInput[] = Array.from({ length: 5000 }, (_, i) => ({ phrase: `item${i} widget${i % 50}`, hsn_code: String(1000 + (i % 8000)).padStart(4, '0'), strength: 'primary', note: null, active: true }));
    rows.push({ phrase: '22k gold ring', hsn_code: '7113', strength: 'primary', note: null, active: true });
    const m = new SynonymMatcher(rows);
    const tokens = normaliseName('22K gold ring with item42 and widget7 stones').matchTokens;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) m.match(tokens);
    const per = (performance.now() - t0) / 200;
    expect(m.match(tokens).get('7113')?.score).toBe(0.7); // validator R2: the phrase does not cover the whole name
    expect(m.match(normaliseName('22K gold ring').matchTokens).get('7113')?.score).toBe(1);
    expect(per).toBeLessThan(2); // ms per match (was ~12.8 ms unindexed + 41.6 ms rebuild per request)
  });
});

describe('ruling 00c-5: rule hint from a curated exact nil-rate synonym on the caller name', () => {
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
  it('exposes rule_hint on the candidate', async () => {
    const repos = makeRepos();
    const r = await make(repos, { synonyms: withHint(repos) }).classify(input({ name: 'Examplomab injection 10 ml' }), ctx());
    expect(top(r).hsn).toBe('3004');
    expect(top(r).rule_hint).toEqual({ condition: 'nil_rate_list', synonym: 'examplomab injection' });
  });
  it('no hint from third-party product names', async () => {
    const repos = makeRepos();
    const r = await make(repos, { synonyms: withHint(repos), adapters: [adapter(found('Examplomab injection', []))] }).classify(input({ barcode: '8901234012345' }), ctx());
    expect(top(r).hsn).toBe('3004');
    expect(top(r).rule_hint).toBeUndefined();
  });
  it('no hint for a contested or partial match', async () => {
    const repos = makeRepos();
    const r = await make(repos, { synonyms: withHint(repos) }).classify(input({ name: 'injection of examplomab' }), ctx());
    expect(top(r).rule_hint).toBeUndefined();
  });
});

describe('SA-K-07 / AI-16: injection fixture corpus', () => {
  const dir = join(here, '..', 'fixtures', 'injection');
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  it('has the AI-16 categories', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });
  const repos = makeRepos();
  const p = make(repos);
  it.each(files)('%s → deterministic path: master codes only, no rate content, no echo of instructions', async (f) => {
    const text = readFileSync(join(dir, f), 'utf8').trim().slice(0, 200);
    const r = await p.classify(input({ name: text }), ctx());
    for (const c of r.candidates) expect(MASTER.has(c.hsn)).toBe(true);
    const json = JSON.stringify(r.candidates);
    expect(json).not.toMatch(/"0000"|igst|rate_bp/);
  });
  it.each(files)('%s → as model output it is discarded by the guard', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    expect(guardRerankOutput(text, ['3004', '2924']).ok).toBe(false);
    expect(guardRerankOutput(JSON.stringify({ ranking: ['3004', '2924'], note: text }), ['3004', '2924']).ok).toBe(false);
  });
});

describe('SA-K-07 / AI-31 / AI-51: pipeline with an enabled stub re-ranker', () => {
  const name = 'paracetamol 500mg tablet'; // deterministic top 3004 medium, 2924 second
  function run(out: string | (() => Promise<string>), allow = true) {
    const repos = makeRepos();
    const log = captureLogger();
    const reranker: Reranker = { enabled: true, model: 'stub-model-1', rerank: typeof out === 'string' ? async () => out : out };
    const p = make(repos, { reranker });
    return { log, go: () => p.classify(input({ name, allowLlm: allow }), ctx(log)) };
  }

  it('accepted permutation that changes the top: llm_used, both tops logged, confidence never rises', async () => {
    const det = await make(makeRepos()).classify(input({ name }), ctx());
    const codes = det.candidates.map((c) => c.hsn);
    const perm = [codes[1]!, codes[0]!, ...codes.slice(2)];
    const { log, go } = run(JSON.stringify({ ranking: perm }));
    const r = await go();
    expect(r.llm_used).toBe(true);
    expect(r.classifier.llm_rerank).toBe(true);
    expect(top(r).hsn).toBe(codes[1]);
    expect(r.diagnostics).toMatchObject({ det_top: codes[0], final_top: codes[1] });
    const changed = log.lines.find((l) => l.obj.event === 'classify.llm_changed_top');
    expect(changed?.obj).toMatchObject({ det_top: codes[0], final_top: codes[1] });
    for (const c of r.candidates) {
      const before = det.candidates.find((d) => d.hsn === c.hsn)!;
      expect(c.confidence).toBeLessThanOrEqual(before.confidence);
    }
    for (let i = 1; i < r.candidates.length; i++) expect(r.candidates[i]!.confidence).toBeLessThanOrEqual(r.candidates[i - 1]!.confidence);
  });

  it.each([
    ['unknown code', JSON.stringify({ ranking: ['0000', '3004', '2924'] }), 'unknown_code', 'ai.rejected_output'],
    ['missing code', JSON.stringify({ ranking: ['2924'] }), 'missing_code', 'ai.rejected_output'],
    ['full-width rate text', '{"ranking":["2924","3004"],"x":"１８％ ＧＳＴ"}', 'rate_text', 'ai.rejected_output'],
    ['garbage', 'Sure! Here is the ranking', 'not_json', 'ai.rejected_output'],
  ])('%s → deterministic result, llm_used false, logged with cause only', async (_n, out, cause, event) => {
    const det = await make(makeRepos()).classify(input({ name }), ctx());
    const { log, go } = run(out);
    const r = await go();
    expect(r.llm_used).toBe(false);
    expect(r.candidates.map((c) => [c.hsn, c.confidence])).toEqual(det.candidates.map((c) => [c.hsn, c.confidence]));
    expect(r.diagnostics?.llm_fallback).toBe(cause);
    expect(log.lines.some((l) => l.obj.event === event && l.obj.cause === cause)).toBe(true);
    expect(log.lines.some((l) => l.obj.event === 'ai.fallback')).toBe(true);
    const dump = JSON.stringify(log.lines) + JSON.stringify(r);
    expect(dump).not.toMatch(/１８|ＧＳＴ|Sure! Here/);
  });

  it('timeout / provider error → ai.fallback (AI-31)', async () => {
    const { log, go } = run(() => Promise.reject(new Error('upstream 500')));
    const r = await go();
    expect(r.llm_used).toBe(false);
    expect(log.lines.find((l) => l.obj.event === 'ai.fallback')?.obj.cause).toBe('error');
    expect(JSON.stringify(log.lines)).not.toContain('upstream 500');
  });

  it('opt-out → the re-ranker is not called', async () => {
    const spy = vi.fn(async () => '');
    const { go } = run(spy, false);
    const r = await go();
    expect(spy).not.toHaveBeenCalled();
    expect(r.llm_used).toBe(false);
  });
});

describe('SA-K-08: name fingerprint is keyed', () => {
  it('HMAC differs by key and is not the bare SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    const n = 'ramesh 9876543210 gold ring';
    expect(nameHmac('k1'.repeat(16), n)).not.toBe(nameHmac('k2'.repeat(16), n));
    expect(nameHmac('k1'.repeat(16), n)).not.toBe(createHash('sha256').update(n).digest('hex').slice(0, 16));
    expect(nameHmac('k1'.repeat(16), n)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('the pipeline itself never logs a name or name hash', async () => {
    const log = captureLogger();
    await make(makeRepos()).classify(input({ name: 'Ramesh Kumar 9876543210 gold ring' }), ctx(log));
    expect(JSON.stringify(log.lines)).not.toMatch(/Ramesh|9876543210|input_hash/);
  });
});

describe('SA-K-10: normalisation stays linear on adversarial input', () => {
  it('10k-char adversarial strings normalise in < 50 ms', () => {
    for (const s of ['9'.repeat(10_000), '1.'.repeat(5000), '1a'.repeat(5000), '22 '.repeat(3333), '1-'.repeat(5000), '​1'.repeat(5000)]) {
      const t0 = performance.now();
      normaliseName(s);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});

describe('SA-K-14: invalid GTIN problem does not reflect the value', () => {
  it('detail and errors carry expected/actual only', async () => {
    try {
      await make(makeRepos()).classify(input({ barcode: '8901234012346' }), ctx());
      throw new Error('expected an error');
    } catch (e) {
      const err = e as { detail: string; errors: { message: string }[] };
      expect(err.detail).not.toContain('8901234012346');
      expect(JSON.stringify(err.errors)).not.toContain('8901234012346');
      expect(err.detail).toMatch(/should be 5, got 6/);
    }
  });
});

describe('messages', () => {
  it('lookup_failed and not_found messages are distinct', () => {
    expect(MESSAGES.barcodeLookupFailed('1')).not.toMatch(/not found/);
    expect(MESSAGES.barcodeNotFound('1')).toMatch(/not found/);
  });
});
