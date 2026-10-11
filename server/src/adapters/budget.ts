/**
 * Small in-process budgets (ruling 25, SA-K-06): a token bucket per minute and a per-key daily
 * counter. Single-instance by design (architecture §4); a multi-instance deployment would move
 * these behind the same interface to Redis.
 */

/** Token bucket: `perMin` tokens per minute, burst = perMin. take() is non-blocking. */
export class MinuteBudget {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMin: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = Math.max(0, perMin);
    this.last = now();
  }
  take(): boolean {
    if (this.perMin <= 0) return false;
    const t = this.now();
    const refill = ((t - this.last) / 60_000) * this.perMin;
    if (refill > 0) {
      this.tokens = Math.min(this.perMin, this.tokens + refill);
      this.last = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Counts uses per key per UTC day; bounded memory (oldest keys evicted). */
export class DailyCounter {
  private day = '';
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}
  /** true and counts one use if `key` is under its daily limit */
  take(key: string): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
    const n = this.counts.get(key) ?? 0;
    if (n >= this.limit) return false;
    if (n === 0 && this.counts.size >= this.maxKeys) {
      const first = this.counts.keys().next().value;
      if (first !== undefined) this.counts.delete(first);
    }
    this.counts.set(key, n + 1);
    return true;
  }
}

/** Day + minute budget pair (LLM calls). */
export class CallBudget {
  private readonly minute: MinuteBudget;
  private readonly daily: DailyCounter;
  constructor(perMin: number, perDay: number, now: () => number = Date.now) {
    this.minute = new MinuteBudget(perMin, now);
    this.daily = new DailyCounter(perDay, now, 1);
  }
  take(): boolean {
    // a minute token is spent even if the daily limit then refuses; that only makes us stricter
    return this.minute.take() && this.daily.take('all');
  }
}
