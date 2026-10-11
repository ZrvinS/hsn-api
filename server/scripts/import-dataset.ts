/**
 * Production data load (R11): load a seed directory (format: data/seed/FORMAT.md) into an EMPTY
 * production database through maker–checker. Two steps, two different admins, each with their own key:
 *
 *   HSN_ADMIN_KEY=<maker key>   npm run import-dataset -- propose --dir data/seed --rationale "Initial load from data/seed @ <commit>"
 *   HSN_ADMIN_KEY=<checker key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed
 *
 * `propose` validates the directory, records the sha256 of every file and the row counts in a pending
 * `dataset_import` proposal (stored as refdata_change with payload.op = "dataset_import") and audits
 * `rate_proposal.created`. `approve` re-reads and re-validates the directory, refuses if any file hash
 * changed, then in ONE transaction publishes the seed as the first dataset version (rules stay
 * `unverified`; `dataset.seeded` audit entry), marks the proposal approved with that version and audits
 * `rate_proposal.approved` with the version's content hash, so the state-to-audit cross-check passes.
 * The API cannot approve a dataset_import (it cannot re-hash the files); it can list or reject one.
 * Runbook: reviews/code-fix-core-round2.md, "Round 5".
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../src/config.js';
import type { Storage } from '../src/repositories/sqlite/index.js';
import type { ProposalRow } from '../src/repositories/types.js';
import { rfc3339 } from '../src/lib/clock.js';
import { newId } from '../src/lib/ids.js';
import { AppError } from '../src/lib/problem.js';
import { hashApiKey, hashesEqual, parseApiKey } from '../src/lib/apiKey.js';
import { applySeed, prepareSeed, SeedError, type PreparedSeed } from '../src/db/seed.js';
import { appendAudit } from '../src/services/audit.js';
import { isDatasetImport, loadForDecision, proposalContentSha256, type Actor } from '../src/services/proposals.js';
import { crossCheckState } from '../src/services/integrity.js';
import { cliBoot } from './_common.js';

export interface ImportResult {
  code: number;
  proposal_id?: string;
  content_sha256?: string;
  version?: string;
}

/** Verify an admin key the way the API does (pepper by pepper_id, not revoked or expired, actor active). */
export function authenticateAdmin(storage: Storage, config: AppConfig, presented: string | undefined, now: Date): Actor | string {
  if (!presented) return 'HSN_ADMIN_KEY is not set (your own admin API key)';
  const parsed = parseApiKey(presented.trim());
  if (!parsed) return 'HSN_ADMIN_KEY is not a well-formed API key';
  const row = storage.write.keys.getByPrefix(parsed.prefix);
  const pepper = row ? config.keyPeppers.find((p) => p.id === row.pepper_id)?.secret.reveal() : undefined;
  if (!row || pepper === undefined || !hashesEqual(hashApiKey(presented.trim(), pepper), row.key_hash)) return 'HSN_ADMIN_KEY does not verify';
  if (row.revoked_at !== null) return 'HSN_ADMIN_KEY is revoked';
  if (row.expires_at !== null && !(Date.parse(row.expires_at) > now.getTime())) return 'HSN_ADMIN_KEY has expired';
  if (!row.scopes.includes('admin') || row.actor_id === null || row.actor === null || row.actor_disabled) return 'HSN_ADMIN_KEY is not an active admin key';
  return { actor: row.actor, actorId: row.actor_id, keyId: row.id, keyPrefix: row.prefix };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function importDatasetCli(argv: string[], env: Record<string, string | undefined> = process.env, now: () => Date = () => new Date()): ImportResult {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { dir: { type: 'string' }, rationale: { type: 'string' }, proposal: { type: 'string' }, 'expected-sha256': { type: 'string' }, comment: { type: 'string' } },
  });
  if (cmd !== 'propose' && cmd !== 'approve') {
    console.error('usage: import-dataset propose --dir <seed dir> --rationale "<why, >= 10 chars>"\n       import-dataset approve --proposal <rp_…> --expected-sha256 <content_sha256> --dir <seed dir> [--comment "…"]');
    return { code: 1 };
  }
  if (!values.dir) {
    console.error('--dir <seed directory> is required');
    return { code: 1 };
  }
  const boot = cliBoot(env);
  if (!boot) return { code: 1 };
  const { config, storage } = boot;
  try {
    const at = now();
    const who = authenticateAdmin(storage, config, env['HSN_ADMIN_KEY'], at);
    if (typeof who === 'string') {
      console.error(who);
      return { code: 1 };
    }
    let prepared: PreparedSeed;
    try {
      prepared = prepareSeed({ dir: resolve(values.dir), allowedRatesBp: config.allowedRatesBp, sourceHosts: config.sourceHosts, allowVerified: false, warn: (m) => console.warn(`warn: ${m}`) });
    } catch (e) {
      if (e instanceof SeedError) {
        console.error(e.message);
        return { code: 2 };
      }
      throw e;
    }
    if (storage.write.dataset.current() !== null) {
      console.error('This database already has a dataset; import-dataset only loads an empty database. Change a live dataset with rate proposals.');
      return { code: 1 };
    }

    if (cmd === 'propose') {
      const rationale = (values.rationale ?? '').trim();
      if (rationale.length < 10) {
        console.error('--rationale "<why, >= 10 chars>" is required (e.g. the commit the seed directory was taken from)');
        return { code: 1 };
      }
      const payload = { op: 'dataset_import', files: prepared.files, counts: prepared.counts };
      const content = { action: 'refdata_change' as const, supersedes_rule_id: null, end_date: null, rule: null, payload, rationale: rationale.slice(0, 2000), retroactive_reason: null, target_sha256: null };
      const row: ProposalRow = {
        id: newId('rp', at.getTime()), status: 'pending', ...content, content_sha256: proposalContentSha256(content),
        proposed_by: who.actor, proposed_by_actor_id: who.actorId, proposed_key_id: who.keyId, proposed_at: rfc3339(at),
        decided_by: null, decided_by_actor_id: null, decided_key_id: null, decided_at: null, decision_comment: null, resulting_rule_id: null, resulting_version: null,
      };
      storage.tx((repos) => {
        if (repos.proposals.pending().some(isDatasetImport)) throw new AppError('proposal_stale', 'A dataset_import proposal is already pending; approve or reject it first.');
        repos.proposals.insert(row);
        appendAudit(repos.audit, config.auditKey.reveal(), {
          at: row.proposed_at, actor: who.actor, key_prefix: who.keyPrefix, action: 'rate_proposal.created', entity_type: 'rate_proposal', entity_id: row.id,
          details: { action: row.action, supersedes_rule_id: null, end_date: null, rule: null, payload, content_sha256: row.content_sha256, actor_id: who.actorId },
        });
      });
      console.log(JSON.stringify({ proposal_id: row.id, content_sha256: row.content_sha256, files: prepared.files, counts: prepared.counts }, null, 2));
      console.log(`A different admin approves with: import-dataset approve --proposal ${row.id} --expected-sha256 ${row.content_sha256} --dir <same directory>`);
      return { code: 0, proposal_id: row.id, content_sha256: row.content_sha256 };
    }

    // approve
    if (!values.proposal || !values['expected-sha256']) {
      console.error('--proposal <rp_…> and --expected-sha256 <content_sha256 printed by propose> are required');
      return { code: 1 };
    }
    const id = values.proposal;
    const expected = values['expected-sha256'];
    const comment = values.comment?.trim().slice(0, 1000) || null;
    const auditKey = config.auditKey.reveal();
    const summary = storage.tx((repos) => {
      const p = loadForDecision(repos, id, who, expected, 'approved');
      if (!isDatasetImport(p)) throw new AppError('proposal_stale', `Proposal ${id} is not a dataset_import; decide it through the admin API.`);
      if (!sameJson(p.payload?.['files'], prepared.files) || !sameJson(p.payload?.['counts'], prepared.counts)) {
        throw new AppError('proposal_stale', `The files in ${values.dir} differ from the ones proposed in ${id} (sha256 or row counts). Reject it and propose again.`);
      }
      const decidedAt = rfc3339(at);
      const s = applySeed(repos, prepared, { now: at, auditKey, signingKey: config.datasetSigningKey }, {
        by: who.actor,
        reason: `dataset_import ${id}`,
        auditDetails: { proposal_id: id },
        // decide first: the dataset pointer and rule-insert guards require the approved proposal
        onVersion: (r, version) =>
          r.proposals.decide(id, {
            status: 'approved', decided_by: who.actor, decided_by_actor_id: who.actorId, decided_key_id: who.keyId, decided_at: decidedAt,
            decision_comment: comment, resulting_rule_id: null, resulting_version: version,
          }),
      });
      appendAudit(repos.audit, auditKey, {
        at: decidedAt, actor: who.actor, key_prefix: who.keyPrefix, action: 'rate_proposal.approved', entity_type: 'rate_proposal', entity_id: id,
        details: {
          dataset_version: s.version, dataset_content_hash: s.content_hash, action: 'refdata_change', rule_id: null, target_rule_id: null,
          content_sha256: p.content_sha256, rule: null, rule_sha256: null, payload: p.payload, retroactive: false, actor_id: who.actorId,
          verified_against_source: true,
        },
      });
      return s;
    });
    const check = crossCheckState(storage.write);
    if (!check.ok) {
      console.error(`WARNING: integrity cross-check reports problems after the import:\n  ${check.problems.join('\n  ')}`);
      return { code: 3, proposal_id: id, version: summary.version };
    }
    console.log(JSON.stringify({ imported: summary, proposal_id: id, integrity: 'ok' }, null, 2));
    return { code: 0, proposal_id: id, version: summary.version };
  } catch (e) {
    if (e instanceof AppError || e instanceof SeedError) {
      console.error(e.message);
      return { code: 1 };
    }
    throw e;
  } finally {
    storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = importDatasetCli(process.argv.slice(2)).code;
