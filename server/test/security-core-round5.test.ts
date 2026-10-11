/**
 * Regression tests for reviews/security-code-core-round5.md (SA-C5-01 … SA-C5-06).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRateRuleRepo } from '../src/repositories/sqlite/rateRules.js';
import { Stmts } from '../src/repositories/sqlite/base.js';
import { documentUrlProblem, isDocumentUrl, sourceUrlProblem } from '../src/services/proposals.js';
import { loadKnownGaps, MAX_KNOWN_GAPS_BYTES } from '../src/services/knownGaps.js';
import { loadConfig } from '../src/config.js';
import { MAX_ERRORS_BYTES } from '../src/lib/schemaGuard.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { AUDIT_KEY, PDF_SHA, PEPPER, SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

const LINE = { hsn: '7113', taxable_value: 100, supply_type: 'intra' };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** the fastest of several runs: robust against other test files competing for the CPU */
const fastest = (xs: number[]) => Math.min(...xs);
/**
 * Body parsing (secure JSON parse: JSON.parse plus the prototype-poisoning scan, ~2× JSON.parse) is paid by
 * every request of that size before and after the fix; the budget is 10 ms of work on top of it.
 * Before the fix the 85k-item body took ~430 ms (audit r5b).
 */
function budget(payload: string): number {
  const t: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    JSON.parse(payload);
    t.push(performance.now() - t0);
  }
  return 10 + 2 * fastest(t);
}

describe('SA-C5-01: oversized bodies are refused before Ajv (allErrors) and pay for their size', () => {
  let env: TestEnv;
  let tight: TestEnv; // the read key's 600 tokens / min
  let big = ''; // a key with a generous limit, so requests reach validation
  beforeAll(async () => {
    env = await makeEnv();
    tight = await makeEnv();
    big = createApiKey(env.storage.tx, env.clock, { pepper: PEPPER, auditKey: AUDIT_KEY }, {
      tenant: 'test', scopes: ['read'], actor: null, label: 'big', rateLimitPerMin: 1_000_000, dailyQuota: null, llmOptOut: false, expiresAt: null, createdBy: 'test',
    }).key;
  });
  afterAll(async () => {
    await env.close();
    await tight.close();
  });
  const post = (e: TestEnv, payload: string) =>
    e.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: { ...bearer(e === env ? big : e.keys.read!), 'content-type': 'application/json' }, payload });
  const timed = async (e: TestEnv, payload: string) => {
    const t: number[] = [];
    let last: Awaited<ReturnType<typeof post>> | null = null;
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      last = await post(e, payload);
      t.push(performance.now() - t0);
    }
    return { r: last!, ms: fastest(t) };
  };

  const empty85k = JSON.stringify({ lines: Array.from({ length: 85_000 }, () => ({})) });
  const numbers85k = JSON.stringify({ lines: Array.from({ length: 85_000 }, () => 1) });

  it('85k empty items: one maxItems error, charged 1 + floor(n/50) tokens, under 10 ms beyond body parsing', async () => {
    expect(Buffer.byteLength(empty85k)).toBeLessThan(256 * 1024);
    const { r, ms } = await timed(env, empty85k);
    const limit = budget(empty85k);
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toEqual([{ pointer: '/lines', code: 'maxItems', message: 'Has 85000 items; at most 500 are allowed' }]);
    expect(r.headers['ratelimit-cost']).toBe(String(1 + Math.floor(85_000 / 50)));
    expect(ms).toBeLessThan(limit);
    expect(ms).toBeLessThan(50);
  });

  it('85k bare numbers: same', async () => {
    const { r, ms } = await timed(env, numbers85k);
    const limit = budget(numbers85k);
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toHaveLength(1);
    expect(r.headers['ratelimit-cost']).toBe('1701');
    expect(ms).toBeLessThan(limit);
    expect(ms).toBeLessThan(50);
  });

  it('with the default 600-token limit the 85k body is rate-limited (1701 tokens) without validation', async () => {
    const r = await post(tight, empty85k);
    expect(r.statusCode).toBe(429);
    expect(r.json().detail).toMatch(/costs 1701 tokens/);
  });

  it('a flood of unknown keys is refused with 50 errors and the total in detail', async () => {
    const body: Record<string, unknown> = { lines: [LINE] };
    for (let i = 0; i < 20_000; i++) body[`k${i}`] = 1;
    const payload = JSON.stringify(body);
    const { r, ms } = await timed(env, payload);
    const limit = budget(payload);
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toHaveLength(50);
    expect(r.json().detail).toBe('Request validation failed: 20000 problems; the first 50 are in errors[].');
    expect(ms).toBeLessThan(limit);
    expect(ms).toBeLessThan(50);
  });

  it('501 lines → maxItems; 500 valid lines are still served and charged 11 tokens; a few unknown keys still go to Ajv', async () => {
    const over = await post(env, JSON.stringify({ lines: Array.from({ length: 501 }, () => LINE) }));
    expect(over.statusCode).toBe(400);
    expect(over.json().errors[0]).toMatchObject({ pointer: '/lines', code: 'maxItems' });
    const ok = await post(env, JSON.stringify({ lines: Array.from({ length: 500 }, () => LINE) }));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['ratelimit-cost']).toBe('11');
    const few = await post(env, JSON.stringify({ lines: [{ ...LINE, extra: 1 }], also: 2 }));
    expect(few.statusCode).toBe(400);
    expect(few.json().errors.map((e: { pointer: string }) => e.pointer).sort()).toEqual(['/also', '/lines/0/extra']);
  });
});

