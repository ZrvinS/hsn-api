/**
 * Round 6: fixes for reviews/security-code-core-round3.md (SA-C3-01 … SA-C3-08). The SA-C3-03 regressions
 * (X5 manual pre-emption, X6 first triage) live with the SA-C2-03 tests in core-round4.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp, createSharedState } from '../src/app.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { crossCheckState } from '../src/services/integrity.js';
import { disableActorInTx } from '../src/services/proposals.js';
import { revokeApiKey } from '../src/services/apiKeys.js';
import { seedRuleId } from '../src/db/seed.js';
import { disableActorCli } from '../scripts/disable-actor.js';
import { ackRestoreCli } from '../scripts/ack-restore.js';
import { AUDIT_KEY, FIXTURE_DIR, LOG_KEY, LogCapture, PDF_SHA, PEPPER, SRC_URL, bearer, makeEnv, type TestEnv } from './helpers.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
const post = (env: TestEnv, who: string, url: string, payload: object) => env.admin.inject({ method: 'POST', url, headers: bearer(env.keys[who]!), payload });
const cliEnv = (env: TestEnv) => ({ NODE_ENV: 'test', HSN_DB_PATH: env.config.dbPath, HSN_KEY_PEPPER: PEPPER, HSN_AUDIT_KEY: AUDIT_KEY, HSN_LOG_KEY: LOG_KEY });
const quiet = <T>(fn: () => T): T => {
  const e = console.error;
  const l = console.log;
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.error = e;
    console.log = l;
  }
};

/** What a database writer WITHOUT HSN_AUDIT_KEY can do: drop a guard trigger, write, put the trigger back. */
function bypass(db: DatabaseSync, triggers: string[], fn: () => void): void {
  const sql = triggers.map((t) => (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(t) as { sql: string }).sql);
  for (const t of triggers) db.exec(`DROP TRIGGER ${t}`);
  try {
    fn();
  } finally {
    for (const s of sql) db.exec(s);
  }
}

async function readyz(env: TestEnv) {
  const logs = new LogCapture();
  const app = await buildApp({ config: env.config, storage: env.storage, clock: env.clock, shared: createSharedState(env.config, env.clock), surface: 'public', logStream: logs });
  const r = await app.inject({ method: 'GET', url: '/readyz' });
  await app.close();
  return { status: r.statusCode, logs: logs.text() };
}

const rule = (bp: number) => ({
  hsn_prefix: '7117', igst_rate_bp: bp, effective_from: '2026-12-01',
  condition: { kind: 'none', text: null, min_unit_price: null, max_unit_price: null },
  source: { notification: '09/2025-Central Tax (Rate), Schedule I', url: SRC_URL, pdf_sha256: PDF_SHA, schedule_serial: 'I-1' },
});

// ------------------------------------------------------------------------------------------------ SA-C3-01

