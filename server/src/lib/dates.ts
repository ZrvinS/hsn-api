import type { Clock } from './clock.js';

export type IsoDate = string & { readonly __brand: 'IsoDate' };
export const GST_START = '2017-07-01' as IsoDate;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date in Asia/Kolkata (UTC+05:30, no DST) for an instant. */
export function istDate(d: Date): IsoDate {
  const shifted = new Date(d.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

export function todayIst(clock: Clock): IsoDate {
  return istDate(clock.now());
}

/** Strict YYYY-MM-DD that is a real calendar date. */
export function isRealDate(s: string): s is IsoDate {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Validates a client-supplied as-of date: real date, >= 2017-07-01, <= today(IST) + 366 days (SEC-29).
 * Returns an error message or null.
 */
export function checkAsOfDate(s: string, clock: Clock): string | null {
  if (!isRealDate(s)) return 'Must be a real calendar date in YYYY-MM-DD format';
  if (s < GST_START) return 'Must be on or after 2017-07-01 (GST start)';
  if (s > addDays(todayIst(clock), 366)) return 'Must be no later than today + 366 days';
  return null;
}