describe('SA-C5-02: codes_without_rules is linear and cached per dataset version and day', () => {
  // the previous correlated SQL, kept here as the reference result
  const REFERENCE = `SELECT COUNT(*) AS n FROM hsn_codes h WHERE h.level >= 4 AND NOT EXISTS (
      SELECT 1 FROM rate_rules r WHERE r.status = 'active' AND r.effective_from <= ? AND (r.effective_to IS NULL OR r.effective_to >= ?)
        AND (substr(h.code, 1, length(r.hsn_prefix)) = r.hsn_prefix OR substr(r.hsn_prefix, 1, length(h.code)) = h.code))`;

  function synthetic(codes: number, rules: number, seed = 7): DatabaseSync {
    let x = seed;
    const rnd = (n: number) => ((x = (x * 1103515245 + 12345) % 2 ** 31), x % n);
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE hsn_codes (code TEXT PRIMARY KEY, level INTEGER NOT NULL);
             CREATE TABLE rate_rules (hsn_prefix TEXT, status TEXT, effective_from TEXT, effective_to TEXT);`);
    const ic = db.prepare('INSERT OR IGNORE INTO hsn_codes VALUES (?, ?)');
    const ir = db.prepare('INSERT INTO rate_rules VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < codes; i++) {
      const c = String(rnd(100_000_000)).padStart(8, '0');
      const len = [4, 6, 8][rnd(3)]!;
      ic.run(c.slice(0, len), len);
    }
    for (let i = 0; i < rules; i++) {
      const c = String(rnd(100_000_000)).padStart(8, '0');
      ir.run(c.slice(0, [2, 4, 6, 8][rnd(4)]!), rnd(10) === 0 ? 'voided' : 'active', '2020-01-01', rnd(5) === 0 ? '2021-01-01' : null);
    }
    db.exec('COMMIT');
    return db;
  }

  it('matches the previous SQL on random data', () => {
    for (const s of [1, 2, 3]) {
      const db = synthetic(3000, 400, s);
      const ref = (db.prepare(REFERENCE).get('2026-10-10', '2026-10-10') as { n: number }).n;
      expect(new SqliteRateRuleRepo(new Stmts(db)).codesWithoutRules('2026-10-10')).toBe(ref);
      db.close();
    }
  });

  it('20k codes / 3k rules computes in under 50 ms', () => {
    const db = synthetic(20_000, 3_000);
    const repo = new SqliteRateRuleRepo(new Stmts(db));
    repo.codesWithoutRules('2026-10-10');
    const t: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      repo.codesWithoutRules('2026-10-10');
      t.push(performance.now() - t0);
    }
    expect(median(t)).toBeLessThan(50);
    db.close();
  });

  it('meta computes it once per dataset version and day (304s and repeats reuse it)', async () => {
    const env = await makeEnv();
    try {
      const spy = vi.spyOn(env.storage.read.rules, 'codesWithoutRules');
      const get = (h: Record<string, string> = {}) => env.app.inject({ method: 'GET', url: '/v1/meta/dataset', headers: { ...bearer(env.keys.read!), ...h } });
      const a = await get();
      expect(a.statusCode).toBe(200);
      const b = await get({ 'if-none-match': String(a.headers.etag) });
      expect(b.statusCode).toBe(304);
      await get();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      await env.close();
    }
  });
});

describe('SA-C5-03: document URLs are plain /view-pdf/<id> or *.pdf paths; index pages compared normalised', () => {
  const base = 'https://cbic-gst.gov.in';
  it('refuses decorated or non-canonical paths', () => {
    for (const u of [
      `${base}/central-tax-rate.html;.pdf`,
      `${base}/central-tax-rate.html/view-pdf/x`,
      `${base}/%2E%2E/view-pdf/1`,
      `${base}/a/../view-pdf/1`,
      `${base}/x.pdf?redirect=https://evil.example`,
      `${base}/x.pdf#page=2`,
      `${base}//x.pdf`,
      `${base}/a%2fb.pdf`,
      `${base}/view-pdf/1;x`,
      `${base}/x.pdf/`,
    ]) {
      expect(documentUrlProblem(u, []), u).not.toBeNull();
    }
    expect(documentUrlProblem(SRC_URL, [])).toBeNull();
    expect(documentUrlProblem(`${base}/pdf/notfctn-10-2025.pdf`, [])).toBeNull();
  });

  it('a configured .pdf index page is matched regardless of case, slashes, query or fragment', () => {
    const idx = [`${base}/pdf/listing.pdf`];
    for (const u of [`${base}/pdf/listing.pdf`, `${base}/pdf/LISTING.PDF`, `https://CBIC-GST.gov.in/pdf/listing.pdf`]) {
      expect(isDocumentUrl(u, idx), u).toBe(false);
    }
    expect(isDocumentUrl(`${base}/pdf/other.pdf`, idx)).toBe(true);
  });

  it('proposal citations may not carry a query string or fragment (none is stored)', () => {
    const hosts = ['cbic-gst.gov.in'];
    expect(sourceUrlProblem(`${base}/x.pdf?a=1`, hosts, true)).toMatch(/query/);
    expect(sourceUrlProblem(`${base}/x.pdf#p`, hosts, true)).toMatch(/query/);
    expect(sourceUrlProblem(`${base}/x.pdf`, hosts, true)).toBeNull();
  });

  it('a verify with a decorated URL is refused through the API', async () => {
    const env = await makeEnv({ seedDir: new URL('../data/seed', import.meta.url).pathname });
    try {
      const nil = (env.storage.readDb.prepare(`SELECT rule_id FROM rate_rules WHERE condition_code = 'nil_rate_list'`).get() as { rule_id: string }).rule_id;
      const r = await env.admin.inject({
        method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys.amit!),
        payload: { action: 'verify', supersedes_rule_id: nil, rationale: 'Decorated URL check.', source: { pdf_sha256: PDF_SHA, schedule_serial: '1', url: 'https://cbic-gst.gov.in/central-tax-rate.html;.pdf' } },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().errors.map((e: { pointer: string }) => e.pointer)).toContain('/source/url');
    } finally {
      await env.close();
    }
  });
});

