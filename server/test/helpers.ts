import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDb, openReadDb, openCacheDb, migrate } from '../src/db/migrate.js';
import { createStorage, type Storage } from '../src/repositories/sqlite/index.js';
import { loadSeed } from '../src/db/seed.js';
import { fixedClock } from '../src/lib/clock.js';
import { bootstrapAdmins, createApiKey } from '../src/services/apiKeys.js';
import { buildApp, createSharedState, type SharedState } from '../src/app.js';
import type { Scope } from '../src/lib/apiKey.js';
import type { Classifier } from '../src/classify/types.js';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seed');
export const NOW = '2026-10-10T06:00:00Z';
export const PEPPER = 'test-pepper-0123456789abcdef0123456789';
export const AUDIT_KEY = 'test-audit-key-0123456789abcdef01234567';
export const LOG_KEY = 'test-log-key-0123456789abcdef0123456789ab';

export class LogCapture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.lines.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.lines.join('');
  }
}

export interface TestEnv {
  /** public listener (no admin routes) */
  app: FastifyInstance;
  /** admin listener (admin routes + health only), ruling 25 */
  admin: FastifyInstance;
  shared: SharedState;
  storage: Storage;
  config: AppConfig;
  clock: ReturnType<typeof fixedClock>;
  logs: LogCapture;
  keys: Record<string, string>;
  keyIds: Record<string, string>;
  dir: string;
  close(): Promise<void>;
}

export interface TestEnvOptions {
  env?: Record<string, string>;
  seed?: boolean;
  classifier?: Classifier;
  /** create the admin actors/keys (default true) */
  admins?: boolean;
  /** seed directory (default the test fixture, loaded with allowVerified) */
  seedDir?: string;
}

