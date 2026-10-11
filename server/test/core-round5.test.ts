/**
 * Round 5: citation_note on rate rules (seed caveat, cleared by verify) and the production data load
 * path (scripts/import-dataset.ts, R11).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedRuleId } from '../src/db/seed.js';
import { bootstrapAdmins } from '../src/services/apiKeys.js';
import { crossCheckState } from '../src/services/integrity.js';
import { buildApp, createSharedState } from '../src/app.js';
import { importDatasetCli } from '../scripts/import-dataset.js';
import { AUDIT_KEY, FIXTURE_DIR, LOG_KEY, LogCapture, PDF_SHA, PEPPER, SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

type Rule = Record<string, unknown>;
const NOTE = 'Gazette not read; schedule S.No. not verified. Secondary source only.';

/** A copy of the fixture seed with every rule unverified (as data/seed must be) and a citation_note on 3004 @ 5%. */
function unverifiedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hsn-seed-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const p = join(dir, 'rate_rules.json');
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Rule[] | { items: Rule[] };
  const items = Array.isArray(raw) ? raw : raw.items;
  for (const r of items) {
    delete r['verification_status'];
    delete r['verified_by'];
    delete r['last_verified_at'];
    if (r['hsn_prefix'] === '3004' && r['igst_rate_bp'] === 500) r['citation_note'] = NOTE;
  }
  writeFileSync(p, JSON.stringify(items));
  return dir;
}

const RULE_3004 = seedRuleId({ hsn_prefix: '3004', effective_from: '2025-09-22', condition_kind: 'none', min_unit_price_paise: null, max_unit_price_paise: null, condition_text: null });

describe('citation_note (seed caveat)', () => {
  let env: TestEnv;
  let seedDir: string;
  beforeAll(async () => {
    seedDir = unverifiedFixture();
    env = await makeEnv({ seedDir });
  });
  afterAll(async () => {
    await env.close();
    rmSync(seedDir, { recursive: true, force: true });
  });

  it('is loaded from the seed and served in rule DTOs', async () => {
    expect(env.storage.read.rules.get(RULE_3004)!.citation_note).toBe(NOTE);
    const r = await env.app.inject({ method: 'GET', url: '/v1/hsn/3004', headers: bearer(env.keys.read!) });
    expect(r.statusCode).toBe(200);
    const rules = r.json().rate.rules as { rule_id: string; citation_note: string | null }[];
    expect(rules.find((x) => x.rule_id === RULE_3004)!.citation_note).toBe(NOTE);
    expect(rules.filter((x) => x.rule_id !== RULE_3004).every((x) => x.citation_note === null)).toBe(true);
  });

  it('cannot be edited directly, only cleared by a verify approval', async () => {
    expect(() => env.storage.writeDb.prepare(`UPDATE rate_rules SET citation_note = 'edited' WHERE rule_id = ?`).run(RULE_3004)).toThrow(/citation_note/);
    expect(() => env.storage.writeDb.prepare(`UPDATE rate_rules SET citation_note = NULL WHERE rule_id = ?`).run(RULE_3004)).toThrow(/citation_note/);
    const c = await env.admin.inject({
      method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
      payload: { action: 'verify', supersedes_rule_id: RULE_3004, source: { pdf_sha256: PDF_SHA, schedule_serial: 'I-63', url: SRC_URL }, rationale: 'Checked 3004 against the gazette PDF.' },
    });
    expect(c.statusCode).toBe(201);
    const a = await env.admin.inject({
      method: 'POST', url: `/v1/admin/rate-proposals/${c.json().id}/approve`, headers: bearer(env.keys.priya!),
      payload: { verified_against_source: true, expected_sha256: c.json().content_sha256 },
    });
    expect(a.statusCode).toBe(200);
    const row = env.storage.read.rules.get(RULE_3004)!;
    expect(row.verification_status).toBe('verified');
    expect(row.citation_note).toBeNull();
    const r = await env.app.inject({ method: 'GET', url: '/v1/hsn/3004', headers: bearer(env.keys.read!) });
    const rules = r.json().rate.rules as { rule_id: string; citation_note: string | null }[];
    expect(rules.find((x) => x.rule_id === RULE_3004)!.citation_note).toBeNull();
    expect(crossCheckState(env.storage.read)).toMatchObject({ ok: true, problems: [] });
  });
});

