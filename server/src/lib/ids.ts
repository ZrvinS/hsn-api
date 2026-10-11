import { randomBytes, createHash } from 'node:crypto';

/** Crockford base32 alphabet used by ULIDs (no I, L, O, U). */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeBytes(bytes: Uint8Array, chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i++) out += CROCKFORD[bytes[i]! % 32]!;
  return out;
}

/** 26-char ULID (48-bit time + 80 bits randomness, from crypto.randomBytes). */
export function ulid(nowMs: number = Date.now()): string {
  return encodeTime(nowMs) + encodeBytes(randomBytes(16), 16);
}

export type IdPrefix = 'rr' | 'rp' | 'key' | 'req' | 'act' | 'wn' | 'sb';
export function newId(prefix: IdPrefix, nowMs?: number): string {
  return `${prefix}_${ulid(nowMs)}`;
}

/** Deterministic 26-char Crockford id from arbitrary text (seed rule ids). */
export function deterministicId(prefix: IdPrefix, material: string): string {
  const h = createHash('sha256').update(material).digest();
  return `${prefix}_${encodeBytes(h, 26)}`;
}

export const ULID_ID = (prefix: IdPrefix): RegExp => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
