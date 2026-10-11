/**
 * routes/classify.ts round-2 tests: SA-K-11 (single decision log), SA-K-12 (candidate shape
 * enforced), ruling 00c-5 (rule hint passed to the rate service), ruling 00c-6 (5-digit SAC).
 */
// "examplomab" is a fictional fixture drug name. The nil-rate hint fixtures are illustrative and say nothing about any real drug's rate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from '../helpers.js';
import type { Classifier, ClassifyCandidate, ClassifyResult } from '../../src/classify/types.js';
import { assertCandidate } from '../../src/routes/classify.js';

const cand = (over: Partial<ClassifyCandidate> = {}): ClassifyCandidate => ({
  hsn: '7113',
  description: 'Articles of jewellery',
  confidence: 0.91,
  confidence_band: 'high',
  needs_review: false,
  signals: { synonym: 1, fts: 0.62, chapter_keyword: 1, barcode_category: null, margin_penalty: 0 },
  reasons: [{ code: 'synonym_exact', detail: 'x', weight: 0.59 }],
  ...over,
});

let next: () => ClassifyResult;
const fake: Classifier = { classify: async () => next() };
const result = (candidates: ClassifyCandidate[]): ClassifyResult => ({
  normalized_name: 'ramesh 9876543210 gold ring',
  product: null,
  needs_review: candidates[0]?.confidence_band !== 'high',
  candidates,
  classifier: { version: 'rules-fts-2.0', llm_rerank: false },
  llm_used: false,
  diagnostics: { product_source: null, lookup_cause: null, llm_fallback: null, det_top: candidates[0]?.hsn ?? null, final_top: candidates[0]?.hsn ?? null, latency_ms: 1 },
});

describe('assertCandidate (SA-K-12, ruling 00c-6)', () => {
  it('accepts valid candidates including a 5-digit SAC group', () => {
    expect(() => assertCandidate(cand())).not.toThrow();
    expect(() => assertCandidate(cand({ hsn: '99972', confidence: 0.5, confidence_band: 'low', needs_review: true }))).not.toThrow();
  });
  it.each([
    ['empty reasons', cand({ reasons: [] })],
    ['unknown reason code', cand({ reasons: [{ code: 'free_text' as never, detail: 'x', weight: 0 }] })],
    ['band does not match confidence', cand({ confidence: 0.7 })],
    ['needs_review false on medium', cand({ confidence: 0.7, confidence_band: 'medium', needs_review: false })],
    ['confidence out of range', cand({ confidence: 1.2 })],
    ['bad code', cand({ hsn: '0000x' })],
    ['5 digits that are not SAC', cand({ hsn: '71131' })],
    ['unknown rule hint', cand({ rule_hint: { condition: 'zero_please', synonym: 'x' } })],
  ])('rejects %s', (_n, c) => {
    expect(() => assertCandidate(c)).toThrow();
  });
});

describe('POST /v1/classify (route)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv({ classifier: fake });
  });
  afterAll(async () => env.close());
  const post = (payload: object) => env.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(env.keys.classify!), payload });

  it('a candidate with empty reasons is a 500, never a silent answer (SA-K-12)', async () => {
    next = () => result([cand({ reasons: [] })]);
    const r = await post({ name: 'gold ring' });
    expect(r.statusCode).toBe(500);
  });

  it('writes exactly one classify.decision line with HMAC name, key_id and dataset_version (SA-K-08, SA-K-11)', async () => {
    next = () => result([cand()]);
    const before = env.logs.text().length;
    const r = await post({ name: 'Ramesh 9876543210 gold ring' });
    expect(r.statusCode).toBe(200);
    const text = env.logs.text().slice(before);
    const lines = text.split('\n').filter((l) => l.includes('"classify.decision"'));
    expect(lines).toHaveLength(1);
    const d = JSON.parse(lines[0]!);
    expect(d.name_hmac).toMatch(/^[0-9a-f]{16}$/);
    expect(d.key_id).toBe(env.keyIds.classify);
    expect(typeof d.dataset_version).toBe('string');
    expect(d.classifier_version).toBe('rules-fts-2.0');
    expect(text).not.toMatch(/Ramesh|9876543210|name_sha256/);
  });

  it('passes the request key id and its tenant (SA-K3-03) to the classifier', async () => {
    let seen: string | null | undefined;
    let tenant: string | null | undefined;
    const spy: Classifier = { classify: async (i) => ((seen = i.keyId), (tenant = i.tenantId), result([cand()])) };
    const e2 = await makeEnv({ classifier: spy });
    try {
      await e2.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(e2.keys.classify!), payload: { name: 'gold ring' } });
      expect(seen).toBe(e2.keyIds.classify);
      expect(tenant).toBe('test');
    } finally {
      await e2.close();
    }
  });

  it('returns rule_hint and scoring; product source lookup_failed serialises', async () => {
    next = () => ({
      ...result([cand({ hsn: '3004', rule_hint: { condition: 'nil_rate_list', synonym: 'examplomab injection' } })]),
      product: { gtin: '8901234012345', gtin_valid: true, name: null, brand: null, category: null, source: 'lookup_failed', fetched_at: null },
      scoring: { applicable: { synonym: true, fts: true, chapter_keyword: true, barcode_category: false }, denominator: 0.85 },
    });
    const r = await post({ name: 'examplomab injection' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.candidates[0].rule_hint).toEqual({ condition: 'nil_rate_list', synonym: 'examplomab injection' });
    expect(b.product.source).toBe('lookup_failed');
    expect(b.scoring.denominator).toBe(0.85);
    expect(b.candidates[0].rate.hsn_queried).toBe('3004');
  });
});
