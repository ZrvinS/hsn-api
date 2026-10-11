/**
 * Verify a database against an exported head (ruling 18): full HMAC chain, no truncation since the
 * export, dataset hashes unchanged, current content hash matches. Exit 0 = ok, 3 = problems found.
 *   npx tsx scripts/verify-audit.ts [--head head-2026-10-10.json]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { verifyAgainstHead, type AuditHeadExport } from '../src/services/auditExport.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({ options: { head: { type: 'string' } } });
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  try {
    const exported = values.head ? (JSON.parse(readFileSync(values.head, 'utf8')) as AuditHeadExport) : null;
    const r = verifyAgainstHead(storage.read, config.auditKey.reveal(), exported);
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 3;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
