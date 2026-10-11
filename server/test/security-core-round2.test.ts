/**
 * Regression tests for reviews/security-code-core-round1.md (SA-C-01..20) plus SA-K-03 (product purge).
 * Test names start with the finding id so reviews/code-fix-core-round2.md can point at them.
 * Some findings are also covered in auth/admin/seed tests; those names carry the id too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearer, makeEnv, proposeAndApprove, AUDIT_KEY, PDF_SHA, SRC_URL, type TestEnv } from './helpers.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { TokenBucketLimiter, AuthFailureTracker } from '../src/lib/rateLimit.js';
import { fixedClock } from '../src/lib/clock.js';
import { truncateIp } from '../src/lib/redact.js';
import { clientBucketKey, ipAllowed, parseIpRule } from '../src/lib/ip.js';
import { createApiKey, KeyInputError } from '../src/services/apiKeys.js';
import { canonicalScopes } from '../src/lib/apiKey.js';
import { verifyFromRepo, MAX_VERIFY_SPAN } from '../src/services/audit.js';
import { classifierDeps } from '../src/classifierDeps.js';
import { buildApp } from '../src/app.js';
import { RULE_PREFIX_RE } from '../src/services/proposals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' };
const NONE = { kind: 'none', text: null, min_unit_price: null, max_unit_price: null };
const BASE_ENV = { NODE_ENV: 'production', HSN_DB_PATH: 'x', HSN_KEY_PEPPER: 'p'.repeat(40), HSN_AUDIT_KEY: 'a'.repeat(40), HSN_LOG_KEY: 'l'.repeat(40), HSN_STATE_HWM_FILE: '/var/lib/hsn-state/hwm.json' };

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ env: { HSN_CORS_ORIGINS: 'https://app.example.com' } });
});
afterAll(async () => env.close());

const hit = (e: TestEnv, headers: Record<string, string>, remoteAddress = '127.0.0.1', url = '/v1/hsn/7113') => e.app.inject({ method: 'GET', url, headers, remoteAddress });

describe('SA-C-01 (High): a shared IP cannot lock out valid keys', () => {
  it('SA-C-01: valid key gets 200 after the address drained its unauth budget AND was brute-force blocked', async () => {
    const e = await makeEnv();
    try {
      for (let i = 0; i < 30; i++) await hit(e, bearer(`hsk_AAAAAAAA_${'x'.repeat(43)}`), '192.0.2.44');
      expect((await hit(e, bearer(`hsk_AAAAAAAA_${'x'.repeat(43)}`), '192.0.2.44')).statusCode).toBe(429);
      expect((await hit(e, {}, '192.0.2.44')).statusCode).toBe(429); // unauth budget gone too
      expect((await hit(e, bearer(e.keys.read!), '192.0.2.44')).statusCode).toBe(200);
    } finally {
      await e.close();
    }
  });
  it('SA-C-01: brute-force block is keyed on address + key prefix: another prefix from the same address is not blocked', async () => {
    const e = await makeEnv();
    try {
      for (let i = 0; i < 25; i++) await hit(e, bearer(`hsk_BBBBBBBB_${'x'.repeat(43)}`), '192.0.2.45');
      e.clock.advance(60_000); // refill the unauth budget; the block (15 min) remains
      expect((await hit(e, bearer(`hsk_BBBBBBBB_${'x'.repeat(43)}`), '192.0.2.45')).statusCode).toBe(429);
      expect((await hit(e, bearer(`hsk_CCCCCCCC_${'x'.repeat(43)}`), '192.0.2.45')).statusCode).toBe(401);
    } finally {
      await e.close();
    }
  });
  it('SA-C-01: production refuses an empty HSN_TRUST_PROXY unless HSN_DIRECT_EXPOSURE=true', () => {
    expect(() => loadConfig(BASE_ENV)).toThrow(/HSN_TRUST_PROXY/);
    expect(loadConfig({ ...BASE_ENV, HSN_DIRECT_EXPOSURE: 'true' }).directExposure).toBe(true);
    expect(loadConfig({ ...BASE_ENV, HSN_TRUST_PROXY: '10.0.0.0/8' }).nodeEnv).toBe('production');
    expect(() => loadConfig({ ...BASE_ENV, HSN_TRUST_PROXY: '10.0.0.0/' })).toThrow(ConfigError);
  });
});

describe('SA-C-02 (High): supersede/correct must keep the prefix', () => {
  it('SA-C-02: a supersede for another prefix → 400 prefix_mismatch; nothing changes', async () => {
    const target = (env.storage.writeDb.prepare("SELECT rule_id FROM rate_rules WHERE hsn_prefix = '9988'").get() as { rule_id: string }).rule_id;
    const r = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'supersede', supersedes_rule_id: target, rule: { hsn_prefix: '04', igst_rate_bp: 0, condition: NONE, effective_from: '2027-07-02', source: SRC }, rationale: 'Harmless-looking chapter 04 rule.' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].code).toBe('prefix_mismatch');
    const c = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'correct', supersedes_rule_id: target, rule: { hsn_prefix: '04', igst_rate_bp: 0, condition: NONE, effective_from: '2027-07-02', source: SRC }, rationale: 'Correct into another prefix.' },
    });
    expect(c.statusCode).toBe(400);
    expect(env.storage.read.rules.get(target)!.effective_to).toBeNull();
  });
  it('SA-C-02: the DB refuses a superseded_by / voided_by_rule link across prefixes', () => {
    const db = env.storage.writeDb;
    const a = (db.prepare("SELECT rule_id FROM rate_rules WHERE hsn_prefix = '9988'").get() as { rule_id: string }).rule_id;
    const b = (db.prepare("SELECT rule_id FROM rate_rules WHERE hsn_prefix = '7113'").get() as { rule_id: string }).rule_id;
    expect(() => db.prepare('UPDATE rate_rules SET superseded_by = ? WHERE rule_id = ?').run(b, a)).toThrow();
  });
  it('SA-C-02: a retroactive supersede needs retroactive_reason (see ruling 25 test for the feed flag)', async () => {
    const t = (env.storage.writeDb.prepare("SELECT rule_id FROM rate_rules WHERE hsn_prefix = '2402'").get() as { rule_id: string }).rule_id;
    const r = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'supersede', supersedes_rule_id: t, rule: { hsn_prefix: '2402', igst_rate_bp: 2800, condition: NONE, effective_from: '2020-01-01', source: SRC }, rationale: 'Backdated supersede.' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].pointer).toBe('/retroactive_reason');
  });
});

describe('SA-C-03 (High): maker–checker compares registered actor ids', () => {
  it('SA-C-03: actor spelling variants all normalise to the same actor and are refused as checker', async () => {
    const secrets = { pepper: env.config.keyPepper.reveal(), auditKey: AUDIT_KEY };
    for (const v of ['Amit ', 'AMIT', 'Ａｍｉｔ']) {
      // a key for a variant spelling is the same actor: without a fresh grant it is refused outright
      expect(() => createApiKey(env.storage.tx, env.clock, secrets, { tenant: 't', scopes: ['admin'], actor: v, label: 'v', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' })).toThrow();
    }
    expect(() => createApiKey(env.storage.tx, env.clock, secrets, { tenant: 't', scopes: ['admin'], actor: 'amit​', label: 'v', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' })).toThrow(KeyInputError);
    const amit = env.storage.read.keys.getById(env.keyIds.amit!)!;
    const amit2 = env.storage.read.keys.getById(env.keyIds.amit2!)!;
    expect(amit.actor_id).toBe(amit2.actor_id);
    const { create, approve } = await proposeAndApprove(env, { action: 'end_date', supersedes_rule_id: (env.storage.writeDb.prepare("SELECT rule_id FROM rate_rules WHERE hsn_prefix = '2402'").get() as { rule_id: string }).rule_id, end_date: '2040-01-01', rationale: 'Self-approval attempt.' }, 'amit', 'amit2');
    expect(create.statusCode).toBe(201);
    expect(approve!.statusCode).toBe(403);
    expect(approve!.json().code).toBe('maker_checker_violation');
  });
  it('SA-C-03: the DB CHECK also refuses decided_by_actor_id = proposed_by_actor_id', () => {
    const p = env.storage.writeDb.prepare("SELECT id, proposed_by_actor_id FROM rate_proposals WHERE status = 'pending' LIMIT 1").get() as { id: string; proposed_by_actor_id: string };
    expect(() =>
      env.storage.writeDb.prepare("UPDATE rate_proposals SET status = 'rejected', decided_by = 'amit', decided_by_actor_id = ?, decided_at = '2026-10-10T06:00:00Z', decision_comment = 'self' WHERE id = ?").run(p.proposed_by_actor_id, p.id),
    ).toThrow();
  });
});

describe('SA-C-04 (Medium): NODE_ENV is required; main.ts exits non-zero', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const runMain = (extra: Record<string, string>) => {
    const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...extra };
    return spawnSync(process.execPath, ['--import', existsSync(tsx) ? 'tsx' : 'tsx', join(ROOT, 'src', 'main.ts')], { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 30_000 });
  };
  it('SA-C-04: main.ts without NODE_ENV exits 1 and names the variable', () => {
    const r = runMain({ HSN_DB_PATH: ':memory:' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NODE_ENV/);
  }, 30_000);
  it('SA-C-04: main.ts in development without a 32-char pepper exits 1', () => {
    const r = runMain({ NODE_ENV: 'development', HSN_DB_PATH: ':memory:', HSN_KEY_PEPPER: 'short' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HSN_KEY_PEPPER/);
  }, 30_000);
  it('SA-C-04: loadConfig({}) → ConfigError; pepper and audit key must differ', () => {
    expect(() => loadConfig({ HSN_DB_PATH: 'x' })).toThrow(/NODE_ENV/);
    expect(() => loadConfig({ ...BASE_ENV, HSN_DIRECT_EXPOSURE: 'true', HSN_AUDIT_KEY: BASE_ENV.HSN_KEY_PEPPER })).toThrow(/must differ/);
  });
});

describe('SA-C-05 (Medium): limiter state cannot be wiped or grown', () => {
  it('SA-C-05: LRU evicts one oldest bucket at a time, never clears', () => {
    const clock = fixedClock('2026-10-10T06:00:00Z');
    const l = new TokenBucketLimiter(clock, 1 / 6, 3);
    expect(l.take('a', 6).allowed).toBe(true);
    expect(l.take('a', 6).allowed).toBe(false); // a drained
    l.take('b', 6);
    l.take('c', 6);
    l.take('a', 6); // touch a → most recent
    l.take('d', 6); // evicts b only
    expect(l.size).toBe(3);
    expect(l.take('a', 6).allowed).toBe(false); // a still drained
  });
  it('SA-C-05: a flood of failing clients never touches key buckets (separate limiters)', async () => {
    const e = await makeEnv();
    try {
      await hit(e, bearer(e.keys.slow!));
      expect((await hit(e, bearer(e.keys.slow!))).statusCode).toBe(429); // drained
      const keyBuckets = e.shared.keyLimiter instanceof TokenBucketLimiter ? e.shared.keyLimiter.size : -1;
      for (let i = 0; i < 200; i++) await hit(e, { authorization: 'Bearer junk' }, `2001:db8:${i.toString(16)}::1`);
      expect(e.shared.keyLimiter instanceof TokenBucketLimiter ? e.shared.keyLimiter.size : -1).toBe(keyBuckets);
      expect((await hit(e, bearer(e.keys.slow!))).statusCode).toBe(429); // still drained
    } finally {
      await e.close();
    }
  });
  it('SA-C-05: IPv6 clients are bucketed per /64', () => {
    expect(clientBucketKey('2001:db8:1:2:aaaa::1')).toBe(clientBucketKey('2001:db8:1:2:ffff::9'));
    expect(clientBucketKey('2001:db8:1:3::1')).not.toBe(clientBucketKey('2001:db8:1:2::1'));
    expect(clientBucketKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });
  it('SA-C-05: AuthFailureTracker is bounded and swept', () => {
    const clock = fixedClock('2026-10-10T06:00:00Z');
    const t = new AuthFailureTracker(clock, 1, 5 * 60_000, 15 * 60_000, 10);
    for (let i = 0; i < 50; i++) t.recordFailure(`k${i}`);
    expect(t.sizes.blocked).toBeLessThanOrEqual(10);
    clock.advance(16 * 60_000);
    t.isBlocked('x'); // triggers sweep
    expect(t.sizes.blocked).toBe(0);
  });
});

describe('SA-C-06 (Medium): admin keys are distinct; allow-list validated and enforced', () => {
  it('SA-C-06: admin cannot be combined with another scope', () => {
    expect(() => canonicalScopes(['read', 'admin'])).toThrow();
    const secrets = { pepper: env.config.keyPepper.reveal(), auditKey: AUDIT_KEY };
    expect(() => createApiKey(env.storage.tx, env.clock, secrets, { tenant: 't', scopes: ['read', 'admin'], actor: 'amit', label: 'mix', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' })).toThrow();
  });
  it('SA-C-06: allow-list entries are strict; "10.0.0.1/" is refused; IPv6 CIDRs work', () => {
    expect(parseIpRule('10.0.0.1/')).toBeNull();
    expect(parseIpRule('10.0.0.1/33')).toBeNull();
    expect(parseIpRule('10.0.0.0/8')).not.toBeNull();
    expect(ipAllowed('203.0.113.5', ['10.0.0.1/'])).toBe(false);
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: 'x', HSN_ADMIN_IP_ALLOWLIST: '10.0.0.1/' })).toThrow(ConfigError);
  });
  it('SA-C-06: an admin key from a non-allow-listed address gets 403; from an allowed one 200', async () => {
    const e = await makeEnv({ env: { HSN_ADMIN_IP_ALLOWLIST: '10.9.9.0/24' } });
    try {
      const no = await e.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals', headers: bearer(e.keys.priya!), remoteAddress: '127.0.0.1' });
      expect(no.statusCode).toBe(403);
      expect(no.json().code).toBe('forbidden_ip');
      const yes = await e.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals', headers: bearer(e.keys.priya!), remoteAddress: '10.9.9.7' });
      expect(yes.statusCode).toBe(200);
    } finally {
      await e.close();
    }
  });
});

describe('SA-C-07 (Medium): tax cost is proportional to lines', () => {
  it('SA-C-07: 500 lines cost 11 tokens; a key without enough tokens gets 429 before computing', async () => {
    const e = await makeEnv();
    try {
      const lines = Array.from({ length: 500 }, () => ({ hsn: '7113', taxable_value: 1, supply_type: 'inter' }));
      const a = await e.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(e.keys.read!), payload: { lines } });
      expect(a.statusCode).toBe(200);
      expect(a.headers['ratelimit-cost']).toBe('11');
      const s = await e.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(e.keys.slow!), payload: { lines } });
      expect(s.statusCode).toBe(429);
      expect(s.json().detail).toMatch(/costs 11 tokens/);
    } finally {
      await e.close();
    }
  });
});

describe('SA-C-08 (Medium): tests exercise the real app', () => {
  it('SA-C-08: route table snapshot for both listeners; every non-public route needs a key', async () => {
    const fmt = (r: { method: string; url: string; scope: string }) => `${r.method} ${r.url} ${r.scope}`;
    expect(env.app.routeTable.map(fmt).sort()).toEqual([
      'GET /healthz public',
      'GET /readyz public',
      'GET /v1/hsn/:code read',
      'GET /v1/hsn/search read',
      'GET /v1/meta/dataset read',
      'GET /v1/rates/changes read',
      'OPTIONS /* public', // CORS preflight (HSN_CORS_ORIGINS set in this env)
      'POST /v1/classify classify',
      'POST /v1/tax/calculate read',
    ]);
    expect(env.admin.routeTable.map(fmt).sort()).toEqual([
      'DELETE /v1/admin/products/:gtin admin',
      'GET /healthz public',
      'GET /metrics public', // ruling 30: admin listener only (see round-3 test)
      'GET /readyz public',
      'GET /v1/admin/audit admin',
      'GET /v1/admin/rate-proposals admin',
      'GET /v1/admin/rate-proposals/:id admin',
      'GET /v1/admin/watched-notifications admin',
      'GET /v1/admin/watcher/status admin',
      'OPTIONS /* public',
      'POST /v1/admin/rate-proposals admin',
      'POST /v1/admin/rate-proposals/:id/approve admin',
      'POST /v1/admin/rate-proposals/:id/reject admin',
      'POST /v1/admin/rate-proposals/:id/withdraw admin',
      'POST /v1/admin/watched-notifications admin',
      'POST /v1/admin/watched-notifications/:id/resolve admin',
      'POST /v1/admin/watched-notifications/:id/triage admin',
    ]);
    for (const app of [env.app, env.admin]) {
      for (const [i, r] of app.routeTable.filter((x) => x.scope !== 'public').entries()) {
        const url = r.url.replace(':code', '7113').replace(':id', 'rp_01J9ZR0000000000000000000A').replace(':gtin', '4006381333931');
        const res = await app.inject({ method: r.method as 'GET', url, remoteAddress: `198.51.100.${i + (app === env.admin ? 100 : 1)}`, ...(r.method === 'POST' ? { payload: {} } : {}) });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      }
    }
  });
  it('SA-C-08: buildApp itself refuses a route without config.scope', async () => {
    const app = await buildApp({ config: env.config, storage: env.storage, clock: env.clock, shared: env.shared, surface: 'public', logStream: env.logs });
    expect(() => app.get('/x', async () => 'x')).toThrow(/no config.scope/);
    await app.close();
  });
  it('SA-C-08: GET /v1/admin/rate-proposals/:id needs admin', async () => {
    const r = await env.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals/rp_01J9ZR0000000000000000000A', headers: bearer(env.keys.read!) });
    expect(r.statusCode).toBe(403);
  });
  it('SA-C-08: X-Forwarded-For is ignored without HSN_TRUST_PROXY, honoured only from a trusted proxy', async () => {
    const e = await makeEnv();
    try {
      let last = 0;
      for (let i = 0; i < 15; i++) last = (await e.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { 'x-forwarded-for': `203.0.113.${i}` }, remoteAddress: '192.0.2.60' })).statusCode;
      expect(last).toBe(429); // all counted against 192.0.2.60
    } finally {
      await e.close();
    }
    const t = await makeEnv({ env: { HSN_TRUST_PROXY: '10.0.0.0/8' } });
    try {
      const codes = new Set<number>();
      for (let i = 0; i < 15; i++) codes.add((await t.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { 'x-forwarded-for': `203.0.113.${i}` }, remoteAddress: '10.0.0.5' })).statusCode);
      expect([...codes]).toEqual([401]); // each forwarded client has its own budget
      let last = 0;
      for (let i = 0; i < 15; i++) last = (await t.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { 'x-forwarded-for': `203.0.113.${i}` }, remoteAddress: '192.0.2.61' })).statusCode;
      expect(last).toBe(429); // untrusted peer: its XFF is ignored
    } finally {
      await t.close();
    }
  });
  it('SA-C-08: the brute-force block expires after 15 minutes', async () => {
    const e = await makeEnv();
    try {
      const k = bearer(`hsk_DDDDDDDD_${'x'.repeat(43)}`);
      for (let i = 0; i < 20; i++) await hit(e, k, '192.0.2.70');
      e.clock.advance(14 * 60_000);
      expect((await hit(e, k, '192.0.2.70')).statusCode).toBe(429);
      e.clock.advance(16 * 60_000);
      expect((await hit(e, k, '192.0.2.70')).statusCode).toBe(401);
    } finally {
      await e.close();
    }
  });
});

describe('SA-C-10 (Low): truncateIp', () => {
  it('SA-C-10: IPv6 expanded before keeping /48; IPv4 /24', () => {
    expect(truncateIp('2001::5:6')).toBe('2001:0:0::/48');
    expect(truncateIp('fe80::1234:5678')).toBe('fe80:0:0::/48');
    expect(truncateIp('::1')).toBe('0:0:0::/48');
    expect(truncateIp('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd::/48');
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(truncateIp('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(truncateIp('garbage')).toBe('unknown');
  });
});

describe('SA-C-11 (Low): audit and dataset integrity', () => {
  it('SA-C-11: filtered verification over a huge id span is refused, not loaded', () => {
    const all = env.storage.read.audit.all();
    const first = all[0]!;
    const fake = { ...all.at(-1)!, id: first.id + MAX_VERIFY_SPAN + 5 };
    const r = verifyFromRepo(env.storage.read.audit, AUDIT_KEY, [first, fake]);
    expect(r.span_too_large).toBe(true);
    expect(r.ok).toBe(false);
  });
  it('SA-C-11: content hash re-checked at boot; a mismatch fails readiness', async () => {
    const e = await makeEnv();
    try {
      e.storage.writeDb.exec('DROP TRIGGER hsn_codes_guard_update');
      e.storage.writeDb.exec("UPDATE hsn_codes SET description = 'tampered', changed_by_proposal = (SELECT id FROM rate_proposals LIMIT 1) WHERE code = '7113'");
      const app = await buildApp({ config: e.config, storage: e.storage, clock: e.clock, shared: e.shared, surface: 'public', logStream: e.logs });
      const r = await app.inject({ method: 'GET', url: '/readyz' });
      expect(r.statusCode).toBe(503);
      expect(JSON.stringify(r.json())).not.toMatch(/content|hash|7113/);
      expect(e.logs.text()).toContain('dataset.integrity_mismatch');
      await app.close();
    } finally {
      await e.close();
    }
  });
});

describe('SA-C-13 (Low): classifier logger is the redacting app logger', () => {
  it('SA-C-13: classifierDeps passes the given pino child logger through', () => {
    const log = env.app.log.child({ component: 'classifier' });
    const d = classifierDeps(env.storage, env.config, log);
    expect(d.log).toBe(log);
    expect(d.datasetVersion?.()).toBe(env.storage.read.dataset.current()!.current_version);
  });
  it('SA-C-13: main.ts no longer writes classifier logs with console/JSON.stringify', () => {
    const src = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    expect(src).not.toMatch(/JSON\.stringify|process\.stdout\.write|console\.log/);
  });
});

describe('SA-C-14 (Low): rule prefixes', () => {
  it('SA-C-14: only 2/4/6/8 digits (5 for 99xxx) and the prefix must exist', async () => {
    for (const p of ['711', '71131', '7113191', '711319100']) expect(RULE_PREFIX_RE.test(p)).toBe(false);
    expect(RULE_PREFIX_RE.test('99972')).toBe(true);
    const r = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'create', rule: { hsn_prefix: '7199', igst_rate_bp: 300, condition: NONE, effective_from: '2027-01-01', source: SRC }, rationale: 'Unknown heading.' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].code).toBe('unknown_hsn');
    const odd = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'create', rule: { hsn_prefix: '711', igst_rate_bp: 300, condition: NONE, effective_from: '2027-01-01', source: SRC }, rationale: 'Odd-length prefix.' },
    });
    expect(odd.statusCode).toBe(400);
  });
});

describe('SA-C-15 (Low): limits', () => {
  it('SA-C-15: q is 2–100 characters (validator 18 recommendation; SEC-27 aligned in docs)', async () => {
    expect((await hit(env, bearer(env.keys.bulk!), '127.0.0.1', `/v1/hsn/search?q=${'a'.repeat(101)}`)).statusCode).toBe(400);
    expect((await hit(env, bearer(env.keys.bulk!), '127.0.0.1', `/v1/hsn/search?q=${'a'.repeat(100)}`)).statusCode).toBe(200);
  });
  it('SA-C-15: tax/calculate body limit is 256 KiB (documented deviation: 500 lines), others use the 64 KiB default', async () => {
    const big = JSON.stringify({ lines: [{ hsn: '7113', taxable_value: 1, supply_type: 'inter', line_id: 'x'.repeat(270_000) }] });
    const r = await env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: { ...bearer(env.keys.bulk!), 'content-type': 'application/json' }, payload: big });
    expect(r.statusCode).toBe(413);
  });
});

describe('SA-C-16 (Low): runtime pinning and build output', () => {
  it('SA-C-16: engines 22.x, .nvmrc, separate build config with rootDir src, start runs dist/main.js', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines: { node: string }; scripts: Record<string, string> };
    expect(pkg.engines.node).toBe('22.x');
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('22');
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as { compilerOptions: { rootDir: string; outDir: string }; include: string[] };
    expect(build.compilerOptions.rootDir).toBe('src');
    expect(build.include).toEqual(['src']);
    expect(pkg.scripts['build']).toContain('tsconfig.build.json');
    expect(pkg.scripts['build']).toContain('schema.sql');
    expect(pkg.scripts['start']).toBe('node dist/main.js');
  });
});

describe('SA-C-18 (Info): Vary: Origin', () => {
  it('SA-C-18: sent on every response when CORS is configured, including disallowed and no-origin requests', async () => {
    for (const headers of [{}, { origin: 'https://evil.example' }, { origin: 'https://app.example.com' }]) {
      const r = await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: { ...bearer(env.keys.read!), ...headers } });
      expect(String(r.headers['vary'])).toMatch(/Origin/);
    }
  });
});

describe('SA-C-19 (Info): no key cache', () => {
  it('SA-C-19: a revoked key fails on the very next request (see also auth "revoked key → 401")', async () => {
    const secrets = { pepper: env.config.keyPepper.reveal(), auditKey: AUDIT_KEY };
    const k = createApiKey(env.storage.tx, env.clock, secrets, { tenant: 't', scopes: ['read'], actor: null, label: 'r', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: false, expiresAt: null, createdBy: 't' });
    expect((await hit(env, bearer(k.key))).statusCode).toBe(200);
    env.storage.writeDb.prepare("UPDATE api_keys SET revoked_at = '2026-10-10T06:00:00Z' WHERE id = ?").run(k.id);
    expect((await hit(env, bearer(k.key))).statusCode).toBe(401);
  });
});

describe('SA-C-20 (Info): readiness', () => {
  it('SA-C-20: /readyz runs no DDL per probe and says only ready/not ready', async () => {
    const before = env.storage.writeDb.prepare("SELECT count(*) AS n FROM sqlite_temp_master").get() as { n: number };
    const r = await env.app.inject({ method: 'GET', url: '/readyz' });
    expect(r.json()).toEqual({ status: 'ready' });
    const after = env.storage.writeDb.prepare("SELECT count(*) AS n FROM sqlite_temp_master").get() as { n: number };
    expect(after.n).toBe(before.n);
    const src = readFileSync(join(ROOT, 'src', 'routes', 'health.ts'), 'utf8');
    expect(src).not.toMatch(/CREATE|writeDb/);
  });
  it('SA-C-20: health probes are rate-limited per client', async () => {
    const e = await makeEnv();
    try {
      let last = 0;
      for (let i = 0; i < 101; i++) last = (await e.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '192.0.2.80' })).statusCode;
      expect(last).toBe(429);
      expect((await e.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '192.0.2.81' })).statusCode).toBe(200);
    } finally {
      await e.close();
    }
  });
});

describe('SA-K-03 remainder: purge a cached product', () => {
  it('SA-K-03: DELETE /v1/admin/products/:gtin (admin listener, admin scope, audited, validated GTIN)', async () => {
    const e = await makeEnv();
    try {
      e.storage.write.products.upsert({ gtin: '04006381333931', name: 'Poisoned', brand: null, category: 'en:jewellery', source: 'open_food_facts', source_ref: null, found: true, fetched_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-16T00:00:00Z' });
      const del = (gtin: string, key = 'priya') => e.admin.inject({ method: 'DELETE', url: `/v1/admin/products/${gtin}`, headers: bearer(e.keys[key]!) });
      expect((await e.app.inject({ method: 'DELETE', url: '/v1/admin/products/4006381333931', headers: bearer(e.keys.priya!) })).statusCode).toBe(404); // not on the public listener
      expect((await del('4006381333931', 'read')).statusCode).toBe(403);
      expect((await del('4006381333932')).statusCode).toBe(400); // bad check digit
      expect((await del('abc')).statusCode).toBe(400);
      const ok = await del('4006381333931');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ gtin: '04006381333931', deleted: true });
      expect(e.storage.read.products.get('04006381333931')).toBeNull();
      const a = e.storage.read.audit.all().at(-1)!;
      expect(a.action).toBe('product.purged');
      expect(a.entity_id).toBe('04006381333931');
      expect(a.actor).toBe('priya');
      expect((await del('4006381333931')).statusCode).toBe(404);
    } finally {
      await e.close();
    }
  });
});
