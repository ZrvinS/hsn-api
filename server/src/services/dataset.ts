import { randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Repos } from '../repositories/types.js';
import { istDate } from '../lib/dates.js';
import { rfc3339 } from '../lib/clock.js';

/** Next 'YYYY.MM.DD-n' for the IST calendar date of `at`. */
export function nextVersion(repos: Repos, at: Date): string {
  const d = istDate(at).replace(/-/g, '.');
  const existing = repos.dataset.versionsOn(d);
  let n = 0;
  for (const v of existing) {
    const k = Number(v.slice(11));
    if (Number.isInteger(k) && k > n) n = k;
  }
  return `${d}-${n + 1}`;
}

export function newFeedEpoch(): string {
  return `fe_${randomBytes(12).toString('hex')}`;
}

/**
 * Create a new dataset version row (stats filled by finishPublish). Call inside a write transaction.
 */
export function beginPublish(repos: Repos, at: Date, by: string, reason: string): string {
  const version = nextVersion(repos, at);
  const cur = repos.dataset.current();
  repos.dataset.insertVersion({
    version,
    parent_version: cur?.current_version ?? null,
    published_at: rfc3339(at),
    published_by: by,
    reason,
    rule_count: 0,
    content_hash: '0'.repeat(64),
  });
  return version;
}

/** Ed25519 signature (base64) over "<version>\n<content_hash>" (SA-C-11). */
export function signDataset(key: KeyObject | null | undefined, version: string, contentHash: string): string | null {
  if (!key) return null;
  return sign(null, Buffer.from(`${version}\n${contentHash}`), key).toString('base64');
}

/** Fill rule_count + content hash (+ signature) and move the current pointer forward. Call after all rows/feed entries are written. */
export function finishPublish(repos: Repos, version: string, at: Date, signingKey?: KeyObject | null): { contentHash: string; lastSeq: number } {
  const contentHash = repos.dataset.computeContentHash();
  repos.dataset.updateVersionStats(version, repos.dataset.activeRuleCount(istDate(at)), contentHash, signDataset(signingKey, version, contentHash));
  const lastSeq = repos.dataset.maxSeq();
  const first = repos.dataset.current() === null;
  repos.dataset.setState(version, lastSeq, first ? newFeedEpoch() : undefined);
  return { contentHash, lastSeq };
}
