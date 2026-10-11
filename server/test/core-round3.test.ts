/**
 * Core round 3: 00c Part C rulings 26, 28, 29, 30. Test names start with "ruling N".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearer, makeEnv, proposeAndApprove, AUDIT_KEY, PEPPER, PDF_SHA, SRC_URL, NO_IDEM_KEY, LogCapture, type TestEnv } from './helpers.js';
import { loadConfig, ConfigError, parsePeppers } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { migrate, currentSchemaVersion, SCHEMA_VERSION } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import type { Classifier } from '../src/classify/types.js';

const SRC = { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' };
const NONE = { kind: 'none', text: null, min_unit_price: null, max_unit_price: null };
const UUID1 = '0b5e2c1a-3f4d-4e6f-8a9b-0c1d2e3f4a5b';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const adminPost = (e: TestEnv, key: string, url: string, payload: object, headers: Record<string, string> = {}) =>
  e.admin.inject({ method: 'POST', url, headers: { ...bearer(e.keys[key]!), ...headers }, payload });
const newProposal = async (e: TestEnv, from: string, maker = 'amit') => {
  const r = await adminPost(e, maker, '/v1/admin/rate-proposals', {
    action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: from, source: SRC }, rationale: 'Round-3 fixture proposal.',
  });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; content_sha256: string };
};

describe('ruling 26: withdraw', () => {
  it('ruling 26: the proposer (any of their keys) withdraws a pending proposal; audited; it can no longer be approved', async () => {
    const p = await newProposal(env, '2031-01-01');
    const head = env.storage.read.audit.head()!.id;
    const w = await adminPost(env, 'amit2', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'Filed against the wrong heading.' }, { 'idempotency-key': UUID1 });
    expect(w.statusCode).toBe(200);
    expect(w.json().status).toBe('withdrawn');
    const row = env.storage.read.proposals.get(p.id)!;
    expect(row.status).toBe('withdrawn');
    const audit = env.storage.read.audit.all().filter((a) => a.id > head);
    expect(audit.map((a) => a.action)).toEqual(['rate_proposal.withdrawn']);
    expect(audit[0]!.actor).toBe('amit');
    // replay with the same key → stored response, no second audit row
    const again = await adminPost(env, 'amit2', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'Filed against the wrong heading.' }, { 'idempotency-key': UUID1 });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(env.storage.read.audit.head()!.id).toBe(audit[0]!.id);
    // terminal now: approve, reject and a fresh withdraw are 409
    expect((await adminPost(env, 'priya', `/v1/admin/rate-proposals/${p.id}/approve`, { verified_against_source: true, expected_sha256: p.content_sha256 })).statusCode).toBe(409);
    expect((await adminPost(env, 'amit', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'second withdraw' })).json().code).toBe('proposal_not_pending');
    // listed under withdrawn
    const list = (await env.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals?status=withdrawn', headers: bearer(env.keys.priya!) })).json();
    expect(list.proposals.map((x: { id: string }) => x.id)).toContain(p.id);
  });
  it('ruling 26: another actor gets 403 not-proposer; unknown id 404; non-admin key 403', async () => {
    const p = await newProposal(env, '2032-01-01');
    const r = await adminPost(env, 'priya', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'Not mine to withdraw.' });
    expect(r.statusCode).toBe(403);
    expect(r.json().type).toBe('https://hsn-api.example/problems/not-proposer');
    expect(env.storage.read.proposals.get(p.id)!.status).toBe('pending');
    expect((await adminPost(env, 'amit', '/v1/admin/rate-proposals/rp_01J9ZR0000000000000000000A/withdraw', { reason: 'no such proposal' })).statusCode).toBe(404);
    expect((await adminPost(env, 'read', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'read key try' })).statusCode).toBe(403);
    // a withdrawn proposal is terminal in the DB too
    await adminPost(env, 'amit', `/v1/admin/rate-proposals/${p.id}/withdraw`, { reason: 'Clean up after test.' });
    expect(() => env.storage.writeDb.prepare("UPDATE rate_proposals SET status = 'pending' WHERE id = ?").run(p.id)).toThrow();
  });
});

describe('ruling 28: Idempotency-Key required on every admin write', () => {
  it('ruling 28: each admin write without the header → 400 idempotency-key-required and writes nothing', async () => {
    const e = await makeEnv();
    try {
      const writes = e.admin.routeTable.filter((r) => r.scope === 'admin' && r.method !== 'GET');
      expect(writes.length).toBe(8); // create, approve, reject, withdraw, watched create/triage/resolve, product purge
      const head = e.storage.read.audit.head()!.id;
      const props = e.storage.writeDb.prepare('SELECT count(*) AS n FROM rate_proposals').get() as { n: number };
      for (const r of writes) {
        const url = r.url.replace(':id', r.url.includes('watched') ? 'wn_01J9ZR0000000000000000000A' : 'rp_01J9ZR0000000000000000000A').replace(':gtin', '4006381333931');
        const res = await e.admin.inject({
          method: r.method as 'POST', url, headers: { ...bearer(e.keys.amit!), 'idempotency-key': NO_IDEM_KEY },
          ...(r.method === 'POST' ? { payload: { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2033-01-01', source: SRC }, rationale: 'No idempotency key here.' } } : {}),
        });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(400);
        expect(res.json().type).toBe('https://hsn-api.example/problems/idempotency-key-required');
      }
      expect(e.storage.read.audit.head()!.id).toBe(head);
      expect((e.storage.writeDb.prepare('SELECT count(*) AS n FROM rate_proposals').get() as { n: number }).n).toBe(props.n);
      // malformed key → 400 validation; no key + no auth → 401 first
      const bad = await e.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: { ...bearer(e.keys.amit!), 'idempotency-key': 'not-a-uuid' }, payload: {} });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().errors[0].pointer).toBe('/headers/idempotency-key');
      const unauth = await e.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: { 'idempotency-key': NO_IDEM_KEY }, payload: {}, remoteAddress: '198.51.100.200' });
      expect(unauth.statusCode).toBe(401);
      // reads need no key
      expect((await e.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals', headers: bearer(e.keys.amit!) })).statusCode).toBe(200);
    } finally {
      await e.close();
    }
  });
  it('ruling 28: triage, resolve and product purge replay under the same key and refuse a different body', async () => {
    const e = await makeEnv();
    try {
      const w = await adminPost(e, 'amit', '/v1/admin/watched-notifications', { notification: '21/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['7113'] });
      expect(w.statusCode).toBe(201);
      const id = w.json().id as string;
      const k = '11111111-2222-4333-8444-555555555555';
      const t1 = await adminPost(e, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['7113', '7117'] }, { 'idempotency-key': k });
      const t2 = await adminPost(e, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['7113', '7117'] }, { 'idempotency-key': k });
      expect(t1.statusCode).toBe(200);
      expect(t2.headers['idempotent-replayed']).toBe('true');
      expect((await adminPost(e, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['61'] }, { 'idempotency-key': k })).statusCode).toBe(409);
      const k2 = '21111111-2222-4333-8444-555555555555';
      expect((await adminPost(e, 'amit', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'dismissed' })).statusCode).toBe(202); // SA-C3-03: keyed row, two admins
      expect((await adminPost(e, 'priya', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'dismissed' }, { 'idempotency-key': k2 })).statusCode).toBe(200);
      const r2 = await adminPost(e, 'priya', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'dismissed' }, { 'idempotency-key': k2 });
      expect(r2.statusCode).toBe(200);
      expect(r2.headers['idempotent-replayed']).toBe('true');
      e.storage.write.products.upsert({ gtin: '04006381333931', name: 'x', brand: null, category: null, source: 'open_food_facts', source_ref: null, found: true, fetched_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-16T00:00:00Z' });
      const k3 = '31111111-2222-4333-8444-555555555555';
      const d1 = await e.admin.inject({ method: 'DELETE', url: '/v1/admin/products/4006381333931', headers: { ...bearer(e.keys.priya!), 'idempotency-key': k3 } });
      const d2 = await e.admin.inject({ method: 'DELETE', url: '/v1/admin/products/4006381333931', headers: { ...bearer(e.keys.priya!), 'idempotency-key': k3 } });
      expect(d1.statusCode).toBe(200);
      expect(d2.statusCode).toBe(200);
      expect(d2.headers['idempotent-replayed']).toBe('true');
      expect(e.storage.read.audit.all().filter((a) => a.action === 'product.purged')).toHaveLength(1);
    } finally {
      await e.close();
    }
  });
});

describe('ruling 29: pepper rotation', () => {
  const NEW = 'new-pepper-p2-0123456789abcdefghijklmnop';
  const cfg = (peppers: string) => loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: env.config.dbPath, HSN_AUDIT_KEY: AUDIT_KEY, HSN_KEY_PEPPERS: peppers });
  it('ruling 29: HSN_KEY_PEPPERS parsing and validation', () => {
    expect(parsePeppers('p2:abc,p1:def')).toEqual([{ id: 'p2', secret: 'abc' }, { id: 'p1', secret: 'd' + 'ef' }]);
    expect(parsePeppers('p2:a:b')).toEqual([{ id: 'p2', secret: 'a:b' }]);
    expect(typeof parsePeppers('P2:abc')).toBe('string');
    expect(typeof parsePeppers('p2:abc,p2:def')).toBe('string');
    expect(typeof parsePeppers('p2:abc,p1:abc')).toBe('string');
    expect(typeof parsePeppers('nocolon')).toBe('string');
    const c = cfg(`p2:${NEW},default:${PEPPER}`);
    expect(c.keyPepperId).toBe('p2');
    expect(c.keyPepper.reveal()).toBe(NEW);
    expect(c.keyPeppers.map((p) => p.id)).toEqual(['p2', 'default']);
    expect(JSON.stringify(c)).not.toContain(NEW);
    const prod = { NODE_ENV: 'production', HSN_DB_PATH: 'x', HSN_AUDIT_KEY: 'a'.repeat(40), HSN_LOG_KEY: 'l'.repeat(40), HSN_DIRECT_EXPOSURE: 'true', HSN_STATE_HWM_FILE: '/var/lib/hsn-state/hwm.json' };
    expect(() => loadConfig({ ...prod, HSN_KEY_PEPPERS: `p2:${'x'.repeat(40)},p1:short` })).toThrow(/pepper "p1"/);
    expect(() => loadConfig({ ...prod, HSN_KEY_PEPPERS: `p2:${'a'.repeat(40)}` })).toThrow(/must differ/);
    expect(() => loadConfig({ ...prod, HSN_KEY_PEPPER: 'p'.repeat(40), HSN_KEY_PEPPERS: `p2:${'x'.repeat(40)}` })).toThrow(ConfigError);
    expect(loadConfig({ ...prod, HSN_KEY_PEPPERS: `p2:${'x'.repeat(40)},p1:${'y'.repeat(40)}` }).keyPepperId).toBe('p2');
  });
  it('ruling 29: end to end — old keys verify during rotation, new keys use the newest pepper, removing the old pepper retires old keys', async () => {
    const logs = new LogCapture();
    const mkApp = async (peppers: string) => buildApp({ config: cfg(peppers), storage: env.storage, clock: env.clock, logStream: logs, surface: 'public' });
    const hit = (app: Awaited<ReturnType<typeof mkApp>>, key: string) => app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(key), remoteAddress: '192.0.2.150' });
    // 1. before rotation: a key hashed with the single HSN_KEY_PEPPER has pepper_id "default"
    const old = env.keys.read!;
    expect(env.storage.read.keys.getById(env.keyIds.read!)!.pepper_id).toBe('default');
    // 2. rotation window: new pepper first, old one kept
    const during = await mkApp(`p2:${NEW},default:${PEPPER}`);
    expect((await hit(during, old)).statusCode).toBe(200);
    const c = cfg(`p2:${NEW},default:${PEPPER}`);
    const fresh = createApiKey(env.storage.tx, env.clock, { pepper: c.keyPepper.reveal(), pepperId: c.keyPepperId, auditKey: AUDIT_KEY }, {
      tenant: 't', scopes: ['read'], actor: null, label: 'rotated', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: false, expiresAt: null, createdBy: 'test',
    });
    expect(env.storage.read.keys.getById(fresh.id)!.pepper_id).toBe('p2');
    expect((await hit(during, fresh.key)).statusCode).toBe(200);
    expect(JSON.stringify(env.storage.read.audit.all().find((a) => a.entity_id === fresh.id)!.details)).toContain('"pepper_id":"p2"');
    // the old single-pepper server cannot verify the new key (its pepper is unknown there)
    expect((await hit(env.app, fresh.key)).statusCode).toBe(401);
    // 3. after rotation: old pepper removed → old keys stop verifying (logged), new keys keep working
    const after = await mkApp(`p2:${NEW}`);
    expect((await hit(after, old)).statusCode).toBe(401);
    expect((await hit(after, fresh.key)).statusCode).toBe(200);
    expect(logs.text()).toContain('api_key.pepper_missing');
    // a key's pepper_id never changes
    expect(() => env.storage.writeDb.prepare("UPDATE api_keys SET pepper_id = 'p2' WHERE id = ?").run(env.keyIds.read!)).toThrow(/immutable/);
    await Promise.all([during.close(), after.close()]);
  });
  it('ruling 29: migration v4 upgrades a v3 database in place; existing keys get pepper_id "default"', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON;');
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'schema.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)').run('2026-10-01T00:00:00Z');
    const v3 = MIGRATIONS.find((m) => m.version === 3)!;
    db.exec(v3.sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)').run('2026-10-02T00:00:00Z');
    db.prepare("INSERT INTO api_keys(id, prefix, key_hash, scopes, tenant, created_at) VALUES ('key_OLD', 'AAAAAAAA', ?, '[\"read\"]', 't', '2026-10-01T00:00:00Z')").run('a'.repeat(64));
    expect(currentSchemaVersion(db)).toBe(3);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(db.prepare("SELECT pepper_id FROM api_keys WHERE id = 'key_OLD'").get()).toEqual({ pepper_id: 'default' });
    expect(() => db.prepare("UPDATE api_keys SET pepper_id = 'p2'").run()).toThrow(/immutable/);
    expect(() => db.prepare("INSERT INTO api_keys(id, prefix, key_hash, scopes, tenant, created_at, pepper_id) VALUES ('key_BAD', 'BBBBBBBB', ?, '[\"read\"]', 't', '2026-10-01T00:00:00Z', 'Bad Id')").run('b'.repeat(64))).toThrow();
    db.close();
  });
});

describe('ruling 29: admin grants are logged at warn level and audited (notifier deferred)', () => {
  it('ruling 29: approving an admin_grant writes admin.granted and a warn-level admin.grant_approved line', async () => {
    const e = await makeEnv();
    try {
      const { approve, proposal } = await proposeAndApprove(e, { action: 'admin_grant', grant: { handle: 'ravi', display_name: 'Ravi', new_actor: true }, rationale: 'Ravi joins as a checker.' });
      expect(approve!.statusCode).toBe(200);
      const a = e.storage.read.audit.all().find((x) => x.action === 'admin.granted' && x.entity_id === 'ravi')!;
      expect(a.actor).toBe('priya');
      expect((a.details as { proposal_id: string }).proposal_id).toBe(proposal!.id);
      const line = e.logs.text().split('\n').filter((l) => l.includes('"event":"admin.grant_approved"')).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['handle'] === 'ravi')!;
      expect(line['level']).toBe(40);
      expect(line['alert']).toBe(true);
      expect(line['approved_by']).toBe('priya');
      expect(line['proposed_by']).toBe('amit');
    } finally {
      await e.close();
    }
  });
});

describe('ruling 30: HSN_PRODUCT_CACHE_MAX_ROWS', () => {
  it('ruling 30: oldest-first eviction keeps the cache at the bound and never drops the row just written', async () => {
    const e = await makeEnv({ env: { HSN_PRODUCT_CACHE_MAX_ROWS: '100' } });
    try {
      expect(e.config.productCacheMaxRows).toBe(100);
      const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString().replace('.000Z', 'Z');
      const gtin = (i: number) => String(10_000_000_000_000 + i).padStart(14, '0');
      for (let i = 0; i < 105; i++) {
        e.storage.write.products.upsert({ gtin: gtin(i), name: `p${i}`, brand: null, category: null, source: 'open_food_facts', source_ref: null, found: true, fetched_at: at(i), expires_at: '2026-12-01T00:00:00Z' });
      }
      expect(e.storage.write.products.count()).toBe(100);
      for (let i = 0; i < 5; i++) expect(e.storage.read.products.get(gtin(i))).toBeNull();
      expect(e.storage.read.products.get(gtin(5))).not.toBeNull();
      expect(e.storage.read.products.get(gtin(104))).not.toBeNull();
      // a refreshed row with an old fetched_at is still kept (the next-oldest goes instead)
      e.storage.write.products.upsert({ gtin: gtin(999), name: 'late', brand: null, category: null, source: 'open_food_facts', source_ref: null, found: true, fetched_at: '2026-01-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z' });
      expect(e.storage.read.products.get(gtin(999))).not.toBeNull();
      expect(e.storage.read.products.get(gtin(5))).toBeNull();
      expect(e.storage.write.products.count()).toBe(100);
    } finally {
      await e.close();
    }
    expect(() => loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: 'x', HSN_PRODUCT_CACHE_MAX_ROWS: '10' })).toThrow(ConfigError);
    expect(loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: 'x' }).productCacheMaxRows).toBe(50_000);
  });
});

describe('ruling 30: Prometheus /metrics on the admin listener only', () => {
  const fake: Classifier = {
    async classify() {
      return {
        normalized_name: 'gold ring', product: null, needs_review: false,
        candidates: [{ hsn: '7113', description: 'Jewellery', confidence: 0.7, confidence_band: 'medium', needs_review: true, signals: { synonym: 0, fts: 0.6, chapter_keyword: 1, barcode_category: null, margin_penalty: 0 }, reasons: [{ code: 'fts_match', detail: 'x', weight: 0.4 }] }],
        classifier: { version: 'test', llm_rerank: false }, llm_used: false,
      };
    },
  };
  it('ruling 30: never on the public listener', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/metrics', headers: bearer(env.keys.priya!) })).statusCode).toBe(404);
    expect(env.app.routeTable.some((r) => r.url === '/metrics')).toBe(false);
    expect(env.admin.routeTable.some((r) => r.url === '/metrics')).toBe(true);
  });
  it('ruling 30: request counts by route/status, latency histogram, classify bands, watcher last success, unverified rules', async () => {
    const e = await makeEnv({ classifier: fake });
    try {
      await e.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(e.keys.read!) });
      await e.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(e.keys.read!) });
      await e.app.inject({ method: 'GET', url: '/v1/hsn/0000', headers: bearer(e.keys.read!) });
      await e.app.inject({ method: 'POST', url: '/v1/classify', headers: bearer(e.keys.classify!), payload: { name: 'gold ring' } });
      e.storage.write.watcherRuns.insert({ source: 'cbic', started_at: '2026-10-10T05:00:00Z', finished_at: '2026-10-10T05:00:03Z', status: 'ok', items_seen: 3, items_new: 0, error: null, details: {} });
      const m = await e.admin.inject({ method: 'GET', url: '/metrics' });
      expect(m.statusCode).toBe(200);
      expect(m.headers['content-type']).toContain('text/plain');
      const t = m.body;
      expect(t).toContain('hsn_http_requests_total{listener="public",method="GET",route="/v1/hsn/:code",status="200"} 2');
      expect(t).toContain('hsn_http_requests_total{listener="public",method="GET",route="/v1/hsn/:code",status="404"} 1');
      expect(t).toMatch(/hsn_http_request_duration_seconds_bucket\{le="\+Inf",listener="public",route="\/v1\/hsn\/:code"\} 3/);
      expect(t).toMatch(/hsn_http_request_duration_seconds_count\{listener="public",route="\/v1\/hsn\/:code"\} 3/);
      expect(t).toContain('hsn_classify_top_band_total{band="medium"} 1');
      expect(t).toContain(`hsn_watcher_last_success_timestamp_seconds ${Date.parse('2026-10-10T05:00:03Z') / 1000}`);
      const unverified = e.storage.writeDb.prepare("SELECT COUNT(*) AS n FROM rate_rules WHERE status = 'active' AND verification_status='unverified' AND effective_from <= '2026-10-10' AND (effective_to IS NULL OR effective_to >= '2026-10-10')").get() as { n: number };
      expect(t).toContain(`hsn_rate_rules_unverified ${unverified.n}`);
      expect(t).toContain('# TYPE hsn_http_request_duration_seconds histogram');
      // admin traffic is counted with its listener label; no secrets or raw input appear
      expect(t).toMatch(/hsn_http_requests_total\{listener="admin"/);
      for (const k of Object.values(e.keys)) expect(t).not.toContain(k.slice(4, 12));
      expect(t).not.toContain('gold ring');
    } finally {
      await e.close();
    }
  });
  it('ruling 30: HSN_ADMIN_IP_ALLOWLIST applies to /metrics', async () => {
    const e = await makeEnv({ env: { HSN_ADMIN_IP_ALLOWLIST: '10.9.9.0/24' } });
    try {
      expect((await e.admin.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })).statusCode).toBe(403);
      expect((await e.admin.inject({ method: 'GET', url: '/metrics', remoteAddress: '10.9.9.3' })).statusCode).toBe(200);
    } finally {
      await e.close();
    }
  });
});

describe('round 3 follow-ups', () => {
  it('SA-K2-01 / ruling 5: a rule_hint selection keeps rules[] and default_rule_id and says how the rule was chosen', async () => {
    const { RateService } = await import('../src/services/rates.js');
    const svc = new RateService(env.storage.read.rules, undefined, { clock: env.clock });
    const plain = svc.resolve('3004', '2026-10-10', null).dto;
    expect(plain.rule_selected_by).toBeNull();
    const hinted = svc.resolve('3004', '2026-10-10', null, { conditionCode: 'nil_rate_list' }).dto;
    expect(hinted.applicable_rule?.igst_rate_bp).toBe(0);
    expect(hinted.rule_selected_by).toBe('rule_hint:nil_rate_list');
    expect(hinted.default_rule_id).toBe(plain.default_rule_id);
    expect(hinted.rules.map((r) => r.rule_id).sort()).toEqual(plain.rules.map((r) => r.rule_id).sort());
    expect(hinted.warnings).toContain('selected_by_hint');
    // the HTTP schema keeps the field
    const r = (await env.app.inject({ method: 'GET', url: '/v1/hsn/3004', headers: bearer(env.keys.read!) })).json().rate;
    expect(r).toHaveProperty('rule_selected_by', null);
  });
  it('audit entity_type filter accepts product', async () => {
    const e = await makeEnv();
    try {
      e.storage.write.products.upsert({ gtin: '04006381333931', name: 'x', brand: null, category: null, source: 'open_food_facts', source_ref: null, found: true, fetched_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-16T00:00:00Z' });
      expect((await e.admin.inject({ method: 'DELETE', url: '/v1/admin/products/4006381333931', headers: bearer(e.keys.priya!) })).statusCode).toBe(200);
      const r = await e.admin.inject({ method: 'GET', url: '/v1/admin/audit?entity_type=product', headers: bearer(e.keys.priya!) });
      expect(r.statusCode).toBe(200);
      expect(r.json().entries.map((x: { action: string }) => x.action)).toEqual(['product.purged']);
    } finally {
      await e.close();
    }
  });
  it('HSN_METRICS_PORT is no longer parsed (metrics share the admin listener, ruling 30)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config.ts'), 'utf8');
    expect(src).not.toContain('HSN_METRICS_PORT');
    expect(() => loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: 'x', HSN_METRICS_PORT: 'not-a-port' })).not.toThrow();
  });
  it('ruling 33: FORMAT.md says seed rows are always unverified and allowVerified is test-fixture-only', () => {
    const f = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed', 'FORMAT.md'), 'utf8');
    expect(f).toMatch(/Ruling 33/);
    expect(f).toMatch(/always `unverified`/);
    expect(f).toContain('test-fixture-only');
    expect(f).toContain('`allowVerified`');
    expect(f).not.toMatch(/"verification_status": "verified"/);
  });
});
