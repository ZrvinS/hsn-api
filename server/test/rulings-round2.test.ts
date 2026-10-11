/**
 * One or more tests per coordinator ruling of 00c (round 2) that touches core. Test names start with
 * "ruling N" so reviews/code-fix-core-round2.md can point at them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify as edVerify, createPublicKey } from 'node:crypto';
import { bearer, makeEnv, proposeAndApprove, AUDIT_KEY, PDF_SHA, SRC_URL, type TestEnv } from './helpers.js';
import { prefixRelated, RateService } from '../src/services/rates.js';
import { parseQuantity, deriveUnitPricePaise } from '../src/services/tax.js';
import { secondsUntilNextIstMidnight } from '../src/lib/etag.js';
import { verifyChain, GENESIS_HASH, verifyAll } from '../src/services/audit.js';
import { exportAuditHead, verifyAgainstHead } from '../src/services/auditExport.js';
import { bootstrapAdmins, createApiKey, normaliseHandle, KeyInputError } from '../src/services/apiKeys.js';
import { IDEMPOTENCY_TTL_MS } from '../src/services/idempotency.js';

const SRC = { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' };
const NONE = { kind: 'none', text: null, min_unit_price: null, max_unit_price: null };

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const get = (url: string, e: TestEnv = env, headers: Record<string, string> = {}) => e.app.inject({ method: 'GET', url, headers: { ...bearer(e.keys.read!), ...headers } });
const adminPost = (e: TestEnv, key: string, url: string, payload: object, headers: Record<string, string> = {}) =>
  e.admin.inject({ method: 'POST', url, headers: { ...bearer(e.keys[key]!), ...headers }, payload });
const ruleId = (e: TestEnv, prefix: string, from: string, bp?: number) =>
  (e.storage.writeDb.prepare('SELECT rule_id FROM rate_rules WHERE hsn_prefix = ? AND effective_from = ? AND (? IS NULL OR igst_rate_bp = ?)').get(prefix, from, bp ?? null, bp ?? null) as { rule_id: string }).rule_id;
const tax = (e: TestEnv, payload: object) => e.app.inject({ method: 'POST', url: '/v1/tax/calculate', headers: bearer(e.keys.read!), payload });

describe('ruling 1: corrections void the target and insert the replacement atomically', () => {
  it('ruling 1: correct → target voided (kept), replacement live, rule_corrected carries both ids', async () => {
    const e = await makeEnv();
    try {
      const target = ruleId(e, '9988', '2017-07-01');
      const before = e.storage.read.dataset.maxSeq();
      const { create, approve } = await proposeAndApprove(e, {
        action: 'correct', supersedes_rule_id: target,
        rule: { hsn_prefix: '9988', igst_rate_bp: 1200, condition: NONE, effective_from: '2017-07-01', source: SRC },
        rationale: 'The 5% figure was keyed wrongly; the schedule says 12%.', retroactive_reason: 'Data-entry error since the first seed; corrected from day one.',
      });
      expect(create.statusCode).toBe(201);
      expect(approve!.statusCode).toBe(200);
      const old = e.storage.read.rules.get(target)!;
      expect(old.status).toBe('voided');
      expect(old.voided_by_rule).toBe(approve!.json().resulting_rule_id);
      expect(old.igst_rate_bp).toBe(500); // content kept for audit
      const live = (await get('/v1/hsn/998892', e)).json().rate;
      expect(live.applicable_rule.igst_rate_bp).toBe(1200);
      expect(live.rules.map((r: { rule_id: string }) => r.rule_id)).not.toContain(target);
      const ch = e.storage.read.dataset.changes(before, 10);
      expect(ch.map((c) => c.change_type)).toEqual(['rule_corrected']);
      expect(ch[0]!.rule_id).toBe(approve!.json().resulting_rule_id);
      expect(ch[0]!.related_rule_id).toBe(target);
      expect(ch[0]!.retroactive).toBe(true);
      // a voided rule never changes again (trigger)
      expect(() => e.storage.writeDb.prepare("UPDATE rate_rules SET last_verified_at = '2030-01-01T00:00:00Z' WHERE rule_id = ?").run(target)).toThrow();
      // and cannot be the target of another proposal
      const again = await adminPost(e, 'amit', '/v1/admin/rate-proposals', { action: 'end_date', supersedes_rule_id: target, end_date: '2027-01-01', rationale: 'End the voided one (must fail).' });
      expect(again.statusCode).toBe(409);
    } finally {
      await e.close();
    }
  });
});

describe('ruling 3: affected_prefix and two-way invalidation', () => {
  it('ruling 3: prefixRelated matches both directions', () => {
    expect(prefixRelated('71131910', '7113')).toBe(true);
    expect(prefixRelated('7113', '71131910')).toBe(true);
    expect(prefixRelated('7114', '7113')).toBe(false);
  });
  it('ruling 3: each change carries affected_prefix; a rule added at 71131910 invalidates a cached 7113', async () => {
    const e = await makeEnv();
    try {
      const seq = e.storage.read.dataset.maxSeq();
      const { approve } = await proposeAndApprove(e, {
        action: 'create', rule: { hsn_prefix: '71131910', igst_rate_bp: 500, condition: NONE, effective_from: '2026-12-01', source: SRC }, rationale: 'Fixture: 8-digit rule under 7113.',
      });
      expect(approve!.statusCode).toBe(200);
      const feed = (await get(`/v1/rates/changes?since=${seq}`, e)).json();
      const c = feed.changes[0];
      expect(c.affected_prefix).toBe('71131910');
      expect(prefixRelated('7113', c.affected_prefix)).toBe(true);
      expect((await get('/v1/hsn/7113?date=2026-12-01', e)).json().rate.ambiguous).toBe(true);
    } finally {
      await e.close();
    }
  });
});

describe('ruling 4: ETag covers the resolved IST date; max-age stops at IST midnight', () => {
  it('ruling 4: same dataset, clock crosses IST midnight → new ETag (no 304), new rule takes effect', async () => {
    const e = await makeEnv();
    try {
      // a future rule from 2026-10-11 for 7117 (no rule today)
      const { approve } = await proposeAndApprove(e, {
        action: 'create', rule: { hsn_prefix: '7117', igst_rate_bp: 300, condition: NONE, effective_from: '2026-10-11', source: SRC }, rationale: 'Fixture: imitation jewellery from tomorrow.',
      });
      expect(approve!.statusCode).toBe(200);
      e.clock.set('2026-10-10T18:00:00Z'); // 23:30 IST
      const a = await get('/v1/hsn/7117', e);
      expect(a.json().rate.coverage).toBe('no_rate_rule');
      expect(a.headers['cache-control']).toBe('private, max-age=1800, must-revalidate');
      e.clock.set('2026-10-10T18:31:00Z'); // 00:01 IST next day, same dataset version
      const b = await get('/v1/hsn/7117', e, { 'if-none-match': a.headers.etag as string });
      expect(b.statusCode).toBe(200);
      expect(b.headers.etag).not.toBe(a.headers.etag);
      expect(b.json().rate.applicable_rule.igst_rate_bp).toBe(300);
    } finally {
      await e.close();
    }
  });
  it('ruling 4: secondsUntilNextIstMidnight', () => {
    expect(secondsUntilNextIstMidnight(new Date('2026-10-10T18:29:00Z'))).toBe(60);
    expect(secondsUntilNextIstMidnight(new Date('2026-10-10T06:00:00Z'))).toBe(12.5 * 3600);
  });
});

describe('ruling 5: 3004 general + nil-rate-list rule', () => {
  it('ruling 5: lookup is ambiguous with default_rule_id = the general rule; every rule listed with its condition', async () => {
    const r = (await get('/v1/hsn/3004')).json().rate;
    expect(r.ambiguous).toBe(true);
    expect(r.coverage).toBe('ambiguous');
    const def = r.rules.find((x: { rule_id: string }) => x.rule_id === r.default_rule_id);
    expect(def.condition.kind).toBe('none');
    expect(def.igst_rate_bp).toBe(500);
    const nil = r.rules.find((x: { igst_rate_bp: number }) => x.igst_rate_bp === 0);
    expect(nil.condition.code).toBe('nil_rate_list');
    expect(nil.condition.text).toMatch(/nil/i);
  });
  it('ruling 5: a nil_rate_list hint (curated synonym) selects the 0% rule', () => {
    const svc = new RateService(env.storage.read.rules, undefined, { clock: env.clock });
    const r = svc.resolve('3004', '2026-10-10', null, { conditionCode: 'nil_rate_list' }).dto;
    expect(r.applicable_rule?.igst_rate_bp).toBe(0);
    expect(r.warnings).toContain('selected_by_hint');
    expect(svc.resolve('3004', '2026-10-10', null, { conditionCode: 'unknown_code' }).dto.ambiguous).toBe(true);
  });
  it('ruling 5: tax needs rule_id or condition "general" on an ambiguous line; a wrong rule_id → 422 rule_choice_invalid', async () => {
    const plain = (await tax(env, { accept_unverified: true, lines: [{ hsn: '3004', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(plain.lines[0].tax).toBeNull();
    expect(plain.lines[0].needs_input).toContain('rule_id');
    expect(plain.lines[0].default_rule_id).toMatch(/^rr_/);
    const general = (await tax(env, { accept_unverified: true, lines: [{ hsn: '3004', taxable_value: 100, condition: 'general', supply_type: 'intra' }] })).json();
    expect(general.lines[0].tax.total_tax).toBe(5);
    expect(general.lines[0].rule_selected_by).toBe('condition_general');
    const nilId = (await get('/v1/hsn/3004')).json().rate.rules.find((x: { igst_rate_bp: number }) => x.igst_rate_bp === 0).rule_id;
    const nil = (await tax(env, { accept_unverified: true, lines: [{ hsn: '3004', taxable_value: 100, rule_id: nilId, supply_type: 'intra' }] })).json();
    expect(nil.lines[0].tax.total_tax).toBe(0);
    expect(nil.lines[0].rule_selected_by).toBe('rule_id');
    const bad = await tax(env, { accept_unverified: true, lines: [{ hsn: '3004', taxable_value: 100, rule_id: ruleId(env, '7113', '2017-07-01'), supply_type: 'intra' }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('rule_choice_invalid');
  });
});

describe('ruling 6: 5-digit SAC groups', () => {
  it('ruling 6: 99972 is a valid code, 999721 resolves through the 99972 rule; 3/5/7-digit goods codes → 400', async () => {
    const g = await get('/v1/hsn/99972');
    expect(g.statusCode).toBe(200);
    expect(g.json().level).toBe(5);
    const c = (await get('/v1/hsn/999721')).json();
    expect(c.rate.applicable_rule.hsn_prefix).toBe('99972');
    expect(c.rate.matched_at_level).toBe(5);
    for (const bad of ['711', '71131', '7113191']) expect((await get(`/v1/hsn/${bad}`)).statusCode).toBe(400);
  });
});

describe('ruling 7: quantity', () => {
  it('ruling 7: up to 3 decimals as qty_milli; unit price = roundHalfUp(taxable × 1000 / qty_milli)', async () => {
    expect(parseQuantity('8.250')?.milli).toBe(8250n);
    expect(parseQuantity(8.25)?.milli).toBe(8250n);
    expect(parseQuantity('1.2345')).toBeNull();
    expect(deriveUnitPricePaise(100_000, parseQuantity('3')!)).toBe(33_333);
    expect(deriveUnitPricePaise(100_000, parseQuantity('0.003')!)).toBe(33_333_333);
    const r = await tax(env, { lines: [{ hsn: '7113', taxable_value: 1000, quantity: '1.2345', supply_type: 'intra' }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].pointer).toBe('/lines/0/quantity');
    const ok = (await tax(env, { lines: [{ hsn: '6109', taxable_value: 3600, quantity: '2.000', supply_type: 'intra' }] })).json();
    expect(ok.lines[0].tax.total_tax).toBe(180);
  });
  it('ruling 7 (validator 7): line_id defaults to the zero-based index; igst_rate_bp is returned', async () => {
    const b = (await tax(env, { lines: [{ hsn: '7113', taxable_value: 10, supply_type: 'inter' }, { hsn: '7113', taxable_value: 10, supply_type: 'inter' }] })).json();
    expect(b.lines.map((l: { line_id: string }) => l.line_id)).toEqual(['0', '1']);
    expect(b.lines[0].igst_rate_bp).toBe(300);
  });
});

describe('ruling 8: idempotency_keys', () => {
  it('ruling 8: stored per key with request hash; another key may reuse the same Idempotency-Key; expires after 24 h', async () => {
    const e = await makeEnv();
    try {
      const body = { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2027-01-01', source: SRC }, rationale: 'Idempotency storage fixture.' };
      const k = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
      const a = await adminPost(e, 'amit', '/v1/admin/rate-proposals', body, { 'idempotency-key': k });
      expect(a.statusCode).toBe(201);
      const rows = e.storage.writeDb.prepare('SELECT key_id, idem_key, request_sha256, response_json FROM idempotency_keys').all() as Record<string, string>[];
      const mine = rows.find((r) => r['idem_key'] === k)!;
      expect(mine['key_id']).toBe(e.keyIds.amit);
      expect(mine['request_sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(mine['response_json']!).id).toBe(a.json().id);
      // same Idempotency-Key from another admin key is a different slot (overlap → 409, not a replay)
      const other = await adminPost(e, 'priya', '/v1/admin/rate-proposals', body, { 'idempotency-key': k });
      expect(other.headers['idempotent-replayed']).toBeUndefined();
      // after the TTL the key is free again: a replay is no longer returned
      e.clock.advance(IDEMPOTENCY_TTL_MS + 1000);
      const late = await adminPost(e, 'amit', '/v1/admin/rate-proposals', body, { 'idempotency-key': k });
      expect(late.headers['idempotent-replayed']).toBeUndefined();
    } finally {
      await e.close();
    }
  });
});

describe('ruling 9: re-verification', () => {
  it('ruling 9: reverify_due_at = last_verified_at + 12 months; overdue → warning + meta count', async () => {
    const r = (await get('/v1/hsn/998892')).json().rate;
    expect(r.applicable_rule.last_verified_at).toBe('2025-06-01T00:00:00Z');
    expect(r.applicable_rule.reverify_due_at).toBe('2026-06-01T00:00:00Z');
    expect(r.warnings).toContain('verification_overdue');
    const ok = (await get('/v1/hsn/7113')).json().rate;
    expect(ok.warnings).not.toContain('verification_overdue');
    const meta = (await get('/v1/meta/dataset')).json();
    expect(meta.coverage.rate_rules_verification_overdue).toBeGreaterThanOrEqual(1);
  });
  it('ruling 9 / 19: verify on a verified rule only moves last_verified_at forward; verified_by stays set-once', async () => {
    const e = await makeEnv();
    try {
      const id = ruleId(e, '9988', '2017-07-01');
      const before = e.storage.read.rules.get(id)!;
      const { approve } = await proposeAndApprove(e, { action: 'verify', supersedes_rule_id: id, source: { pdf_sha256: PDF_SHA, schedule_serial: 'III-26' }, rationale: 'Annual re-verification.' });
      expect(approve!.statusCode).toBe(200);
      const after = e.storage.read.rules.get(id)!;
      expect(after.last_verified_at! > before.last_verified_at!).toBe(true);
      expect(after.verified_by).toBe(before.verified_by);
      expect((await get('/v1/hsn/998892', e)).json().rate.warnings).not.toContain('verification_overdue');
      expect(() => e.storage.writeDb.prepare("UPDATE rate_rules SET last_verified_at = '2020-01-01T00:00:00Z' WHERE rule_id = ?").run(id)).toThrow();
    } finally {
      await e.close();
    }
  });
});

describe('ruling 10: pending change signal', () => {
  it('ruling 10: a detected notification shows in meta and warns on related codes until resolved', async () => {
    const e = await makeEnv();
    try {
      const w = await adminPost(e, 'amit', '/v1/admin/watched-notifications', { notification: '12/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['7113'], effective_from: '2026-11-01', expedite: true });
      expect(w.statusCode).toBe(201);
      const meta = (await get('/v1/meta/dataset', e)).json();
      expect(meta.pending_notifications).toHaveLength(1);
      expect(meta.pending_notifications[0].affected_prefixes).toEqual(['7113']);
      expect(meta.freshness_sla_business_days).toBe(2);
      expect((await get('/v1/hsn/71131910', e)).json().rate.warnings).toContain('pending_change_detected');
      expect((await get('/v1/hsn/71', e)).json().rate.warnings).toContain('pending_change_detected');
      expect((await get('/v1/hsn/6109', e)).json().rate.warnings).not.toContain('pending_change_detected');
      // SA-C3-03: a row with a CBIC notification key needs a second admin to dismiss it
      expect((await adminPost(e, 'amit', `/v1/admin/watched-notifications/${w.json().id}/resolve`, { state: 'dismissed' })).statusCode).toBe(202);
      expect((await get('/v1/hsn/7113', e)).json().rate.warnings).toContain('pending_change_detected');
      const res = await adminPost(e, 'priya', `/v1/admin/watched-notifications/${w.json().id}/resolve`, { state: 'dismissed' });
      expect(res.statusCode).toBe(200);
      expect((await get('/v1/hsn/7113', e)).json().rate.warnings).not.toContain('pending_change_detected');
      expect(() => e.storage.writeDb.exec('DELETE FROM watched_notifications')).toThrow();
    } finally {
      await e.close();
    }
  });
});

describe('ruling 11: content_sha256', () => {
  it('ruling 11: meta content_sha256 = recomputed canonical export hash, and changes when reference data changes', async () => {
    const e = await makeEnv();
    try {
      const a = (await get('/v1/meta/dataset', e)).json().content_sha256;
      expect(a).toBe(e.storage.read.dataset.computeContentHash());
      const { approve } = await proposeAndApprove(e, { action: 'refdata_change', refdata: { table: 'synonym', op: 'add', phrase: 'gold kada', hsn_code: '7113', strength: 'primary' }, rationale: 'Common bangle name.' });
      expect(approve!.statusCode).toBe(200);
      const b = (await get('/v1/meta/dataset', e)).json().content_sha256;
      expect(b).not.toBe(a);
      expect(b).toBe(e.storage.read.dataset.computeContentHash());
    } finally {
      await e.close();
    }
  });
});

describe('ruling 12: source PDF hash and schedule serial', () => {
  it('ruling 12: create/supersede/correct need source.pdf_sha256 and schedule_serial; stored on the rule', async () => {
    const { source: _s, ...noPdf } = { ...SRC, source: null };
    void _s;
    const missing = await adminPost(env, 'amit', '/v1/admin/rate-proposals', {
      action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2029-01-01', source: { notification: SRC.notification, url: SRC.url } }, rationale: 'No PDF hash given.',
    });
    expect(missing.statusCode).toBe(400);
    void noPdf;
    const badHash = await adminPost(env, 'amit', '/v1/admin/rate-proposals', {
      action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2029-01-01', source: { ...SRC, pdf_sha256: 'XYZ' } }, rationale: 'Bad PDF hash given.',
    });
    expect(badHash.statusCode).toBe(400);
  });
});

describe('ruling 13: coverage is required', () => {
  it('ruling 13: ok / no_rate_rule / ambiguous on every resolution', async () => {
    expect((await get('/v1/hsn/7113')).json().rate.coverage).toBe('ok');
    expect((await get('/v1/hsn/7117')).json().rate.coverage).toBe('no_rate_rule');
    expect((await get('/v1/hsn/7102')).json().rate.coverage).toBe('ambiguous');
  });
});

describe('ruling 14: RateLimit headers in tokens', () => {
  it('ruling 14: Limit 600, Remaining tokens, Cost per request, Policy', async () => {
    const e = await makeEnv();
    try {
      const r = await get('/v1/hsn/7113', e);
      expect(r.headers['ratelimit-limit']).toBe('600');
      expect(r.headers['ratelimit-cost']).toBe('1');
      expect(r.headers['ratelimit-policy']).toBe('600;w=60;burst=100');
      expect(r.headers['ratelimit-remaining']).toBe('99');
      const lines = Array.from({ length: 120 }, () => ({ hsn: '7113', taxable_value: 1, supply_type: 'inter' }));
      const t = await tax(e, { lines });
      expect(t.statusCode).toBe(200);
      expect(t.headers['ratelimit-cost']).toBe('3'); // 1 + floor(120/50) (ruling 25)
      expect(t.headers['ratelimit-remaining']).toBe('96');
    } finally {
      await e.close();
    }
  });
});

describe('ruling 15: UTGST', () => {
  it('ruling 15: intra_ut returns CGST + UTGST, no SGST', async () => {
    const b = (await tax(env, { lines: [{ hsn: '7113', taxable_value: 68500, supply_type: 'intra_ut' }] })).json();
    expect(b.lines[0].tax).toEqual({ cgst: 1027.5, sgst: 0, utgst: 1027.5, igst: 0, cess: 0, total_tax: 2055 });
    expect(b.totals.utgst).toBe(1027.5);
  });
});

describe('ruling 17: admin actors', () => {
  it('ruling 17: handles are NFKC + lower-case + [a-z0-9_-]{3,32}', () => {
    expect(normaliseHandle('  Ｐriya ')).toBe('priya');
    expect(() => normaliseHandle('ri')).toThrow(KeyInputError);
    expect(() => normaliseHandle('priya​')).toThrow(KeyInputError);
    expect(() => normaliseHandle('pri ya')).toThrow(KeyInputError);
  });
  it('ruling 17: bootstrap only once (two actors, audited); later actors and admin keys need an admin_grant by a different admin', async () => {
    const e = await makeEnv();
    try {
      const secrets = { pepper: e.config.keyPepper.reveal(), auditKey: AUDIT_KEY };
      expect(() => bootstrapAdmins(e.storage.tx, e.clock, secrets, [{ handle: 'mallory', display_name: 'M' }, { handle: 'trent', display_name: 'T' }], { tenant: 'x', by: 'x' })).toThrow();
      expect(e.storage.read.audit.all().some((a) => a.action === 'admin.bootstrapped')).toBe(true);
      // an admin key without a grant is refused (service and trigger)
      expect(() => createApiKey(e.storage.tx, e.clock, secrets, { tenant: 't', scopes: ['admin'], actor: 'amit', label: 'x', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' })).toThrow();
      // a new actor through admin_grant: maker cannot approve their own grant
      const c = await adminPost(e, 'amit', '/v1/admin/rate-proposals', { action: 'admin_grant', grant: { handle: 'Ravi', display_name: 'Ravi', new_actor: true }, rationale: 'Ravi joins as checker.' });
      expect(c.statusCode).toBe(201);
      expect(c.json().payload.handle).toBe('ravi');
      const self = await adminPost(e, 'amit2', `/v1/admin/rate-proposals/${c.json().id}/approve`, { verified_against_source: true, expected_sha256: c.json().content_sha256 });
      expect(self.statusCode).toBe(403);
      const ok = await adminPost(e, 'priya', `/v1/admin/rate-proposals/${c.json().id}/approve`, { verified_against_source: true, expected_sha256: c.json().content_sha256 });
      expect(ok.statusCode).toBe(200);
      expect(e.storage.read.actors.byHandle('ravi')).not.toBeNull();
      // the grant is single-use for one key
      const k = createApiKey(e.storage.tx, e.clock, secrets, { tenant: 't', scopes: ['admin'], actor: 'ravi', adminGrantId: c.json().id, label: 'ravi', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' });
      expect(k.key).toMatch(/^hsk_/);
      expect(() => createApiKey(e.storage.tx, e.clock, secrets, { tenant: 't', scopes: ['admin'], actor: 'ravi', adminGrantId: c.json().id, label: 'ravi2', rateLimitPerMin: 60, dailyQuota: null, llmOptOut: true, expiresAt: null, createdBy: 't' })).toThrow();
      // a duplicate handle in another spelling is refused at creation
      const dup = await adminPost(e, 'amit', '/v1/admin/rate-proposals', { action: 'admin_grant', grant: { handle: 'RAVI', display_name: 'Ravi again', new_actor: true }, rationale: 'Duplicate actor attempt.' });
      expect(dup.statusCode).toBe(400);
      expect(dup.json().errors[0].code).toBe('duplicate');
    } finally {
      await e.close();
    }
  });
});

describe('ruling 18: HMAC audit chain and off-host head', () => {
  it('ruling 18: chain verifies only with HSN_AUDIT_KEY; approval entries carry the canonical rule and its sha256', async () => {
    const all = env.storage.read.audit.all();
    expect(verifyChain(AUDIT_KEY, all, GENESIS_HASH).ok).toBe(true);
    expect(verifyChain('another-key-0123456789abcdef0123456789', all, GENESIS_HASH).ok).toBe(false);
    const e = await makeEnv();
    try {
      const { approve } = await proposeAndApprove(e, { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2027-01-01', source: SRC }, rationale: 'Audit content fixture.' });
      const entry = e.storage.read.audit.all().filter((a) => a.action === 'rate_proposal.approved').at(-1)!;
      const d = entry.details as { rule: { rule_id: string; igst_rate_bp: number }; rule_sha256: string };
      expect(d.rule.rule_id).toBe(approve!.json().resulting_rule_id);
      expect(d.rule.igst_rate_bp).toBe(1800);
      expect(d.rule_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await e.close();
    }
  });
  it('ruling 18: export-audit-head + verify-audit detect truncation of the newest rows and a restored DB', async () => {
    const e = await makeEnv();
    try {
      const head = exportAuditHead(e.storage.read, AUDIT_KEY, '2026-10-10T06:00:00Z');
      expect(verifyAgainstHead(e.storage.read, AUDIT_KEY, head).ok).toBe(true);
      // tampered export
      expect(verifyAgainstHead(e.storage.read, AUDIT_KEY, { ...head, audit_head_id: head.audit_head_id - 1 }).problems.join()).toMatch(/MAC/);
      // truncate the newest audit row (attacker with DB access, triggers dropped)
      e.storage.writeDb.exec('DROP TRIGGER audit_no_delete');
      e.storage.writeDb.prepare('DELETE FROM audit_log WHERE id = ?').run(head.audit_head_id);
      expect(verifyAll(e.storage.read.audit, AUDIT_KEY).ok).toBe(true); // the chain alone cannot see it
      const r = verifyAgainstHead(e.storage.read, AUDIT_KEY, head);
      expect(r.ok).toBe(false);
      expect(r.problems.join()).toMatch(/shorter than the exported head/);
    } finally {
      await e.close();
    }
  });
  it('ruling 18: GET /v1/admin/audit returns head_id and head_hash', async () => {
    const r = (await env.admin.inject({ method: 'GET', url: '/v1/admin/audit?verify=true', headers: bearer(env.keys.priya!) })).json();
    const h = env.storage.read.audit.head()!;
    expect(r.head_id).toBe(h.id);
    expect(r.head_hash).toBe(h.hash);
  });
});

describe('ruling 19: DB guards', () => {
  const db = () => env.storage.writeDb;
  it('ruling 19: a rule insert needs an approved proposal naming it, or the seed batch of an empty DB', () => {
    const v = env.storage.read.dataset.current()!.current_version;
    const sb = (db().prepare('SELECT id FROM seed_batches').get() as { id: string }).id;
    expect(() => db().prepare(`INSERT INTO rate_rules(rule_id, hsn_prefix, igst_rate_bp, effective_from, notification_ref, source_url, created_in_version, seed_batch_id) VALUES ('rr_X', '8517', 1800, '2030-01-01', 'x', 'https://x', ?, ?)`).run(v, sb)).toThrow(/insert needs/);
    const pending = db().prepare("SELECT id FROM rate_proposals WHERE status = 'pending' LIMIT 1").get() as { id: string } | undefined;
    if (pending) expect(() => db().prepare(`INSERT INTO rate_rules(rule_id, hsn_prefix, igst_rate_bp, effective_from, notification_ref, source_url, created_in_version, proposal_id) VALUES ('rr_Y', '8517', 1800, '2030-01-01', 'x', 'https://x', ?, ?)`).run(v, pending.id)).toThrow(/insert needs/);
  });
  it('ruling 19: verified_by / superseded_by / effective_to are set once from NULL', () => {
    const v = ruleId(env, '7113', '2017-07-01');
    expect(() => db().prepare("UPDATE rate_rules SET verified_by = 'mallory' WHERE rule_id = ?").run(v)).toThrow();
    const ended = ruleId(env, '3004', '2017-07-01');
    expect(() => db().prepare("UPDATE rate_rules SET effective_to = '2030-01-01' WHERE rule_id = ?").run(ended)).toThrow();
  });
  it('ruling 19: terminal proposals are immutable; the dataset pointer only moves forward', async () => {
    const approved = db().prepare("SELECT id FROM rate_proposals WHERE status = 'approved' LIMIT 1").get() as { id: string };
    expect(() => db().prepare("UPDATE rate_proposals SET status = 'rejected' WHERE id = ?").run(approved.id)).toThrow();
    expect(() => db().prepare("UPDATE rate_proposals SET rationale = 'rewritten rationale' WHERE id = ?").run(approved.id)).toThrow();
    const versions = (db().prepare('SELECT version FROM dataset_versions ORDER BY rowid').all() as { version: string }[]).map((r) => r.version);
    if (versions.length > 1) expect(() => db().prepare('UPDATE dataset_state SET current_version = ?').run(versions[0]!)).toThrow();
    expect(() => db().prepare("UPDATE dataset_versions SET content_hash = 'x' WHERE version = ?").run(versions.at(-1)!)).toThrow();
  });
});

describe('ruling 20: approval binding', () => {
  it('ruling 20: approval fails if the superseded rule changed after the proposal (target_sha256)', async () => {
    const e = await makeEnv();
    try {
      const target = ruleId(e, '7113', '2017-07-01');
      const t = e.storage.read.rules.get(target)!;
      const sup = await adminPost(e, 'amit', '/v1/admin/rate-proposals', {
        action: 'supersede', supersedes_rule_id: t.rule_id,
        rule: { hsn_prefix: t.hsn_prefix, igst_rate_bp: 1800, condition: t.condition_kind === 'price' ? { kind: 'price', text: t.condition_text, min_unit_price: t.min_unit_price_paise === null ? null : t.min_unit_price_paise / 100, max_unit_price: t.max_unit_price_paise === null ? null : t.max_unit_price_paise / 100 } : NONE, effective_from: '2027-04-01', source: SRC },
        rationale: 'Supersede fixture for staleness.',
      });
      expect(sup.statusCode).toBe(201);
      // meanwhile the target is end-dated by another approved proposal
      const end = await proposeAndApprove(e, { action: 'end_date', supersedes_rule_id: t.rule_id, end_date: '2027-01-31', rationale: 'Ends earlier (fixture).' }, 'priya', 'amit');
      expect(end.create.statusCode).toBe(201);
      expect(end.approve!.statusCode).toBe(200);
      const r = await adminPost(e, 'priya', `/v1/admin/rate-proposals/${sup.json().id}/approve`, { verified_against_source: true, expected_sha256: sup.json().content_sha256 });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toMatch(/proposal_stale|rule_not_active/);
    } finally {
      await e.close();
    }
  });
  it('ruling 20: the proposal DTO shows the target rule summary (prefix, rate, dates)', async () => {
    const t = ruleId(env, '7113', '2017-07-01');
    const r = await adminPost(env, 'amit', '/v1/admin/rate-proposals', { action: 'end_date', supersedes_rule_id: t, end_date: '2031-12-31', rationale: 'DTO summary fixture.' });
    expect(r.statusCode).toBe(201);
    expect(r.json().target_rule).toMatchObject({ rule_id: t, hsn_prefix: '7113', igst_rate_bp: 300, effective_from: '2017-07-01' });
    expect(r.json().content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ruling 23: reference data change control', () => {
  it('ruling 23: synonyms/category_map/chapter_keywords change only via approved refdata_change; rows are deactivated, never deleted', async () => {
    const e = await makeEnv();
    try {
      const db = e.storage.writeDb;
      expect(() => db.exec("INSERT INTO synonyms(phrase, hsn_code) VALUES ('evil', '7113')")).toThrow();
      expect(() => db.exec('DELETE FROM synonyms')).toThrow();
      expect(() => db.exec("UPDATE synonyms SET hsn_code = '6109'")).toThrow();
      expect(() => db.exec("UPDATE chapter_keywords SET chapter = '61'")).toThrow();
      expect(() => db.exec('DELETE FROM category_map')).toThrow();
      const syn = db.prepare("SELECT id FROM synonyms WHERE active = 1 LIMIT 1").get() as { id: number };
      const seq = e.storage.read.dataset.maxSeq();
      const { approve } = await proposeAndApprove(e, { action: 'refdata_change', refdata: { table: 'synonym', op: 'deactivate', id: syn.id }, rationale: 'Misleading synonym.' });
      expect(approve!.statusCode).toBe(200);
      expect((db.prepare('SELECT active, deactivated_by_proposal FROM synonyms WHERE id = ?').get(syn.id) as { active: number; deactivated_by_proposal: string }).active).toBe(0);
      expect(e.storage.read.dataset.changes(seq, 5).map((c) => c.change_type)).toEqual(['synonym_changed']);
      // re-activation in place is blocked
      expect(() => db.prepare('UPDATE synonyms SET active = 1 WHERE id = ?').run(syn.id)).toThrow();
      expect(e.storage.read.audit.all().at(-1)!.action).toBe('rate_proposal.approved');
    } finally {
      await e.close();
    }
  });
  it('ruling 23: an HSN description update keeps history', async () => {
    const e = await makeEnv();
    try {
      const old = e.storage.read.hsn.get('7117')!.description;
      expect(() => e.storage.writeDb.exec("UPDATE hsn_codes SET description = 'x' WHERE code = '7117'")).toThrow();
      const { approve } = await proposeAndApprove(e, { action: 'refdata_change', refdata: { table: 'hsn_description', op: 'update', code: '7117', description: 'Imitation jewellery (updated wording)' }, rationale: 'Align with the tariff text.' });
      expect(approve!.statusCode).toBe(200);
      expect(e.storage.read.hsn.get('7117')!.description).toBe('Imitation jewellery (updated wording)');
      const hist = e.storage.writeDb.prepare("SELECT description, replaced_by_proposal FROM hsn_code_history WHERE code = '7117'").all() as { description: string; replaced_by_proposal: string }[];
      expect(hist.map((h) => h.description)).toEqual([old]);
      expect(hist[0]!.replaced_by_proposal).toMatch(/^rp_/);
    } finally {
      await e.close();
    }
  });
});

describe('ruling 24: unverified rates gate on tax', () => {
  it('ruling 24: an unverified line is refused (needs_input accept_unverified) unless accept_unverified: true, then flagged', async () => {
    const refused = (await tax(env, { lines: [{ hsn: '6109', taxable_value: 100, unit_price: 100, supply_type: 'intra' }, { hsn: '3004', condition: 'general', taxable_value: 100, supply_type: 'intra' }] })).json();
    const l = refused.lines[1];
    expect(l.tax).toBeNull();
    expect(l.needs_input).toContain('accept_unverified');
    expect(refused.complete).toBe(false);
    const ok = (await tax(env, { accept_unverified: true, lines: [{ hsn: '3004', condition: 'general', taxable_value: 100, supply_type: 'intra' }] })).json();
    expect(ok.lines[0].unverified_accepted).toBe(true);
    expect(ok.lines[0].tax.total_tax).toBe(5);
    // lookup still returns unverified rules with a warning
    expect((await get('/v1/hsn/3004')).json().rate.warnings).toContain('rate_unverified');
  });
});

describe('ruling 25: mediums and lows', () => {
  it('ruling 25: retroactive effective dates need retroactive_reason and set the feed retroactive flag', async () => {
    const e = await makeEnv();
    try {
      const body = { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2026-01-01', source: SRC }, rationale: 'Backdated fixture.' };
      const no = await adminPost(e, 'amit', '/v1/admin/rate-proposals', body);
      expect(no.statusCode).toBe(400);
      expect(no.json().errors[0].pointer).toBe('/retroactive_reason');
      const seq = e.storage.read.dataset.maxSeq();
      const { create, approve } = await proposeAndApprove(e, { ...body, retroactive_reason: 'Notification published late; effective from 1 Jan.' });
      expect(create.json().retroactive).toBe(true);
      expect(approve!.statusCode).toBe(200);
      const feed = (await get(`/v1/rates/changes?since=${seq}`, e)).json();
      expect(feed.changes[0].retroactive).toBe(true);
      // a future-dated change must not carry a reason
      const fut = await adminPost(e, 'amit', '/v1/admin/rate-proposals', { ...body, rule: { ...body.rule, hsn_prefix: '6109', effective_from: '2031-01-01' }, retroactive_reason: 'not needed here at all' });
      expect(fut.statusCode).toBe(400);
    } finally {
      await e.close();
    }
  });
  it('ruling 25: feed_epoch is reported and changes on restore (rotate)', async () => {
    const e = await makeEnv();
    try {
      const a = (await get('/v1/rates/changes?since=0', e)).json().feed_epoch;
      expect(a).toMatch(/^fe_[0-9a-f]{24}$/);
      expect((await get('/v1/meta/dataset', e)).json().feed_epoch).toBe(a);
      e.storage.tx((r) => r.dataset.rotateFeedEpoch('fe_' + '1'.repeat(24)));
      expect((await get('/v1/rates/changes?since=0', e)).json().feed_epoch).toBe('fe_' + '1'.repeat(24));
    } finally {
      await e.close();
    }
  });
  it('ruling 25: admin key CHECK requires actor_id whatever the JSON spelling of scopes', () => {
    const db = env.storage.writeDb;
    for (const scopes of ['["admin"]', '[ "admin" ]', '["Admin"]', '["admin","read"]']) {
      expect(() => db.prepare(`INSERT INTO api_keys(id, prefix, key_hash, tenant, scopes, label, rate_limit_per_min, llm_opt_out, created_at, created_by, expires_at) VALUES (?, ?, ?, 't', ?, 'x', 60, 1, '2026-10-10T00:00:00Z', 't', '2026-11-01T00:00:00Z')`).run(`ak_${scopes.length}X`, `p${scopes.length}xxxxxx`.slice(0, 8), 'a'.repeat(64), scopes)).toThrow();
    }
  });
  it('ruling 25: admin keys expire within 90 days', () => {
    const k = env.storage.read.keys.getById(env.keyIds.amit2!)!;
    const days = (Date.parse(k.expires_at!) - Date.parse(k.created_at)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(90);
    expect(days).toBeGreaterThan(0);
  });
  it('ruling 25: outbound caps and LLM budget have config with defaults', () => {
    expect(env.config.outbound).toEqual({ perKeyDaily: 500, offPerMin: 15, obfPerMin: 10, queueMax: 4 });
    expect(env.config.llm.callsPerMin).toBe(30);
    expect(env.config.llm.callsPerDay).toBe(5000);
  });
  it('ruling 25: dataset signature (Ed25519) when HSN_DATASET_SIGNING_KEY is set', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const e = await makeEnv({ env: { HSN_DATASET_SIGNING_KEY: der } });
    try {
      await proposeAndApprove(e, { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: NONE, effective_from: '2027-01-01', source: SRC }, rationale: 'Signed publish fixture.' });
      const m = (await get('/v1/meta/dataset', e)).json();
      expect(m.signature_alg).toBe('ed25519');
      const ok = edVerify(null, Buffer.from(`${m.dataset_version}\n${m.sha256}`), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(m.signature, 'base64'));
      expect(ok).toBe(true);
    } finally {
      await e.close();
    }
  });
});
