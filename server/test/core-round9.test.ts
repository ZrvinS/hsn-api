/**
 * Round 9 (validator round 3 + ruling 36): verify can replace an index-page citation with the notification
 * document (url + notification), end to end on the shipped 3004 nil rule; plus the polish items
 * (all validation errors, needs_input lists rule_id and condition, unpadded notification numbers,
 * meta known_data_gaps / codes_without_rules).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crossCheckState } from '../src/services/integrity.js';
import { isDocumentUrl, normaliseNotificationRef } from '../src/services/proposals.js';
import { loadKnownGaps, DEFAULT_KNOWN_GAPS_FILE } from '../src/services/knownGaps.js';
import { loadConfig } from '../src/config.js';
import { MAX_VALIDATION_ERRORS } from '../src/app.js';
import { PDF_SHA, SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
const P = 'https://hsn-api.example/problems/';
const INDEX = 'https://cbic-gst.gov.in/central-tax-rate.html';

let env: TestEnv;
let nilRule: string;
beforeAll(async () => {
  env = await makeEnv({ seedDir: SEED });
  const row = env.storage.readDb
    .prepare(`SELECT rule_id FROM rate_rules WHERE hsn_prefix = '3004' AND condition_code = 'nil_rate_list'`)
    .get() as { rule_id: string };
  nilRule = row.rule_id;
});
afterAll(async () => env.close());

const propose = (payload: object, who = 'amit') =>
  env.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys[who]!), payload });
const approve = (p: { id: string; content_sha256: string }, who = 'priya') =>
  env.admin.inject({
    method: 'POST', url: `/v1/admin/rate-proposals/${p.id}/approve`, headers: bearer(env.keys[who]!),
    payload: { verified_against_source: true, expected_sha256: p.content_sha256 },
  });
const verifyBody = (source: Record<string, unknown>) => ({
  action: 'verify', supersedes_rule_id: nilRule, rationale: 'Checked the nil list entry against 10/2025-CT(Rate).',
  source: { pdf_sha256: PDF_SHA, schedule_serial: '1', ...source },
});
const tax = (payload: object) => env.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(env.keys.read!), payload });

describe('ruling 36: index-page set', () => {
  it('index pages and non-document URLs are not documents; /view-pdf/ and .pdf are', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: ':memory:', HSN_KEY_PEPPER: 'p'.repeat(32), HSN_AUDIT_KEY: 'a'.repeat(32), HSN_LOG_KEY: 'l'.repeat(32) });
    expect(cfg.sourceIndexPages.length).toBeGreaterThan(0);
    expect(isDocumentUrl(INDEX, cfg.sourceIndexPages)).toBe(false);
    expect(isDocumentUrl('https://cbic-gst.gov.in/gst-goods-services-rates.html', cfg.sourceIndexPages)).toBe(false);
    expect(isDocumentUrl('https://cbic-gst.gov.in/some-page.html', [])).toBe(false);
    expect(isDocumentUrl(SRC_URL, cfg.sourceIndexPages)).toBe(true);
    expect(isDocumentUrl('https://cbic-gst.gov.in/pdf/notfctn-10-2025.pdf', cfg.sourceIndexPages)).toBe(true);
  });

  it('HSN_SOURCE_INDEX_PAGES adds pages to the set', () => {
    const extra = 'https://cbic-gst.gov.in/pdf/listing.pdf';
    const cfg = loadConfig({ NODE_ENV: 'test', HSN_DB_PATH: ':memory:', HSN_KEY_PEPPER: 'p'.repeat(32), HSN_AUDIT_KEY: 'a'.repeat(32), HSN_LOG_KEY: 'l'.repeat(32), HSN_SOURCE_INDEX_PAGES: extra });
    expect(isDocumentUrl(extra, cfg.sourceIndexPages)).toBe(false);
  });
});

describe('ruling 36: 3004 nil rule verify, end to end (shipped seed)', () => {
  it('the seed rule cites the CBIC index page', () => {
    const row = env.storage.read.rules.get(nilRule)!;
    expect(row).toMatchObject({ source_url: INDEX, notification_ref: '10/2025-CT(Rate)', verification_status: 'unverified' });
    expect(row.citation_note).not.toBeNull();
  });

  it('verify without source.url → 400 source-url-not-document', async () => {
    const r = await propose(verifyBody({}));
    expect(r.statusCode).toBe(400);
    expect(r.json().type).toBe(`${P}source-url-not-document`);
    expect(r.json().errors[0]).toMatchObject({ pointer: '/source/url', code: 'required' });
  });

  it('verify with an index page or a non-document url → 400', async () => {
    for (const url of [INDEX, 'https://cbic-gst.gov.in/gst-goods-services-rates.html', 'https://cbic-gst.gov.in/about.html']) {
      const r = await propose(verifyBody({ url }));
      expect(r.statusCode, url).toBe(400);
      expect(r.json().errors.map((e: { pointer: string }) => e.pointer)).toContain('/source/url');
    }
    const host = await propose(verifyBody({ url: 'https://evil.example/view-pdf/1/x.pdf' }));
    expect(host.statusCode).toBe(400);
  });

  it('a direct SQL citation change is refused by the trigger', () => {
    expect(() => env.storage.writeDb.prepare(`UPDATE rate_rules SET source_url = ? WHERE rule_id = ?`).run(SRC_URL, nilRule)).toThrow();
    expect(() => env.storage.writeDb.prepare(`UPDATE rate_rules SET notification_ref = 'x' WHERE rule_id = ?`).run(nilRule)).toThrow();
    expect(() =>
      env.storage.writeDb
        .prepare(`UPDATE rate_rules SET verification_status = 'verified', verified_by = 'amit', last_verified_at = '2026-10-10T06:00:00.000Z', source_url = ? WHERE rule_id = ?`)
        .run(SRC_URL, nilRule),
    ).toThrow();
  });

  it('verify with url + notification: approval replaces both atomically, clears citation_note', async () => {
    const c = await propose(verifyBody({ url: SRC_URL, notification: ' 010/2025-Integrated  Tax (Rate) ' }));
    expect(c.statusCode).toBe(201);
    expect(c.json().payload.source).toMatchObject({ url: SRC_URL, notification: '10/2025-IT(Rate)' });
    // nothing changes before approval
    expect(env.storage.read.rules.get(nilRule)!.source_url).toBe(INDEX);
    const a = await approve(c.json());
    expect(a.statusCode).toBe(200);
    const row = env.storage.read.rules.get(nilRule)!;
    expect(row).toMatchObject({ source_url: SRC_URL, notification_ref: '10/2025-IT(Rate)', verification_status: 'verified', citation_note: null });

    const g = await env.app.inject({ method: 'GET', url: '/v1/hsn/3004?date=2026-10-10', headers: bearer(env.keys.read!) });
    const dto = (g.json().rate.rules as Record<string, unknown>[]).find((x) => x['rule_id'] === nilRule)!;
    expect(dto).toMatchObject({ verification_status: 'verified', citation_note: null, igst_rate_bp: 0 });
    expect(JSON.stringify(dto)).toContain(SRC_URL);
    expect(JSON.stringify(dto)).toContain('10/2025-IT(Rate)');
    expect(crossCheckState(env.storage.read)).toMatchObject({ ok: true, problems: [] });
  });

  it('a later verify may not change url/notification (400), plain re-verify still works', async () => {
    const r = await propose(verifyBody({ url: SRC_URL }));
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0]).toMatchObject({ pointer: '/source', code: 'forbidden' });
    const plain = await propose(verifyBody({}));
    expect(plain.statusCode).toBe(201);
  });

  it('create proposals must cite a document, not an index page', async () => {
    const r = await propose({
      action: 'create', rationale: 'New rule citing an index page.',
      rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: { kind: 'none', text: null, min_unit_price: null, max_unit_price: null }, effective_from: '2027-01-01',
        source: { notification: '9/2025-CT(Rate)', url: INDEX, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors.map((e: { pointer: string }) => e.pointer).join(' ')).toContain('url');
  });

  it('a citation changed behind the trigger after the verify is flagged by the cross-check', () => {
    env.storage.writeDb.exec('DROP TRIGGER rate_rules_guard_update');
    env.storage.writeDb.prepare(`UPDATE rate_rules SET source_url = 'https://taxinformation.cbic.gov.in/view-pdf/999/ENG/Notifications' WHERE rule_id = ?`).run(nilRule);
    const cc = crossCheckState(env.storage.read);
    expect(cc.ok).toBe(false);
    expect(cc.problems.join('\n')).toMatch(/source_url\/notification_ref differ/);
  });
});

describe('polish: validation errors list every problem', () => {
  it('three lines missing supply_type → three errors', async () => {
    const r = await tax({ lines: [1, 2, 3].map(() => ({ hsn: '7113', taxable_value: 100 })) });
    expect(r.statusCode).toBe(400);
    const errs = r.json().errors as { pointer: string; code: string }[];
    expect(errs.map((e) => e.pointer).sort()).toEqual(['/lines/0/supply_type', '/lines/1/supply_type', '/lines/2/supply_type']);
    expect(r.json().detail).toBe('Request validation failed: 3 problems. See errors[].');
  });

  it(`more than ${MAX_VALIDATION_ERRORS} problems are capped, the total is in detail`, async () => {
    const r = await tax({ lines: Array.from({ length: 60 }, () => ({ hsn: '7113', taxable_value: 100 })) });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(r.json().detail).toBe(`Request validation failed: 60 problems; the first ${MAX_VALIDATION_ERRORS} are in errors[].`);
  });
});

describe('polish: ambiguous needs_input', () => {
  it('3004 lists both accepted inputs (rule_id or condition: "general")', async () => {
    const b = (await tax({ accept_unverified: true, lines: [{ hsn: '3004', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(b.lines[0].needs_input).toEqual(expect.arrayContaining(['rule_id', 'condition']));
    const ok = (await tax({ accept_unverified: true, lines: [{ hsn: '3004', condition: 'general', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(ok.lines[0].needs_input ?? []).toEqual([]);
  });
});

describe('polish: notification number padding', () => {
  it('normaliseNotificationRef strips zero padding from N/YYYY and collapses spaces', () => {
    expect(normaliseNotificationRef('01/2026-CT(Rate), Schedule I')).toBe('1/2026-CT(Rate), Schedule I');
    expect(normaliseNotificationRef('  09/2025-Central Tax (Rate)  ')).toBe('9/2025-CT(Rate)');
    expect(normaliseNotificationRef('10/2025-CT(Rate)')).toBe('10/2025-CT(Rate)');
    expect(normaliseNotificationRef('100/2017-CT(Rate)')).toBe('100/2017-CT(Rate)');
    expect(normaliseNotificationRef('1/2017 and 01/2026')).toBe('1/2017 and 1/2026');
  });

  it('the seed loader stores no zero-padded notification numbers', () => {
    const rows = env.storage.readDb.prepare(`SELECT notification_ref FROM rate_rules`).all() as { notification_ref: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => /(^|[^0-9])0[0-9]*\/(19|20)\d{2}/.test(r.notification_ref))).toEqual([]);
  });
});

describe('polish: meta known_data_gaps and codes_without_rules', () => {
  it('meta lists the curated gaps and counts codes without rules', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/v1/meta/dataset', headers: bearer(env.keys.read!) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.coverage.codes_without_rules).toEqual(expect.any(Number));
    const gaps = b.known_data_gaps as { prefix: string | null; kind: string; reason: string }[];
    expect(gaps).toEqual(loadKnownGaps().map((g) => ({ ...g })));
    expect(gaps.find((g) => g.prefix === '7104')).toMatchObject({ kind: 'disputed' });
    expect(gaps.find((g) => g.prefix === '3004')).toMatchObject({ kind: 'not_transcribed' });
  });

  it('loader: missing file → [], malformed file throws, default file parses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsn-gaps-'));
    try {
      expect(loadKnownGaps(join(dir, 'absent.json'), { required: false })).toEqual([]);
      expect(() => loadKnownGaps(join(dir, 'absent.json'))).toThrow(/not found/); // SA-C5-04: explicit path
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ items: [{ prefix: '7104', kind: 'unknown_kind', reason: 'nope nope' }] }));
      expect(() => loadKnownGaps(bad)).toThrow(/kind/);
      writeFileSync(bad, '{not json');
      expect(() => loadKnownGaps(bad)).toThrow();
      expect(loadKnownGaps(DEFAULT_KNOWN_GAPS_FILE).length).toBeGreaterThan(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
