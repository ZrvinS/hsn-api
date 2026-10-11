/**
 * Hardened outbound HTTP client (SEC-07, SEC-32..SEC-37). The only module in the classifier
 * area that opens network connections.
 *
 * - URL must be https, no credentials, port 443, host in the exact-hostname allow-list.
 *   A refused URL never opens a socket and never resolves DNS.
 * - DNS is resolved by our own `lookup` hook and every returned address is checked with
 *   isBlockedAddress(); the connection is made to the checked address (no TOCTOU / rebinding).
 *   IP-literal hosts are checked directly.
 * - Redirects are never followed: any 3xx is a failure.
 * - Connect timeout 2 s, total 3 s; body cap 256 KiB (coordinator ruling 22) enforced on
 *   Content-Length and while streaming; identity encoding only (no decompression bombs).
 * - At most 4 concurrent requests (excess fails fast with `busy`); circuit breaker opens after
 *   5 consecutive failures for 60 s.
 * - Only User-Agent and Accept headers are sent; caller headers are never forwarded.
 * - getJson: response must be JSON; it is parsed but NOT trusted — adapters validate it with zod.
 * - getText: only for clients constructed with an explicit `textContentTypes` allow-list (exact media
 *   types, e.g. text/html for the CBIC watcher). The body is returned as a string, still capped at
 *   256 KiB; callers must treat it as untrusted text (it is parsed, never executed or rendered).
 */
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedAddress } from './ipGuard.js';
import { MinuteBudget } from './budget.js';

export const OUTBOUND_MAX_BYTES = 256 * 1024;
export const OUTBOUND_TIMEOUT_MS = 3000;
export const OUTBOUND_CONNECT_TIMEOUT_MS = 2000;
/** Conservative default budget for an allow-listed host without its own setting. */
export const DEFAULT_HOST_PER_MIN = 10;

export type OutboundErrorCode =
  | 'bad_url'
  | 'host_not_allowed'
  | 'blocked_address'
  | 'dns_error'
  | 'redirect'
  | 'http_status'
  | 'timeout'
  | 'too_large'
  | 'bad_content_type'
  | 'bad_json'
  | 'network'
  | 'circuit_open'
  | 'busy'
  | 'rate_budget';

export type OutboundResult = { ok: true; status: number; body: unknown } | { ok: false; error: OutboundErrorCode; status?: number };
export type OutboundTextResult = { ok: true; status: number; body: string; contentType: string } | { ok: false; error: OutboundErrorCode; status?: number };

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundClientOptions {
  /** exact lower-case hostnames */
  allowlist: readonly string[];
  /** identifies us to the third party, e.g. "hsn-api/0.1 (+contact)" */
  userAgent: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxBytes?: number;
  maxConcurrent?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  /**
   * Per-host request budget in requests/minute (SA-K-06, ruling 25), e.g. 15 for
   * world.openfoodfacts.org. A host without an entry gets DEFAULT_HOST_PER_MIN.
   * When the bucket is empty the call is refused with `rate_budget` and no request is made.
   */
  hostPerMin?: Readonly<Record<string, number>>;
  /**
   * SA-K2-03 / SA-K3-03: no single partition (the caller's tenant, else its API key) may take more
   * than this fraction of a host's minute budget. Default 1/3.
   */
  partitionShare?: number;
  /**
   * SA-K3-03 / SA-K3-06: at most this many partitions are tracked (default 1,000). When full, the
   * least-recently-used partition is evicted only if it has been idle for a minute (its bucket is
   * full again, so nothing is lost); if every partition is active, a new partition is refused
   * (`rate_budget`) instead of resetting someone's budget.
   */
  maxPartitions?: number;
  /**
   * Exact media types (lower case, no parameters) that getText() accepts, e.g. ['text/html'].
   * Empty/absent: getText() is refused (`bad_content_type`) and only JSON is possible. Per adapter:
   * each adapter builds its own client, so the OFF client can never receive HTML.
   */
  textContentTypes?: readonly string[];
  /** HTTP statuses whose JSON body is returned to the adapter (default 200 and 404) */
  acceptStatuses?: readonly number[];
  now?: () => number;
  /**
   * Test seams. They are constructor-only (never read from env) and the composition root
   * must not set them. `isAddressAllowed` replaces the private-address check, `port` and `ca`
   * let tests talk to a local TLS server.
   */
  testOnly?: {
    resolver?: Resolver;
    isAddressAllowed?: (ip: string) => boolean;
    port?: number;
    ca?: string | Buffer;
  };
}

class OutboundError extends Error {
  constructor(public readonly code: OutboundErrorCode) {
    super(code);
  }
}

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

