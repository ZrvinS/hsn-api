/** Injected clock so "today" is controllable in tests. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { set(iso: string): void; advance(ms: number): void } {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (s: string) => {
      t = new Date(s).getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** RFC 3339 UTC without milliseconds, e.g. 2026-10-03T09:15:02Z */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
