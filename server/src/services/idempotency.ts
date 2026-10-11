/**
 * Idempotent admin writes (ruling 8, 07 §8). Scoped per API key: (key_id, Idempotency-Key) →
 * (route, request sha256, status, response) for 24 h. Runs inside the caller's write transaction, so
 * the stored response and the write commit together.
 * - same key + same route + same request → the stored response is replayed (replayed = true);
 * - same key + anything else → 409 idempotency-conflict;
 * - otherwise the write runs and its response is stored.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonicalJson.js';
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import { AppError } from '../lib/problem.js';
import type { Repos } from '../repositories/types.js';

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

export interface IdempotencyContext {
  keyId: string;
  key: string;
  route: string;
  requestSha256: string;
}

export function idempotencyContext(keyId: string, header: unknown, route: string, request: unknown): IdempotencyContext | null {
  if (typeof header !== 'string') return null;
  return { keyId, key: header.toLowerCase(), route, requestSha256: createHash('sha256').update(canonicalJson(request)).digest('hex') };
}

export function runIdempotent<T>(repos: Repos, idem: IdempotencyContext | null, clock: Clock, status: number, fn: () => T): { proposal: T; replayed: boolean } {
  if (idem === null) return { proposal: fn(), replayed: false };
  const now = clock.now();
  const notBefore = rfc3339(new Date(now.getTime() - IDEMPOTENCY_TTL_MS));
  const prior = repos.idempotency.get(idem.keyId, idem.key, notBefore);
  if (prior) {
    if (prior.route !== idem.route || prior.request_sha256 !== idem.requestSha256) {
      throw new AppError('idempotency_conflict', 'This Idempotency-Key was already used with a different request.');
    }
    return { proposal: JSON.parse(prior.response_json) as T, replayed: true };
  }
  const result = fn();
  repos.idempotency.purgeBefore(notBefore);
  repos.idempotency.put({
    key_id: idem.keyId,
    idem_key: idem.key,
    route: idem.route,
    request_sha256: idem.requestSha256,
    status_code: status,
    response_json: JSON.stringify(result),
    created_at: rfc3339(now),
  });
  return { proposal: result, replayed: false };
}
