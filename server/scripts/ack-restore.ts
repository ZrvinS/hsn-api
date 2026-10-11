/**
 * Acknowledge a detected database restore (SA-C2-06). The server rotated the feed epoch and fails
 * readiness (`dataset.restore_detected`) because the database is behind the high-water mark recorded in
 * HSN_STATE_HWM_FILE. After checking the restore was intended (restore runbook), accept the current state as
 * the new high-water mark (audited as `dataset.restore_acknowledged`) and restart the server.
 *   npx tsx scripts/ack-restore.ts --by priya --note "restored 2026-10-09 backup after disk failure"
 * Also rewrites a sidecar whose MAC no longer verifies (e.g. after rotating HSN_AUDIT_KEY).
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemClock } from '../src/lib/clock.js';
import { acknowledgeRestore } from '../src/services/restoreGuard.js';
import { cliBoot } from './_common.js';

export function ackRestoreCli(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const { values } = parseArgs({ args: argv, options: { by: { type: 'string' }, note: { type: 'string' } } });
  if (!values.by || !values.note || values.note.trim().length < 10) {
    console.error('--by <actor> and --note "<incident note, >= 10 chars>" are required');
    return 1;
  }
  const boot = cliBoot(env);
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    if (config.stateHwmFile === null) {
      console.error('restore detection is disabled (HSN_STATE_HWM_FILE=off or an in-memory database); nothing to acknowledge');
      return 1;
    }
    const h = acknowledgeRestore(config.stateHwmFile, config.auditKey.reveal(), storage.tx, systemClock, values.by, values.note.trim().slice(0, 500));
    console.log(JSON.stringify({ hwm_file: config.stateHwmFile, audit_head_id: h.audit_head_id, last_change_seq: h.last_change_seq, feed_epoch: h.feed_epoch }));
    console.error('acknowledged; restart the server so readiness is re-evaluated');
    return 0;
  } finally {
    storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = ackRestoreCli(process.argv.slice(2));
