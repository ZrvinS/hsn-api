/**
 * Log fingerprint of a product name (SEC-62, SA-K-08, ruling 25): HMAC-SHA256 under the
 * server-side HSN_LOG_KEY over the NORMALISED name, truncated to 16 hex chars. Unlike a bare
 * SHA-256, it cannot be reversed by hashing guesses (e.g. phone numbers) without the key.
 */
import { createHmac } from 'node:crypto';

export function nameHmac(key: string, normalisedName: string): string {
  return createHmac('sha256', key).update(normalisedName, 'utf8').digest('hex').slice(0, 16);
}
