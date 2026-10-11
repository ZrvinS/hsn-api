/**
 * buildApp(deps): Fastify instance with all plugins and routes. Used by main.ts and tests (app.inject).
 * Hooks: request id → CORS → auth (prefix + HMAC + timingSafeEqual) → scope → per-key token bucket →
 * daily quota → JSON-schema validation → handler → problem+json errors → security headers.
 */
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Writable } from 'node:stream';
import type { AppConfig } from './config.js';
import type { AppContext, AuthInfo, BootChecks, RouteEntry } from './context.js';
import { systemClock, rfc3339, type Clock } from './lib/clock.js';
import { clientRequestId, newRequestId } from './lib/requestId.js';
import { AppError, problemBody, type FieldError } from './lib/problem.js';
import { capPointer, fitErrors, pointerToken, preValidateShape } from './lib/schemaGuard.js';
import { REDACT_PATHS, scrubKeys, truncateIp } from './lib/redact.js';
import { bearerToken, DUMMY_HASH, hashApiKey, hashesEqual, parseApiKey } from './lib/apiKey.js';
import { AuthFailureTracker, DailyQuota, TokenBucketLimiter, type RateLimiter } from './lib/rateLimit.js';
import { istDate } from './lib/dates.js';
import { clientBucketKey, ipAllowed } from './lib/ip.js';
import type { Storage } from './repositories/sqlite/index.js';
import { RateService } from './services/rates.js';
import { TaxService } from './services/tax.js';
import { ProposalService } from './services/proposals.js';
import type { Classifier } from './classify/types.js';
import { unavailableClassifier } from './classify/stub.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHsnRoutes } from './routes/hsn.js';
import { registerTaxRoutes } from './routes/tax.js';
import { registerRatesRoutes } from './routes/rates.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { Metrics } from './lib/metrics.js';
import { registerClassifyRoutes } from './routes/classify.js';
import { verifyAll } from './services/audit.js';
import { crossCheckState } from './services/integrity.js';
import { RestoreGuard } from './services/restoreGuard.js';

/** Which routes a listener serves (ruling 25): admin routes only on the admin listener. */
export type AppSurface = 'public' | 'admin' | 'all';

/**
 * Limiter / quota / brute-force state shared by the public and admin listeners of one process.
 * Authenticated keys and unauthenticated clients use separate limiter instances (SA-C-05).
 */
/** health probe budget per client (SA-C-20): 10/s sustained, burst 100 */
export const PROBE_LIMIT_PER_MIN = 600;

export interface SharedState {
  keyLimiter: RateLimiter;
  unauthLimiter: RateLimiter;
  quota: DailyQuota;
  authFails: AuthFailureTracker;
  lastTouched: Map<string, number>;
  /** Prometheus metrics for both listeners, served on the admin listener only (ruling 30) */
  metrics: Metrics;
  /** SA-C2-06: restore detection sidecar (moved forward after audit appends and on an interval) */
  restoreGuard?: RestoreGuard;
}

export function createSharedState(config: AppConfig, clock: Clock, keyLimiter?: RateLimiter): SharedState {
  return {
    keyLimiter: keyLimiter ?? new TokenBucketLimiter(clock),
    unauthLimiter: new TokenBucketLimiter(clock),
    quota: new DailyQuota(() => istDate(clock.now())),
    authFails: new AuthFailureTracker(clock, config.authFailBlockThreshold),
    lastTouched: new Map(),
    metrics: new Metrics(),
  };
}

export interface BuildAppDeps {
  config: AppConfig;
  storage: Storage;
  clock?: Clock;
  classifier?: Classifier;
  /** builds the classifier with this app's redacting logger (SA-C-13) */
  classifierFactory?: (log: FastifyBaseLogger) => Classifier | Promise<Classifier>;
  /** log destination (tests capture logs here); defaults to stdout */
  logStream?: Writable;
  /** per-key limiter override (tests) */
  rateLimiter?: RateLimiter;
  /** default 'public' */
  surface?: AppSurface;
  shared?: SharedState;
}

const EXPOSED_HEADERS = 'ETag, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Cost, RateLimit-Policy, Retry-After, X-Request-Id, Location';

