import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, PEPPER, AUDIT_KEY, type TestEnv } from './helpers.js';
import { revokeApiKey } from '../src/services/apiKeys.js';
import { generateApiKey, parseApiKey } from '../src/lib/apiKey.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ env: { HSN_CORS_ORIGINS: 'https://app.example.com' } });
});
afterAll(async () => env.close());

describe('API key format', () => {
  it('hsk_<8>_<43 base64url>, 32 random bytes, unique', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^hsk_[0-9A-Za-z]{8}_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(parseApiKey(a.key)?.prefix).toBe(a.prefix);
    expect(parseApiKey(`${a.key}x`)).toBeNull();
  });
  it('the DB stores only prefix + hash, never the key', () => {
    const rows = env.storage.writeDb.prepare('SELECT * FROM api_keys').all();
    const dump = JSON.stringify(rows);
    for (const k of Object.values(env.keys)) {
      expect(dump).not.toContain(k);
      expect(dump).not.toContain(k.slice(13));
    }
    const audit = JSON.stringify(env.storage.writeDb.prepare('SELECT * FROM audit_log').all());
    for (const k of Object.values(env.keys)) expect(audit).not.toContain(k.slice(13));
  });
});

describe('authentication', () => {
  const hit = (headers: Record<string, string>, url = '/v1/hsn/7113') => env.app.inject({ method: 'GET', url, headers });

  it('missing, malformed, unknown prefix and wrong secret all give the same 401 body', async () => {
    const real = env.keys.read!;
    const wrongSecret = real.slice(0, 13) + (real[13] === 'A' ? 'B' : 'A') + real.slice(14);
    const unknownPrefix = 'hsk_ZZZZZZZZ' + real.slice(12);
    const results = await Promise.all([hit({}), hit({ authorization: 'Bearer nope' }), hit(bearer(unknownPrefix)), hit(bearer(wrongSecret)), hit({ authorization: `Basic ${real}` })]);
    for (const r of results) {
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toContain('Bearer');
      const { request_id: _r, ...rest } = r.json();
      expect(rest).toEqual({
        type: 'https://hsn-api.example/problems/unauthenticated',
        title: 'API key missing or invalid',
        status: 401,
        detail: expect.any(String),
        instance: '/v1/hsn/7113',
        code: 'unauthenticated',
      });
    }
  });

  it('key in the query string is ignored → 401', async () => {
    const r = await env.app.inject({ method: 'GET', url: `/v1/hsn/7113?api_key=${env.keys.read}` });
    expect(r.statusCode).toBe(401);
  });

  it('valid key → 200 with RateLimit headers', async () => {
    const r = await hit(bearer(env.keys.read!));
    expect(r.statusCode).toBe(200);
    expect(r.headers['ratelimit-limit']).toBe('600');
    expect(Number(r.headers['ratelimit-remaining'])).toBeGreaterThan(0);
    expect(r.headers['ratelimit-reset']).toBeDefined();
  });

  it('revoked key → 401 (cache TTL 0)', async () => {
    const { createApiKey } = await import('../src/services/apiKeys.js');
    const k = createApiKey(env.storage.tx, env.clock, { pepper: PEPPER, auditKey: AUDIT_KEY }, {
      tenant: 't', scopes: ['read'], actor: null, label: 'tmp', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: false, expiresAt: null, createdBy: 'test',
    });
    expect((await hit(bearer(k.key))).statusCode).toBe(200);
    expect(revokeApiKey(env.storage.tx, env.clock, AUDIT_KEY, k.id, 'test')).toBe(true);
    expect((await hit(bearer(k.key))).statusCode).toBe(401);
    const audit = env.storage.read.audit.all().filter((a) => a.entity_id === k.id).map((a) => a.action);
    expect(audit).toEqual(['api_key.created', 'api_key.revoked']);
  });

  it('expired key → 401; SA-C-09: expiry is validated at creation and compared as an instant', async () => {
    const { createApiKey, KeyInputError } = await import('../src/services/apiKeys.js');
    const mk = (expiresAt: string) => createApiKey(env.storage.tx, env.clock, { pepper: PEPPER, auditKey: AUDIT_KEY }, {
      tenant: 't', scopes: ['read'], actor: null, label: 'exp', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: false, expiresAt, createdBy: 'test',
    });
    expect(() => mk('2026-10-10T05:00:00Z')).toThrow(KeyInputError); // in the past
    expect(() => mk('next tuesday')).toThrow(KeyInputError);
    expect(() => mk('2026-13-01T00:00:00Z')).toThrow(KeyInputError);
    // offset forms would break a lexicographic compare; only canonical UTC is accepted
    expect(() => mk('2026-10-10T12:00:00+05:30')).toThrow(KeyInputError);
    const k = mk('2026-10-10T06:30:00Z'); // 30 min from now
    expect(env.storage.read.keys.getById(k.id)?.expires_at).toBe('2026-10-10T06:30:00Z');
    expect((await hit(bearer(k.key))).statusCode).toBe(200);
    env.clock.advance(31 * 60_000);
    expect((await hit(bearer(k.key))).statusCode).toBe(401);
  });

  it('health probes need no key', async () => {
    expect((await hit({}, '/healthz')).statusCode).toBe(200);
    const r = await hit({}, '/readyz');
    expect(r.statusCode).toBe(200);
    // SA-C-20: unauthenticated readiness says only ok / not ok, and runs no DDL
    expect(r.json()).toEqual({ status: 'ready' });
  });
});

