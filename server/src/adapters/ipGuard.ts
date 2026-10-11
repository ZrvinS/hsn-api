/**
 * Outbound address classifier (SEC-34). An address is blocked unless it is ordinary public
 * unicast. Blocked: loopback, RFC 1918, link-local (incl. 169.254.169.254 cloud metadata),
 * CGNAT 100.64/10, 0/8, multicast, reserved/broadcast, benchmarking, documentation ranges,
 * IPv6 ::, ::1, fc00::/7, fe80::/10, multicast ff00::/8, site-local fec0::/10, and IPv4-mapped /
 * IPv4-compatible / NAT64 / 6to4 / Teredo forms (blocked outright: they can smuggle an internal
 * IPv4 and we have no reason to call them).
 */
import { isIP } from 'node:net';

function v4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Blocked(ip: string): boolean {
  const a = v4ToInt(ip);
  if (a === null) return true;
  for (const [base, bits] of V4_BLOCKS) {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** Expand an IPv6 literal to 8 16-bit groups; null if malformed. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  // trailing dotted IPv4
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (g === null) return true;
  const g0 = g[0]!;
  const allZeroPrefix = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (allZeroPrefix(8)) return true; // ::
  if (allZeroPrefix(7) && g[7] === 1) return true; // ::1
  if (allZeroPrefix(5) && g[5] === 0xffff) return true; // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZeroPrefix(6)) return true; // ::a.b.c.d (IPv4-compatible, deprecated)
  if (allZeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  if (g0 === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 and /48 NAT64
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x2001 && g[1]! < 0x200) return true; // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking, ...)
  if (g0 === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g0 === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x3fff && g[1]! < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
  if ((g0 & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3 is allowed
  return false;
}

/** true if the address must never be connected to. Non-IP input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip.includes('%') ? ip.slice(0, ip.indexOf('%')) : ip);
  if (fam === 4) return v4Blocked(ip);
  if (fam === 6) return v6Blocked(ip);
  return true;
}