describe('SA-C3-01: a pending proposal swapped after review cannot be approved, and a swap after approval is detected', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  it('X1: rule_json edited (hash kept) → approval with the reviewed hash is 409 proposal_hash_mismatch; nothing published', async () => {
    const c = await post(env, 'amit', '/v1/admin/rate-proposals', { action: 'create', rule: rule(1800), rationale: 'Amend 7117 to 18% from December.' });
    expect(c.statusCode).toBe(201);
    const { id, content_sha256 } = c.json() as { id: string; content_sha256: string };
    bypass(env.storage.writeDb, ['rate_proposals_guard_update'], () => {
      env.storage.writeDb.prepare(`UPDATE rate_proposals SET rule_json = json_set(rule_json, '$.igst_rate_bp', 0) WHERE id = ?`).run(id);
    });
    // the cross-check already sees the pending swap
    expect(crossCheckState(env.storage.read).problems.join('\n')).toMatch(new RegExp(`proposal ${id}: stored content does not hash`));
    const versionBefore = env.storage.read.dataset.current()!.current_version;
    const a = await post(env, 'priya', `/v1/admin/rate-proposals/${id}/approve`, { verified_against_source: true, expected_sha256: content_sha256 });
    expect(a.statusCode).toBe(409);
    expect(a.json().type).toMatch(/proposal-hash-mismatch/);
    expect(env.storage.read.proposals.get(id)!.status).toBe('pending');
    expect(env.storage.read.dataset.current()!.current_version).toBe(versionBefore);
  });

  it('an approved proposal edited afterwards (content and hash recomputed) no longer matches its HMAC\'d created entry', async () => {
    const env2 = await makeEnv();
    try {
      const c = await post(env2, 'amit', '/v1/admin/rate-proposals', { action: 'create', rule: rule(1200), rationale: 'Amend 7117 to 12% from December.' });
      const { id, content_sha256 } = c.json() as { id: string; content_sha256: string };
      expect((await post(env2, 'priya', `/v1/admin/rate-proposals/${id}/approve`, { verified_against_source: true, expected_sha256: content_sha256 })).statusCode).toBe(200);
      expect(crossCheckState(env2.storage.read)).toMatchObject({ ok: true });
      const { proposalContentSha256 } = await import('../src/services/proposals.js');
      const p = env2.storage.read.proposals.get(id)!;
      const forged = { ...p, rule: { ...p.rule!, igst_rate_bp: 0 } };
      bypass(env2.storage.writeDb, ['rate_proposals_guard_update'], () => {
        env2.storage.writeDb.prepare(`UPDATE rate_proposals SET rule_json = ?, content_sha256 = ? WHERE id = ?`).run(JSON.stringify(forged.rule), proposalContentSha256(forged), id);
      });
      const x = crossCheckState(env2.storage.read);
      expect(x.ok).toBe(false);
      expect(x.problems.join('\n')).toMatch(/content_sha256 differs from its rate_proposal.created audit entry|stored rule\/payload differs/);
    } finally {
      await env2.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SA-C3-02

describe('SA-C3-02: revocation, disablement and decisions cannot be reversed behind the audit log', () => {
  it('X2 un-revoked key and X3 re-enabled actor → cross-check problems', async () => {
    const env = await makeEnv();
    try {
      // X2
      expect(revokeApiKey(env.storage.tx, env.clock, AUDIT_KEY, env.keyIds.read!, 'priya')).toBe(true);
      expect(crossCheckState(env.storage.read).ok).toBe(true);
      bypass(env.storage.writeDb, ['api_keys_guard_update'], () => {
        env.storage.writeDb.prepare(`UPDATE api_keys SET revoked_at = NULL, expires_at = NULL WHERE id = ?`).run(env.keyIds.read!);
      });
      let x = crossCheckState(env.storage.read);
      expect(x.problems.join('\n')).toMatch(/revoked in the audit log but usable/);

      // X3
      env.storage.tx((repos) => disableActorInTx(repos, AUDIT_KEY, { handle: 'amit', at: '2026-10-10T06:00:00Z', by: 'priya', keyPrefix: null, note: 'incident drill', proposalId: null }));
      bypass(env.storage.writeDb, ['admin_actors_guard_update'], () => {
        env.storage.writeDb.prepare(`UPDATE admin_actors SET disabled_at = NULL WHERE handle = 'amit'`).run();
      });
      x = crossCheckState(env.storage.read);
      expect(x.problems.join('\n')).toMatch(/admin actor amit: disabled in the audit log but active/);

    } finally {
      await env.close();
    }
  });

  it('X4: a rejected proposal set back to pending is detected', async () => {
    const env = await makeEnv();
    try {
      const c = await post(env, 'priya', '/v1/admin/rate-proposals', { action: 'create', rule: rule(1800), rationale: 'Will be rejected then resurrected.' });
      const { id, content_sha256 } = c.json() as { id: string; content_sha256: string };
      expect((await post(env, 'amit', `/v1/admin/rate-proposals/${id}/reject`, { reason: 'wrong rate', expected_sha256: content_sha256 })).statusCode).toBe(200);
      expect(crossCheckState(env.storage.read).ok).toBe(true);
      bypass(env.storage.writeDb, ['rate_proposals_guard_update'], () => {
        env.storage.writeDb.prepare(
          `UPDATE rate_proposals SET status = 'pending', decided_by = NULL, decided_by_actor_id = NULL, decided_key_id = NULL, decided_at = NULL, decision_comment = NULL WHERE id = ?`,
        ).run(id);
      });
      expect(crossCheckState(env.storage.read).problems.join('\n')).toMatch(new RegExp(`proposal ${id}: pending, but the audit log records rate_proposal.rejected`));
    } finally {
      await env.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SA-C3-04

describe('SA-C3-04: a missing high-water-mark sidecar is a possible restore', () => {
  it('sidecar deleted for a database that had one → alert, epoch rotated, /readyz 503 until ack-restore', async () => {
    const env = await makeEnv();
    try {
      const f = env.config.stateHwmFile!;
      expect(existsSync(f)).toBe(true);
      expect(env.storage.read.audit.all().some((e) => e.action === 'dataset.hwm_initialised')).toBe(true);
      const epoch = env.storage.read.dataset.current()!.feed_epoch;
      unlinkSync(f);
      const r = await readyz(env);
      expect(r.status).toBe(503);
      expect(r.logs).toContain('"event":"dataset.hwm_missing"');
      expect(r.logs).toContain('"alert":true');
      expect(env.storage.read.dataset.current()!.feed_epoch).not.toBe(epoch);
      expect(env.storage.read.audit.all().at(-1)!.action).toBe('dataset.restore_detected');
      expect(quiet(() => ackRestoreCli(['--by', 'priya', '--note', 'sidecar volume was lost; state checked'], { ...cliEnv(env), HSN_STATE_HWM_FILE: f }))).toBe(0);
      expect((await readyz(env)).status).toBe(200);
    } finally {
      await env.close();
    }
  });

  it('production requires HSN_STATE_HWM_FILE outside the database directory', () => {
    const prod = { NODE_ENV: 'production', HSN_DB_PATH: '/var/lib/hsn/hsn.db', HSN_KEY_PEPPER: 'p'.repeat(40), HSN_AUDIT_KEY: 'a'.repeat(40), HSN_LOG_KEY: 'l'.repeat(40), HSN_DIRECT_EXPOSURE: 'true' };
    expect(() => loadConfig(prod)).toThrow(/HSN_STATE_HWM_FILE.*required in production/s);
    expect(() => loadConfig({ ...prod, HSN_STATE_HWM_FILE: '/var/lib/hsn/hwm.json' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, HSN_STATE_HWM_FILE: '/var/lib/hsn/../hsn/hwm.json' })).toThrow(/database's directory/);
    expect(loadConfig({ ...prod, HSN_STATE_HWM_FILE: '/var/lib/hsn-state/hwm.json' }).stateHwmFile).toBe('/var/lib/hsn-state/hwm.json');
  });
});

// ------------------------------------------------------------------------------------------------ SA-C3-05

describe('SA-C3-05: disable-actor refuses to leave fewer than two active admins', () => {
  it('with two active admins the script refuses and nothing changes', async () => {
    const env = await makeEnv();
    try {
      const errs: string[] = [];
      const e = console.error;
      console.error = (m: string) => void errs.push(String(m));
      try {
        expect(disableActorCli(['--handle', 'amit', '--by', 'priya', '--note', 'incident 9: key leaked'], cliEnv(env))).toBe(1);
      } finally {
        console.error = e;
      }
      expect(errs.join('\n')).toMatch(/fewer than two active admins would remain/);
      expect(errs.join('\n')).toMatch(/Grant a third admin first/);
      expect(errs.join('\n')).not.toMatch(/bootstrapped/);
      expect(env.storage.read.actors.byHandle('amit')!.disabled_at).toBeNull();
      expect(env.storage.read.audit.all().some((x) => x.action === 'admin.disabled')).toBe(false);
    } finally {
      await env.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SA-C3-07

describe('SA-C3-07: citation_note is covered by the cross-check (not by the content hash)', () => {
  let env: TestEnv;
  let dir: string;
  const NOTE = 'Gazette not read; schedule S.No. not verified.';
  const RULE = seedRuleId({ hsn_prefix: '3004', effective_from: '2025-09-22', condition_kind: 'none', min_unit_price_paise: null, max_unit_price_paise: null, condition_text: null });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hsn-seed-'));
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    const p = join(dir, 'rate_rules.json');
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>[] | { items: Record<string, unknown>[] };
    const items = Array.isArray(raw) ? raw : raw.items;
    for (const r of items) {
      delete r['verification_status'];
      delete r['verified_by'];
      delete r['last_verified_at'];
      if (r['hsn_prefix'] === '3004' && r['igst_rate_bp'] === 500) r['citation_note'] = NOTE;
    }
    writeFileSync(p, JSON.stringify(items));
    env = await makeEnv({ seedDir: dir });
  });
  afterAll(async () => {
    await env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the seed audit entry records the notes; editing or removing one without a verify is a cross-check problem; the content hash is unchanged', () => {
    const seeded = env.storage.read.audit.all().find((e) => e.action === 'dataset.seeded')!;
    expect(seeded.details['citation_notes']).toEqual({ [RULE]: NOTE });
    expect(crossCheckState(env.storage.read).ok).toBe(true);
    const hash = env.storage.read.dataset.computeContentHash();
    bypass(env.storage.writeDb, ['rate_rules_guard_citation_note_update'], () => {
      env.storage.writeDb.prepare(`UPDATE rate_rules SET citation_note = 'Verified against the gazette.' WHERE rule_id = ?`).run(RULE);
    });
    expect(env.storage.read.dataset.computeContentHash()).toBe(hash);
    expect(crossCheckState(env.storage.read).problems.join('\n')).toMatch(new RegExp(`rule ${RULE}: citation_note differs`));
    bypass(env.storage.writeDb, ['rate_rules_guard_citation_note_update'], () => {
      env.storage.writeDb.prepare(`UPDATE rate_rules SET citation_note = NULL WHERE rule_id = ?`).run(RULE);
    });
    expect(crossCheckState(env.storage.read).problems.join('\n')).toMatch(new RegExp(`rule ${RULE}: seed citation_note removed without a verify`));
  });
});

// ------------------------------------------------------------------------------------------------ SA-C3-08

describe('SA-C3-08: a computed line for a code outside the master is flagged on the line and the invoice', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv({ seedDir: SEED });
  });
  afterAll(async () => env.close());

  it('complete:true is kept, but line.warnings and top-level warnings carry code_not_in_master', async () => {
    const r = await env.app.inject({
      method: 'POST', url: '/v1/tax/calculate', headers: bearer(env.keys.read!),
      payload: { invoice_date: '2026-10-10', accept_unverified: true, lines: [{ line_id: 'a', hsn: '85171300', taxable_value: 1000, supply_type: 'inter' }, { line_id: 'b', hsn: '7113', taxable_value: 1000, supply_type: 'inter' }] },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.complete).toBe(true);
    expect(b.warnings).toEqual(['code_not_in_master']);
    expect(b.lines[0].warnings).toEqual(['code_not_in_master']);
    expect(b.lines[1].warnings).toEqual([]);
    const clean = await env.app.inject({
      method: 'POST', url: '/v1/tax/calculate', headers: bearer(env.keys.read!),
      payload: { invoice_date: '2026-10-10', accept_unverified: true, lines: [{ hsn: '7113', taxable_value: 1000, supply_type: 'inter' }] },
    });
    expect(clean.json().warnings).toEqual([]);
  });
});
