import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from './helpers.js';
import { ClassifyInputError, type Classifier, type ClassifyInput } from '../src/classify/types.js';

const calls: ClassifyInput[] = [];
const fake: Classifier = {
  async classify(input) {
    calls.push(input);
    if (input.barcode === '8901234012346') {
      throw new ClassifyInputError('invalid_gtin', 'Check digit should be 5, got 6.', [{ pointer: '/barcode', code: 'gtin_checksum', message: 'Check digit should be 5, got 6' }]);
    }
    return {
      normalized_name: '22k gold ring',
      product: null,
      needs_review: false,
      candidates: [
        { hsn: '7113', description: 'Articles of jewellery', confidence: 0.91, confidence_band: 'high', needs_review: false, signals: { synonym: 1, fts: 0.62, chapter_keyword: 1, barcode_category: null, margin_penalty: 0 }, reasons: [{ code: 'synonym_exact', detail: 'x', weight: 0.5 }] },
        { hsn: '7117', description: 'Imitation jewellery', confidence: 0.27, confidence_band: 'low', needs_review: true, signals: { synonym: 0, fts: 0.41, chapter_keyword: 1, barcode_category: null, margin_penalty: 0 }, reasons: [{ code: 'fts_match', detail: 'y', weight: 0.2 }] },
      ],
      classifier: { version: 'rules-fts-1.0', llm_rerank: false },
      llm_used: false,
    };
  },
};

describe('POST /v1/classify with an injected classifier', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv({ classifier: fake });
  });
  afterAll(async () => env.close());
  const post = (payload: object) => env.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(env.keys.classify!), payload });

  it('attaches rate resolution per candidate from the rate table; raw name never logged', async () => {
    const res = await post({ name: '22K gold ring for Mrs Sharma 9876543210', unit_price: 68500, allow_llm: true });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.candidates[0].rate.applicable_rule.igst_rate_bp).toBe(300);
    expect(b.candidates[1].rate.coverage).toBe('no_rate_rule');
    expect(b.needs_review).toBe(false);
    expect(b.llm_used).toBe(false);
    expect(b.candidates[0].reasons[0].weight).toBe(0.5);
    expect(b.disclaimer).toMatch(/best-guess/);
    expect(calls.at(-1)!.allowLlm).toBe(false); // LLM not configured → never allowed
    expect(env.logs.text()).not.toContain('Sharma');
    expect(env.logs.text()).toContain('name_hmac'); // round 2: keyed fingerprint (SA-K-08)
  });

  it('costs 5 tokens', async () => {
    const r = await post({ name: 'gold ring' });
    expect(Number(r.headers['ratelimit-remaining'])).toBeLessThanOrEqual(100 - 10);
  });

  it('invalid GTIN → 422 invalid-gtin', async () => {
    const r = await post({ barcode: '8901234012346' });
    expect(r.statusCode).toBe(422);
    expect(r.json().type).toBe('https://hsn-api.example/problems/invalid-gtin');
  });

  it('validation: needs name or barcode; max_candidates ≤ 5; unknown fields rejected', async () => {
    expect((await post({ unit_price: 1 })).statusCode).toBe(400);
    expect((await post({ name: 'gold', max_candidates: 6 })).statusCode).toBe(400);
    expect((await post({ name: 'gold', confidence: 1 })).statusCode).toBe(400);
    expect((await post({ barcode: '12345' })).statusCode).toBe(400);
  });
});

describe('POST /v1/classify without a classifier', () => {
  it('stub returns 503 problem+json', async () => {
    const env = await makeEnv();
    const r = await env.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(env.keys.classify!), payload: { name: 'gold ring' } });
    expect(r.statusCode).toBe(503);
    expect(r.json().type).toBe('https://hsn-api.example/problems/classifier-unavailable');
    await env.close();
  });
});
