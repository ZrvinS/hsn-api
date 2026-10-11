/**
 * Integer money and rate maths (07-best-practices §6). No floating point in the domain:
 * rupee inputs are parsed by string splitting, never `x * 100`.
 */
export type Paise = number & { readonly __brand: 'Paise' };
export type RateBp = number & { readonly __brand: 'RateBp' };

/** Max per line: ₹10,000,000,000 = 1e12 paise (SEC-30). */
export const MAX_LINE_PAISE = 1_000_000_000_000;

const RUPEE_RE = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/**
 * Parse an INR amount given as a JSON number or decimal string with <= 2 decimals.
 * Returns null if the value is not a non-negative amount with at most 2 decimals.
 */
export function parseRupees(v: number | string): Paise | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    // Shortest round-trip representation, e.g. 0.07 -> "0.07", 1027.5 -> "1027.5", 1e21 -> "1e+21" (rejected).
    s = String(v);
  } else {
    s = v.trim();
  }
  const m = RUPEE_RE.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  const p = whole * 100n + frac;
  if (p > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(p) as Paise;
}

/** Paise -> INR as a JSON number (e.g. 102750 -> 1027.5). Exact for safe integers. */
export function paiseToRupees(p: number): number {
  return Number(paiseToRupeeString(p));
}

/** Paise -> "1027.50" */
export function paiseToRupeeString(p: number): string {
  const neg = p < 0;
  const a = BigInt(Math.abs(p));
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** round-half-up(n / d) for non-negative n, positive d, using BigInt. */
export function roundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  if (n < 0n) throw new RangeError('numerator must be non-negative');
  return (n * 2n + d) / (2n * d);
}

/**
 * bp -> percent number for display (300 -> 3, 25 -> 0.25, 12.5 -> 0.125).
 * Display only: tax maths never uses this value.
 */
export function bpToPercent(bp: number): number {
  return Number((bp / 100).toFixed(4));
}
