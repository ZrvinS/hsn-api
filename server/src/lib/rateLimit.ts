import type { Clock } from './clock.js';

/**
 * In-memory token buckets (architecture §6). Interface allows a Redis implementation later.
 * capacity = burst = ceil(perMin / 6); refill = perMin / 60 tokens per second.
 * State is bounded: least-recently-used buckets are evicted one at a time (never a full clear,
 * SA-C-05). Authenticated keys and unauthenticated clients use separate limiter instances so
 * unauthenticated traffic can never evict a key's bucket.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** the per-minute policy (RateLimit-Limit, ruling 14) */
  limit: number;
  /** tokens left, floored (RateLimit-Remaining) */
  remaining: number;
  /** seconds until the bucket is full again (RateLimit-Reset) */
  resetSec: number;
  /** seconds until enough tokens for this request (Retry-After), when denied */
  retryAfterSec: number;
  burst: number;
}

export interface RateLimiter {
  take(key: string, perMin: number, cost?: number): RateLimitResult;
  /** true if at least one token is available (does not consume) */
  available(key: string, perMin: number): boolean;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly clock: Clock,
    /** burst as a fraction of the per-minute limit (architecture: 1/6) */
    private readonly burstFraction = 1 / 6,
    private readonly maxEntries = 100_000,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  private capacity(perMin: number, cost: number): number {
    return Math.max(cost, Math.ceil(perMin * this.burstFraction));
  }

  take(key: string, perMin: number, cost = 1): RateLimitResult {
    const now = this.clock.now().getTime();
    const capacity = this.capacity(perMin, cost);
    const ratePerMs = perMin / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      while (this.buckets.size >= this.maxEntries) {
        // LRU: Map iteration order is insertion order and we re-insert on every touch
        const oldest = this.buckets.keys().next();
        if (oldest.done) break;
        this.buckets.delete(oldest.value);
      }
      b = { tokens: capacity, updatedMs: now };
    } else {
      this.buckets.delete(key);
      const elapsed = Math.max(0, now - b.updatedMs);
      b.tokens = Math.min(capacity, b.tokens + elapsed * ratePerMs);
      b.updatedMs = now;
    }
    this.buckets.set(key, b);
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    const resetSec = Math.ceil((capacity - b.tokens) / ratePerMs / 1000);
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((cost - b.tokens) / ratePerMs / 1000));
    return { allowed, limit: perMin, remaining: Math.max(0, Math.floor(b.tokens)), resetSec, retryAfterSec, burst: capacity };
  }

  available(key: string, perMin: number): boolean {
    const b = this.buckets.get(key);
    if (!b) return true;
    const capacity = this.capacity(perMin, 1);
    const elapsed = Math.max(0, this.clock.now().getTime() - b.updatedMs);
    return Math.min(capacity, b.tokens + (elapsed * perMin) / 60_000) >= 1;
  }
}

/** Per-key daily counters (SEC-22), reset at IST midnight via the day string. */
export class DailyQuota {
  private day = '';
  private readonly counts = new Map<string, number>();
  constructor(private readonly dayOf: () => string) {}
  /** returns false if the quota is exhausted */
  take(key: string, quota: number, n = 1): boolean {
    const d = this.dayOf();
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
    const used = this.counts.get(key) ?? 0;
    if (used + n > quota) return false;
    this.counts.set(key, used + n);
    return true;
  }
}

/**
 * Tracks failed authentications per (client, key prefix) (ruling 25, SA-D-15). After `threshold`
 * failures in 5 min that pair is blocked for 15 min. A block only changes how *failing* requests are
 * answered (429 instead of 401); a valid key is never refused because of it (SA-C-01).
 * Both maps are bounded (LRU) and swept (SA-C-05).
 */
export class AuthFailureTracker {
  private readonly fails = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();
  private lastSweep = 0;
  constructor(
    private readonly clock: Clock,
    private readonly threshold: number,
    private readonly windowMs = 5 * 60_000,
    private readonly blockMs = 15 * 60_000,
    private readonly maxEntries = 100_000,
  ) {}

  get sizes(): { fails: number; blocked: number } {
    return { fails: this.fails.size, blocked: this.blockedUntil.size };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(k);
    for (const [k, arr] of this.fails) if (arr.length === 0 || now - arr[arr.length - 1]! >= this.windowMs) this.fails.delete(k);
  }

  private bound<V>(m: Map<string, V>): void {
    while (m.size >= this.maxEntries) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }

  isBlocked(key: string): boolean {
    const now = this.clock.now().getTime();
    this.sweep(now);
    const until = this.blockedUntil.get(key);
    if (until === undefined) return false;
    if (now >= until) {
      this.blockedUntil.delete(key);
      return false;
    }
    return true;
  }

  /** record a failure; returns true if this failure triggered a block */
  recordFailure(key: string): boolean {
    const now = this.clock.now().getTime();
    this.sweep(now);
    const arr = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.fails.delete(key);
    this.bound(this.fails);
    this.fails.set(key, arr);
    if (arr.length >= this.threshold) {
      this.bound(this.blockedUntil);
      this.blockedUntil.set(key, now + this.blockMs);
      this.fails.delete(key);
      return true;
    }
    return false;
  }
}