describe('SA-C5-04: HSN_KNOWN_GAPS_FILE', () => {
  const base = { NODE_ENV: 'production', HSN_DB_PATH: '/var/lib/hsn/hsn.db', HSN_KEY_PEPPER: 'p'.repeat(40), HSN_AUDIT_KEY: 'a'.repeat(40), HSN_LOG_KEY: 'l'.repeat(40), HSN_STATE_HWM_FILE: '/var/backup/hsn.hwm.json' };
  it('must be absolute in production', () => {
    expect(() => loadConfig({ ...base, HSN_KNOWN_GAPS_FILE: 'gaps.json' })).toThrow(/HSN_KNOWN_GAPS_FILE/);
  });

  it('explicit path: missing, not a file, too large, or not JSON → throws without echoing contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsn-gaps-'));
    try {
      expect(() => loadKnownGaps(join(dir, 'nope.json'))).toThrow(/not found/);
      expect(() => loadKnownGaps(dir)).toThrow(/not a regular file/);
      const big = join(dir, 'big.json');
      writeFileSync(big, ' '.repeat(MAX_KNOWN_GAPS_BYTES + 1));
      expect(() => loadKnownGaps(big)).toThrow(/exceeds/);
      const secret = join(dir, 'secret.json');
      writeFileSync(secret, 'SECRET_TOKEN=abc123');
      let msg = '';
      try {
        loadKnownGaps(secret);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/not valid JSON/);
      expect(msg).not.toContain('SECRET');
      expect(loadKnownGaps(undefined).length).toBeGreaterThan(0); // shipped default
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bad explicit file refuses the boot', async () => {
    await expect(makeEnv({ env: { HSN_KNOWN_GAPS_FILE: '/nonexistent/known_gaps.json' } })).rejects.toThrow(/not found/);
  });
});

describe('SA-C5-05: echoed property names are escaped and truncated; the error list is size-capped', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  it('a 200 KB key comes back as at most 64 characters, escaped', async () => {
    const long = `a/b~${'x'.repeat(200_000)}`;
    const r = await env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: { ...bearer(env.keys.read!), 'content-type': 'application/json' }, payload: JSON.stringify({ lines: [LINE], [long]: 1 }) });
    expect(r.statusCode).toBe(400);
    expect(r.body.length).toBeLessThan(16 * 1024);
    const p = r.json().errors[0].pointer as string;
    expect(p.startsWith('/a~1b~0xxx')).toBe(true);
    expect(p.length).toBeLessThanOrEqual(1 + 64 + 6 + 1);
  });

  it('50 long keys still fit the 16 KiB body cap', async () => {
    const body: Record<string, unknown> = { lines: [LINE] };
    for (let i = 0; i < 50; i++) body[`${i}_${'y'.repeat(5000)}`] = 1;
    const r = await env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: { ...bearer(env.keys.read!), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(r.statusCode).toBe(400);
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(r.json().errors))).toBeLessThanOrEqual(MAX_ERRORS_BYTES);
    expect(r.json().detail).toMatch(/^Request validation failed: 50 problems/);
  });
});
