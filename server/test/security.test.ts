import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, type TestEnv } from './helpers.js';
import { buildFtsQuery, ftsTokens } from '../src/lib/fts.js';
import { loadConfig, ConfigError } from '../src/config.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const search = (q: string) => env.app.inject({ method: 'GET', url: `/v1/hsn/search?q=${encodeURIComponent(q)}`, headers: bearer(env.keys.bulk!) });

describe('FTS5 injection (SEC-40)', () => {
  it('query builder emits only quoted letter/digit tokens', () => {
    expect(buildFtsQuery('gold OR "ring" NEAR(*)', 'and')).toBe('"gold" "ring"');
    expect(buildFtsQuery('rate:* ^x -y +z', 'or')).toBe('"rate" OR "x" OR "y" OR "z"');
    expect(buildFtsQuery('***', 'and')).toBeNull();
    expect(ftsTokens(Array(30).fill('a1').map((x, i) => x + i).join(' '))).toHaveLength(10);
  });

  it.each(['gold" OR rate:* NEAR(', '*', '^x', 'NOT', 'a:b', '""', "'; DROP TABLE hsn_codes; --", 'code:7113', '(gold', 'gold)', 'NEAR(gold ring, 2)', '\u0000gold', 'gold‮ring'])(
    'q=%j → 200, no SQLite error',
    async (q) => {
      const res = await search(q.length < 2 ? `${q}${q}` : q);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/SQLITE|syntax error|fts5/i);
    },
  );

  it('fuzz: 1000 random strings never produce a 5xx', async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const alphabet = 'abcXYZ0123"\'*^:()-+ ORNEATD{}[]\\/%_éक';
    for (let i = 0; i < 1000; i++) {
      const len = 2 + Math.floor(rnd() * 30);
      let q = '';
      for (let j = 0; j < len; j++) q += alphabet[Math.floor(rnd() * alphabet.length)];
      const res = await search(q);
      expect(res.statusCode, q).toBeLessThan(500);
    }
  });

  it('search returns ranked results with a normalised score and highlight', async () => {
    const b = (await search('gold jewellery')).json();
    expect(b.results.length).toBeGreaterThan(0);
    expect(b.results[0].score).toBe(1);
    expect(b.results[0].highlight).toContain('[');
    expect(b.dataset_version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });

  it('search limits and filters are validated', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/search?q=gold&limit=51', headers: bearer(env.keys.read!) })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/search?q=g', headers: bearer(env.keys.read!) })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: `/v1/hsn/search?q=${'a'.repeat(201)}`, headers: bearer(env.keys.read!) })).statusCode).toBe(400);
    const lvl = (await env.app.inject({ method: 'GET', url: '/v1/hsn/search?q=gold&level=8', headers: bearer(env.keys.read!) })).json();
    expect(lvl.results.every((r: { level: number }) => r.level === 8)).toBe(true);
  });
});