describe('R11: scripts/import-dataset.ts (maker–checker production load)', () => {
  let env: TestEnv;
  let seedDir: string;
  const keys: Record<string, string> = {};
  const cli = (args: string[], who: string) =>
    importDatasetCli(args, { NODE_ENV: 'test', HSN_DB_PATH: env.config.dbPath, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY, HSN_ADMIN_KEY: keys[who] });
  beforeAll(async () => {
    seedDir = unverifiedFixture();
    env = await makeEnv({ seed: false });
    const boot = bootstrapAdmins(env.storage.tx, env.clock, { pepper: PEPPER, auditKey: AUDIT_KEY }, [{ handle: 'amit', display_name: 'Amit' }, { handle: 'priya', display_name: 'Priya' }], { tenant: 'prod', by: 'ops' });
    keys['amit'] = boot[0]!.key;
    keys['priya'] = boot[1]!.key;
    keys['read'] = env.keys.read!;
  });
  afterAll(async () => {
    await env.close();
    rmSync(seedDir, { recursive: true, force: true });
  });

  it('propose → refused for the same actor and for changed files → approved by a second admin; rules unverified; integrity ok', async () => {
    expect(cli(['propose', '--dir', seedDir, '--rationale', 'Initial load'], 'read').code).toBe(1); // not an admin key
    expect(cli(['propose', '--dir', seedDir, '--rationale', 'short'], 'amit').code).toBe(1);
    const p = cli(['propose', '--dir', seedDir, '--rationale', 'Initial production load from data/seed'], 'amit');
    expect(p.code).toBe(0);
    const id = p.proposal_id!;
    expect(cli(['propose', '--dir', seedDir, '--rationale', 'Initial production load again'], 'priya').code).toBe(1); // one pending import at a time

    // listed through the API as dataset_import; the API cannot approve it
    const got = await env.admin.inject({ method: 'GET', url: `/v1/admin/rate-proposals/${id}`, headers: bearer(keys.priya!) });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ action: 'dataset_import', status: 'pending' });
    const apiApprove = await env.admin.inject({
      method: 'POST', url: `/v1/admin/rate-proposals/${id}/approve`, headers: bearer(keys.priya!),
      payload: { verified_against_source: true, expected_sha256: p.content_sha256 },
    });
    expect(apiApprove.statusCode).toBe(409);
    expect(apiApprove.body).toMatch(/import-dataset/);

    const approve = ['approve', '--proposal', id, '--expected-sha256', p.content_sha256!, '--dir', seedDir];
    expect(cli(approve, 'amit').code).toBe(1); // maker ≠ checker
    expect(cli(['approve', '--proposal', id, '--expected-sha256', 'b'.repeat(64), '--dir', seedDir], 'priya').code).toBe(1);
    const syn = join(seedDir, 'synonyms.json');
    const before = readFileSync(syn, 'utf8');
    writeFileSync(syn, `${before}\n `); // still valid JSON, different sha256
    expect(cli(approve, 'priya').code).toBe(1); // file hash changed since proposing
    writeFileSync(syn, before);
    expect(env.storage.read.dataset.current()).toBeNull();

    const ok = cli(approve, 'priya');
    expect(ok.code).toBe(0);
    const cur = env.storage.read.dataset.current()!;
    expect(cur.current_version).toBe(ok.version);
    const prop = env.storage.read.proposals.get(id)!;
    expect(prop).toMatchObject({ status: 'approved', decided_by: 'priya', resulting_version: ok.version, resulting_rule_id: null });
    const rules = env.storage.readDb.prepare(`SELECT verification_status, seed_batch_id, citation_note FROM rate_rules`).all() as { verification_status: string; seed_batch_id: string | null; citation_note: string | null }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.verification_status === 'unverified' && r.seed_batch_id !== null)).toBe(true);
    expect(rules.filter((r) => r.citation_note === NOTE)).toHaveLength(1);
    const audit = env.storage.read.audit.list(0, 1000).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['rate_proposal.created', 'dataset.seeded', 'rate_proposal.approved']));
    expect(crossCheckState(env.storage.read)).toMatchObject({ ok: true, problems: [] });

    // a second import into a non-empty database is refused
    expect(cli(['propose', '--dir', seedDir, '--rationale', 'Second load attempt'], 'amit').code).toBe(1);

    const app = await buildApp({ config: env.config, storage: env.storage, clock: env.clock, shared: createSharedState(env.config, env.clock), surface: 'public', logStream: new LogCapture() });
    const rz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(rz.statusCode).toBe(200);
    const h = await app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(keys.read!) });
    expect(h.statusCode).toBe(200);
    expect(h.json().rate.warnings).toContain('rate_unverified');
    await app.close();
  });
});
