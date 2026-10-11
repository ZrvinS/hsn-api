import { isIP } from 'node:net';

/**
 * IP helpers: strict allow-list parsing (SA-C-06), CIDR matching for IPv4 and IPv6, IPv6 expansion
 * (SA-C-10) and the /64 bucketing key used by the unauthenticated limiter (SA-C-05).
 */

/** Expand an IPv6 address to 8 groups of 16-bit numbers, or null. Handles '::' and an embedded IPv4 tail. */
export function expandIpv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1, 5).map(Number);
    tail = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!];
    s = s.slice(0, s.length - v4[0].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const parseGroups = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  let groups: number[];
  const dbl = s.indexOf('::');
  if (dbl >= 0) {
    const head = parseGroups(s.slice(0, dbl));
    const rest = parseGroups(s.slice(dbl + 2));
    const fill = 8 - tail.length - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  } else {
    groups = [...parseGroups(s), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').reduce((n, s) => n * 256 + Number(s), 0);
}

function unmapV4(ip: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

function v6ToBigInt(ip: string): bigint | null {
  const g = expandIpv6(ip);
  if (!g) return null;
  return g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);
}

export interface IpRule {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

/**
 * Parse one allow-list entry strictly: an IPv4/IPv6 address, or address/prefix where prefix is an
 * explicit integer (0–32 / 0–128). Returns null for anything else (e.g. "10.0.0.1/" or "10.0.0.1/x").
 */
export function parseIpRule(entry: string): IpRule | null {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(entry.trim());
  if (!m) return null;
  const addr = unmapV4(m[1]!);
  const fam = isIP(addr);
  if (fam === 0) return null;
  const max = fam === 4 ? 32 : 128;
  const bits = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const base = fam === 4 ? BigInt(v4ToInt(addr)!) : v6ToBigInt(addr)!;
  return { family: fam as 4 | 6, base, bits };
}

function matches(rule: IpRule, ip: string): boolean {
  const addr = unmapV4(ip);
  const fam = isIP(addr);
  if (fam !== rule.family) return false;
  const width = fam === 4 ? 32n : 128n;
  const value = fam === 4 ? BigInt(v4ToInt(addr)!) : v6ToBigInt(addr);
  if (value === null) return false;
  if (rule.bits === 0) return true;
  const shift = width - BigInt(rule.bits);
  return value >> shift === rule.base >> shift;
}

/** True when ip matches any entry. Invalid entries never match (they are rejected at boot by config). */
export function ipAllowed(ip: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    const r = parseIpRule(entry);
    if (r && matches(r, ip)) return true;
  }
  return false;
}

/** Limiter bucket key for a client address: full IPv4, IPv6 truncated to its /64 (SA-C-05). */
export function clientBucketKey(ip: string): string {
  const addr = unmapV4(ip);
  if (isIP(addr) === 4) return addr;
  const g = expandIpv6(addr);
  if (!g) return 'unknown';
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