export class OutboundHttpClient {
  private readonly allow: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly accept: ReadonlySet<number>;
  private readonly now: () => number;
  private readonly resolver: Resolver;
  private readonly addressAllowed: (ip: string) => boolean;
  private readonly port: number;
  private readonly ca: string | Buffer | undefined;
  private readonly userAgent: string;
  private readonly budgets = new Map<string, MinuteBudget>();
  private readonly hostRate = new Map<string, number>();
  private readonly partitionShare: number;
  /** insertion order = least recently used first (SA-K3-06) */
  private readonly partBudgets = new Map<string, { budget: MinuteBudget; lastUsed: number }>();
  private readonly maxPartitions: number;
  private readonly textTypes: ReadonlySet<string>;
  private inflight = 0;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(opts: OutboundClientOptions) {
    this.allow = new Set(opts.allowlist.map((h) => h.toLowerCase()));
    this.userAgent = opts.userAgent.replace(/[^\x20-\x7e]/g, '').slice(0, 200);
    this.timeoutMs = Math.min(opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS, OUTBOUND_TIMEOUT_MS);
    this.connectTimeoutMs = Math.min(opts.connectTimeoutMs ?? OUTBOUND_CONNECT_TIMEOUT_MS, this.timeoutMs);
    this.maxBytes = Math.min(opts.maxBytes ?? OUTBOUND_MAX_BYTES, OUTBOUND_MAX_BYTES);
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.breakerThreshold = opts.breakerThreshold ?? 5;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 60_000;
    this.accept = new Set(opts.acceptStatuses ?? [200, 404]);
    this.now = opts.now ?? Date.now;
    this.resolver = opts.testOnly?.resolver ?? defaultResolver;
    this.addressAllowed = opts.testOnly?.isAddressAllowed ?? ((ip) => !isBlockedAddress(ip));
    this.port = opts.testOnly?.port ?? 443;
    this.ca = opts.testOnly?.ca;
    const types = (opts.textContentTypes ?? []).map((t) => t.trim().toLowerCase());
    for (const t of types) if (!MEDIA_TYPE_RE.test(t)) throw new Error(`invalid media type in textContentTypes: ${t}`);
    this.textTypes = new Set(types);
    this.partitionShare = Math.min(1, Math.max(0, opts.partitionShare ?? 1 / 3));
    this.maxPartitions = Math.max(1, Math.floor(opts.maxPartitions ?? 1_000));
    for (const h of this.allow) {
      const rate = opts.hostPerMin?.[h] ?? DEFAULT_HOST_PER_MIN;
      this.hostRate.set(h, rate);
      this.budgets.set(h, new MinuteBudget(rate, this.now));
    }
  }