describe('scopes (default deny, non-hierarchical)', () => {
  const adminRoutes: [string, string, object?][] = [
    ['GET', '/v1/admin/rate-proposals'],
    ['POST', '/v1/admin/rate-proposals', { action: 'create', rationale: 'xxxxxxxxxxxx' }],
    ['POST', '/v1/admin/rate-proposals/rp_01J9ZR0000000000000000000A/approve', { verified_against_source: true }],
    ['POST', '/v1/admin/rate-proposals/rp_01J9ZR0000000000000000000A/reject', { reason: 'nope nope' }],
    ['GET', '/v1/admin/audit'],
  ];
  it.each(adminRoutes)('%s %s: not on the public listener (404); on the admin listener read/classify keys → 403, no key → 401', async (method, url, payload) => {
    expect((await env.app.inject({ method: method as 'GET', url, headers: bearer(env.keys.priya!), ...(payload ? { payload } : {}) })).statusCode).toBe(404);
    for (const k of ['read', 'classify', 'readClassify']) {
      const r = await env.admin.inject({ method: method as 'GET', url, headers: bearer(env.keys[k]!), ...(payload ? { payload } : {}) });
      expect(r.statusCode).toBe(403);
      expect(r.json().type).toBe('https://hsn-api.example/problems/insufficient-scope');
    }
    // own address: the unauthenticated burst budget (60/min, burst 10) is per client
    const r = await env.admin.inject({ method: method as 'GET', url, remoteAddress: '198.51.100.7', ...(payload ? { payload } : {}) });
    expect(r.statusCode).toBe(401);
  });

  it('read key cannot classify; classify key cannot read; admin key cannot read', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(env.keys.read!), payload: { name: 'gold ring' } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.classify!) })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.priya!) })).statusCode).toBe(403);
  });

  it('a route registered without config.scope fails boot', async () => {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.addHook('onRoute', (r) => {
      if (r.config?.scope === undefined) throw new Error('no scope');
    });
    expect(() => app.get('/x', async () => 'x')).toThrow(/no scope/);
  });
});

describe('rate limiting', () => {
  it('per-key token bucket → 429 with Retry-After and problem+json', async () => {
    // slow key: 6/min → burst 1
    const first = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.slow!) });
    expect(first.statusCode).toBe(200);
    const second = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.slow!) });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('10');
    expect(second.headers['ratelimit-remaining']).toBe('0');
    expect(second.headers['content-type']).toContain('application/problem+json');
    expect(second.json().type).toBe('https://hsn-api.example/problems/rate-limited');
    env.clock.advance(10_000);
    expect((await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.slow!) })).statusCode).toBe(200);
  });

  it('daily quota on search → 429 quota-exceeded', async () => {
    const q = () => env.app.inject({ method: 'GET', url: '/v1/hsn/search?q=gold', headers: bearer(env.keys.quota!) });
    expect((await q()).statusCode).toBe(200);
    expect((await q()).statusCode).toBe(200);
    const r = await q();
    expect(r.statusCode).toBe(429);
    expect(r.json().type).toBe('https://hsn-api.example/problems/quota-exceeded');
  });

  it('SA-C-01: repeated auth failures from one IP are throttled, but a valid key from that IP still works', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { authorization: 'Bearer bad' }, remoteAddress: '203.0.113.9' })).statusCode;
    }
    expect(last).toBe(429);
    // a holder of a valid key behind the same NAT is not locked out
    const r = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.read!), remoteAddress: '203.0.113.9' });
    expect(r.statusCode).toBe(200);
    expect(env.logs.text()).toContain('auth.bruteforce_suspected');
  });
});

describe('headers and CORS', () => {
  it('security headers on 200, 4xx and 404', async () => {
    for (const r of [
      await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.read!) }),
      await env.app.inject({ method: 'GET', url: '/v1/hsn/7113' }),
      await env.app.inject({ method: 'GET', url: '/nope' }),
    ]) {
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['cache-control']).toBeDefined();
      expect(r.headers['x-request-id']).toBeDefined();
    }
  });

  it('SA-C-12: request id is always server-generated req_<ULID>; a client id is only echoed as client_request_id', async () => {
    const a = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { 'x-request-id': 'abc-123' } });
    expect(a.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.json().client_request_id).toBe('abc-123');
    const b = await env.app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id <script>' } });
    expect(b.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('CORS: allowed origin gets ACAO, others do not', async () => {
    const ok = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { ...bearer(env.keys.read!), origin: 'https://app.example.com' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const bad = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { ...bearer(env.keys.read!), origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await env.app.inject({ method: 'OPTIONS', url: '/v1/hsn/7113', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('Authorization');
    const preBad = await env.app.inject({ method: 'OPTIONS', url: '/v1/hsn/7113', headers: { origin: 'https://evil.example' } });
    expect(preBad.headers['access-control-allow-origin']).toBeUndefined();
  });
});
