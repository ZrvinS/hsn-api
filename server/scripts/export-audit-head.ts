/**
 * Export the audit chain head + dataset sha256 for off-host storage (ruling 18). Run daily; copy the
 * output somewhere the API host cannot write.
 *   npx tsx scripts/export-audit-head.ts [--out head-2026-10-10.json]
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { rfc3339 } from '../src/lib/clock.js';
import { exportAuditHead } from '../src/services/auditExport.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const head = exportAuditHead(storage.read, config.auditKey.reveal(), rfc3339(new Date()));
    const text = `${JSON.stringify(head, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, text, { mode: 0o600 });
    else process.stdout.write(text);
    return 0;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
