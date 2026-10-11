/**
 * Round 7: reviews/security-code-core-round4.md SA-C4-01 (key policy columns), SA-C4-02 (watched rows),
 * SA-C4-05 (lock-out message).
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { crossCheckState } from '../src/services/integrity.js';
import { SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

const post = (env: TestEnv, who: string, url: string, payload: object) => env.admin.inject({ method: 'POST', url, headers: bearer(env.keys[who]!), payload });

/** A database writer without HSN_AUDIT_KEY: drop guard triggers, write, restore them. */
function bypass(db: DatabaseSync, triggers: string[], fn: () => void): void {
  const sql = triggers.map((t) => (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(t) as { sql: string }).sql);
  for (const t of triggers) db.exec(`DROP TRIGGER ${t}`);
  try {
    fn();
  } finally {
    for (const s of sql) db.exec(s);
  }
}
const problems = (env: TestEnv) => crossCheckState(env.storage.read).problems.join('\n');

describe('SA-C4-01: API key policy columns are bound to api_key.created', () => {
  it('P1: flipping llm_opt_out, raising the rate limit, removing the quota or changing the tenant is detected', async () => {
    const env = await makeEnv();
    try {
      const created = env.storage.read.audit.all().find((e) => e.action === 'api_key.created' && e.entity_id === env.keyIds.quota)!;
      expect(created.details).toMatchObject({ llm_opt_out: false, rate_limit_per_min: 600, daily_quota: 2, tenant: 'test' });
      expect(crossCheckState(env.storage.read).ok).toBe(true);
      const cases: [string, string][] = [
        ['llm_opt_out = 1', 'llm_opt_out'],
        ['rate_limit_per_min = 100000', 'rate_limit_per_min'],
        ['daily_quota = NULL', 'daily_quota'],
        [`tenant = 'other'`, 'tenant'],
      ];
      for (const [set, field] of cases) {
        const before = env.storage.readDb.prepare(`SELECT tenant, llm_opt_out, rate_limit_per_min, daily_quota FROM api_keys WHERE id = ?`).get(env.keyIds.quota!) as Record<string, unknown>;
        bypass(env.storage.writeDb, ['api_keys_guard_update'], () => env.storage.writeDb.prepare(`UPDATE api_keys SET ${set} WHERE id = ?`).run(env.keyIds.quota!));
        expect(problems(env)).toMatch(new RegExp(`api key ${env.keyIds.quota}.*${field} differ`));
        bypass(env.storage.writeDb, ['api_keys_guard_update'], () =>
          env.storage.writeDb.prepare(`UPDATE api_keys SET tenant = ?, llm_opt_out = ?, rate_limit_per_min = ?, daily_quota = ? WHERE id = ?`)
            .run(before['tenant'] as string, before['llm_opt_out'] as number, before['rate_limit_per_min'] as number, before['daily_quota'] as number | null, env.keyIds.quota!),
        );
        expect(crossCheckState(env.storage.read).ok).toBe(true);
      }
    } finally {
      await env.close();
    }
  });
});

describe('SA-C4-02: watched notification rows are bound to their audit history', () => {
  const GUARDS = ['watched_notifications_guard_confirm', 'watched_notifications_guard_update'];
  it('P3: a SQL dismiss or emptied prefixes of a keyed row is detected; the two-admin flow is not', async () => {
    const env = await makeEnv();
    try {
      const a = await post(env, 'amit', '/v1/admin/watched-notifications', { notification: '13/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['8517'] });
      const b = await post(env, 'amit', '/v1/admin/watched-notifications', { notification: '14/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['7113', '6109'] });
      expect(crossCheckState(env.storage.read).ok).toBe(true);
      const A = a.json().id as string;
      const B = b.json().id as string;

      bypass(env.storage.writeDb, GUARDS, () => env.storage.writeDb.prepare(`UPDATE watched_notifications SET state = 'dismissed', resolved_at = 'x', resolved_by = 'amit' WHERE id = ?`).run(A));
      expect(problems(env)).toMatch(new RegExp(`watched notification ${A}: dismissed without a watched_notification.dismissed audit entry`));
      bypass(env.storage.writeDb, GUARDS, () => env.storage.writeDb.prepare(`UPDATE watched_notifications SET affected_prefixes = '[]' WHERE id = ?`).run(B));
      expect(problems(env)).toMatch(new RegExp(`watched notification ${B}: affected_prefixes differ`));
      bypass(env.storage.writeDb, GUARDS, () => env.storage.writeDb.prepare(`UPDATE watched_notifications SET affected_prefixes = '["6109","7113"]' WHERE id = ?`).run(B));
      expect(problems(env)).not.toMatch(new RegExp(B)); // same set, any order
    } finally {
      await env.close();
    }
  });

  it('legitimate triage and two-admin dismiss keep the cross-check clean; a resolved row set back to detected is detected', async () => {
    const env = await makeEnv();
    try {
      const a = await post(env, 'amit', '/v1/admin/watched-notifications', { notification: '15/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['8517'] });
      const A = a.json().id as string;
      expect((await post(env, 'amit', `/v1/admin/watched-notifications/${A}/triage`, { affected_prefixes: ['8517', '7113'] })).statusCode).toBe(200);
      expect((await post(env, 'amit', `/v1/admin/watched-notifications/${A}/resolve`, { state: 'published' })).statusCode).toBe(202);
      expect((await post(env, 'priya', `/v1/admin/watched-notifications/${A}/resolve`, { state: 'published' })).statusCode).toBe(200);
      expect(crossCheckState(env.storage.read)).toMatchObject({ ok: true, problems: [] });
      bypass(env.storage.writeDb, ['watched_notifications_guard_confirm', 'watched_notifications_guard_update'], () =>
        env.storage.writeDb.prepare(`UPDATE watched_notifications SET state = 'detected', resolved_at = NULL, resolved_by = NULL WHERE id = ?`).run(A),
      );
      expect(problems(env)).toMatch(new RegExp(`watched notification ${A}: still detected, but the audit log records watched_notification.published`));
    } finally {
      await env.close();
    }
  });
});

describe('SA-C4-05: the API lock-out message no longer points to the host script', () => {
  it('disable_actor with two active admins → 400 last_actors without the disable-actor.ts hint', async () => {
    const env = await makeEnv();
    try {
      const r = await post(env, 'amit', '/v1/admin/rate-proposals', { action: 'disable_actor', disable: { handle: 'priya' }, rationale: 'drill: lock-out guidance' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(/grant a third admin first/);
      expect(r.body).not.toMatch(/disable-actor\.ts/);
    } finally {
      await env.close();
    }
  });
});
