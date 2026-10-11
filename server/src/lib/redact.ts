/**
 * Log redaction (SEC-61/62/63). pino `redact` paths plus helpers that keep raw
 * product names and full IPs out of logs.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { expandIpv6 } from './ip.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.api_key',
  '*.apiKey',
  '*.key',
  '*.secret',
  '*.password',
  '*.token',
];

/** Replace anything that looks like an API key secret with its public prefix. */
export function scrubKeys(s: string): string {
  return s.replace(/(hsk_[0-9A-Za-z]{8})_[A-Za-z0-9_-]{10,}/g, '$1_[redacted]');
}

/** Truncate IPv4 to /24 and IPv6 to /48 (expanded first, so no host bits leak; SA-C-10). */
export function truncateIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4 && isIP(ip.replace(/^::ffff:/i, '')) === 4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const g = expandIpv6(ip);
  if (g) return `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48`;
  return 'unknown';
}

/** Fallback when no HSN_LOG_KEY is configured (dev/test): random per process, never logged. */
const PROCESS_LOG_KEY = randomBytes(32).toString('hex');

/**
 * Debug-safe fingerprint of a product name: HMAC-SHA256 with HSN_LOG_KEY (ruling 25, SA-D-18),
 * so a dictionary over common names cannot reverse it. Never the raw text.
 */
export function nameFingerprint(name: string, key?: string): { name_length: number; name_hmac: string } {
  return {
    name_length: name.length,
    name_hmac: createHmac('sha256', key ?? PROCESS_LOG_KEY).update(name.normalize('NFKC').toLowerCase().trim()).digest('hex').slice(0, 16),
  };
}
