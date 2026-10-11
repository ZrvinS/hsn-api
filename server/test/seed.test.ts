import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../src/db/migrate.js';
import { createStorage } from '../src/repositories/sqlite/index.js';
import { loadSeed, SeedError } from '../src/db/seed.js';
import { loadConfig } from '../src/config.js';
import { FIXTURE_DIR, AUDIT_KEY } from './helpers.js';

const cfg = loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: ':memory:' });
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  return createStorage(db);
};
const opts = (dir: string, allowVerified = true) => ({ dir, allowedRatesBp: cfg.allowedRatesBp, sourceHosts: cfg.sourceHosts, now: new Date('2026-10-10T06:00:00Z'), auditKey: AUDIT_KEY, allowVerified });

function withRules(rules: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  writeFileSync(join(dir, 'rate_rules.json'), JSON.stringify(rules));
  return dir;
}
const rule = { hsn_prefix: '7113', igst_rate_bp: 300, effective_from: '2017-07-01', notification_ref: '01/2017-IT(Rate), Schedule V', source_url: 'https://cbic-gst.gov.in/x' };

describe('seed loader', () => {
  it('loads the fixture and refuses a second seed', () => {
    const s = fresh();
    const out = loadSeed(s.tx, opts(FIXTURE_DIR));
    expect(out.hsn_codes).toBeGreaterThan(10);
    expect(out.version).toBe('2026.10.10-1');
    expect(() => loadSeed(s.tx, opts(FIXTURE_DIR))).toThrow(SeedError);
    expect(s.read.audit.all().map((a) => a.action)).toEqual(['dataset.seeded']);
  });

  it('rejects a non-allowed slab (1700 bp) and writes nothing', () => {
    const s = fresh();
    expect(() => loadSeed(s.tx, opts(withRules([{ ...rule, igst_rate_bp: 1700 }])))).toThrow(/1700/);
    expect(s.read.dataset.current()).toBeNull();
  });

  it('rejects verified_by on an unverified row, unknown fields, bad hosts, overlaps', () => {
    expect(() => loadSeed(fresh().tx, opts(withRules([{ ...rule, verified_by: 'amit' }])))).toThrow(/null while unverified/);
    expect(() => loadSeed(fresh().tx, opts(withRules([{ ...rule, rate: 3 }])))).toThrow(/Unrecognized key/);
    expect(() => loadSeed(fresh().tx, opts(withRules([{ ...rule, source_url: 'https://example.com/x' }])))).toThrow(/Host must be/);
    expect(() => loadSeed(fresh().tx, opts(withRules([rule, { ...rule, igst_rate_bp: 500, effective_from: '2020-01-01' }])))).toThrow(/overlap/);
  });

  it('derived rule ids are deterministic and match the API pattern', () => {
    const a = fresh();
    const b = fresh();
    loadSeed(a.tx, opts(FIXTURE_DIR));
    loadSeed(b.tx, opts(FIXTURE_DIR));
    const ids = (s: ReturnType<typeof fresh>) => (s.writeDb.prepare('SELECT rule_id FROM rate_rules ORDER BY rule_id').all() as { rule_id: string }[]).map((r) => r.rule_id);
    expect(ids(a)).toEqual(ids(b));
    for (const id of ids(a)) expect(id).toMatch(/^rr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('SA-C-17: verified seed rows are refused unless allowVerified (fixtures only)', () => {
    expect(() => loadSeed(fresh().tx, opts(FIXTURE_DIR, false))).toThrow(/verified/);
    const s = fresh();
    loadSeed(s.tx, opts(FIXTURE_DIR, true));
    const seeded = s.read.audit.all().find((a) => a.action === 'dataset.seeded')!;
    expect(JSON.stringify(seeded.details)).toContain('verified_rules');
    expect(JSON.stringify(seeded.details)).toContain('seed_batch_id');
    // every rule carries the seed batch id (ruling 19)
    const n = s.writeDb.prepare('SELECT count(*) AS n FROM rate_rules WHERE seed_batch_id IS NULL').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('ruling 6 / SA-C-14: 5-digit SAC codes load and rule/category prefixes must exist in hsn_codes', () => {
    const s = fresh();
    loadSeed(s.tx, opts(FIXTURE_DIR));
    expect(s.read.hsn.get('99972')?.level).toBe(5);
    expect(s.read.hsn.get('999721')?.parent).toBe('99972');
    expect(() => loadSeed(fresh().tx, opts(withRules([{ ...rule, hsn_prefix: '7199' }])))).toThrow(/7199/);
  });

  it('ruling 12: a rule with no source fields still loads (seed path nullable, ruling 12)', () => {
    const s = fresh();
    loadSeed(s.tx, opts(withRules([rule]), false));
    const r = s.writeDb.prepare("SELECT source_pdf_sha256, schedule_serial, verification_status FROM rate_rules WHERE hsn_prefix = '7113'").get() as Record<string, unknown>;
    expect(r).toEqual({ source_pdf_sha256: null, schedule_serial: null, verification_status: 'unverified' });
  });

  const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
  it.skipIf(!existsSync(join(real, 'hsn_codes.json')))('the shipped data/seed loads cleanly', () => {
    const s = fresh();
    const out = loadSeed(s.tx, opts(real, false));
    expect(out.hsn_codes).toBeGreaterThan(0);
    expect(out.rate_rules).toBeGreaterThan(0);
  });
});

void rmSync;