describe('request validation and limits', () => {
  const tax = (payload: string | object, headers: Record<string, string> = {}) =>
    env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: { ...bearer(env.keys.read!), 'content-type': 'application/json', ...headers }, payload });

  it('unknown body field → 400 with pointer, no value echoed', async () => {
    const res = await tax({ lines: [{ hsn: '7113', taxable_value: 1, supply_type: 'intra', rate_bp: 0 }] });
    expect(res.statusCode).toBe(400);
    const b = res.json();
    expect(b.type).toBe('https://hsn-api.example/problems/validation-failed');
    expect(b.errors[0].pointer).toBe('/lines/0/rate_bp');
    expect(b.errors[0].code).toBe('additionalProperties');
  });

  it('unknown top-level field and unknown query param → 400', async () => {
    expect((await tax({ lines: [{ hsn: '7113', taxable_value: 1, supply_type: 'intra' }], confidence: 1 })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/7113?foo=1', headers: bearer(env.keys.read!) })).statusCode).toBe(400);
  });

  it('oversized body → 413 (64 KiB global, 256 KiB tax, 16 KiB classify)', async () => {
    const big = JSON.stringify({ lines: [{ hsn: '7113', taxable_value: 1, supply_type: 'intra', line_id: 'x' }], pad: 'x'.repeat(300 * 1024) });
    const r = await tax(big);
    expect(r.statusCode).toBe(413);
    expect(r.headers['content-type']).toContain('application/problem+json');
    const c = await env.app.inject({ method: 'POST', url: '/v1/classify', headers: { ...bearer(env.keys.classify!), 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'x'.repeat(17 * 1024) }) });
    expect(c.statusCode).toBe(413);
    const a = await env.app.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: { ...bearer(env.keys.amit!), 'content-type': 'application/json' }, payload: JSON.stringify({ rationale: 'x'.repeat(65 * 1024) }) });
    expect(a.statusCode).toBe(413);
  });

  it('__proto__ / constructor keys → 400', async () => {
    expect((await tax('{"lines":[{"hsn":"7113","taxable_value":1,"supply_type":"intra"}],"__proto__":{"x":1}}')).statusCode).toBe(400);
    expect((await tax('{"lines":[],"constructor":{"prototype":{"x":1}}}')).statusCode).toBe(400);
  });

  it('malformed JSON → 400; wrong content-type → 415', async () => {
    expect((await tax('{"lines": [')).statusCode).toBe(400);
    const r = await tax('lines=1', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(r.statusCode).toBe(415);
    expect(r.json().type).toBe('https://hsn-api.example/problems/unsupported-media-type');
  });

  it('unknown route → 404 problem distinguishable from hsn-not-found', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/v2/hsn/7113', headers: bearer(env.keys.read!) });
    expect(r.statusCode).toBe(404);
    expect(r.json().type).toBe('https://hsn-api.example/problems/not-found');
  });
});

describe('errors and logs do not leak', () => {
  it('a forced DB error returns a generic 500 without SQL or SQLITE', async () => {
    const e2 = await makeEnv();
    e2.storage.writeDb.exec('ALTER TABLE rate_rules RENAME TO rate_rules_x');
    const r = await e2.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(e2.keys.read!) });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/SQLITE|rate_rules|SELECT|no such table|stack/i);
    expect(Object.keys(r.json()).sort()).toEqual(['code', 'detail', 'instance', 'request_id', 'status', 'title', 'type']);
    await e2.close();
  });

  it('logs never contain the API key or Authorization header', async () => {
    await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.read!) });
    await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { authorization: `Bearer ${env.keys.read!.slice(0, -1)}X` } });
    const text = env.logs.text();
    expect(text).toContain('"request_id"');
    for (const k of Object.values(env.keys)) expect(text).not.toContain(k.slice(13));
    expect(text.toLowerCase()).not.toContain('bearer ');
  });
});

describe('config fails closed', () => {
  it('missing DB path, bad values, production without pepper, LLM without key → ConfigError', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'test', HSN_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'staging' })).toThrow(ConfigError);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'production' })).toThrow(/HSN_KEY_PEPPER/);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'test', HSN_LLM_ENABLED: 'true' })).toThrow(/HSN_LLM_API_KEY/);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'test', HSN_TRUST_PROXY: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'test', HSN_CORS_ORIGINS: '*' })).toThrow(ConfigError);
  });
  it('defaults: external lookups and LLM off; secrets redacted from JSON', () => {
    const c = loadConfig({ HSN_DB_PATH: 'x', NODE_ENV: 'development', HSN_KEY_PEPPER: 'super-secret-pepper-value-1234567890', HSN_AUDIT_KEY: 'super-secret-audit-key-1234567890abcd', HSN_OFF_ENABLED: 'true' });
    expect(c.offEnabled).toBe(false); // gated by HSN_ADAPTERS_ENABLED
    expect(c.llm.enabled).toBe(false);
    expect(c.allowedRatesBp).toContain(25);
    expect(JSON.stringify(c)).not.toContain('super-secret-pepper');
    expect(JSON.stringify(c)).not.toContain('super-secret-audit');
  });
});
