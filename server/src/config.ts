import { z } from 'zod';
import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseIpRule } from './lib/ip.js';

/**
 * Secret wrapper: never serialised or logged (SEC-59).
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return '[redacted]';
  }
  toString(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

const DEFAULT_ALLOWED_RATES_BP = [0, 10, 25, 100, 150, 300, 500, 600, 1200, 1800, 2800, 4000];
const DEFAULT_SOURCE_HOSTS = [
  'cbic-gst.gov.in', 'www.cbic-gst.gov.in', 'taxinformation.cbic.gov.in', 'cbic.gov.in', 'www.cbic.gov.in',
  'egazette.gov.in', 'www.egazette.gov.in', 'gstcouncil.gov.in', 'www.gstcouncil.gov.in',
];

/** Hosts the CBIC watcher may contact (research/sources.md §1.1, §6.1); exact names, configurable. */
const DEFAULT_WATCHER_HOSTS = ['cbic-gst.gov.in', 'www.cbic-gst.gov.in', 'taxinformation.cbic.gov.in', 'www.cbic.gov.in'];
const DEFAULT_CT_RATE_URL = 'https://cbic-gst.gov.in/central-tax-rate.html';
const DEFAULT_IT_RATE_URL = 'https://cbic-gst.gov.in/integrated-tax-rate.html';
/** Ruling 36: listing / index pages that are never a notification document (plus the watcher pages). */
const DEFAULT_SOURCE_INDEX_PAGES = [DEFAULT_CT_RATE_URL, DEFAULT_IT_RATE_URL, 'https://cbic-gst.gov.in/gst-goods-services-rates.html'];

