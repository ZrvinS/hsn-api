/**
 * Disable an admin actor (incident response, SEC-82 / SA-C2-04). In one transaction: sets disabled_at
 * (their admin keys stop authenticating at once), withdraws every pending proposal they made, and writes
 * an `admin.disabled` audit entry plus one `rate_proposal.withdrawn` entry per proposal.
 *   npx tsx scripts/disable-actor.ts --handle amit --by priya --note "key leaked in incident 2026-10-11"
 * Two admins can also do this through the API: POST /v1/admin/rate-proposals {action: "disable_actor", disable: {handle}}.
 * This script is the host-level path (ruling 17). Like the API (SA-C3-05) it refuses to leave fewer than two
 * active admins: with one admin no proposal can ever be approved again and re-bootstrap is refused. To replace
 * a compromised admin when only two are active, first grant a third admin (admin_grant proposal), then disable.
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rfc3339 } from '../src/lib/clock.js';
import { normaliseHandle } from '../src/services/apiKeys.js';
import { AppError } from '../src/lib/problem.js';
import { disableActorInTx } from '../src/services/proposals.js';
import { cliBoot } from './_common.js';

export function disableActorCli(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const { values } = parseArgs({ args: argv, options: { handle: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' } } });
  if (!values.handle || !values.by || !values.note || values.note.trim().length < 10) {
    console.error('--handle <actor>, --by <who> and --note "<incident note, >= 10 chars>" are required');
    return 1;
  }
  const boot = cliBoot(env);
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const handle = normaliseHandle(values.handle);
    const at = rfc3339(new Date());
    const withdrawn = storage.tx((repos) => {
      const actor = repos.actors.byHandle(handle);
      if (actor && actor.disabled_at === null && repos.actors.activeCount() - 1 < 2) {
        throw new AppError(
          'proposal_stale',
          `Refusing to disable ${handle}: fewer than two active admins would remain, and then no proposal (not even a new admin grant) could ever be approved. ` +
            'Grant a third admin first (admin_grant proposal approved by a second admin), then disable. To cut off a leaked key immediately, revoke that key: npm run create-key -- --revoke <key id> --by <you>.',
        );
      }
      return disableActorInTx(repos, config.auditKey.reveal(), { handle, at, by: values.by!, keyPrefix: null, note: values.note!.trim().slice(0, 500), proposalId: null });
    });
    const active = storage.write.actors.activeCount();
    console.error(JSON.stringify({ level: 40, event: 'admin.actor_disabled', alert: true, handle, by: values.by, withdrawn, active_admins: active }));
    console.log(`disabled ${handle}; withdrew ${withdrawn.length} pending proposal(s)`);
    return 0;
  } catch (e) {
    if (e instanceof AppError || (e as Error).name === 'KeyInputError') {
      console.error((e as Error).message);
      return 1;
    }
    throw e;
  } finally {
    storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = disableActorCli(process.argv.slice(2));
