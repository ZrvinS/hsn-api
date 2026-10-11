import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());
const get = (url: string, headers: Record<string, string> = {}) => env.app.inject({ method: 'GET', url, headers: { ...bearer(env.keys.read!), ...headers } });

describe('GET /v1/rates/changes', () => {
  it('since=0 pages through the whole feed exactly once', async () => {
    const seen: number[] = [];
    let since = 0;
    for (let i = 0; i < 20; i++) {
      const b = (await get(`/v1/rates/changes?since=${since}&limit=7`)).json();
      seen.push(...b.changes.map((c: { seq: number }) => c.seq));
      since = b.next_since;
      if (!b.has_more) break;
    }
    expect(seen.length).toBe(env.storage.read.dataset.maxSeq());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('limit > 500 → 400; since missing → 400; since ahead → 410', async () => {
    expect((await get('/v1/rates/changes?since=0&limit=501')).statusCode).toBe(400);
    expect((await get('/v1/rates/changes')).statusCode).toBe(400);
    expect((await get('/v1/rates/changes?since=-1')).statusCode).toBe(400);
    const r = await get('/v1/rates/changes?since=999999');
    expect(r.statusCode).toBe(410);
    expect(r.json().type).toBe('https://hsn-api.example/problems/feed-window-expired');
  });

  it('ETag/304 and Cache-Control: private, no-cache', async () => {
    const a = await get('/v1/rates/changes?since=0');
    expect(a.headers['cache-control']).toBe('private, no-cache');
    expect((await get('/v1/rates/changes?since=0', { 'if-none-match': a.headers.etag as string })).statusCode).toBe(304);
  });
});

describe('GET /v1/meta/dataset', () => {
  it('reports version, hash, coverage incl. verified/unverified, LLM disclosure', async () => {
    const r = await get('/v1/meta/dataset');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.dataset_version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
    expect(b.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const unverified = env.storage.writeDb.prepare(
      "SELECT COUNT(*) AS n FROM rate_rules WHERE verification_status='unverified' AND effective_from <= '2026-10-10' AND (effective_to IS NULL OR effective_to >= '2026-10-10')",
    ).get() as { n: number };
    expect(b.coverage.rate_rules_unverified).toBe(unverified.n);
    expect(b.coverage.rate_rules_verified + b.coverage.rate_rules_unverified).toBe(b.coverage.rate_rules_active);
    expect(b.coverage.sac_codes).toBe(6); // 99, 9988, 998892, 9997, 99972, 999721
    expect(b.classifier).toEqual({ llm_configured: false, llm_provider: null, external_lookups: [] });
    expect(b.disclaimer).toMatch(/not an official/i);
    expect(b.content_sha256).toBe(env.storage.read.dataset.computeContentHash());
  });
});
