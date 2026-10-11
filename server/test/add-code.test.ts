/**
 * Adding HSN/SAC codes after the seed: refdata_change op add_code (maker–checker, audited; ruling 23 extended).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeEnv, proposeAndApprove, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

const propose = (body: object, key = 'amit') =>
  env.admin.inject({ method: 'POST', url: '/v1/admin/rate-proposals', headers: bearer(env.keys[key]!), payload: { action: 'refdata_change', rationale: 'New tariff item from the Finance Act.', ...body } });
const get = (url: string) => env.app.inject({ method: 'GET', url, headers: bearer(env.keys['read']!) });

describe('refdata_change add_code', () => {
  it('maker proposes, a different checker approves: code inserted with its parent, FTS updated, feed hsn_added, audited, new dataset version', async () => {
    const before = (await get('/v1/meta/dataset')).json();
    const seq = env.storage.read.dataset.maxSeq();
    const { create, approve } = await proposeAndApprove(env, {
      action: 'refdata_change',
      refdata: { table: 'hsn_code', op: 'add_code', code: '71131920', description: 'Articles of jewellery of silver, studded with lab-grown stones (illustrative)', keywords: 'labgrown silverjewellery' },
      rationale: 'New 8-digit tariff item (illustrative test data).',
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().payload).toMatchObject({ table: 'hsn_code', op: 'add_code', code: '71131920', parent: '711319', level: 8, type: 'goods' });
    expect(approve!.statusCode).toBe(200);
    const row = env.storage.read.hsn.get('71131920')!;
    expect(row).toMatchObject({ code: '71131920', parent: '711319', chapter: '71', level: 8, type: 'goods' });
    expect(row.added_in_version).toBe(approve!.json().resulting_dataset_version);
    // FTS index follows (insert trigger)
    const s = (await get('/v1/hsn/search?q=labgrown')).json();
    expect(s.results.map((r: { code: string }) => r.code)).toContain('71131920');
    // lookup works and inherits the 7113 rule
    const look = await get('/v1/hsn/71131920');
    expect(look.statusCode).toBe(200);
    expect(look.json().code).toBe('71131920');
    expect(env.storage.read.dataset.changes(seq, 5).map((c) => [c.change_type, c.hsn_prefix])).toEqual([['hsn_added', '71131920']]);
    const audit = env.storage.read.audit.all().at(-1)!;
    expect(audit).toMatchObject({ action: 'rate_proposal.approved', actor: 'priya' });
    expect(audit.details['payload']).toMatchObject({ op: 'add_code', code: '71131920' });
    const after = (await get('/v1/meta/dataset')).json();
    expect(after.dataset_version).not.toBe(before.dataset_version);
    expect(after.content_sha256).not.toBe(before.content_sha256);
    expect(after.coverage.hsn_codes).toBe(before.coverage.hsn_codes + 1);
  });

  it('SAC: a 5-digit 99xxx group and a 6-digit service under it; type must match the chapter', async () => {
    const g = await proposeAndApprove(env, { action: 'refdata_change', refdata: { table: 'hsn_code', op: 'add_code', code: '99973', description: 'Leasing or rental services without operator (illustrative)' }, rationale: 'Add SAC group.' });
    expect(g.approve!.statusCode).toBe(200);
    expect(env.storage.read.hsn.get('99973')).toMatchObject({ parent: '9997', level: 5, type: 'service' });
    const c = await propose({ refdata: { table: 'hsn_code', op: 'add_code', code: '999731', description: 'Leasing of machinery (illustrative)' } });
    expect(c.statusCode).toBe(201);
    expect(c.json().payload.parent).toBe('99973');
    const wrongType = await propose({ refdata: { table: 'hsn_code', op: 'add_code', code: '999799', description: 'x service', type: 'goods' } });
    expect(wrongType.statusCode).toBe(400);
  });

  it('rejects invalid lengths, existing codes, missing parents, duplicates of a pending add, and bad ops', async () => {
    const bad = async (refdata: object, code?: string) => {
      const r = await propose({ refdata });
      expect(r.statusCode).toBe(400);
      if (code) expect(JSON.stringify(r.json())).toContain(code);
    };
    await bad({ table: 'hsn_code', op: 'add_code', code: '711', description: 'three digits' });
    await bad({ table: 'hsn_code', op: 'add_code', code: '7113191', description: 'seven digits' });
    await bad({ table: 'hsn_code', op: 'add_code', code: '71131', description: 'five digits outside chapter 99' });
    await bad({ table: 'hsn_code', op: 'add_code', code: '7113', description: 'exists' }, 'duplicate');
    await bad({ table: 'hsn_code', op: 'add_code', code: '5208', description: 'chapter 52 missing' }, 'unknown_parent');
    await bad({ table: 'hsn_code', op: 'add_code', code: '01011010', description: 'chapter 01 missing' }, 'unknown_parent');
    await bad({ table: 'hsn_code', op: 'add_code', code: '71151000', description: 'heading 7115 missing' }, 'unknown_parent');
    await bad({ table: 'hsn_code', op: 'deactivate', id: 1 });
    await bad({ table: 'hsn_description', op: 'deactivate', id: 1 });
    // a second pending proposal for the same code
    const first = await propose({ refdata: { table: 'hsn_code', op: 'add_code', code: '85171400', description: 'Other telephones for cellular networks (illustrative)' } });
    expect(first.statusCode).toBe(201);
    await bad({ table: 'hsn_code', op: 'add_code', code: '85171400', description: 'again' }, 'duplicate');
  });

  it('maker cannot approve their own add_code', async () => {
    const c = await propose({ refdata: { table: 'hsn_code', op: 'add_code', code: '24021000', description: 'Cigars (illustrative)' } });
    expect(c.statusCode).toBe(201);
    const a = await env.admin.inject({
      method: 'POST', url: `/v1/admin/rate-proposals/${c.json().id}/approve`, headers: bearer(env.keys['amit2']!),
      payload: { verified_against_source: true, expected_sha256: c.json().content_sha256 },
    });
    expect(a.statusCode).toBe(403);
    expect(env.storage.read.hsn.get('24021000')).toBeNull();
  });

  it('the database refuses codes not named by an approved add_code proposal', async () => {
    const db = env.storage.writeDb;
    const version = env.storage.read.dataset.current()!.current_version;
    const ins = (code: string, by: string | null) =>
      db.prepare("INSERT INTO hsn_codes(code, level, parent, chapter, type, description, keywords, added_in_version, added_by_proposal) VALUES (?, 8, '711319', '71', 'goods', 'x', '', ?, ?)").run(code, version, by);
    expect(() => ins('71131990', null)).toThrow(/approved refdata_change add_code/);
    // an approved add_code proposal for a DIFFERENT code cannot be reused
    const other = db.prepare("SELECT id FROM rate_proposals WHERE status = 'approved' AND json_extract(payload_json, '$.code') = '71131920'").get() as { id: string };
    expect(() => ins('71131990', other.id)).toThrow(/approved refdata_change add_code/);
    // and the marker cannot be rewritten afterwards
    expect(() => db.prepare("UPDATE hsn_codes SET added_by_proposal = NULL WHERE code = '71131920'").run()).toThrow();
  });
});
