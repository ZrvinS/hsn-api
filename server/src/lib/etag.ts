import { createHash } from 'node:crypto';
import { canonicalJson } from './canonicalJson.js';

/**
 * Weak ETag W/"ds-<dataset_version>-<16 hex>" where the hash covers the resolved as-of date (IST),
 * the dataset version and the response body (ruling 4). A response that would differ — because "today"
 * moved past an effective date, a warning appeared, or the dataset changed — gets a different ETag.
 */
export function makeEtag(datasetVersion: string, asOf: string, body: unknown): string {
  const h = createHash('sha256').update(datasetVersion).update('\n').update(asOf).update('\n').update(canonicalJson(body)).digest('hex').slice(0, 16);
  return `W/"ds-${datasetVersion}-${h}"`;
}

/** RFC 9110 weak comparison against an If-None-Match header value. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.length > 1024) return false;
  if (header.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  const target = strip(etag);
  return header.split(',').some((t) => strip(t) === target);
}

/** Seconds from `now` until the next midnight in Asia/Kolkata (UTC+05:30). Always ≥ 1. */
export function secondsUntilNextIstMidnight(now: Date): number {
  const istMs = now.getTime() + 330 * 60_000;
  const dayMs = 86_400_000;
  const next = Math.floor(istMs / dayMs) * dayMs + dayMs;
  return Math.max(1, Math.ceil((next - istMs) / 1000));
}