const boolStr = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const intStr = (def: number, min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'must be a non-negative integer')
    .optional()
    .transform((v) => (v === undefined ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = (def: string[]) =>
  z
    .string()
    .max(4000)
    .optional()
    .transform((v) =>
      v === undefined
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    );

const hostname = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be an exact lower-case hostname');
const origin = z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, 'must be an exact origin like https://app.example.com');

const ipRule = z.string().max(64).refine((v) => parseIpRule(v) !== null, 'must be an IPv4/IPv6 address or CIDR with an explicit integer prefix length');
const secretStr = z.string().max(512).optional();
/** Fixed keys used only when NODE_ENV=test, so test runs are reproducible. */
const TEST_AUDIT_KEY = 'test-audit-key-not-for-production-0000';

const EnvSchema = z
  .object({
    /** Required, no default (SA-C-04): fail-closed checks must not depend on a forgotten variable. */
    NODE_ENV: z.enum(['development', 'test', 'production'], { required_error: 'must be set explicitly (development | test | production)' }),
    HSN_PORT: intStr(3000, 1, 65535),
    HSN_HOST: z.string().min(1).max(255).default('0.0.0.0'),
    /** Admin routes are served only on this separate listener (ruling 25). */
    HSN_ADMIN_HOST: z.string().min(1).max(255).default('127.0.0.1'),
    HSN_ADMIN_PORT: intStr(3001, 1, 65535),
    /** Production with an empty HSN_TRUST_PROXY must say explicitly that clients connect directly (SA-C-01). */
    HSN_DIRECT_EXPOSURE: boolStr(false),
    HSN_DB_PATH: z.string().min(1).max(1024),
    HSN_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** empty/'false' (default) or a comma-separated list of proxy IPs/CIDRs. Never blindly `true` (SEC-23). */
    HSN_TRUST_PROXY: z
      .string()
      .max(1000)
      .default('')
      .refine((v) => v.trim() !== 'true' && v.trim() !== '*', 'must be empty or a list of proxy IPs/CIDRs, never true')
      .refine(
        (v) => v.trim() === '' || v.trim() === 'false' || v.split(',').every((e) => e.trim() === '' || parseIpRule(e.trim()) !== null),
        'entries must be IP addresses or CIDRs with an explicit prefix length',
      ),
    /** Pepper (HMAC key) for API-key hashes (SEC-12, ruling 10). Required (>= 32 chars) unless NODE_ENV=test. */
    HSN_KEY_PEPPER: secretStr,
    /**
     * Pepper rotation (ruling 29): "id:secret,id:secret", NEWEST FIRST. New keys are hashed with the first;
     * a key verifies with the pepper named by its stored pepper_id. Ids [a-z0-9_-]{1,32}; secrets may not
     * contain commas. A key issued under HSN_KEY_PEPPER has pepper_id "default". Not with HSN_KEY_PEPPER.
     */
    HSN_KEY_PEPPERS: z.string().max(4000).optional(),
    /** Product cache bound (ruling 30): oldest fetched rows are evicted first. */
    HSN_PRODUCT_CACHE_MAX_ROWS: intStr(50_000, 100, 10_000_000),
    /** HMAC key for the audit chain, separate from the pepper (ruling 18). Required unless NODE_ENV=test. */
    HSN_AUDIT_KEY: secretStr,
    /** HMAC key for product-name fingerprints in logs (ruling 25). Required in production; random per process otherwise. */
    HSN_LOG_KEY: secretStr,
    /** Optional Ed25519 private key (base64 PKCS#8 DER) that signs each dataset content hash (SA-C-11). */
    HSN_DATASET_SIGNING_KEY: z.string().max(4000).optional(),
    /** Default per-key bucket (ruling 11: one bucket per key, classify costs 5 tokens). */
    HSN_RATE_LIMIT_PER_MIN: intStr(600, 1, 1_000_000),
    HSN_RATE_LIMIT_UNAUTH_PER_MIN: intStr(60, 1, 1_000_000),
    HSN_DAILY_QUOTA_DEFAULT: intStr(50_000, 1, 100_000_000),
    HSN_AUTH_FAIL_BLOCK_THRESHOLD: intStr(20, 1, 100_000),
    HSN_CORS_ORIGINS: csv([]).pipe(z.array(origin).max(50)),
    HSN_ADMIN_IP_ALLOWLIST: csv([]).pipe(z.array(ipRule).max(100)),
    HSN_ADMIN_WRITES_ENABLED: boolStr(true),
    /** SA-C2-05: an approved admin_grant must be redeemed (create-key --grant) within this many hours (the DB caps it at 72). */
    HSN_ADMIN_GRANT_TTL_HOURS: intStr(72, 1, 72),
    /**
     * SA-C2-06: high-water-mark sidecar (feed_epoch, last_change_seq, audit head), HMAC'd with HSN_AUDIT_KEY, used to
     * detect a database restore at boot. Keep it OUTSIDE the database's backup set. Default "<HSN_DB_PATH>.hwm.json";
     * "off" disables detection (not allowed in production). SA-C3-04: in production it must be set explicitly
     * to a path outside the database's directory (another volume / backup set), so a directory-level restore
     * cannot bring back a matching old sidecar.
     */
    HSN_STATE_HWM_FILE: z.string().min(1).max(1024).optional(),
    /** Kill switch for all outbound adapters (SEC-83). Off by default. */
    HSN_ADAPTERS_ENABLED: boolStr(false),
    HSN_OFF_ENABLED: boolStr(false),
    HSN_OBF_ENABLED: boolStr(false),
    HSN_OFF_USER_AGENT: z.string().max(200).optional(),
    HSN_OUTBOUND_ALLOWLIST: csv([]).pipe(z.array(hostname).max(20)),
    HSN_LLM_ENABLED: boolStr(false),
    HSN_LLM_PROVIDER: z.string().max(64).optional(),
    HSN_LLM_MODEL: z.string().max(128).optional(),
    HSN_LLM_API_KEY: z.string().max(512).optional(),
    HSN_LLM_DATA_DISCLOSURE_ACK: boolStr(false),
    HSN_LLM_CALLS_PER_MIN: intStr(30, 1, 100_000),
    HSN_LLM_CALLS_PER_DAY: intStr(5000, 1, 10_000_000),
    /** outbound product lookups (cache misses) per key per IST day, plus global rates and queue (ruling 25) */
    HSN_OUTBOUND_PER_KEY_DAILY: intStr(500, 0, 10_000_000),
    HSN_OFF_RATE_PER_MIN: intStr(15, 1, 10_000),
    HSN_OBF_RATE_PER_MIN: intStr(10, 1, 10_000),
    HSN_OUTBOUND_QUEUE_MAX: intStr(4, 0, 1000),
    /** CBIC notification watcher (ruling 10 / 27). The in-process interval is off by default; cron runs scripts/watch-cbic.ts. */
    HSN_WATCHER_ENABLED: boolStr(false),
    HSN_WATCHER_INTERVAL_MIN: intStr(360, 15, 1440),
    HSN_WATCHER_HOSTS: csv(DEFAULT_WATCHER_HOSTS).pipe(z.array(hostname.refine((h) => !/^[\d.]+$/.test(h), 'must be a DNS name, not an IP address')).min(1).max(10)),
    /** empty string disables that page */
    HSN_WATCHER_CT_RATE_URL: z.string().max(500).default(DEFAULT_CT_RATE_URL),
    HSN_WATCHER_IT_RATE_URL: z.string().max(500).default(DEFAULT_IT_RATE_URL),
    HSN_WATCHER_USER_AGENT: z.string().min(3).max(200).default('hsn-api-watcher/0.1 (rate notification watcher)'),
    /** notifications dated before this are not queued (the seed already transcribes 9/2025-CT(Rate), 17-09-2025) */
    HSN_WATCHER_NOT_BEFORE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').default('2025-09-17'),
    /** curated known data gaps served by /v1/meta/dataset (default <server>/data/seed/known_gaps.json) */
    HSN_KNOWN_GAPS_FILE: z.string().min(1).max(1024).optional(),
    HSN_SOURCE_HOSTS: csv(DEFAULT_SOURCE_HOSTS).pipe(z.array(hostname).min(1).max(50)),
    /**
     * Ruling 36: citation URLs that are listing/index pages, not notification documents. A rule citing one (or any
     * URL whose path neither contains /view-pdf/ nor ends in .pdf) can only be verified with a document source.url.
     * The watcher pages are always included.
     */
    HSN_SOURCE_INDEX_PAGES: csv(DEFAULT_SOURCE_INDEX_PAGES).pipe(z.array(z.string().url().max(500)).max(50)),
    HSN_ALLOWED_RATES_BP: csv(DEFAULT_ALLOWED_RATES_BP.map(String)).pipe(
      z.array(z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(0).max(10000))).min(1),
    ),
    HSN_FEED_RETENTION_DAYS: z
      .string()
      .regex(/^\d{1,6}$/)
      .optional()
      .transform((v) => (v === undefined ? null : Number(v))),
  })
  .superRefine((env, ctx) => {
    let peppers: { id: string; secret: string }[] = [];
    if (env.HSN_KEY_PEPPERS !== undefined) {
      if (env.HSN_KEY_PEPPER !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_KEY_PEPPERS'], message: 'set HSN_KEY_PEPPERS or HSN_KEY_PEPPER, not both (put the old pepper in the list as "default:<secret>")' });
      }
      const parsed = parsePeppers(env.HSN_KEY_PEPPERS);
      if (typeof parsed === 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_KEY_PEPPERS'], message: parsed });
      else peppers = parsed;
    } else if (env.HSN_KEY_PEPPER !== undefined) {
      peppers = [{ id: 'default', secret: env.HSN_KEY_PEPPER }];
    }
    if (env.NODE_ENV !== 'test') {
      if (peppers.length === 0 && env.HSN_KEY_PEPPERS === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_KEY_PEPPER'], message: 'required (>= 32 chars) unless NODE_ENV=test (or set HSN_KEY_PEPPERS)' });
      }
      for (const p of peppers) {
        if (p.secret.length < 32) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [env.HSN_KEY_PEPPERS !== undefined ? 'HSN_KEY_PEPPERS' : 'HSN_KEY_PEPPER'], message: `pepper "${p.id}": required (>= 32 chars) unless NODE_ENV=test` });
        }
      }
      if (env.HSN_AUDIT_KEY === undefined || env.HSN_AUDIT_KEY.length < 32) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_AUDIT_KEY'], message: 'required (>= 32 chars) unless NODE_ENV=test' });
      }
      if (peppers.some((p) => p.secret === env.HSN_AUDIT_KEY)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_AUDIT_KEY'], message: 'must differ from HSN_KEY_PEPPER / every HSN_KEY_PEPPERS secret' });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.HSN_LOG_KEY === undefined || env.HSN_LOG_KEY.length < 32) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_LOG_KEY'], message: 'required (>= 32 chars) when NODE_ENV=production' });
      }
      // SA-C2-07: the admin listener (admin routes and /metrics) is loopback-only unless an allow-list is set
      if (!isLoopbackHost(env.HSN_ADMIN_HOST) && env.HSN_ADMIN_IP_ALLOWLIST.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['HSN_ADMIN_HOST'],
          message: 'a non-loopback admin listener needs HSN_ADMIN_IP_ALLOWLIST in production (it serves /metrics and the admin API)',
        });
      }
      if (env.HSN_KNOWN_GAPS_FILE !== undefined && !isAbsolute(env.HSN_KNOWN_GAPS_FILE)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_KNOWN_GAPS_FILE'], message: 'must be an absolute path in production (SA-C5-04)' });
      }
      if (env.HSN_STATE_HWM_FILE === 'off') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_STATE_HWM_FILE'], message: 'restore detection cannot be turned off in production' });
      } else if (env.HSN_STATE_HWM_FILE === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_STATE_HWM_FILE'], message: 'required in production: a path on a different volume / backup set than HSN_DB_PATH (SA-C3-04)' });
      } else if (env.HSN_DB_PATH !== ':memory:' && dirname(resolve(env.HSN_STATE_HWM_FILE)) === dirname(resolve(env.HSN_DB_PATH))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_STATE_HWM_FILE'], message: "must not be in the database's directory in production: a directory-level backup would restore a matching sidecar (SA-C3-04)" });
      }
      const tp = env.HSN_TRUST_PROXY.trim();
      if ((tp === '' || tp === 'false') && !env.HSN_DIRECT_EXPOSURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['HSN_TRUST_PROXY'],
          message: 'set it to the platform proxy addresses/CIDRs, or set HSN_DIRECT_EXPOSURE=true if clients connect directly (SA-C-01)',
        });
      }
    }
    for (const k of ['HSN_WATCHER_CT_RATE_URL', 'HSN_WATCHER_IT_RATE_URL'] as const) {
      const v = env[k].trim();
      if (v === '') continue;
      let u: URL | null = null;
      try {
        u = new URL(v);
      } catch {
        u = null;
      }
      if (u === null || u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443') || u.pathname === '/') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'must be an https URL of a listing page (default port, no credentials)' });
      } else if (!env.HSN_WATCHER_HOSTS.includes(u.hostname) || !env.HSN_SOURCE_HOSTS.includes(u.hostname)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'host must be in both HSN_WATCHER_HOSTS and HSN_SOURCE_HOSTS' });
      }
    }
    if (env.HSN_ADMIN_HOST === env.HSN_HOST && env.HSN_ADMIN_PORT === env.HSN_PORT) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_ADMIN_PORT'], message: 'admin listener must differ from the public listener' });
    }
    if (env.HSN_DATASET_SIGNING_KEY !== undefined) {
      try {
        const k = createPrivateKey({ key: Buffer.from(env.HSN_DATASET_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
        if (k.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_DATASET_SIGNING_KEY'], message: 'must be a base64 PKCS#8 DER Ed25519 private key' });
      }
    }
    if (env.HSN_LLM_ENABLED) {
      for (const k of ['HSN_LLM_PROVIDER', 'HSN_LLM_MODEL', 'HSN_LLM_API_KEY'] as const) {
        if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'required when HSN_LLM_ENABLED=true' });
      }
      if (!env.HSN_LLM_DATA_DISCLOSURE_ACK) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_LLM_DATA_DISCLOSURE_ACK'], message: 'must be true when HSN_LLM_ENABLED=true' });
      }
    }
    if (env.HSN_OBF_ENABLED && env.HSN_ADAPTERS_ENABLED) {
      if (!env.HSN_OFF_USER_AGENT) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_OFF_USER_AGENT'], message: 'required when the Open Beauty Facts adapter is enabled' });
      if (!env.HSN_OUTBOUND_ALLOWLIST.includes('world.openbeautyfacts.org')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_OUTBOUND_ALLOWLIST'], message: 'must include world.openbeautyfacts.org when the adapter is enabled' });
      }
    }
    if (env.HSN_OFF_ENABLED && env.HSN_ADAPTERS_ENABLED) {
      if (!env.HSN_OFF_USER_AGENT) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_OFF_USER_AGENT'], message: 'required when the Open Food Facts adapter is enabled' });
      if (!env.HSN_OUTBOUND_ALLOWLIST.includes('world.openfoodfacts.org')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HSN_OUTBOUND_ALLOWLIST'], message: 'must include world.openfoodfacts.org when the adapter is enabled' });
      }
    }
  });

