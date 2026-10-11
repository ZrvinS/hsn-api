/**
 * Round 4: fixes for reviews/security-code-core-round2.md (SA-C2-01 … SA-C2-09) and 405 handling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CbicWatcherAdapter, parseCbicListing, parseCbicListingIsolated, type CbicPage, type CbicFetchResult } from '../src/adapters/cbicWatcher.js';
import { runCbicWatch, type WatcherLogger, type WatcherSource } from '../src/services/watcher.js';
import { watcherDeps } from '../src/watcherDeps.js';
import { buildApp, createSharedState } from '../src/app.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { openDb, openReadDb, migrate } from '../src/db/migrate.js';
import { createStorage } from '../src/repositories/sqlite/index.js';
import { verifyAgainstHead } from '../src/services/auditExport.js';
import { crossCheckState } from '../src/services/integrity.js';
import { createApiKey, KeyInputError } from '../src/services/apiKeys.js';
import { readHwm, writeHwm } from '../src/services/restoreGuard.js';
import { TokenBucketLimiter } from '../src/lib/rateLimit.js';
import { disableActorCli } from '../scripts/disable-actor.js';
import { ackRestoreCli } from '../scripts/ack-restore.js';
import { AUDIT_KEY, LOG_KEY, LogCapture, PDF_SHA, PEPPER, SRC_URL, bearer, makeEnv, proposeAndApprove, type TestEnv } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = ['cbic-gst.gov.in', 'taxinformation.cbic.gov.in'];
const CT: CbicPage = { url: 'https://cbic-gst.gov.in/central-tax-rate.html', series: 'central_tax_rate' };
const IT: CbicPage = { url: 'https://cbic-gst.gov.in/integrated-tax-rate.html', series: 'integrated_tax_rate' };
const SECRETS = { pepper: PEPPER, auditKey: AUDIT_KEY };
const ruleBody = (prefix: string, from: string, bp = 300) => ({
  hsn_prefix: prefix, igst_rate_bp: bp, effective_from: from,
  condition: { kind: 'none', text: null, min_unit_price: null, max_unit_price: null },
  source: { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' },
});
const post = (env: TestEnv, who: string, url: string, payload: object) => env.admin.inject({ method: 'POST', url, headers: bearer(env.keys[who]!), payload });
const cliEnv = (env: TestEnv) => ({ NODE_ENV: 'test', HSN_DB_PATH: env.config.dbPath, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY });
async function readyz(env: TestEnv, logs = new LogCapture()) {
  const app = await buildApp({ config: env.config, storage: env.storage, clock: env.clock, shared: createSharedState(env.config, env.clock), surface: 'public', logStream: logs });
  const r = await app.inject({ method: 'GET', url: '/readyz' });
  await app.close();
  return { status: r.statusCode, logs: logs.text() };
}

// ------------------------------------------------------------------------------------------------ SA-C2-01 / 08

describe('SA-C2-01: linear watcher parser, caps, worker isolation', () => {
  const pre = '<html><body><table><tr><td>01/2026-Central Tax (Rate)</td><td>01-01-2026</td><td>Seeks to amend ';
  const N = 256 * 1024;
  const fill = (p: string) => (pre + p.repeat(Math.ceil((N - pre.length) / p.length))).slice(0, N);
  const patterns: Record<string, string> = {
    'unclosed <a href=': '<a href=', '<a href=x> without </a>': '<a href=x>', 'unclosed <!--': '<!--', '<tr without >': '<tr', '<tr> rows': '<tr>',
    '<td without >': '<td', '<td> cells': '<td>', '<b without >': '<b', '<b> tags': '<b>', 'unclosed <script>': '<script>', 'bars': '| ', 'quoted href': '<a href="',
  };
  for (const [name, p] of Object.entries(patterns)) {
    it(`256 KiB adversarial page (${name}) parses in well under 1 s`, () => {
      const html = fill(p);
      expect(html.length).toBe(N);
      const t = performance.now();
      const r = parseCbicListing(html, CT, { linkHosts: HOSTS });
      const ms = performance.now() - t;
      expect(ms).toBeLessThan(250);
      expect(r.stats.matched).toBeGreaterThanOrEqual(0);
    });
  }

  it('row text, cells and anchors are capped', () => {
    const many = '<html><table><tr><td>01/2026-Central Tax (Rate)</td><td>01-01-2026</td>' + '<td>x'.repeat(500) + '<td>' + 'y'.repeat(40_000) + '</table>';
    const r = parseCbicListing(many, CT, { linkHosts: HOSTS });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.items[0]!.title ?? '').length).toBeLessThanOrEqual(500);
  });

  it('isolated parse: same result in a worker; a stuck parser is terminated and fails closed as shape_changed', async () => {
    const html = readFileSync(join(ROOT, 'test', 'fixtures', 'cbic', 'central-tax-rate.html'), 'utf8');
    const inline = parseCbicListing(html, CT, { linkHosts: HOSTS });
    const iso = await parseCbicListingIsolated(html, CT, { linkHosts: HOSTS });
    expect(iso).toEqual(inline);
    const t = Date.now();
    const stuck = await parseCbicListingIsolated(html, CT, { linkHosts: HOSTS }, { timeoutMs: 200, testOnlyBusyMs: 5000 });
    expect(stuck).toMatchObject({ ok: false, error: 'shape_changed' });
    expect(!stuck.ok && stuck.detail).toMatch(/timed out/);
    expect(Date.now() - t).toBeLessThan(4000);
  }, 20_000);

  it('watcherDeps (in-process and cron) always isolates the parse with a 2 s limit', () => {
    const cfg = loadConfig({
      NODE_ENV: 'test', HSN_DB_PATH: ':memory:', HSN_WATCHER_CT_RATE_URL: CT.url, HSN_WATCHER_HOSTS: 'cbic-gst.gov.in',
      HSN_SOURCE_HOSTS: 'cbic-gst.gov.in',
    });
    const db = openDb(':memory:');
    migrate(db);
    const d = watcherDeps(cfg, createStorage(db), { now: () => new Date() } as never, { info() {}, warn() {}, error() {} });
    expect(d.source).toBeInstanceOf(CbicWatcherAdapter);
    expect((d.source as unknown as { opts: { isolateParse?: { timeoutMs?: number } } }).opts.isolateParse).toEqual({ timeoutMs: 2000 });
    db.close();
  });
});

describe('SA-C2-08: hidden rows are ignored and logged', () => {
  const page = (rows: string) => `<html><table><tbody>${rows}</tbody></table></html>`;
  const visible = '<tr><td>03/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>Seeks to amend the rate of something</td></tr>';

  it('display:none / hidden rows, cells and containers never become items; stats.hidden counts them', () => {
    const html = page(
      visible +
        '<tr style="display: none"><td>99/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>pre-claim</td></tr>' +
        '<tr hidden><td>98/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>pre-claim</td></tr>' +
        '<tr><td style="visibility:hidden">97/2026-Central Tax (Rate)</td><td>02/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>visible text</td></tr>' +
        '<tr><td><span style="DISPLAY:NONE">96/2026-Central Tax (Rate) </span>04/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>visible</td></tr>',
    ) + '<div hidden><table><tr><td>95/2026-Central Tax (Rate)</td><td>01-10-2026</td></tr></table></div>';
    const r = parseCbicListing(html, CT, { linkHosts: HOSTS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => i.key).sort()).toEqual(['central_tax_rate:2/2026', 'central_tax_rate:3/2026', 'central_tax_rate:4/2026']);
    expect(r.stats.hidden).toBe(5);
  });

  it('a watcher run logs watcher.hidden_rows (warn, alert) and queues only visible rows', async () => {
    const env = await makeEnv();
    try {
      const lines: { level: string; obj: Record<string, unknown> }[] = [];
      const log: WatcherLogger = {
        info: (obj) => lines.push({ level: 'info', obj }), warn: (obj) => lines.push({ level: 'warn', obj }), error: (obj) => lines.push({ level: 'error', obj }),
      };
      const html = page(visible + '<tr style="display:none"><td>99/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>pre-claim</td></tr>');
      const source: WatcherSource = {
        pages: [CT],
        async fetchAll(): Promise<CbicFetchResult[]> {
          const res = parseCbicListing(html, CT, { linkHosts: HOSTS });
          return [{ page: CT, result: res.ok ? { ok: true, items: res.items, stats: res.stats } : { ok: false, error: res.error, detail: res.detail } }];
        },
      };
      const out = await runCbicWatch({ tx: env.storage.tx, read: env.storage.write, clock: env.clock, auditKey: AUDIT_KEY, source, log, notBefore: '2025-01-01' });
      expect(out.new_keys).toEqual(['central_tax_rate:3/2026']);
      expect(out.pages[0]!.hidden).toBe(1);
      const w = lines.find((l) => l.obj['event'] === 'watcher.hidden_rows')!;
      expect(w).toMatchObject({ level: 'warn', obj: { alert: true } });
    } finally {
      await env.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SA-C2-02

describe('SA-C2-02: bound guards + state-to-audit cross-check (forgery is detected)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  const ids = () => {
    const amit = env.storage.read.actors.byHandle('amit')!;
    const priya = env.storage.read.actors.byHandle('priya')!;
    return { amit: amit.id, priya: priya.id, amitKey: env.keyIds['amit']!, priyaKey: env.keyIds['priya']! };
  };

  it('a legitimate history cross-checks clean (boot, readyz, verify-audit), approvals record the content hash', async () => {
    const a = await proposeAndApprove(env, { action: 'create', rule: ruleBody('7117', '2026-10-11'), rationale: 'round 4 baseline rule' });
    expect(a.approve!.statusCode).toBe(200);
    const entry = env.storage.read.audit.all().filter((e) => e.action === 'rate_proposal.approved').at(-1)!;
    expect(entry.details['dataset_content_hash']).toBe(env.storage.read.dataset.current()!.content_hash);
    expect(crossCheckState(env.storage.read)).toMatchObject({ ok: true, problems: [] });
    expect(verifyAgainstHead(env.storage.read, AUDIT_KEY, null)).toMatchObject({ ok: true });
    expect((await readyz(env)).status).toBe(200);
  });

  it('DB guards: approved proposal insert, void / end-date / verify / supersede without the matching proposal are refused', () => {
    const db = env.storage.writeDb;
    const { amit, priya, amitKey, priyaKey } = ids();
    const ver = env.storage.read.dataset.current()!.current_version;
    expect(() =>
      db.prepare(`INSERT INTO rate_proposals(id, status, action, rule_json, rationale, content_sha256, proposed_by, proposed_by_actor_id, proposed_key_id, proposed_at,
                  decided_by, decided_by_actor_id, decided_key_id, decided_at, resulting_rule_id, resulting_version)
                  VALUES ('rp_forged0','approved','create','{}','forged rationale', ?, 'amit', ?, ?, '2026-10-10T06:00:00Z', 'priya', ?, ?, '2026-10-10T06:00:00Z', 'rr_forged0', ?)`)
        .run('f'.repeat(64), amit, amitKey, priya, priyaKey, ver),
    ).toThrow(/pending and undecided/);
    const rule = db.prepare(`SELECT rule_id FROM rate_rules WHERE status = 'active' AND effective_to IS NULL LIMIT 1`).get() as { rule_id: string };
    const other = db.prepare(`SELECT rule_id FROM rate_rules WHERE rule_id <> ? LIMIT 1`).get(rule.rule_id) as { rule_id: string };
    expect(() => db.prepare(`UPDATE rate_rules SET status = 'voided', voided_at = '2026-10-10T06:00:00Z', voided_in_version = ?, voided_by_rule = ? WHERE rule_id = ?`).run(ver, other.rule_id, rule.rule_id)).toThrow();
    expect(() => db.prepare(`UPDATE rate_rules SET effective_to = '2026-12-31', end_dated_in_version = ? WHERE rule_id = ?`).run(ver, rule.rule_id)).toThrow(/approved proposal/);
    expect(() => db.prepare(`UPDATE rate_rules SET effective_to = '2026-12-31' WHERE rule_id = ?`).run(rule.rule_id)).toThrow(/approved proposal/);
    const unverified = db.prepare(`SELECT rule_id FROM rate_rules WHERE verification_status = 'unverified' LIMIT 1`).get() as { rule_id: string } | undefined;
    if (unverified) {
      expect(() => db.prepare(`UPDATE rate_rules SET verification_status = 'verified', verified_by = 'amit', last_verified_at = '2026-10-10T06:00:00Z' WHERE rule_id = ?`).run(unverified.rule_id)).toThrow(/approved proposal/);
    }
    // add_code / description guards bind the whole payload
    expect(() => db.prepare(`UPDATE hsn_codes SET description = 'x', changed_by_proposal = (SELECT id FROM rate_proposals WHERE status = 'approved' LIMIT 1) WHERE code = '7113'`).run()).toThrow(/descriptions change only/);
  });

  it("the auditor's forgery (DB11: fake approved proposal + rule + version + pointer) is detected by the boot check, /readyz and verify-audit", async () => {
    const db = env.storage.writeDb;
    const { amit, priya, amitKey, priyaKey } = ids();
    const cur = env.storage.read.dataset.current()!;
    const v = '2026.10.10-9';
    const at = '2026-10-10T06:30:00Z';
    // a database writer without HSN_AUDIT_KEY can drop triggers; they cannot write HMAC'd audit entries
    db.exec('DROP TRIGGER rate_proposals_guard_insert');
    db.exec('BEGIN');
    const ruleJson = JSON.stringify({ hsn_prefix: '6109', igst_rate_bp: 0, cess_rate_bp: 0, effective_from: '2026-12-01', effective_to: null, notification_ref: '99/2026-Central Tax (Rate)', source_url: SRC_URL });
    db.prepare(`INSERT INTO dataset_versions(version, parent_version, published_at, published_by, reason, rule_count, content_hash) VALUES (?,?,?,?,?,?,?)`)
      .run(v, cur.current_version, at, 'priya', 'proposal rp_forged1', 0, '0'.repeat(64));
    db.prepare(`INSERT INTO rate_proposals(id, status, action, rule_json, rationale, content_sha256, proposed_by, proposed_by_actor_id, proposed_key_id, proposed_at,
                decided_by, decided_by_actor_id, decided_key_id, decided_at, resulting_rule_id, resulting_version)
                VALUES ('rp_forged1','approved','create', ?, 'forged rationale', ?, 'amit', ?, ?, ?, 'priya', ?, ?, ?, 'rr_forged1', ?)`)
      .run(ruleJson, 'f'.repeat(64), amit, amitKey, at, priya, priyaKey, at, v);
    db.prepare(`INSERT INTO rate_rules(rule_id, hsn_prefix, igst_rate_bp, cess_rate_bp, condition_kind, effective_from, notification_ref, source_url,
                verified_by, last_verified_at, verification_status, created_in_version, proposal_id)
                VALUES ('rr_forged1','6109',0,0,'none','2026-12-01','99/2026-Central Tax (Rate)',?, 'priya', ?, 'verified', ?, 'rp_forged1')`).run(SRC_URL, at, v);
    const hash = env.storage.write.dataset.computeContentHash();
    db.prepare(`UPDATE dataset_versions SET content_hash = ? WHERE version = ?`).run(hash, v);
    db.prepare(`UPDATE dataset_state SET current_version = ? WHERE id = 1`).run(v);
    db.exec('COMMIT');
    // the old checks pass: the stored hash matches the data
    expect(env.storage.read.dataset.computeContentHash()).toBe(env.storage.read.dataset.current()!.content_hash);

    const x = crossCheckState(env.storage.read);
    expect(x.ok).toBe(false);
    expect(x.problems.join('\n')).toMatch(/dataset version 2026\.10\.10-9: no rate_proposal\.approved/);
    expect(x.problems.join('\n')).toMatch(/proposal rp_forged1: no rate_proposal\.created/);
    expect(x.problems.join('\n')).toMatch(/rule rr_forged1: no approval audit entry/);
    const va = verifyAgainstHead(env.storage.read, AUDIT_KEY, null);
    expect(va.ok).toBe(false);
    expect(va.problems.some((p) => p.startsWith('state without matching audit entry'))).toBe(true);
    const r = await readyz(env);
    expect(r.status).toBe(503);
    expect(r.logs).toContain('audit.state_mismatch');
  });
});

describe('SA-C2-02: keys, actors and rule edits made behind the audit log are detected', () => {
  it('a raw api_keys insert and a dropped-trigger rule edit are reported', async () => {
    const env = await makeEnv();
    try {
      const db = env.storage.writeDb;
      db.prepare(`INSERT INTO api_keys(id, prefix, key_hash, scopes, tenant, created_at) VALUES ('key_forged','hsk_forged00', ?, '["read"]', 'x', '2026-10-10T06:00:00Z')`).run('0'.repeat(64));
      db.exec('DROP TRIGGER rate_rules_guard_bind');
      const r = db.prepare(`SELECT rule_id FROM rate_rules WHERE effective_to IS NULL AND status = 'active' LIMIT 1`).get() as { rule_id: string };
      const ver = env.storage.read.dataset.current()!.current_version;
      db.prepare(`UPDATE rate_rules SET effective_to = '2026-10-31', end_dated_in_version = ? WHERE rule_id = ?`).run(ver, r.rule_id);
      const x = crossCheckState(env.storage.read);
      expect(x.problems.join('\n')).toMatch(/api key key_forged .*no api_key\.created/);
      expect(x.problems.join('\n')).toMatch(new RegExp(`rule ${r.rule_id}: end-dated without`));
    } finally {
      await env.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SA-C2-03

describe('SA-C2-03: silencing a watcher-detected notification takes two admins', () => {
  let env: TestEnv;
  let id: string;
  beforeAll(async () => {
    env = await makeEnv();
    const html = '<html><table><tr><td>07/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>Seeks to amend the rate on 7113</td></tr></table></html>';
    const source: WatcherSource = {
      pages: [CT],
      async fetchAll() {
        const r = parseCbicListing(html, CT, { linkHosts: HOSTS });
        return [{ page: CT, result: r.ok ? { ok: true as const, items: r.items, stats: r.stats } : { ok: false as const, error: r.error, detail: r.detail } }];
      },
    };
    const noop = { info() {}, warn() {}, error() {} };
    await runCbicWatch({ tx: env.storage.tx, read: env.storage.write, clock: env.clock, auditKey: AUDIT_KEY, source, log: noop, notBefore: '2025-01-01' });
    id = env.storage.read.watched.byKey('central_tax_rate:7/2026')!.id;
  });
  afterAll(async () => env.close());

  it('first triage needs a second admin (SA-C3-03); later additions are single-step; removing prefixes needs a different admin to repeat the request', async () => {
    // SA-C3-03 (X6): one admin cannot point a fresh watcher row at unrelated codes
    expect((await post(env, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['7113'] })).statusCode).toBe(202);
    expect(() => env.storage.writeDb.prepare(`UPDATE watched_notifications SET affected_prefixes = '["0406"]' WHERE id = ?`).run(id)).toThrow(/second admin/);
    expect((await post(env, 'priya', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['7113'] })).statusCode).toBe(200);
    expect((await post(env, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['7113', '6109'] })).statusCode).toBe(200);
    const req = await post(env, 'amit', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['6109'] });
    expect(req.statusCode).toBe(202);
    expect(req.json()).toMatchObject({ affected_prefixes: ['7113', '6109'], pending_action: { kind: 'triage', affected_prefixes: ['6109'], by: 'amit' } });
    // the same human (another key) cannot confirm
    const self = await post(env, 'amit2', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['6109'] });
    expect(self.statusCode).toBe(403);
    expect(self.json().type).toMatch(/maker-checker-violation/);
    const ok = await post(env, 'priya', `/v1/admin/watched-notifications/${id}/triage`, { affected_prefixes: ['6109'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ affected_prefixes: ['6109'], pending_action: null });
    const audit = env.storage.read.audit.all().filter((e) => e.entity_id === id).map((e) => e.action);
    expect(audit).toEqual([
      'watched_notification.detected', 'watched_notification.confirmation_requested', 'watched_notification.triaged', 'watched_notification.triaged',
      'watched_notification.confirmation_requested', 'watched_notification.triaged',
    ]);
    expect(env.logs.text()).toContain('watcher.row_silenced');
  });

  it('dismiss: first admin → 202 (still detected, warnings stay); same admin again → 403; DB refuses a direct resolve', async () => {
    const r1 = await post(env, 'priya', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'dismissed' });
    expect(r1.statusCode).toBe(202);
    expect(env.storage.read.watched.get(id)!.state).toBe('detected');
    expect((await post(env, 'priya', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'dismissed' })).statusCode).toBe(403);
    // a different requested state replaces the request instead of confirming it
    expect((await post(env, 'amit', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'published' })).statusCode).toBe(202);
    expect(() => env.storage.writeDb.prepare(`UPDATE watched_notifications SET state = 'dismissed', resolved_at = 'x', resolved_by = 'amit' WHERE id = ?`).run(id)).toThrow(/second admin/);
    const ok = await post(env, 'priya', `/v1/admin/watched-notifications/${id}/resolve`, { state: 'published' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'published', resolved_by: 'priya' });
    const last = env.storage.read.audit.all().at(-1)!;
    expect(last).toMatchObject({ action: 'watched_notification.published', details: { requested_by: 'amit', confirmed_by: 'priya' } });
  });

  it('SA-C3-03 (X5): a manual row with a CBIC notification key cannot be dismissed by one admin, so it cannot pre-empt the watcher', async () => {
    const m = await post(env, 'amit', '/v1/admin/watched-notifications', { notification: '08/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['6109'] });
    expect(m.json().notification_key).toBe('central_tax_rate:8/2026');
    expect(() => env.storage.writeDb.prepare(`UPDATE watched_notifications SET state = 'dismissed', resolved_at = 'x', resolved_by = 'amit' WHERE id = ?`).run(m.json().id)).toThrow(/second admin/);
    expect((await post(env, 'amit', `/v1/admin/watched-notifications/${m.json().id}/resolve`, { state: 'dismissed' })).statusCode).toBe(202);
    expect(env.storage.read.watched.get(m.json().id)!.state).toBe('detected');
    expect((await post(env, 'priya', `/v1/admin/watched-notifications/${m.json().id}/resolve`, { state: 'dismissed' })).statusCode).toBe(200);
  });

  it('manual watch entries without a notification key keep single-admin resolve', async () => {
    const m = await post(env, 'amit', '/v1/admin/watched-notifications', { notification: 'GST Council press note on textiles', url: SRC_URL, affected_prefixes: ['6109'] });
    expect(m.json().notification_key).toBeNull();
    expect((await post(env, 'amit', `/v1/admin/watched-notifications/${m.json().id}/resolve`, { state: 'dismissed' })).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ SA-C2-04 / 05

async function addActor(env: TestEnv, handle: string): Promise<string> {
  const g = await proposeAndApprove(env, { action: 'admin_grant', grant: { handle, new_actor: true }, rationale: `grant for ${handle} (new admin)` });
  expect(g.approve!.statusCode).toBe(200);
  const k = createApiKey(env.storage.tx, env.clock, SECRETS, {
    tenant: 'test', scopes: ['admin'], actor: handle, adminGrantId: g.proposal!.id, label: handle, rateLimitPerMin: 600, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 'test',
  });
  env.keys[handle] = k.key;
  env.keyIds[handle] = k.id;
  return g.proposal!.id;
}

describe('SA-C2-04: disabling an actor', () => {
  it('disable_actor proposal (two admins): actor disabled, keys 401, pending proposals withdrawn, audited, alert line', async () => {
    const env = await makeEnv();
    try {
      await addActor(env, 'ravi');
      const pend = await post(env, 'ravi', '/v1/admin/rate-proposals', { action: 'create', rule: ruleBody('7117', '2026-11-01'), rationale: 'ravi pending proposal' });
      expect(pend.statusCode).toBe(201);
      const d = await proposeAndApprove(env, { action: 'disable_actor', disable: { handle: 'ravi' }, rationale: 'ravi key leaked (incident 7)' });
      expect(d.create.statusCode).toBe(201);
      expect(d.create.json().action).toBe('disable_actor');
      expect(d.approve!.statusCode).toBe(200);
      expect(env.storage.read.actors.byHandle('ravi')!.disabled_at).not.toBeNull();
      expect(env.storage.read.proposals.get(pend.json().id)!.status).toBe('withdrawn');
      expect((await env.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals', headers: bearer(env.keys['ravi']!) })).statusCode).toBe(401);
      expect(env.storage.read.audit.all().some((e) => e.action === 'admin.disabled' && e.details['handle'] === 'ravi')).toBe(true);
      expect(env.logs.text()).toContain('admin.actor_disabled');
      // the state still cross-checks clean
      expect(crossCheckState(env.storage.read).ok).toBe(true);
      // disabling would leave fewer than two active admins → refused through the API
      const last = await post(env, 'amit', '/v1/admin/rate-proposals', { action: 'disable_actor', disable: { handle: 'priya' }, rationale: 'would leave one admin' });
      expect(last.statusCode).toBe(400);
    } finally {
      await env.close();
    }
  });

  it('a disabled proposer\'s pending proposal cannot be approved (service 409 and DB trigger)', async () => {
    const env = await makeEnv();
    try {
      await addActor(env, 'ravi');
      const pend = await post(env, 'ravi', '/v1/admin/rate-proposals', { action: 'create', rule: ruleBody('7117', '2026-11-01'), rationale: 'ravi pending proposal' });
      const p = pend.json() as { id: string; content_sha256: string };
      env.storage.write.actors.disable(env.storage.read.actors.byHandle('ravi')!.id, '2026-10-10T06:00:00Z'); // legacy disable without withdrawal
      const a = await post(env, 'priya', `/v1/admin/rate-proposals/${p.id}/approve`, { verified_against_source: true, expected_sha256: p.content_sha256 });
      expect(a.statusCode).toBe(409);
      expect(a.json().type).toMatch(/proposer-disabled/);
      const priya = env.storage.read.actors.byHandle('priya')!;
      expect(() =>
        env.storage.writeDb.prepare(`UPDATE rate_proposals SET status = 'approved', decided_by = 'priya', decided_by_actor_id = ?, decided_key_id = ?, decided_at = 'x' WHERE id = ?`)
          .run(priya.id, env.keyIds['priya']!, p.id),
      ).toThrow(/disabled actor/);
    } finally {
      await env.close();
    }
  });

  it('scripts/disable-actor.ts disables, withdraws pending proposals and audits in one transaction', async () => {
    const env = await makeEnv();
    try {
      await addActor(env, 'ravi');
      const pend = await post(env, 'ravi', '/v1/admin/rate-proposals', { action: 'create', rule: ruleBody('7117', '2026-11-01'), rationale: 'ravi pending proposal' });
      const errs: string[] = [];
      const origErr = console.error;
      const origLog = console.log;
      console.error = (m: string) => void errs.push(String(m));
      console.log = () => undefined;
      try {
        expect(disableActorCli(['--handle', 'Ravi', '--by', 'priya', '--note', 'incident 7: laptop stolen'], cliEnv(env))).toBe(0);
        expect(disableActorCli(['--handle', 'ravi', '--by', 'priya'], cliEnv(env))).toBe(1);
      } finally {
        console.error = origErr;
        console.log = origLog;
      }
      expect(errs.join('\n')).toContain('"event":"admin.actor_disabled"');
      expect(env.storage.read.actors.byHandle('ravi')!.disabled_at).not.toBeNull();
      expect(env.storage.read.proposals.get(pend.json().id)!.status).toBe('withdrawn');
      expect(env.storage.read.audit.all().filter((e) => e.action === 'admin.disabled')).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
});

describe('SA-C2-05: admin grants for existing actors and grant expiry', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  it('an extra key for an existing actor can only be requested by that actor (service and DB)', async () => {
    const r = await post(env, 'amit', '/v1/admin/rate-proposals', { action: 'admin_grant', grant: { handle: 'priya', new_actor: false }, rationale: 'one more key for priya' });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json().errors)).toMatch(/not_self/);
    const amit = env.storage.read.actors.byHandle('amit')!;
    expect(() =>
      env.storage.writeDb.prepare(`INSERT INTO rate_proposals(id, action, payload_json, rationale, content_sha256, proposed_by, proposed_by_actor_id, proposed_key_id, proposed_at)
        VALUES ('rp_g1','admin_grant', '{"handle":"priya","display_name":"","new_actor":false}', 'raw grant', ?, 'amit', ?, ?, 'x')`).run('e'.repeat(64), amit.id, env.keyIds['amit']!),
    ).toThrow(/requested by its holder/);
  });

  it('an approved grant expires 72 h after approval if not redeemed (service and DB trigger)', async () => {
    const g = await proposeAndApprove(env, { action: 'admin_grant', grant: { handle: 'priya', new_actor: false }, rationale: 'second key for priya (phone)' }, 'priya', 'amit');
    expect(g.approve!.statusCode).toBe(200);
    env.clock.advance(73 * 3_600_000);
    expect(() =>
      createApiKey(env.storage.tx, env.clock, SECRETS, {
        tenant: 'test', scopes: ['admin'], actor: 'priya', adminGrantId: g.proposal!.id, label: 'late', rateLimitPerMin: 600, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 'test',
      }),
    ).toThrow(KeyInputError);
    // the DB enforces the 72 h ceiling even when the service check is bypassed
    const priya = env.storage.read.actors.byHandle('priya')!;
    expect(() =>
      env.storage.writeDb.prepare(`INSERT INTO api_keys(id, prefix, key_hash, scopes, tenant, actor_id, admin_grant_id, created_at, expires_at)
        VALUES ('key_late','hsk_late0000', ?, '["admin"]', 'test', ?, ?, ?, ?)`).run('0'.repeat(64), priya.id, g.proposal!.id, '2026-10-13T08:00:00Z', '2026-11-13T08:00:00Z'),
    ).toThrow(/unexpired/);
  });

  it('create-key prints issued_by in the admin.key_issued line', () => {
    expect(readFileSync(join(ROOT, 'scripts', 'create-key.ts'), 'utf8')).toMatch(/event: 'admin\.key_issued'[^\n]*issued_by/);
  });
});

// ------------------------------------------------------------------------------------------------ SA-C2-06

describe('SA-C2-06: automatic restore detection', () => {
  it('a restored backup (database behind the high-water mark) rotates the feed epoch, alerts and fails readiness until acknowledged', async () => {
    const env = await makeEnv();
    try {
      const hwmFile = env.config.stateHwmFile!;
      expect(hwmFile).toBe(`${env.config.dbPath}.hwm.json`);
      // backup now, then more audited changes move the high-water mark forward
      const backup = join(env.dir, 'backup.db');
      env.storage.writeDb.exec(`VACUUM INTO '${backup}'`);
      const a = await proposeAndApprove(env, { action: 'create', rule: ruleBody('7117', '2026-10-11'), rationale: 'change after the backup' });
      expect(a.approve!.statusCode).toBe(200);
      const h = readHwm(hwmFile, AUDIT_KEY);
      expect(typeof h === 'object' && h.audit_head_id).toBe(env.storage.read.audit.head()!.id);

      // "restore": serve the backup with the same sidecar
      const restoredPath = join(env.dir, 'restored.db');
      copyFileSync(backup, restoredPath);
      const config = loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: restoredPath, HSN_STATE_HWM_FILE: hwmFile, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY });
      const w = openDb(restoredPath);
      migrate(w);
      const storage = createStorage(w, openReadDb(restoredPath));
      const epochBefore = storage.read.dataset.current()!.feed_epoch;
      const logs = new LogCapture();
      const app = await buildApp({ config, storage, clock: env.clock, shared: createSharedState(config, env.clock), surface: 'public', logStream: logs });
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
      expect(logs.text()).toContain('"event":"dataset.restore_detected"');
      expect(logs.text()).toContain('"alert":true');
      expect(storage.read.dataset.current()!.feed_epoch).not.toBe(epochBefore);
      expect(storage.read.audit.all().at(-1)!.action).toBe('dataset.restore_detected');
      // clients holding the old epoch must resync
      const feed = await app.inject({ method: 'GET', url: '/v1/rates/changes?since=0', headers: bearer(env.keys['read']!) });
      expect(feed.statusCode).toBe(200);
      expect(feed.json().feed_epoch).not.toBe(epochBefore);
      await app.close();
      storage.close();

      // acknowledge, restart → ready
      const origErr = console.error;
      const origLog = console.log;
      console.error = () => undefined;
      console.log = () => undefined;
      try {
        expect(ackRestoreCli(['--by', 'priya', '--note', 'restored the 06:00 backup on purpose'], { NODE_ENV: 'test', HSN_DB_PATH: restoredPath, HSN_STATE_HWM_FILE: hwmFile, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY })).toBe(0);
      } finally {
        console.error = origErr;
        console.log = origLog;
      }
      const w2 = openDb(restoredPath);
      const storage2 = createStorage(w2, openReadDb(restoredPath));
      const app2 = await buildApp({ config, storage: storage2, clock: env.clock, shared: createSharedState(config, env.clock), surface: 'public', logStream: new LogCapture() });
      expect((await app2.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      expect(storage2.read.audit.all().at(-1)!.action).toBe('dataset.restore_acknowledged');
      await app2.close();
      storage2.close();
    } finally {
      await env.close();
    }
  });

  it('an edited sidecar (MAC fails) fails readiness; an untouched one passes', async () => {
    const env = await makeEnv();
    try {
      expect((await readyz(env)).status).toBe(200);
      const f = env.config.stateHwmFile!;
      const h = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      writeFileSync(f, JSON.stringify({ ...h, audit_head_id: 1 }));
      const r = await readyz(env);
      expect(r.status).toBe(503);
      expect(r.logs).toContain('dataset.hwm_invalid');
      // a correctly MAC'd mark that is ahead of the database = restore
      writeHwm(f, AUDIT_KEY, { format: 'hsn-hwm/1', written_at: 'x', audit_head_id: 10_000, audit_head_hash: null, last_change_seq: 0, feed_epoch: null, dataset_version: null });
      expect((await readyz(env)).status).toBe(503);
    } finally {
      await env.close();
    }
  });

  it('production refuses HSN_STATE_HWM_FILE=off', () => {
    expect(() => loadConfig({ ...PROD, HSN_STATE_HWM_FILE: 'off' })).toThrow(/HSN_STATE_HWM_FILE/);
  });
});

// ------------------------------------------------------------------------------------------------ SA-C2-07, 09, 405

const PROD = { NODE_ENV: 'production', HSN_DB_PATH: 'x', HSN_KEY_PEPPER: 'p'.repeat(40), HSN_AUDIT_KEY: 'a'.repeat(40), HSN_LOG_KEY: 'l'.repeat(40), HSN_DIRECT_EXPOSURE: 'true', HSN_STATE_HWM_FILE: '/var/lib/hsn-state/hwm.json' };

describe('SA-C2-07: non-loopback admin listener needs an allow-list in production', () => {
  it('0.0.0.0 without HSN_ADMIN_IP_ALLOWLIST is refused; loopback or an allow-list is accepted', () => {
    expect(() => loadConfig({ ...PROD, HSN_ADMIN_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD, HSN_ADMIN_HOST: '0.0.0.0' })).toThrow(/HSN_ADMIN_HOST/);
    expect(loadConfig({ ...PROD, HSN_ADMIN_HOST: '0.0.0.0', HSN_ADMIN_IP_ALLOWLIST: '10.0.0.0/8' }).adminHost).toBe('0.0.0.0');
    for (const h of ['127.0.0.1', '::1', 'localhost', '127.0.0.2']) expect(loadConfig({ ...PROD, HSN_ADMIN_HOST: h }).adminHost).toBe(h);
    // not production: allowed (dev convenience)
    expect(loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: 'x', HSN_ADMIN_HOST: '0.0.0.0', HSN_ADMIN_PORT: '3999' }).adminHost).toBe('0.0.0.0');
  });
});

describe('SA-C2-09 (accepted, documented): LRU-bounded limiter state', () => {
  it('limiter memory stays bounded; an evicted bucket starts full (not a hard control for unauthenticated clients)', () => {
    const clock = { now: () => new Date('2026-10-10T06:00:00Z') };
    const l = new TokenBucketLimiter(clock as never, 1 / 6, 10);
    for (let i = 0; i < 10; i++) l.take('victim', 6);
    expect(l.take('victim', 6).allowed).toBe(false);
    for (let i = 0; i < 10; i++) l.take(`other${i}`, 6);
    expect(l.size).toBeLessThanOrEqual(10);
    expect(l.take('victim', 6).allowed).toBe(true);
  });
});

describe('405 method not allowed', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  it('known path, wrong method → 405 problem with Allow; unknown path → 404', async () => {
    const r = await env.app.inject({ method: 'DELETE', url: '/v1/hsn/6109', headers: bearer(env.keys['read']!) });
    expect(r.statusCode).toBe(405);
    expect(r.headers['allow']).toBe('GET, HEAD');
    expect(r.json()).toMatchObject({ status: 405, code: 'method_not_allowed' });
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    const p = await env.app.inject({ method: 'PUT', url: '/v1/tax/calculate', payload: {} });
    expect(p.statusCode).toBe(405);
    expect(p.headers['allow']).toContain('POST');
    const a = await env.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals/rp_x/approve', headers: bearer(env.keys['amit']!) });
    expect(a.statusCode).toBe(405);
    expect(a.headers['allow']).toBe('POST');
    expect((await env.app.inject({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(404);
    // admin paths are not known on the public listener
    expect((await env.app.inject({ method: 'GET', url: '/v1/admin/rate-proposals/rp_x/approve' })).statusCode).toBe(404);
  });
});