  /** Validate a URL against the policy without any I/O. */
  checkUrl(raw: string): { ok: true; url: URL } | { ok: false; error: 'bad_url' | 'host_not_allowed' | 'blocked_address' } {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: 'bad_url' };
    }
    if (url.protocol !== 'https:') return { ok: false, error: 'bad_url' };
    if (url.username !== '' || url.password !== '') return { ok: false, error: 'bad_url' };
    const port = url.port === '' ? 443 : Number(url.port);
    if (port !== this.port) return { ok: false, error: 'bad_url' };
    const host = url.hostname.toLowerCase();
    if (!this.allow.has(host)) return { ok: false, error: 'host_not_allowed' };
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    if (isIP(literal) !== 0 && !this.addressAllowed(literal)) return { ok: false, error: 'blocked_address' };
    return { ok: true, url };
  }

  private partitionAllows(host: string, partition: string): boolean {
    const k = `${host}\u0000${partition}`;
    const now = this.now();
    const existing = this.partBudgets.get(k);
    if (existing !== undefined) {
      // SA-K4-03: only a granted call refreshes the slot; a refused call neither moves the entry
      // to most-recently-used nor extends its life, so a key hammering an empty bucket goes idle
      // 60 s after its last granted call (its bucket is then full again and eviction loses nothing)
      if (!existing.budget.take()) return false;
      existing.lastUsed = now;
      this.partBudgets.delete(k);
      this.partBudgets.set(k, existing);
      return true;
    }
    if (this.partBudgets.size >= this.maxPartitions) {
      const oldest = this.partBudgets.entries().next().value;
      // the LRU entry is the most idle one: if it is still active, every partition is
      if (oldest === undefined || now - oldest[1].lastUsed < 60_000) return false;
      this.partBudgets.delete(oldest[0]);
    }
    const e = { budget: new MinuteBudget(Math.max(1, Math.floor((this.hostRate.get(host) ?? DEFAULT_HOST_PER_MIN) * this.partitionShare)), this.now), lastUsed: now };
    this.partBudgets.set(k, e);
    return e.budget.take();
  }

  /** number of tracked partitions (tests, metrics) */
  get partitionCount(): number {
    return this.partBudgets.size;
  }

  /** @param partition optional caller partition (tenant, else API key id) for the per-owner budget share */
  async getJson(rawUrl: string, partition?: string): Promise<OutboundResult> {
    const r = await this.execute(rawUrl, 'json', partition);
    return r.ok ? { ok: true, status: r.status, body: r.body } : r;
  }

  /** GET an allow-listed URL whose response must be one of `textContentTypes`; body returned as text. */
  async getText(rawUrl: string): Promise<OutboundTextResult> {
    if (this.textTypes.size === 0) return { ok: false, error: 'bad_content_type' };
    const r = await this.execute(rawUrl, 'text');
    return r.ok ? { ok: true, status: r.status, body: r.body as string, contentType: r.contentType } : r;
  }

  private async execute(rawUrl: string, mode: 'json' | 'text', partition?: string): Promise<{ ok: true; status: number; body: unknown; contentType: string } | { ok: false; error: OutboundErrorCode; status?: number }> {
    const checked = this.checkUrl(rawUrl);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (this.now() < this.openUntil) return { ok: false, error: 'circuit_open' };
    if (this.inflight >= this.maxConcurrent) return { ok: false, error: 'busy' };
    const host = checked.url.hostname.toLowerCase();
    const budget = this.budgets.get(host);
    if (budget === undefined) return { ok: false, error: 'rate_budget' };
    // per-key share first, so a refused key does not spend a shared token
    if (partition !== undefined && !this.partitionAllows(host, partition)) return { ok: false, error: 'rate_budget' };
    if (!budget.take()) return { ok: false, error: 'rate_budget' };
    this.inflight++;
    try {
      const res = await this.request(checked.url, mode);
      this.consecutiveFailures = 0;
      return res;
    } catch (e) {
      const code = e instanceof OutboundError ? e.code : 'network';
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.breakerThreshold) {
        this.openUntil = this.now() + this.breakerCooldownMs;
        this.consecutiveFailures = 0;
      }
      return code === 'http_status' || code === 'redirect'
        ? { ok: false, error: code, ...(e instanceof StatusError ? { status: e.status } : {}) }
        : { ok: false, error: code };
    } finally {
      this.inflight--;
    }
  }

  private lookupHook(): LookupFunction {
    const resolver = this.resolver;
    const allowed = this.addressAllowed;
    return ((hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      resolver(hostname).then(
        (addrs) => {
          if (addrs.length === 0) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
          // Every address must be allowed: one internal address poisons the whole answer.
          if (addrs.some((a) => !allowed(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKEDADDR' }));
          const first = addrs[0]!;
          if (options && options.all) return cb(null, [{ address: first.address, family: first.family }]);
          return cb(null, first.address, first.family);
        },
        (err: unknown) => cb(Object.assign(new Error('dns failure'), { code: (err as { code?: string })?.code ?? 'EDNS' })),
      );
    }) as unknown as LookupFunction;
  }

  private request(url: URL, mode: 'json' | 'text'): Promise<{ ok: true; status: number; body: unknown; contentType: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code: OutboundErrorCode, status?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        clearTimeout(connectTimer);
        req.destroy();
        reject(status === undefined ? new OutboundError(code) : new StatusError(code, status));
      };
      const req = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: this.port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'user-agent': this.userAgent,
            accept: mode === 'json' ? 'application/json' : [...this.textTypes].join(', '),
            'accept-encoding': 'identity',
          },
          agent: false,
          lookup: this.lookupHook(),
          servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
          ...(this.ca !== undefined ? { ca: this.ca } : {}),
          rejectUnauthorized: true,
          maxHeaderSize: 16 * 1024,
        },
        (res) => {
          clearTimeout(connectTimer);
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) return fail('redirect', status);
          if (!this.accept.has(status)) return fail('http_status', status);
          const ctype = String(res.headers['content-type'] ?? '').toLowerCase();
          const mediaType = ctype.split(';')[0]!.trim();
          if (mode === 'json' && !/^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/.test(ctype)) return fail('bad_content_type');
          if (mode === 'text' && !this.textTypes.has(mediaType)) return fail('bad_content_type');
          const charset = /;\s*charset\s*=\s*"?([a-z0-9_-]+)"?/.exec(ctype)?.[1] ?? 'utf-8';
          if (mode === 'text' && !['utf-8', 'utf8', 'us-ascii', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset)) return fail('bad_content_type');
          const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (enc !== 'identity' && enc !== '') return fail('bad_content_type');
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > this.maxBytes) return fail('too_large');
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > this.maxBytes) return fail('too_large');
            chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            let body: unknown;
            const raw = Buffer.concat(chunks);
            if (mode === 'text') {
              body = ['utf-8', 'utf8', 'us-ascii'].includes(charset) ? raw.toString('utf8') : raw.toString('latin1');
            } else {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                return fail('bad_json');
              }
            }
            settled = true;
            clearTimeout(total);
            resolve({ ok: true, status, body, contentType: mediaType });
          });
          res.on('error', () => fail('network'));
          res.on('aborted', () => fail('network'));
        },
      );
      const total = setTimeout(() => fail('timeout'), this.timeoutMs);
      const connectTimer = setTimeout(() => fail('timeout'), this.connectTimeoutMs);
      req.on('socket', (sock) => {
        sock.once('secureConnect', () => clearTimeout(connectTimer));
      });
      req.on('error', (err: Error & { code?: string }) => {
        if (err.code === 'EBLOCKEDADDR') return fail('blocked_address');
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EDNS') return fail('dns_error');
        fail('network');
      });
      req.end();
    });
  }
}

class StatusError extends OutboundError {
  constructor(
    code: OutboundErrorCode,
    public readonly status: number,
  ) {
    super(code);
  }
}