export function sendProblem(reply: FastifyReply, request: FastifyRequest, err: AppError): FastifyReply {
  const body = problemBody(err, request.id, request.url.split('?')[0] ?? '/', request.clientRequestId ?? null);
  if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  return reply.code(err.status).header('content-type', 'application/problem+json; charset=utf-8').send(body);
}

/** Validator r3 polish: Ajv runs with allErrors; the problem lists at most this many (the total is in `detail`). */
export const MAX_VALIDATION_ERRORS = 50;

/** A validation problem listing at most MAX_VALIDATION_ERRORS errors within MAX_ERRORS_BYTES (SA-C5-05); `total` is in detail. */
function validationProblem(errors: FieldError[], total: number): AppError {
  const shown = fitErrors(errors.slice(0, MAX_VALIDATION_ERRORS));
  const detail = total > shown.length
    ? `Request validation failed: ${total} problems; the first ${shown.length} are in errors[].`
    : `Request validation failed: ${total} problem${total === 1 ? '' : 's'}. See errors[].`;
  return new AppError('validation_failed', detail, shown);
}

/** Map Ajv errors to problem `errors[]` without reflecting the rejected values (SEC-75). */
function ajvToFieldErrors(err: FastifyError): FieldError[] {
  const ctx = (err as FastifyError & { validationContext?: string }).validationContext ?? 'body';
  // allErrors can report one failure several times (e.g. type + anyOf); keep the first per pointer+keyword
  const seen = new Set<string>();
  const all = (err.validation ?? []).map((v) => {
    const params = v.params as Record<string, unknown>;
    let pointer = v.instancePath || '';
    // SA-C5-05: client-supplied names are escaped (RFC 6901) and truncated; the pointer as a whole is capped
    if (typeof params['missingProperty'] === 'string') pointer += `/${pointerToken(params['missingProperty'])}`;
    if (typeof params['additionalProperty'] === 'string') pointer += `/${pointerToken(params['additionalProperty'])}`;
    pointer = capPointer(pointer);
    if (ctx !== 'body' && pointer === '') pointer = '';
    const message =
      v.keyword === 'additionalProperties'
        ? 'Unknown field is not allowed'
        : v.keyword === 'required'
          ? 'Required'
          : (v.message ?? 'Invalid');
    return { pointer: ctx === 'body' ? pointer || '/' : pointer || `/${ctx}`, code: v.keyword, message };
  });
  return all.filter((e) => {
    const k = `${e.pointer}|${e.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One-time boot checks (SA-C-20, SA-C-11, SA-C2-02, SA-C2-06): FTS5 available; current dataset content hash
 * re-verified; audit chain verified and the published state cross-checked against it; database not behind
 * the recorded high-water mark (restore detection).
 */
function runBootChecks(storage: Storage, log: FastifyBaseLogger, auditKey: string, guard: RestoreGuard): BootChecks {
  let fts5 = false;
  try {
    storage.writeDb.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.boot_fts_probe USING fts5(x); DROP TABLE temp.boot_fts_probe;');
    fts5 = true;
  } catch {
    log.error({ event: 'boot.fts5_unavailable' }, 'FTS5 is not available');
  }
  let datasetIntegrity = true;
  const ds = storage.read.dataset.current();
  if (ds) {
    const recomputed = storage.read.dataset.computeContentHash();
    datasetIntegrity = recomputed === ds.content_hash;
    if (!datasetIntegrity) {
      log.error({ event: 'dataset.integrity_mismatch', dataset_version: ds.current_version, stored: ds.content_hash, recomputed }, 'dataset content hash mismatch');
    }
  }
  // SA-C2-02: the HMAC chain must verify AND explain every published version, proposal, rule, key and actor
  let auditIntegrity = false;
  const chain = verifyAll(storage.read.audit, auditKey);
  if (!chain.ok) {
    log.error({ event: 'audit.chain_broken', alert: true, broken_at: chain.broken_at }, 'audit chain does not verify (edited rows or a different HSN_AUDIT_KEY)');
  } else {
    const x = crossCheckState(storage.read);
    auditIntegrity = x.ok;
    if (!x.ok) log.error({ event: 'audit.state_mismatch', alert: true, problems: x.problems }, 'published state is not explained by the audit log (database edited without HSN_AUDIT_KEY?)');
    if (x.legacy.length > 0) log.warn({ event: 'audit.legacy_state', count: x.legacy.length, sample: x.legacy.slice(0, 5) }, 'some state predates audited content hashes (checked by name only)');
  }
  // SA-C2-06
  const restore = guard.check(log);
  return { fts5, datasetIntegrity, auditIntegrity, stateContinuity: restore.ok, restore: restore.status };
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { config, storage } = deps;
  const clock = deps.clock ?? systemClock;
  const surface: AppSurface = deps.surface ?? 'public';
  const shared = deps.shared ?? createSharedState(config, clock, deps.rateLimiter);
  const { keyLimiter, unauthLimiter, quota, authFails, lastTouched } = shared;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
    // SA-C-12: always a server-generated req_<ULID>; the client's value is logged separately
    genReqId: () => newRequestId(),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 100 },
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    trustProxy: config.trustProxy === false ? false : config.trustProxy,
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true, allErrors: true, allowUnionTypes: true } },
  });

  const log = app.log;
  const auditKey = config.auditKey.reveal();
  const rates = new RateService(storage.read.rules, { warn: (o, m) => log.warn(o, m) }, {
    clock,
    pendingPrefixes: () => storage.read.watched.pending().flatMap((w) => w.affected_prefixes),
  });
  const classifier = deps.classifier ?? (deps.classifierFactory ? await deps.classifierFactory(log.child({ component: 'classifier' })) : unavailableClassifier);
  const ctx: AppContext = {
    config,
    clock,
    storage,
    rates,
    tax: new TaxService(storage.read.hsn, rates),
    proposals: new ProposalService({
      tx: storage.tx,
      read: storage.read,
      clock,
      allowedRatesBp: config.allowedRatesBp,
      sourceHosts: config.sourceHosts,
      sourceIndexPages: config.sourceIndexPages,
      auditKey,
      signingKey: config.datasetSigningKey,
      onAuditHead: (h) => {
        log.info({ event: 'audit.chain_head', audit_id: h.id, audit_hash: h.hash, action: h.action }, 'audit.chain_head');
        // after the surrounding transaction commits (it is synchronous; the read connection sees committed data)
        queueMicrotask(() => shared.restoreGuard?.record());
      },
      onPublish: (v) => log.info({ event: 'dataset.published', dataset_version: v }, 'dataset published'),
      // ruling 29: warn-level line for the operator's alerting (out-of-band notifier deferred)
      onAdminGrant: (g) => log.warn({ event: 'admin.grant_approved', alert: true, ...g }, 'admin.grant_approved'),
      onActorDisabled: (e) => log.warn({ event: 'admin.actor_disabled', alert: true, ...e }, 'admin.actor_disabled'),
    }),
    classifier,
    boot: runBootChecks(storage, log, auditKey, (shared.restoreGuard ??= new RestoreGuard(config.stateHwmFile, auditKey, storage.read, storage.tx, clock))),
    dataset() {
      const d = storage.read.dataset.current();
      if (!d) throw new AppError('dataset_not_loaded', 'No dataset has been published yet. Seed or publish a dataset first.');
      return d;
    },
  };

  // Ruling 29: a key verifies with the pepper its row names; unknown prefixes use the newest (constant work).
  const peppers = new Map(config.keyPeppers.map((p) => [p.id, p.secret.reveal()] as const));
  const newestPepper = config.keyPepper.reveal();

  app.decorateRequest('auth', null);
  app.decorateRequest('startNs', 0n);
  app.decorateRequest('clientRequestId', null);
  app.decorateRequest('rateCost', 0);

  // SEC-05: every route must declare a scope; boot fails otherwise.
  const routeTable: RouteEntry[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (route) => {
    const scope = route.config?.scope;
    if (scope === undefined) throw new Error(`Route ${String(route.method)} ${route.url} has no config.scope (default deny)`);
    for (const m of [route.method].flat()) if (m !== 'HEAD') routeTable.push({ method: String(m), url: route.url, scope: String(scope) });
  });

  app.addHook('onRequest', async (request, reply) => {
    request.startNs = process.hrtime.bigint();
    request.clientRequestId = clientRequestId(request.headers['x-request-id']);
    reply.header('X-Request-Id', request.id);
    if (config.corsOrigins.length > 0) {
      // SA-C-18: always vary on Origin when CORS is configured, so shared caches never mix variants
      reply.header('Vary', 'Origin');
      const origin = request.headers.origin;
      if (typeof origin === 'string' && config.corsOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
      }
    }
  });

  const unauthenticatedError = () =>
    new AppError('unauthenticated', 'Send "Authorization: Bearer <key>". Keys look like hsk_xxxxxxxx_…', undefined, {
      'WWW-Authenticate': 'Bearer realm="hsn-api", error="invalid_token"',
    });

  /** Record a failed authentication against (client, presented prefix) and the client's unauth budget. */
  const recordFailure = (request: FastifyRequest, client: string, prefix: string): void => {
    unauthLimiter.take(`unauth:${client}`, config.rateLimitUnauthPerMin);
    const blocked = authFails.recordFailure(`${client}|${prefix}`);
    request.log.warn({ event: 'auth.failed', ip: truncateIp(request.ip), key_prefix: prefix === '-' ? null : prefix }, 'auth.failed');
    if (blocked) request.log.warn({ event: 'auth.bruteforce_suspected', ip: truncateIp(request.ip), key_prefix: prefix === '-' ? null : prefix }, 'auth.bruteforce_suspected');
  };

  const setRateHeaders = (reply: FastifyReply, rl: { limit: number; remaining: number; resetSec: number; burst: number }, cost: number) => {
    reply.header('RateLimit-Limit', String(rl.limit));
    reply.header('RateLimit-Remaining', String(rl.remaining));
    reply.header('RateLimit-Reset', String(rl.resetSec));
    reply.header('RateLimit-Cost', String(cost));
    reply.header('RateLimit-Policy', `${rl.limit};w=60;burst=${rl.burst}`);
  };

  // Auth, scope, rate limit, quota (runs before body parsing and validation).
  // SA-C-01: the presented key is verified FIRST. A valid key is never refused because of other
  // parties' failures from the same address; the per-client budget and the brute-force block only
  // apply to requests that fail authentication (and to requests with no usable credential at all).
  app.addHook('onRequest', async (request, reply) => {
    const routeConfig = request.routeOptions.config;
    if (request.routeOptions.url === undefined) return; // unknown route → 404 handler
    const scope = routeConfig.scope;
    if (scope === 'public') {
      // SA-C-20: health probes are unauthenticated, so they get their own cheap per-client budget
      if (!unauthLimiter.take(`probe:${clientBucketKey(request.ip)}`, PROBE_LIMIT_PER_MIN).allowed) {
        throw new AppError('rate_limited', 'Too many health probes from this address.', undefined, { 'Retry-After': '10' });
      }
      return;
    }
    if (scope === undefined) throw new AppError('forbidden_scope', 'Route has no scope configured.');

    const client = clientBucketKey(request.ip);
    const token = bearerToken(request.headers.authorization);
    const parsed = token === null ? null : parseApiKey(token);
    if (parsed === null) {
      // no or malformed credential: cheap pre-verification throttle, no DB work
      const blocked = authFails.isBlocked(`${client}|-`);
      if (blocked || !unauthLimiter.available(`unauth:${client}`, config.rateLimitUnauthPerMin)) {
        recordFailure(request, client, '-');
        throw new AppError('rate_limited', 'Too many unauthenticated requests from this address.', undefined, { 'Retry-After': blocked ? '900' : '60' });
      }
      recordFailure(request, client, '-');
      throw unauthenticatedError();
    }

    // No auth cache: revocation takes effect immediately (ruling 20, SA-C-19).
    const row = storage.read.keys.getByPrefix(parsed.prefix);
    const rowPepper = row === null ? newestPepper : peppers.get(row.pepper_id);
    if (row !== null && rowPepper === undefined) {
      // the pepper this key was hashed with was removed from HSN_KEY_PEPPERS: the key can no longer verify
      request.log.error({ event: 'api_key.pepper_missing', key_prefix: row.prefix, pepper_id: row.pepper_id }, 'api_key.pepper_missing');
    }
    const actual = hashApiKey(token!, rowPepper ?? newestPepper);
    const match = hashesEqual(actual, row?.key_hash ?? DUMMY_HASH) && row !== null && rowPepper !== undefined;
    const nowMs = clock.now().getTime();
    const expired = row?.expires_at != null && !(Date.parse(row.expires_at) > nowMs); // SA-C-09: epoch compare; unparseable = expired
    const usable = match && row !== null && row.revoked_at === null && !expired && row.scopes.length > 0 && !(row.scopes.includes('admin') && (row.actor_id === null || row.actor_disabled));
    if (!usable || row === null) {
      const failKey = `${client}|${parsed.prefix}`;
      const throttled = authFails.isBlocked(failKey) || !unauthLimiter.available(`unauth:${client}`, config.rateLimitUnauthPerMin);
      recordFailure(request, client, parsed.prefix);
      if (throttled) {
        throw new AppError('rate_limited', 'Too many failed authentication attempts from this address. Try again later.', undefined, { 'Retry-After': '900' });
      }
      throw unauthenticatedError();
    }
    const auth: AuthInfo = {
      keyId: row.id, prefix: row.prefix, tenant: row.tenant, actor: row.actor, actorId: row.actor_id, scopes: row.scopes, llmOptOut: row.llm_opt_out,
    };
    request.auth = auth;

    if (!row.scopes.includes(scope)) {
      throw new AppError('forbidden_scope', `${request.method} ${request.routeOptions.url} needs scope "${scope}"; key ${row.prefix} has [${row.scopes.join(', ')}].`);
    }
    if (scope === 'admin' && config.adminIpAllowlist.length > 0 && !ipAllowed(request.ip, config.adminIpAllowlist)) {
      throw new AppError('forbidden_ip', 'Admin keys may only be used from allow-listed addresses.');
    }

    const cost = routeConfig.cost ?? 1;
    const rl = keyLimiter.take(`key:${row.id}`, row.rate_limit_per_min, cost);
    request.rateCost = cost;
    setRateHeaders(reply, rl, cost);
    if (!rl.allowed) {
      throw new AppError(
        'rate_limited',
        `Key ${row.prefix} is limited to ${rl.limit} tokens per 60 s (this request costs ${cost}). Retry in ${rl.retryAfterSec} s, or cache with ETag / the change feed.`,
        undefined,
        { 'Retry-After': String(rl.retryAfterSec) },
      );
    }
    if (routeConfig.quota && !quota.take(row.id, row.daily_quota ?? config.dailyQuotaDefault)) {
      throw new AppError('quota_exceeded', `Daily quota for key ${row.prefix} is exhausted; it resets at midnight IST.`, undefined, { 'Retry-After': '3600' });
    }
    if ((lastTouched.get(row.id) ?? 0) < nowMs - 60_000) {
      if (lastTouched.size > 100_000) lastTouched.clear();
      lastTouched.set(row.id, nowMs);
      try {
        storage.cache.keys.touchLastUsed(row.id, rfc3339(clock.now()));
      } catch (e) {
        request.log.warn({ event: 'api_key.touch_failed', err: (e as Error).name }, 'last_used_at update failed');
      }
    }
  });

  // Work-proportional cost (ruling 25, SA-C-07): e.g. tax = 1 + floor(lines/50). SA-C5-01: charged from the
  // parsed body BEFORE schema validation, so an oversized invalid body pays for its size.
  app.addHook('preValidation', async (request, reply) => {
    const extra = request.routeOptions.config?.extraCost;
    const a = request.auth;
    if (!extra || !a) return;
    const n = extra(request.body);
    if (!(n > 0)) return;
    const row = storage.read.keys.getById(a.keyId);
    const perMin = row?.rate_limit_per_min ?? config.rateLimitPerMin;
    const rl = keyLimiter.take(`key:${a.keyId}`, perMin, n);
    request.rateCost += n;
    setRateHeaders(reply, rl, request.rateCost);
    if (!rl.allowed) {
      throw new AppError('rate_limited', `This request costs ${request.rateCost} tokens (1 + 1 per ${50} lines); key ${a.prefix} has ${rl.remaining} left. Retry in ${rl.retryAfterSec} s or send fewer lines.`, undefined, {
        'Retry-After': String(rl.retryAfterSec),
      });
    }
  });

  // SA-C5-01: refuse oversized arrays / floods of unknown keys before Ajv (allErrors) looks at every element
  app.addHook('preValidation', async (request) => {
    const bodySchema = (request.routeOptions.schema as { body?: unknown } | undefined)?.body;
    if (!bodySchema || request.body === undefined) return;
    const { errors, total } = preValidateShape(bodySchema, request.body);
    if (errors.length > 0) throw validationProblem(errors, total);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.removeHeader('X-Powered-By');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    // ruling 30: count the top candidate's band (routes/classify.ts belongs to the classifier module)
    if (request.routeOptions.url === '/v1/classify' && reply.statusCode === 200 && typeof payload === 'string') {
      let band = 'unknown';
      try {
        const top = (JSON.parse(payload) as { candidates?: { confidence_band?: string }[] }).candidates?.[0];
        band = top === undefined ? 'none' : ['high', 'medium', 'low'].includes(String(top.confidence_band)) ? String(top.confidence_band) : 'unknown';
      } catch {
        /* not JSON: counted as unknown */
      }
      shared.metrics.classifyBands.inc({ band });
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const ms = Number(process.hrtime.bigint() - request.startNs) / 1e6;
    const routeTpl = request.routeOptions.url ?? 'unmatched';
    shared.metrics.requests.inc({ listener: surface, method: request.method, route: routeTpl, status: String(reply.statusCode) });
    shared.metrics.latency.observe({ listener: surface, route: routeTpl }, ms / 1000);
    request.log.info(
      {
        request_id: request.id,
        client_request_id: request.clientRequestId,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        latency_ms: Math.round(ms * 10) / 10,
        key_id: request.auth?.keyId ?? null,
        tenant: request.auth?.tenant ?? null,
        ip: truncateIp(request.ip),
      },
      'request',
    );
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) return sendProblem(reply, request, error);
    const fe = error as FastifyError;
    if (fe.validation) {
      const errors = ajvToFieldErrors(fe);
      return sendProblem(reply, request, validationProblem(errors, errors.length));
    }
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) return sendProblem(reply, request, new AppError('payload_too_large', 'Request body exceeds the size limit for this route.'));
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe.statusCode === 415) return sendProblem(reply, request, new AppError('unsupported_media_type', 'Send Content-Type: application/json.'));
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      return sendProblem(reply, request, new AppError('validation_failed', 'Malformed request (invalid JSON or forbidden keys such as __proto__).'));
    }
    // Unknown error: log server-side (scrubbed), return generic 500 (SEC-41, SEC-73).
    request.log.error({ event: 'internal_error', err_name: error.name, err_message: scrubKeys(error.message).slice(0, 500) }, 'internal error');
    return sendProblem(reply, request, new AppError('internal', 'Something failed on our side. Quote request_id when reporting.'));
  });

  // 405 for a known path with another method (Allow lists the methods this listener serves for it); 404 otherwise
  let routePatterns: { re: RegExp; method: string }[] | null = null;
  const methodsFor = (path: string): string[] => {
    routePatterns ??= routeTable
      .filter((r) => r.url !== '/*' && r.method !== 'OPTIONS')
      .map((r) => ({
        method: r.method,
        re: new RegExp(`^${r.url.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`),
      }));
    const out = new Set<string>();
    for (const p of routePatterns) if (p.re.test(path)) out.add(p.method);
    if (out.has('GET')) out.add('HEAD');
    return [...out];
  };
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const allowed = path.length <= 512 ? methodsFor(path) : [];
    if (allowed.length > 0 && !allowed.includes(request.method)) {
      return sendProblem(reply, request, new AppError('method_not_allowed', `${request.method} is not supported here; use ${allowed.join(', ')}.`, undefined, { Allow: allowed.join(', ') }));
    }
    return sendProblem(reply, request, new AppError('not_found', 'No such route. All endpoints are under /v1; see the API reference.'));
  });

  // CORS preflight (SEC-71): only allow-listed origins get CORS headers.
  app.options('/*', { config: { scope: 'public' } }, async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && config.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Methods', 'GET, POST');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match, Idempotency-Key, X-Request-Id');
      reply.header('Access-Control-Max-Age', '600');
    }
    return reply.code(204).send();
  });

  registerHealthRoutes(app, ctx);
  if (surface !== 'admin') {
    registerHsnRoutes(app, ctx);
    registerTaxRoutes(app, ctx);
    registerRatesRoutes(app, ctx);
    registerMetaRoutes(app, ctx);
    registerClassifyRoutes(app, ctx);
  }
  if (surface !== 'public') {
    registerAdminRoutes(app, ctx);
  }
  // ruling 30: metrics exist only on the dedicated admin listener (not 'public', not the combined 'all')
  if (surface === 'admin') registerMetricsRoute(app, ctx, shared.metrics);

  await app.ready();
  return app;
}