/** 127.0.0.0/8, ::1 and localhost. */
export function isLoopbackHost(h: string): boolean {
  const v = h.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return v === 'localhost' || v === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly adminHost: string;
  readonly adminPort: number;
  readonly directExposure: boolean;
  readonly dbPath: string;
  /** SA-C2-06: high-water-mark sidecar file, or null when disabled (in-memory DB or "off") */
  readonly stateHwmFile: string | null;
  /** SA-C2-05: hours an approved admin_grant stays redeemable */
  readonly adminGrantTtlHours: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** false, or list of trusted proxy addresses/CIDRs passed to Fastify trustProxy. */
  readonly trustProxy: false | string[];
  /** newest pepper: new keys are hashed with it (ruling 29) */
  readonly keyPepper: Secret;
  readonly keyPepperId: string;
  /** every configured pepper, newest first; a key verifies with the one its pepper_id names */
  readonly keyPeppers: readonly { id: string; secret: Secret }[];
  readonly productCacheMaxRows: number;
  readonly auditKey: Secret;
  /** HMAC key for name fingerprints in logs; random per process when not configured (dev/test) */
  readonly logKey: Secret;
  readonly datasetSigningKey: KeyObject | null;
  readonly rateLimitPerMin: number;
  readonly rateLimitUnauthPerMin: number;
  readonly dailyQuotaDefault: number;
  readonly authFailBlockThreshold: number;
  readonly corsOrigins: readonly string[];
  readonly adminIpAllowlist: readonly string[];
  readonly adminWritesEnabled: boolean;
  readonly adaptersEnabled: boolean;
  readonly offEnabled: boolean;
  readonly obfEnabled: boolean;
  readonly offUserAgent: string | null;
  readonly outboundAllowlist: readonly string[];
  readonly llm: {
    readonly enabled: boolean;
    readonly provider: string | null;
    readonly model: string | null;
    readonly apiKey: Secret | null;
    readonly callsPerMin: number;
    readonly callsPerDay: number;
  };
  readonly outbound: { readonly perKeyDaily: number; readonly offPerMin: number; readonly obfPerMin: number; readonly queueMax: number };
  readonly sourceHosts: readonly string[];
  /** null: the default <server>/data/seed/known_gaps.json */
  readonly knownGapsFile: string | null;
  /** ruling 36: index/listing pages (normalised hrefs), never a notification document */
  readonly sourceIndexPages: readonly string[];
  readonly watcher: {
    readonly enabled: boolean;
    readonly intervalMin: number;
    readonly hosts: readonly string[];
    readonly pages: readonly { readonly url: string; readonly series: 'central_tax_rate' | 'integrated_tax_rate' }[];
    readonly userAgent: string;
    readonly notBefore: string;
  };
  readonly allowedRatesBp: readonly number[];
  readonly feedRetentionDays: number | null;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse env once. Throws ConfigError (caller exits non-zero): fail closed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Never echo values: only variable names and constraint messages.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const trust = e.HSN_TRUST_PROXY.trim();
  const cfg: AppConfig = {
    nodeEnv: e.NODE_ENV,
    port: e.HSN_PORT,
    host: e.HSN_HOST,
    adminHost: e.HSN_ADMIN_HOST,
    adminPort: e.HSN_ADMIN_PORT,
    directExposure: e.HSN_DIRECT_EXPOSURE,
    dbPath: e.HSN_DB_PATH,
    stateHwmFile:
      e.HSN_STATE_HWM_FILE === 'off' ? null : (e.HSN_STATE_HWM_FILE ?? (e.HSN_DB_PATH === ':memory:' ? null : `${e.HSN_DB_PATH}.hwm.json`)),
    adminGrantTtlHours: e.HSN_ADMIN_GRANT_TTL_HOURS,
    logLevel: e.HSN_LOG_LEVEL,
    trustProxy:
      trust === 'false' || trust === ''
        ? false
        : trust
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    ...pepperFields(e.HSN_KEY_PEPPERS, e.HSN_KEY_PEPPER),
    productCacheMaxRows: e.HSN_PRODUCT_CACHE_MAX_ROWS,
    auditKey: new Secret(e.HSN_AUDIT_KEY ?? TEST_AUDIT_KEY),
    logKey: new Secret(e.HSN_LOG_KEY ?? randomBytes(32).toString('hex')),
    datasetSigningKey:
      e.HSN_DATASET_SIGNING_KEY === undefined
        ? null
        : createPrivateKey({ key: Buffer.from(e.HSN_DATASET_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' }),
    rateLimitPerMin: e.HSN_RATE_LIMIT_PER_MIN,
    rateLimitUnauthPerMin: e.HSN_RATE_LIMIT_UNAUTH_PER_MIN,
    dailyQuotaDefault: e.HSN_DAILY_QUOTA_DEFAULT,
    authFailBlockThreshold: e.HSN_AUTH_FAIL_BLOCK_THRESHOLD,
    corsOrigins: Object.freeze([...e.HSN_CORS_ORIGINS]),
    adminIpAllowlist: Object.freeze([...e.HSN_ADMIN_IP_ALLOWLIST]),
    adminWritesEnabled: e.HSN_ADMIN_WRITES_ENABLED,
    adaptersEnabled: e.HSN_ADAPTERS_ENABLED,
    offEnabled: e.HSN_ADAPTERS_ENABLED && e.HSN_OFF_ENABLED,
    obfEnabled: e.HSN_ADAPTERS_ENABLED && e.HSN_OBF_ENABLED,
    offUserAgent: e.HSN_OFF_USER_AGENT ?? null,
    outboundAllowlist: Object.freeze([...e.HSN_OUTBOUND_ALLOWLIST]),
    llm: Object.freeze({
      enabled: e.HSN_LLM_ENABLED,
      provider: e.HSN_LLM_PROVIDER ?? null,
      model: e.HSN_LLM_MODEL ?? null,
      apiKey: e.HSN_LLM_API_KEY ? new Secret(e.HSN_LLM_API_KEY) : null,
      callsPerMin: e.HSN_LLM_CALLS_PER_MIN,
      callsPerDay: e.HSN_LLM_CALLS_PER_DAY,
    }),
    outbound: Object.freeze({
      perKeyDaily: e.HSN_OUTBOUND_PER_KEY_DAILY,
      offPerMin: e.HSN_OFF_RATE_PER_MIN,
      obfPerMin: e.HSN_OBF_RATE_PER_MIN,
      queueMax: e.HSN_OUTBOUND_QUEUE_MAX,
    }),
    sourceHosts: Object.freeze([...e.HSN_SOURCE_HOSTS]),
    knownGapsFile: e.HSN_KNOWN_GAPS_FILE ?? null,
    sourceIndexPages: Object.freeze(
      [...new Set([...e.HSN_SOURCE_INDEX_PAGES, e.HSN_WATCHER_CT_RATE_URL.trim(), e.HSN_WATCHER_IT_RATE_URL.trim()].filter((u) => u !== '').map((u) => new URL(u).href))],
    ),
    watcher: Object.freeze({
      enabled: e.HSN_WATCHER_ENABLED,
      intervalMin: e.HSN_WATCHER_INTERVAL_MIN,
      hosts: Object.freeze([...e.HSN_WATCHER_HOSTS]),
      pages: Object.freeze(
        [
          { url: e.HSN_WATCHER_CT_RATE_URL.trim(), series: 'central_tax_rate' as const },
          { url: e.HSN_WATCHER_IT_RATE_URL.trim(), series: 'integrated_tax_rate' as const },
        ].filter((p) => p.url !== ''),
      ),
      userAgent: e.HSN_WATCHER_USER_AGENT.replace(/[^\x20-\x7e]/g, ''),
      notBefore: e.HSN_WATCHER_NOT_BEFORE,
    }),
    allowedRatesBp: Object.freeze([...e.HSN_ALLOWED_RATES_BP]),
    feedRetentionDays: e.HSN_FEED_RETENTION_DAYS,
  };
  return Object.freeze(cfg);
}

const PEPPER_ID = /^[a-z0-9_-]{1,32}$/;

/** Parse HSN_KEY_PEPPERS ("id:secret,…", newest first); returns an error message on bad input. */
export function parsePeppers(raw: string): { id: string; secret: string }[] | string {
  const out: { id: string; secret: string }[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const i = entry.indexOf(':');
    if (i <= 0) return 'entries must be "id:secret"';
    const id = entry.slice(0, i);
    const secret = entry.slice(i + 1);
    if (!PEPPER_ID.test(id)) return `pepper id "${id.slice(0, 40)}" must match [a-z0-9_-]{1,32}`;
    if (secret === '') return `pepper "${id}" has an empty secret`;
    if (out.some((p) => p.id === id)) return `pepper id "${id}" is listed twice`;
    if (out.some((p) => p.secret === secret)) return `pepper "${id}" repeats another pepper's secret`;
    out.push({ id, secret });
  }
  if (out.length === 0) return 'must list at least one "id:secret"';
  return out;
}

function pepperFields(list: string | undefined, single: string | undefined): { keyPepper: Secret; keyPepperId: string; keyPeppers: readonly { id: string; secret: Secret }[] } {
  const parsed = list !== undefined ? parsePeppers(list) : [{ id: 'default', secret: single ?? '' }];
  const peppers = typeof parsed === 'string' ? [{ id: 'default', secret: '' }] : parsed; // unreachable after validation
  const all = Object.freeze(peppers.map((p) => Object.freeze({ id: p.id, secret: new Secret(p.secret) })));
  return { keyPepper: all[0]!.secret, keyPepperId: all[0]!.id, keyPeppers: all };
}
