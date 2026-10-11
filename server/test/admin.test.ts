import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, proposeAndApprove, AUDIT_KEY, PDF_SHA, SRC_URL, type TestEnv } from './helpers.js';
import { verifyChain, GENESIS_HASH } from '../src/services/audit.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const SRC = { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' };
const COND_NONE = { kind: 'none', text: null, min_unit_price: null, max_unit_price: null };
const post = (key: string, url: string, payload: object, headers: Record<string, string> = {}) =>
  env.admin.inject({ method: 'POST', url, headers: { ...bearer(env.keys[key]!), ...headers }, payload });
const ruleIdFor = (prefix: string, from: string, bp?: number) =>
  (env.storage.writeDb.prepare('SELECT rule_id FROM rate_rules WHERE hsn_prefix = ? AND effective_from = ? AND (? IS NULL OR igst_rate_bp = ?)').get(prefix, from, bp ?? null, bp ?? null) as { rule_id: string }).rule_id;
const shaOf = (id: string) => env.storage.read.proposals.get(id)!.content_sha256;

describe('maker–checker', () => {
  let proposalId = '';
  const decide = (id: string, extra: object = {}) => ({ verified_against_source: true, expected_sha256: shaOf(id), ...extra });

  it('maker creates a supersede proposal (201, pending, audit entry)', async () => {
    const old = ruleIdFor('7113', '2017-07-01');
    const res = await post('amit', '/v1/admin/rate-proposals', {
      action: 'supersede',
      supersedes_rule_id: old,
      rule: { hsn_prefix: '7113', igst_rate_bp: 500, condition: COND_NONE, effective_from: '2026-11-01', effective_to: null, source: SRC },
      rationale: 'Fixture: rate change for jewellery from 1 Nov 2026.',
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.id).toMatch(/^rp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(p.status).toBe('pending');
    expect(p.proposed_by).toBe('amit');
    expect(res.headers.location).toBe(`/v1/admin/rate-proposals/${p.id}`);
    proposalId = p.id;
    // nothing published yet
    const live = (await env.app.inject({ method: 'GET', url: '/v1/hsn/7113?date=2026-11-02', headers: bearer(env.keys.read!) })).json();
    expect(live.rate.applicable_rule.igst_rate_bp).toBe(300);
  });

  it('same actor cannot approve, even with a different key → 403 maker-checker-violation', async () => {
    for (const k of ['amit', 'amit2']) {
      const res = await post(k, `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId));
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe('https://hsn-api.example/problems/maker-checker-violation');
    }
    expect((await post('amit2', `/v1/admin/rate-proposals/${proposalId}/reject`, { reason: 'self reject', expected_sha256: shaOf(proposalId) })).statusCode).toBe(403);
  });

  it('approval requires verified_against_source: true', async () => {
    expect((await post('priya', `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId, { verified_against_source: false }))).statusCode).toBe(400);
    // ruling 20: a wrong expected_sha256 is refused
    const bad = await post('priya', `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId, { expected_sha256: 'b'.repeat(64) }));
    expect(bad.statusCode).toBe(409);
    expect(bad.json().code ?? bad.json().type).toMatch(/proposal_hash_mismatch|proposal-hash-mismatch/);
  });

  it('a different actor approves: rule + end-date + feed + version bump + audit in one transaction', async () => {
    const before = env.storage.read.dataset.current()!;
    const etagBefore = (await env.app.inject({ method: 'GET', url: '/v1/hsn/7113', headers: bearer(env.keys.read!) })).headers.etag;
    env.clock.advance(60_000);
    const res = await post('priya', `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId, { comment: 'Checked the notification.' }), { 'idempotency-key': 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.status).toBe('approved');
    expect(p.decided_by).toBe('priya');
    expect(p.resulting_rule_id).toMatch(/^rr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(p.resulting_dataset_version).not.toBe(before.current_version);
    const after = env.storage.read.dataset.current()!;
    expect(after.current_version).toBe(p.resulting_dataset_version);

    const read = (url: string) => env.app.inject({ method: 'GET', url, headers: bearer(env.keys.read!) });
    const oldDay = (await read('/v1/hsn/7113?date=2026-10-31')).json().rate.applicable_rule;
    const newDay = (await read('/v1/hsn/7113?date=2026-11-01')).json().rate.applicable_rule;
    expect(oldDay.igst_rate_bp).toBe(300);
    expect(oldDay.effective_to).toBe('2026-10-31');
    expect(newDay.igst_rate_bp).toBe(500);
    expect(newDay.verification_status).toBe('verified');
    expect(newDay.verified_by).toBe('priya');

    const feed = (await read(`/v1/rates/changes?since=${before.last_change_seq}`)).json();
    expect(feed.changes.map((c: { change_type: string }) => c.change_type)).toEqual(['rule_end_dated', 'rule_added']);
    expect(feed.changes[1].seq).toBe(feed.changes[0].seq + 1);
    expect(feed.next_since).toBe(feed.changes[1].seq);
    expect(feed.current_dataset_version).toBe(after.current_version);

    const etagAfter = (await read('/v1/hsn/7113')).headers.etag;
    expect(etagAfter).not.toBe(etagBefore);

    const audit = env.storage.read.audit.all();
    expect(audit.at(-1)!.action).toBe('rate_proposal.approved');
    expect(audit.at(-1)!.actor).toBe('priya');
  });

  it('re-approving with the same Idempotency-Key replays (200); without it → 409 not pending', async () => {
    const again = await post('priya', `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId, { comment: 'Checked the notification.' }), { 'idempotency-key': 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await post('priya', `/v1/admin/rate-proposals/${proposalId}/approve`, decide(proposalId))).statusCode).toBe(409);
    expect((await post('priya', `/v1/admin/rate-proposals/${proposalId}/reject`, { reason: 'too late now', expected_sha256: shaOf(proposalId) })).statusCode).toBe(409);
  });

  it('list proposals by status', async () => {
    const r = await env.admin.inject({ method: 'GET', url: '/v1/admin/rate-proposals?status=approved', headers: bearer(env.keys.priya!) });
    expect(r.statusCode).toBe(200);
    expect(r.json().proposals.map((p: { id: string }) => p.id)).toContain(proposalId);
  });
});

describe('proposal validation', () => {
  const create = (rule: object, extra: object = {}) =>
    post('amit', '/v1/admin/rate-proposals', { action: 'create', rule, rationale: 'Fixture proposal for validation.', ...extra });
  const base = { hsn_prefix: '8517', igst_rate_bp: 1800, condition: COND_NONE, effective_from: '2027-01-01', source: SRC };

  it('overlapping rule → 409 overlapping-rule', async () => {
    const res = await create({ ...base, hsn_prefix: '9988' });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://hsn-api.example/problems/overlapping-rule');
  });

  it('non-allowed slab (1700 bp) → 400', async () => {
    expect((await create({ ...base, igst_rate_bp: 1700 })).statusCode).toBe(400);
  });

  it('source url on a non-allow-listed host or http → 400', async () => {
    for (const url of ['https://evil.example/n.pdf', 'http://cbic-gst.gov.in/x', 'https://cbic-gst.gov.in.evil.com/x', 'https://cbic-gst.gov.in./', 'https://user@cbic-gst.gov.in/x']) {
      const res = await create({ ...base, source: { ...SRC, url } });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].pointer).toBe('/rule/source/url');
    }
  });

  it('missing citation → 400', async () => {
    const { source: _s, ...noSource } = base;
    expect((await create(noSource)).statusCode).toBe(400);
  });

  it('price condition needs bounds and text', async () => {
    expect((await create({ ...base, condition: { kind: 'price', text: null, min_unit_price: null, max_unit_price: null } })).statusCode).toBe(400);
  });

  it('unknown field in body or rule → 400', async () => {
    expect((await create({ ...base, verification_status: 'verified' })).statusCode).toBe(400);
    expect((await create(base, { status: 'approved' })).statusCode).toBe(400);
  });

  it('idempotency: same key + same body → replay; different body → 409', async () => {
    const key = '3f2c1d2e-1111-4a4a-9b9b-0123456789ab';
    const body = { action: 'create', rule: { ...base, effective_from: '2027-02-01' }, rationale: 'Idempotency fixture proposal.' };
    const a = await post('amit', '/v1/admin/rate-proposals', body, { 'idempotency-key': key });
    const b = await post('amit', '/v1/admin/rate-proposals', body, { 'idempotency-key': key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const c = await post('amit', '/v1/admin/rate-proposals', { ...body, rationale: 'Different body, same key.' }, { 'idempotency-key': key });
    expect(c.statusCode).toBe(409);
    // a second pending proposal overlapping the first → 409
    expect((await create({ ...base, effective_from: '2027-03-01' })).statusCode).toBe(409);
  });

  it('verify action: only verification fields change and rule_verified is emitted', async () => {
    const target = ruleIdFor('3004', '2025-09-22', 500);
    // ruling 12: verify needs the PDF hash and schedule serial
    expect((await post('amit', '/v1/admin/rate-proposals', { action: 'verify', supersedes_rule_id: target, rationale: 'Checked 3004 against the PDF.' })).statusCode).toBe(400);
    // ruling 36: the fixture rule cites an index page, so the verify must name the notification document
    const noUrl = await post('amit', '/v1/admin/rate-proposals', { action: 'verify', supersedes_rule_id: target, source: { pdf_sha256: PDF_SHA, schedule_serial: 'I-63' }, rationale: 'Checked 3004 against the PDF.' });
    expect(noUrl.statusCode).toBe(400);
    expect(noUrl.json().type).toMatch(/source-url-not-document/);
    const created = await post('amit', '/v1/admin/rate-proposals', { action: 'verify', supersedes_rule_id: target, source: { pdf_sha256: PDF_SHA, schedule_serial: 'I-63', url: SRC_URL }, rationale: 'Checked 3004 against the PDF.' });
    expect(created.statusCode).toBe(201);
    const seqBefore = env.storage.read.dataset.maxSeq();
    const ok = await post('priya', `/v1/admin/rate-proposals/${created.json().id}/approve`, { verified_against_source: true, expected_sha256: created.json().content_sha256 });
    expect(ok.statusCode).toBe(200);
    const row = env.storage.read.rules.get(target)!;
    expect(row.verification_status).toBe('verified');
    expect(row.igst_rate_bp).toBe(500);
    expect(row.verified_by).toBe('priya');
    expect(row.source_pdf_sha256).toBe(PDF_SHA);
    expect(row.schedule_serial).toBe('I-63');
    expect(row.source_url).toBe(SRC_URL);
    const feed = env.storage.read.dataset.changes(seqBefore, 10);
    expect(feed.map((c) => c.change_type)).toEqual(['rule_verified']);
  });

  it('kill switch HSN_ADMIN_WRITES_ENABLED=false → 503', async () => {
    const e2 = await (await import('./helpers.js')).makeEnv({ env: { HSN_ADMIN_WRITES_ENABLED: 'false' } });
    const r = await e2.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(e2.keys.amit!), payload: { action: 'create', rule: base, rationale: 'kill switch check' } });
    expect(r.statusCode).toBe(503);
    await e2.close();
  });
});

describe('approval is atomic', () => {
  it('a conflict discovered at approval time rolls back everything (no rule, no feed row, no version bump)', async () => {
    const created = await post('amit', '/v1/admin/rate-proposals', {
      action: 'create',
      rule: { hsn_prefix: '2402', igst_rate_bp: 2800, condition: COND_NONE, effective_from: '2030-01-01', source: SRC },
      rationale: 'Will conflict with an older rule at approval.',
    });
    // 2402 already has an open-ended rule from 2017 → this create overlaps; creation must have been refused
    expect(created.statusCode).toBe(409);

    // a separate env: the conflicting row is planted by dropping the insert guard (simulating a raw import)
    const e2 = await makeEnv();
    try {
      const ok = await e2.admin.inject({
        method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(e2.keys.amit!),
        payload: { action: 'create', rule: { hsn_prefix: '8517', igst_rate_bp: 1800, condition: COND_NONE, effective_from: '2028-01-01', source: SRC }, rationale: 'Phones from 2028 (fixture).' },
      });
      expect(ok.statusCode).toBe(201);
      const ds = e2.storage.read.dataset.current()!;
      const sb = (e2.storage.writeDb.prepare('SELECT id FROM seed_batches').get() as { id: string }).id;
      e2.storage.writeDb.exec('DROP TRIGGER rate_rules_guard_insert');
      e2.storage.writeDb
        .prepare(
          `INSERT INTO rate_rules(rule_id, hsn_prefix, igst_rate_bp, effective_from, notification_ref, source_url, created_in_version, seed_batch_id)
           VALUES ('rr_CONFLICT', '8517', 1200, '2027-06-01', 'x', 'https://cbic-gst.gov.in/x', ?, ?)`,
        )
        .run(ds.current_version, sb);
      const seqBefore = e2.storage.read.dataset.maxSeq();
      const auditBefore = e2.storage.read.audit.head()!.id;
      const res = await e2.admin.inject({
        method: 'POST', url: `/v1/admin/rate-proposals/${ok.json().id}/approve`, headers: bearer(e2.keys.priya!),
        payload: { verified_against_source: true, expected_sha256: ok.json().content_sha256 },
      });
      expect(res.statusCode).toBe(409);
      expect(e2.storage.read.dataset.current()!.current_version).toBe(ds.current_version);
      expect(e2.storage.read.dataset.maxSeq()).toBe(seqBefore);
      expect(e2.storage.read.audit.head()!.id).toBe(auditBefore);
      expect(e2.storage.read.rules.byPrefix('8517').map((r) => r.rule_id)).toEqual(['rr_CONFLICT']);
      expect(e2.storage.read.proposals.get(ok.json().id)!.status).toBe('pending');
    } finally {
      await e2.close();
    }
  });
});

describe('integrity triggers (append-only, immutable rules)', () => {
  const db = () => env.storage.writeDb;
  it('rate fields cannot be updated; rules cannot be deleted', () => {
    const id = ruleIdFor('9988', '2017-07-01');
    expect(() => db().prepare('UPDATE rate_rules SET igst_rate_bp = 1800 WHERE rule_id = ?').run(id)).toThrow(/immutable/);
    expect(() => db().prepare('DELETE FROM rate_rules WHERE rule_id = ?').run(id)).toThrow(/delete not allowed/);
  });
  it('verified → unverified is blocked', () => {
    const id = ruleIdFor('9988', '2017-07-01');
    expect(() => db().prepare("UPDATE rate_rules SET verification_status = 'unverified', verified_by = NULL, last_verified_at = NULL WHERE rule_id = ?").run(id)).toThrow();
  });
  it('change_feed and audit_log are append-only', () => {
    expect(() => db().exec('UPDATE change_feed SET summary = 1')).toThrow(/append-only/);
    expect(() => db().exec('DELETE FROM change_feed')).toThrow(/append-only/);
    expect(() => db().exec("UPDATE audit_log SET actor = 'x'")).toThrow(/append-only/);
    expect(() => db().exec('DELETE FROM audit_log')).toThrow(/append-only/);
  });
  it('the request-handling connection is read-only', () => {
    expect(() => env.storage.readDb.exec("INSERT INTO chapter_keywords VALUES ('x','71')")).toThrow();
  });
});

describe('audit hash chain', () => {
  it('verify=true reports chain_ok for an intact log', async () => {
    const r = await env.admin.inject({ method: 'GET', url: '/v1/admin/audit?verify=true&limit=500', headers: bearer(env.keys.priya!) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.chain_ok).toBe(true);
    expect(b.entries[0].prev_hash).toBe(GENESIS_HASH);
    expect(b.entries.length).toBeGreaterThan(5);
  });

  it('tampering with a row (raw edit bypassing triggers) is detected at that id', async () => {
    const db = env.storage.writeDb;
    const target = env.storage.read.audit.all()[2]!;
    db.exec('DROP TRIGGER audit_no_update');
    db.prepare("UPDATE audit_log SET actor = 'mallory' WHERE id = ?").run(target.id);
    const r = await env.admin.inject({ method: 'GET', url: '/v1/admin/audit?verify=true&limit=500', headers: bearer(env.keys.priya!) });
    expect(r.json().chain_ok).toBe(false);
    expect(r.json().chain_broken_at).toBe(target.id);
    // a page that starts after the tampered row still verifies its own links
    const later = await env.admin.inject({ method: 'GET', url: `/v1/admin/audit?verify=true&after_id=${target.id}`, headers: bearer(env.keys.priya!) });
    expect(later.json().chain_ok).toBe(true);
    // deleting a row breaks the link
    const all = env.storage.read.audit.all();
    expect(verifyChain(AUDIT_KEY, [all[0]!, all[2]!], GENESIS_HASH).ok).toBe(false);
  });
});
