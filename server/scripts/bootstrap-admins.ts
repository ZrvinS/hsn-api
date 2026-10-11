/**
 * One-time bootstrap of maker–checker (ruling 17): creates the first TWO admin actors and one admin key
 * each, in one transaction, recorded in the audit log. Refused once any admin actor exists; later actors
 * and admin keys need an approved `admin_grant` proposal.
 *   npx tsx scripts/bootstrap-admins.ts --admin amit:"Amit K" --admin priya:"Priya S" --tenant internal
 * The two keys are printed once. Hand each to its owner over separate channels.
 * Residual risk: anyone with host or database access can bypass maker–checker.
 */
import { parseArgs } from 'node:util';
import { systemClock } from '../src/lib/clock.js';
import { bootstrapAdmins } from '../src/services/apiKeys.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({
    options: { admin: { type: 'string', multiple: true }, tenant: { type: 'string', default: 'internal' }, by: { type: 'string', default: process.env['USER'] ?? 'cli' } },
  });
  const admins = (values.admin ?? []).map((a) => {
    const i = a.indexOf(':');
    return i < 0 ? { handle: a, display_name: '' } : { handle: a.slice(0, i), display_name: a.slice(i + 1) };
  });
  if (admins.length !== 2) {
    console.error('pass exactly two --admin handle[:Display Name] (two different people)');
    return 1;
  }
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const out = bootstrapAdmins(storage.tx, systemClock, { pepper: config.keyPepper.reveal(), pepperId: config.keyPepperId, auditKey: config.auditKey.reveal() }, [admins[0]!, admins[1]!], {
      tenant: values.tenant ?? 'internal',
      by: values.by ?? 'cli',
    });
    for (const o of out) {
      console.error(`actor ${o.handle} (${o.actor_id}) key ${o.key_id} (${o.prefix}); shown once:`);
      console.log(`${o.handle} ${o.key}`);
    }
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
