import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys (coordinator ruling 10): `hsk_<8-char prefix>_<43-char base64url secret>`.
 * The secret is 32 bytes from crypto.randomBytes (256 bits). The prefix `hsk_<8>` is a
 * public lookup index. Stored: HMAC-SHA256(key = HSN_KEY_PEPPER, message = full key) as hex.
 * Verification: prefix lookup → recompute → crypto.timingSafeEqual.
 */
export const SCOPES = ['read', 'classify', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_RE = /^(hsk_[0-9A-Za-z]{8})_([A-Za-z0-9_-]{43})$/;

/** Unbiased base62 string from crypto.randomBytes via rejection sampling. */
export function randomBase62(len: number): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) out += BASE62[b % 62]!; // 248 = 62*4: reject to avoid modulo bias
      if (out.length === len) break;
    }
  }
  return out;
}

export interface GeneratedKey {
  key: string;
  prefix: string;
}

export function generateApiKey(): GeneratedKey {
  const prefix = `hsk_${randomBase62(8)}`;
  const secret = randomBytes(32).toString('base64url'); // 43 chars, no padding
  return { key: `${prefix}_${secret}`, prefix };
}

/** Parse a presented key. Returns its lookup prefix or null if malformed. */
export function parseApiKey(presented: string): { prefix: string } | null {
  if (presented.length !== 56) return null;
  const m = KEY_RE.exec(presented);
  return m ? { prefix: m[1]! } : null;
}

export function hashApiKey(fullKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update(fullKey, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex sha256 digests. */
export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== 32 || b.length !== 32) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); // keep timing similar
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Used when the prefix is unknown, so both paths do an HMAC + compare (SEC-13). */
export const DUMMY_HASH = 'f'.repeat(64);

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer ([!-~]{1,256})$/.exec(header);
  return m ? m[1]! : null;
}

/**
 * Canonical stored spelling of a scope set (matches the api_keys CHECK). Admin is exclusive (SEC-18,
 * SA-C-06): a key is either ["admin"] or a subset of read/classify. Throws for anything else.
 */
export function canonicalScopes(scopes: readonly Scope[]): string {
  const set = new Set(scopes);
  if (set.size === 0) throw new Error('at least one scope is required');
  if (set.has('admin')) {
    if (set.size !== 1) throw new Error('admin keys are distinct keys: "admin" cannot be combined with other scopes');
    return '["admin"]';
  }
  return JSON.stringify(SCOPES.filter((s) => set.has(s)));
}