export async function makeEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'hsn-test-'));
  const dbPath = join(dir, 'hsn.db');
  // NB: the unauthenticated limit is left at its default (60/min) so tests see production behaviour (SA-C-08)
  const config = loadConfig({
    NODE_ENV: 'test',
    HSN_DB_PATH: dbPath,
    HSN_KEY_PEPPER: PEPPER,
    HSN_AUDIT_KEY: AUDIT_KEY,
    HSN_LOG_KEY: LOG_KEY,
    HSN_LOG_LEVEL: 'info',
    ...opts.env,
  });
  const clock = fixedClock(NOW);
  const w = openDb(dbPath);
  migrate(w);
  const r = openReadDb(dbPath);
  const storage = createStorage(w, r, { productCacheMaxRows: config.productCacheMaxRows, cacheDb: openCacheDb(dbPath) });
  if (opts.seed !== false) {
    loadSeed(storage.tx, {
      dir: opts.seedDir ?? FIXTURE_DIR, allowedRatesBp: config.allowedRatesBp, sourceHosts: config.sourceHosts,
      now: new Date('2026-10-03T09:15:00Z'), auditKey: config.auditKey.reveal(), allowVerified: opts.seedDir === undefined,
    });
  }
  const secrets = { pepper: PEPPER, auditKey: config.auditKey.reveal() };
  const keys: Record<string, string> = {};
  const keyIds: Record<string, string> = {};
  const mk = (name: string, scopes: Scope[], rate = 600, extra: { dailyQuota?: number; llmOptOut?: boolean } = {}) => {
    const k = createApiKey(storage.tx, clock, secrets, {
      tenant: 'test', scopes, actor: null, label: name, rateLimitPerMin: rate, dailyQuota: extra.dailyQuota ?? null,
      llmOptOut: extra.llmOptOut ?? false, expiresAt: null, createdBy: 'test',
    });
    keys[name] = k.key;
    keyIds[name] = k.id;
  };
  mk('read', ['read']);
  mk('classify', ['classify']);
  mk('readClassify', ['read', 'classify']);
  mk('slow', ['read'], 6);
  mk('quota', ['read'], 600, { dailyQuota: 2 });
  mk('bulk', ['read'], 1_000_000, { dailyQuota: 1_000_000 });
  const logs = new LogCapture();
  const shared = createSharedState(config, clock);
  const app = await buildApp({ config, storage, clock, logStream: logs, shared, surface: 'public', ...(opts.classifier ? { classifier: opts.classifier } : {}) });
  const admin = await buildApp({ config, storage, clock, logStream: logs, shared, surface: 'admin' });
  withAutoIdempotencyKey(admin);
  if (opts.admins !== false && opts.seed !== false) {
    // ruling 17: bootstrap creates the first two actors + one key each ...
    const boot = bootstrapAdmins(storage.tx, clock, secrets, [{ handle: 'amit', display_name: 'Amit' }, { handle: 'priya', display_name: 'Priya' }], { tenant: 'test', by: 'test' });
    keys['amit'] = boot[0]!.key;
    keyIds['amit'] = boot[0]!.key_id;
    keys['priya'] = boot[1]!.key;
    keyIds['priya'] = boot[1]!.key_id;
    // ... and a second key for amit needs an admin_grant approved by a different admin (priya)
    const p = await admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(keys['amit']!), payload: { action: 'admin_grant', grant: { handle: 'amit', new_actor: false }, rationale: 'second key for amit (laptop)' } });
    const prop = p.json() as { id: string; content_sha256: string };
    if (p.statusCode !== 201) return finish(); // admin writes disabled / allow-listed admin IPs: no amit2 key
    const ap = await admin.inject({ method: 'POST', url: `/v1/admin/rate-proposals/${prop.id}/approve`, headers: bearer(keys['priya']!), payload: { verified_against_source: true, expected_sha256: prop.content_sha256 } });
    if (ap.statusCode !== 200) throw new Error(`grant approval failed: ${ap.body}`);
    const k2 = createApiKey(storage.tx, clock, secrets, {
      tenant: 'test', scopes: ['admin'], actor: 'amit', adminGrantId: prop.id, label: 'amit2', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 'test',
    });
    keys['amit2'] = k2.key;
    keyIds['amit2'] = k2.id;
  }
  return finish();
  function finish(): TestEnv {
    return {
    app, admin, shared, storage, config, clock, logs, keys, keyIds, dir,
    async close() {
      await app.close();
      await admin.close();
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
    };
  }
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/** Create a proposal as `maker` and approve it as `checker`, quoting its content hash. */
export async function proposeAndApprove(env: TestEnv, body: Record<string, unknown>, maker = 'amit', checker = 'priya') {
  const c = await env.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys[maker]!), payload: body });
  if (c.statusCode !== 201) return { create: c, approve: null, proposal: null };
  const proposal = c.json() as { id: string; content_sha256: string };
  const a = await env.admin.inject({
    method: 'POST', url: `/v1/admin/rate-proposals/${proposal.id}/approve`, headers: bearer(env.keys[checker]!),
    payload: { verified_against_source: true, expected_sha256: proposal.content_sha256 },
  });
  return { create: c, approve: a, proposal };
}

export const PDF_SHA = 'a'.repeat(64);
export const SRC_URL = 'https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications';

/**
 * Ruling 28 makes Idempotency-Key mandatory on admin writes. Tests that are not about idempotency get a
 * fresh UUID automatically; pass the header explicitly to control it, or `'idempotency-key': NO_IDEM_KEY`
 * to send none at all.
 */
export const NO_IDEM_KEY = '__none__';
export function withAutoIdempotencyKey(app: FastifyInstance): void {
  const orig = app.inject.bind(app) as (o: Record<string, unknown>) => Promise<unknown>;
  (app as unknown as { inject: unknown }).inject = (opts: Record<string, unknown>) => {
    const method = String(opts['method'] ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return orig(opts);
    const headers = { ...((opts['headers'] as Record<string, string> | undefined) ?? {}) };
    if (headers['idempotency-key'] === NO_IDEM_KEY) delete headers['idempotency-key'];
    else if (headers['idempotency-key'] === undefined) headers['idempotency-key'] = randomUUID();
    return orig({ ...opts, headers });
  };
}
