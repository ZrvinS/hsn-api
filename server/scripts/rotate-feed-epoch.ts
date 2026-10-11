/**
 * Run after restoring the database from a backup (restore runbook): sets a new feed_epoch so clients
 * see that the change feed may have gone backwards and resync from since=0 (ruling 25, SA-D-12).
 *   npx tsx scripts/rotate-feed-epoch.ts --by priya --note "restored 2026-10-09 backup after disk failure"
 */
import { parseArgs } from 'node:util';
import { rfc3339 } from '../src/lib/clock.js';
import { appendAudit } from '../src/services/audit.js';
import { newFeedEpoch } from '../src/services/dataset.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({ options: { by: { type: 'string' }, note: { type: 'string' } } });
  if (!values.by || !values.note || values.note.length < 10) {
    console.error('--by <actor> and --note "<incident note, ≥ 10 chars>" are required');
    return 1;
  }
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const epoch = newFeedEpoch();
    storage.tx((repos) => {
      const ds = repos.dataset.current();
      if (!ds) throw new Error('no dataset');
      repos.dataset.rotateFeedEpoch(epoch);
      appendAudit(repos.audit, config.auditKey.reveal(), {
        at: rfc3339(new Date()), actor: values.by!, key_prefix: null, action: 'dataset.restored', entity_type: 'dataset_version', entity_id: ds.current_version,
        details: { old_feed_epoch: ds.feed_epoch, new_feed_epoch: epoch, note: values.note },
      });
    });
    console.log(epoch);
    return 0;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
