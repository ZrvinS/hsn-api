/**
 * Round 10 (validator round 4 N3): the canonical notification citation
 * `<n>/<yyyy>-<CT|IT|UTT|Cess>(Rate)[, Schedule <roman>]` is enforced after normalisation on every proposal
 * input, the seed loader and import-dataset; the verify feed summary names the post-approval citation;
 * meta sources[] carry rule_count / verified_count.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normaliseNotificationRef, notificationRefProblem } from '../src/services/proposals.js';
import { prepareSeed, SeedError } from '../src/db/seed.js';
import { bootstrapAdmins } from '../src/services/apiKeys.js';
import { importDatasetCli } from '../scripts/import-dataset.js';
import { AUDIT_KEY, LOG_KEY, PDF_SHA, PEPPER, SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
const NONE = { kind: 'none', text: null, min_unit_price: null, max_unit_price: null };
const FREE_TEXT = ['lol not a citation', '9/2025 schedule 4', 'Notification No. 5/2026-CT(Rate)', '9/2025-CT(Rate), Schedule 4', '9/2025-GST(Rate)', '0/2025-CT(Rate)', '9/2025-CT(Rate), Sl. No. 1'];

type Rule = Record<string, unknown>;
function seedCopy(edit: (items: Rule[]) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'hsn-seed-'));
  cpSync(SEED, dir, { recursive: true });
  const p = join(dir, 'rate_rules.json');
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Rule[] | { items: Rule[] };
  edit(Array.isArray(raw) ? raw : raw.items);
  writeFileSync(p, JSON.stringify(raw));
  return dir;
}

describe('canonical notification citation (unit)', () => {
  it('accepts the canonical form after normalisation, refuses free text', () => {
    for (const ok of ['9/2025-CT(Rate)', '1/2017-IT(Rate), Schedule V', '3/2026-UTT(Rate)', '1/2017-Cess(Rate)', '9/2025-CT(Rate), Schedule VII']) {
      expect(notificationRefProblem(ok), ok).toBeNull();
    }
    expect(normaliseNotificationRef('01/2026-CT(Rate)')).toBe('1/2026-CT(Rate)');
    expect(normaliseNotificationRef('01/2017-Integrated Tax (Rate), Schedule V')).toBe('1/2017-IT(Rate), Schedule V');
    expect(normaliseNotificationRef('2/2017-Compensation Cess (Rate)')).toBe('2/2017-Cess(Rate)');
    for (const bad of FREE_TEXT) expect(notificationRefProblem(normaliseNotificationRef(bad)), bad).not.toBeNull();
  });
});

describe('proposal entry points (shipped seed)', () => {
  let env: TestEnv;
  let def3004: string;
  let nil3004: string;
  beforeAll(async () => {
    env = await makeEnv({ seedDir: SEED });
    const q = (code: string) => (env.storage.readDb.prepare(`SELECT rule_id FROM rate_rules WHERE hsn_prefix = '3004' AND effective_to IS NULL AND ${code}`).get() as { rule_id: string }).rule_id;
    def3004 = q(`condition_kind = 'none'`);
    nil3004 = q(`condition_code = 'nil_rate_list'`);
  });
  afterAll(async () => env.close());

  const propose = (payload: object, who = 'amit') =>
    env.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys[who]!), payload });
  const src = (notification: string) => ({ notification, url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' });
  const pointers = (r: { json: () => { errors?: { pointer: string }[] } }) => (r.json().errors ?? []).map((e) => e.pointer);

  it('create / supersede / correct refuse free text with /rule/source/notification', async () => {
    for (const n of FREE_TEXT) {
      const rule = { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2027-01-01', source: src(n) };
      const bodies = [
        { action: 'create', rule, rationale: 'Free-text citation check.' },
        { action: 'supersede', supersedes_rule_id: def3004, rule: { ...rule, hsn_prefix: '3004', effective_from: '2027-01-01' }, rationale: 'Free-text citation check.' },
        { action: 'correct', supersedes_rule_id: def3004, rule: { ...rule, hsn_prefix: '3004', igst_rate_bp: 500, effective_from: '2025-09-22' }, rationale: 'Free-text citation check.', retroactive_reason: 'Correcting the seed citation text.' },
      ];
      for (const b of bodies) {
        const r = await propose(b);
        expect(r.statusCode, `${b.action}: ${n}`).toBe(400);
        expect(r.json().type).toBe('https://hsn-api.example/problems/validation-failed');
        expect(pointers(r), `${b.action}: ${n}`).toContain('/rule/source/notification');
      }
    }
  });

  it('verify refuses free text with /source/notification', async () => {
    for (const n of FREE_TEXT) {
      const r = await propose({ action: 'verify', supersedes_rule_id: nil3004, rationale: 'Free-text citation check.', source: { pdf_sha256: PDF_SHA, schedule_serial: '1', url: SRC_URL, notification: n } });
      expect(r.statusCode, n).toBe(400);
      expect(pointers(r), n).toContain('/source/notification');
    }
  });

  it('"01/2026-CT(Rate), Schedule I" is accepted and stored as "1/2026-CT(Rate), Schedule I"', async () => {
    const r = await propose({ action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2027-01-01', source: src('01/2026-CT(Rate), Schedule I') }, rationale: 'Padded citation check.' });
    expect(r.statusCode).toBe(201);
    expect(r.json().rule.source.notification).toBe('1/2026-CT(Rate), Schedule I');
  });

  it('a verify that changes the citation puts the new one in the rule_verified feed summary', async () => {
    const before = env.storage.read.rules.get(nil3004)!;
    expect(before.notification_ref).toBe('10/2025-CT(Rate)');
    const since = (await env.app.inject({ method: 'GET', url: '/v1/meta/dataset', headers: bearer(env.keys.read!) })).json().last_change_seq as number;
    const c = await propose({ action: 'verify', supersedes_rule_id: nil3004, rationale: 'Checked the nil list against the gazette.', source: { pdf_sha256: PDF_SHA, schedule_serial: '1', url: SRC_URL, notification: '011/2025-CT(Rate)' } });
    expect(c.statusCode).toBe(201);
    const a = await env.admin.inject({
      method: 'POST', url: `/v1/admin/rate-proposals/${c.json().id}/approve`, headers: bearer(env.keys.priya!),
      payload: { verified_against_source: true, expected_sha256: c.json().content_sha256 },
    });
    expect(a.statusCode).toBe(200);
    const feed = (await env.app.inject({ method: 'GET', url: `/v1/rates/changes?since=${since}`, headers: bearer(env.keys.read!) })).json();
    const ch = (feed.changes as { change_type: string; rule_id: string; summary: string }[]).find((x) => x.change_type === 'rule_verified' && x.rule_id === nil3004)!;
    expect(ch.summary).toContain('11/2025-CT(Rate)');
    expect(ch.summary).not.toContain('10/2025');
  });

  it('meta sources[] carry rule_count and verified_count', async () => {
    const b = (await env.app.inject({ method: 'GET', url: '/v1/meta/dataset', headers: bearer(env.keys.read!) })).json();
    const sources = b.sources as { notification: string; url: string; rule_count: number; verified_count: number }[];
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.rule_count).toBeGreaterThanOrEqual(1);
      expect(s.verified_count).toBeGreaterThanOrEqual(0);
      expect(s.verified_count).toBeLessThanOrEqual(s.rule_count);
    }
    expect(sources.find((s) => s.notification === '11/2025-CT(Rate)' && s.url === SRC_URL)).toMatchObject({ verified_count: 1 });
    expect(sources.reduce((n, s) => n + s.rule_count, 0)).toBe(b.coverage?.active_rules ?? sources.reduce((n, s) => n + s.rule_count, 0));
  });
});

describe('seed loader and import-dataset', () => {
  const opts = { allowedRatesBp: [0, 25, 150, 300, 500, 1200, 1800, 2800, 4000], sourceHosts: ['cbic-gst.gov.in', 'taxinformation.cbic.gov.in', 'www.cbic.gov.in', 'cbic.gov.in'], now: new Date('2026-10-03T09:15:00Z'), auditKey: AUDIT_KEY, allowVerified: false };

  it('the shipped seed conforms', () => {
    expect(() => prepareSeed({ dir: SEED, ...opts })).not.toThrow();
  });

  it('a free-text notification_ref is refused by the loader; a padded one is normalised', () => {
    const bad = seedCopy((items) => { items[0]!['notification_ref'] = 'GST Council press note on textiles'; });
    const padded = seedCopy((items) => { items[0]!['notification_ref'] = '01/2017-Integrated Tax (Rate), Schedule V'; });
    try {
      expect(() => prepareSeed({ dir: bad, ...opts })).toThrow(SeedError);
      expect(() => prepareSeed({ dir: bad, ...opts })).toThrow(/notification_ref/);
      const ok = prepareSeed({ dir: padded, ...opts });
      expect(JSON.stringify(ok)).toContain('1/2017-IT(Rate), Schedule V');
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(padded, { recursive: true, force: true });
    }
  });

  it('import-dataset propose refuses a seed with a free-text citation', async () => {
    const env = await makeEnv({ seed: false });
    const dir = seedCopy((items) => { items[1]!['notification_ref'] = 'lol not a citation'; });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      const boot = bootstrapAdmins(env.storage.tx, env.clock, { pepper: PEPPER, auditKey: AUDIT_KEY }, [{ handle: 'amit', display_name: 'Amit' }, { handle: 'priya', display_name: 'Priya' }], { tenant: 'prod', by: 'ops' });
      const r = importDatasetCli(['propose', '--dir', dir, '--rationale', 'Initial production load from data/seed'],
        { NODE_ENV: 'test', HSN_DB_PATH: env.config.dbPath, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY, HSN_ADMIN_KEY: boot[0]!.key });
      expect(r.code).toBe(2); // seed invalid
      expect(errors.join('\n')).toMatch(/notification_ref/);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      await env.close();
    }
  });
});
