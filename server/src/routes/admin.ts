/**
 * Admin API (served only on the admin listener, ruling 25). Every route needs an admin key, which is
 * bound to an admin actor (ruling 17). Writes honour the HSN_ADMIN_WRITES_ENABLED kill switch and an
 * optional Idempotency-Key (24 h, per key; ruling 8).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError, validationError } from '../lib/problem.js';
import type { ProposalCreateApi } from '../services/proposals.js';
import { sourceUrlProblem, RULE_PREFIX_RE, CONDITION_CODES } from '../services/proposals.js';
import type { PendingWatchAction, ProposalStatus, Repos, WatchedNotificationRow } from '../repositories/types.js';
import { verifyFromRepo, appendAudit } from '../services/audit.js';
import { idempotencyContext, runIdempotent } from '../services/idempotency.js';
import { newId } from '../lib/ids.js';
import { rfc3339 } from '../lib/clock.js';
import { isRealDate } from '../lib/dates.js';
import { validateGtin } from '../classify/gtin.js';
import { freshnessFromRepos, keyForText } from '../services/watcher.js';
import { CACHE_NONE, dateQ, digitsQ, intParam, requireAuthActor, S } from './common.js';

const PROPOSAL_ID = '^rp_[0-9A-HJKMNP-TV-Z]{26}$';
const WATCH_ID = '^wn_[0-9A-HJKMNP-TV-Z]{26}$';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const PREFIX = { type: 'string', pattern: '^([0-9]{2}|[0-9]{4}|99[0-9]{3}|[0-9]{6}|[0-9]{8})$' } as const;

const ruleInputBody = {
  type: 'object',
  additionalProperties: false,
  required: ['hsn_prefix', 'igst_rate_bp', 'condition', 'effective_from', 'source'],
  properties: {
    hsn_prefix: PREFIX,
    igst_rate_bp: { type: 'integer', minimum: 0, maximum: 10000 },
    cess: {
      type: 'object',
      additionalProperties: false,
      required: ['rate_bp'],
      properties: {
        rate_bp: { type: 'integer', minimum: 0, maximum: 30000 },
        specific_amount: { type: ['number', 'null'], minimum: 0, maximum: 1_000_000_000 },
        specific_unit: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
      },
    },
    condition: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['none', 'price', 'other'] },
        code: { type: ['string', 'null'], enum: [...CONDITION_CODES, null] },
        text: { type: ['string', 'null'], maxLength: 500 },
        min_unit_price: { type: ['number', 'null'], minimum: 0, maximum: 1_000_000_000 },
        max_unit_price: { type: ['number', 'null'], minimum: 0, maximum: 1_000_000_000 },
      },
    },
    effective_from: dateQ,
    effective_to: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['notification', 'url', 'pdf_sha256', 'schedule_serial'],
      properties: {
        notification: { type: 'string', minLength: 3, maxLength: 300 },
        url: { type: 'string', minLength: 8, maxLength: 2000 },
        pdf_sha256: SHA256,
        schedule_serial: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
  },
} as const;

const refdataBody = {
  type: 'object',
  additionalProperties: false,
  required: ['table', 'op'],
  properties: {
    table: { type: 'string', enum: ['synonym', 'category_map', 'chapter_keyword', 'hsn_description', 'hsn_code'] },
    op: { type: 'string', enum: ['add', 'deactivate', 'update', 'add_code'] },
    type: { type: 'string', enum: ['goods', 'service'] },
    id: { type: 'integer', minimum: 1 },
    phrase: { type: 'string', minLength: 1, maxLength: 200 },
    hsn_code: PREFIX,
    strength: { type: 'string', enum: ['primary', 'related'] },
    note: { type: ['string', 'null'], maxLength: 1000 },
    rule_hint: { type: ['string', 'null'], enum: [...CONDITION_CODES, null] },
    source: { type: 'string', minLength: 1, maxLength: 64 },
    category: { type: 'string', minLength: 1, maxLength: 200 },
    hsn_prefix: PREFIX,
    keyword: { type: 'string', minLength: 1, maxLength: 64 },
    chapter: { type: 'string', pattern: '^[0-9]{2}$' },
    code: PREFIX,
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    keywords: { type: 'string', maxLength: 2000 },
  },
} as const;

const ruleOut = {
  type: ['object', 'null'],
  properties: {
    hsn_prefix: S.str,
    igst_rate_bp: S.int,
    cess: { type: 'object', properties: { rate_bp: S.int, specific_amount: S.numN, specific_unit: S.strN } },
    condition: { type: 'object', properties: { kind: S.str, code: S.strN, text: S.strN, min_unit_price: S.numN, max_unit_price: S.numN } },
    effective_from: S.str,
    effective_to: S.strN,
    source: { type: 'object', properties: { notification: S.str, url: S.str, pdf_sha256: S.str, schedule_serial: S.str } },
  },
} as const;

const proposalOut = {
  type: 'object',
  properties: {
    id: S.str,
    status: S.str,
    action: S.str,
    supersedes_rule_id: S.strN,
    target_rule: {
      type: ['object', 'null'],
      properties: {
        rule_id: S.str,
        hsn_prefix: S.str,
        igst_rate_bp: S.int,
        igst_rate_percent: S.num,
        condition_kind: S.str,
        condition_text: S.strN,
        effective_from: S.str,
        effective_to: S.strN,
        status: S.str,
        verification_status: S.str,
        notification: S.str,
        citation_note: S.strN,
      },
    },
    end_date: S.strN,
    rule: ruleOut,
    payload: { type: ['object', 'null'], additionalProperties: true },
    rationale: S.str,
    retroactive: S.bool,
    retroactive_reason: S.strN,
    content_sha256: S.str,
    proposed_by: S.str,
    proposed_at: S.str,
    decided_by: S.strN,
    decided_at: S.strN,
    decision_comment: S.strN,
    resulting_rule_id: S.strN,
    resulting_dataset_version: S.strN,
  },
} as const;

const watchOut = {
  type: 'object',
  properties: {
    id: S.str,
    notification_ref: S.str,
    source_url: S.str,
    affected_prefixes: { type: 'array', items: S.str },
    effective_from: S.strN,
    detected_at: S.str,
    state: S.str,
    expedite: S.bool,
    note: S.strN,
    created_by: S.str,
    resolved_at: S.strN,
    resolved_by: S.strN,
    source: S.str,
    notification_key: S.strN,
    title: S.strN,
    notification_date: S.strN,
    // SA-C2-03: request awaiting a second admin's confirmation
    pending_action: {
      type: ['object', 'null'],
      properties: { kind: S.str, affected_prefixes: { type: 'array', items: S.str }, effective_from: S.strN, by: S.str, at: S.str },
    },
  },
} as const;

const runOut = {
  type: ['object', 'null'],
  properties: {
    id: S.int,
    started_at: S.str,
    finished_at: S.str,
    status: S.str,
    items_seen: S.int,
    items_new: S.int,
    error: S.strN,
  },
} as const;

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const assertWritable = () => {
    if (!ctx.config.adminWritesEnabled) throw new AppError('admin_writes_disabled', 'Admin writes are disabled by the HSN_ADMIN_WRITES_ENABLED kill switch.');
  };
  const idemHeader = { type: 'object', properties: { 'idempotency-key': { type: 'string', pattern: UUID } } };
  const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: PROPOSAL_ID } } };
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const UUID_RE = new RegExp(UUID);

  // Ruling 28: every admin write carries an Idempotency-Key (UUID). Runs after authentication (onRequest),
  // before body validation, so an unauthenticated caller still gets 401 and a keyless write never runs.
  app.addHook('preValidation', async (request) => {
    if (request.routeOptions.config?.scope !== 'admin' || !WRITE_METHODS.has(request.method)) return;
    const h = request.headers['idempotency-key'];
    if (typeof h !== 'string' || h === '') {
      throw new AppError('idempotency_key_required', 'Admin writes need an "Idempotency-Key: <UUID>" header; reuse it to retry safely.');
    }
    if (!UUID_RE.test(h)) throw validationError([{ pointer: '/headers/idempotency-key', code: 'pattern', message: 'Must be a UUID' }]);
  });
  /** The Idempotency-Key context for this write (always present after the hook above). */
  const idemFor = (request: FastifyRequest, keyId: string, route: string, body: unknown) => idempotencyContext(keyId, request.headers['idempotency-key'], route, body);

  const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

  /** SA-C2-03: store the first admin's request on a watcher row; 202 until a different admin repeats it. Audited. */
  const requestConfirmation = (
    repos: Repos,
    who: { actor: string; actorId: string; keyPrefix: string },
    row: WatchedNotificationRow,
    action: Omit<PendingWatchAction, 'by' | 'by_actor_id' | 'at'>,
    at: string,
  ): { row: WatchedNotificationRow; awaiting: true } => {
    const pending: PendingWatchAction = { ...action, by: who.actor, by_actor_id: who.actorId, at };
    repos.watched.setPending(row.id, pending);
    appendAudit(repos.audit, ctx.config.auditKey.reveal(), {
      at, actor: who.actor, key_prefix: who.keyPrefix, action: 'watched_notification.confirmation_requested', entity_type: 'watched_notification', entity_id: row.id,
      details: { kind: action.kind, affected_prefixes: action.affected_prefixes ?? null, effective_from: action.effective_from ?? null, replaces: row.pending_action ?? null },
    });
    return { row: repos.watched.get(row.id)!, awaiting: true };
  };

  app.post<{ Body: ProposalCreateApi }>(
    '/v1/admin/rate-proposals',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'rationale'],
          properties: {
            action: { type: 'string', enum: ['create', 'supersede', 'end_date', 'verify', 'correct', 'admin_grant', 'disable_actor', 'refdata_change'] },
            supersedes_rule_id: { type: 'string', pattern: '^rr_[0-9A-Za-z_]{1,60}$' },
            end_date: dateQ,
            rule: ruleInputBody,
            source: {
              type: 'object',
              additionalProperties: false,
              required: ['pdf_sha256', 'schedule_serial'],
              properties: {
                pdf_sha256: SHA256,
                schedule_serial: { type: 'string', minLength: 1, maxLength: 100 },
                // ruling 36: the notification document (required when the rule cites an index page) and canonical reference
                url: { type: 'string', minLength: 8, maxLength: 2000 },
                notification: { type: 'string', minLength: 3, maxLength: 300 },
              },
            },
            grant: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'new_actor'],
              properties: { handle: { type: 'string', minLength: 1, maxLength: 64 }, display_name: { type: 'string', maxLength: 100 }, new_actor: S.bool },
            },
            disable: {
              type: 'object',
              additionalProperties: false,
              required: ['handle'],
              properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
            },
            refdata: refdataBody,
            rationale: { type: 'string', minLength: 10, maxLength: 2000 },
            retroactive_reason: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
        response: { 200: proposalOut, 201: proposalOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      ctx.dataset();
      const who = requireAuthActor(request);
      const idem = idemFor(request, who.keyId, 'proposal.create', request.body);
      const { proposal, replayed } = ctx.proposals.create(request.body, who, idem);
      reply.header('Cache-Control', CACHE_NONE);
      reply.header('Location', `/v1/admin/rate-proposals/${proposal.id}`);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      request.log.info({ event: 'admin.proposal_created', proposal_id: proposal.id, actor: who.actor, replayed }, 'admin.proposal_created');
      return reply.code(201).send(proposal);
    },
  );

  app.get<{ Querystring: { status?: ProposalStatus; limit?: string; cursor?: string } }>(
    '/v1/admin/rate-proposals',
    {
      config: { scope: 'admin' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'withdrawn'] },
            limit: digitsQ(3),
            cursor: { type: 'string', pattern: PROPOSAL_ID },
          },
        },
        response: { 200: { type: 'object', properties: { proposals: { type: 'array', items: proposalOut }, next_cursor: S.strN } } },
      },
    },
    async (request, reply) => {
      const limit = intParam(request.query.limit, 25, 1, 100, '/limit');
      reply.header('Cache-Control', CACHE_NONE);
      return ctx.proposals.list(request.query.status ?? 'pending', limit, request.query.cursor ?? null);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/admin/rate-proposals/:id',
    { config: { scope: 'admin' }, schema: { params: idParams, response: { 200: proposalOut } } },
    async (request, reply) => {
      reply.header('Cache-Control', CACHE_NONE);
      return ctx.proposals.get(request.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { verified_against_source: true; expected_sha256: string; comment?: string } }>(
    '/v1/admin/rate-proposals/:id/approve',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['verified_against_source', 'expected_sha256'],
          properties: { verified_against_source: { type: 'boolean', const: true }, expected_sha256: SHA256, comment: { type: 'string', maxLength: 1000 } },
        },
        response: { 200: proposalOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const idem = idemFor(request, who.keyId, `proposal.approve:${request.params.id}`, request.body);
      const { proposal, replayed } = ctx.proposals.approve(request.params.id, who, { expectedSha256: request.body.expected_sha256, comment: request.body.comment ?? null }, idem);
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      request.log.info({ event: 'admin.proposal_approved', proposal_id: proposal.id, actor: who.actor, replayed }, 'admin.proposal_approved');
      return proposal;
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string; expected_sha256: string } }>(
    '/v1/admin/rate-proposals/:id/reject',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'expected_sha256'],
          properties: { reason: { type: 'string', minLength: 5, maxLength: 1000 }, expected_sha256: SHA256 },
        },
        response: { 200: proposalOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const idem = idemFor(request, who.keyId, `proposal.reject:${request.params.id}`, request.body);
      const { proposal, replayed } = ctx.proposals.reject(request.params.id, who, { expectedSha256: request.body.expected_sha256, comment: request.body.reason }, idem);
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return proposal;
    },
  );

  // Ruling 26: the proposer withdraws their own pending proposal.
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/v1/admin/rate-proposals/:id/withdraw',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 5, maxLength: 1000 } } },
        response: { 200: proposalOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const idem = idemFor(request, who.keyId, `proposal.withdraw:${request.params.id}`, request.body);
      const { proposal, replayed } = ctx.proposals.withdraw(request.params.id, who, { reason: request.body.reason }, idem);
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      request.log.info({ event: 'admin.proposal_withdrawn', proposal_id: proposal.id, actor: who.actor, replayed }, 'admin.proposal_withdrawn');
      return proposal;
    },
  );

  // ---- pending-change signal (ruling 10): a detected-but-unpublished notification
  app.get(
    '/v1/admin/watched-notifications',
    { config: { scope: 'admin' }, schema: { response: { 200: { type: 'object', properties: { notifications: { type: 'array', items: watchOut } } } } } },
    async (_request, reply) => {
      reply.header('Cache-Control', CACHE_NONE);
      return { notifications: ctx.storage.read.watched.pending() };
    },
  );

  app.post<{ Body: { notification: string; url: string; affected_prefixes: string[]; effective_from?: string; expedite?: boolean; note?: string } }>(
    '/v1/admin/watched-notifications',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['notification', 'url', 'affected_prefixes'],
          properties: {
            notification: { type: 'string', minLength: 3, maxLength: 300 },
            url: { type: 'string', minLength: 8, maxLength: 2000 },
            affected_prefixes: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: PREFIX },
            effective_from: dateQ,
            expedite: S.bool,
            note: { type: 'string', maxLength: 1000 },
          },
        },
        response: { 201: watchOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      ctx.dataset();
      const who = requireAuthActor(request);
      const b = request.body;
      const urlProblem = sourceUrlProblem(b.url, ctx.config.sourceHosts, true);
      if (urlProblem) throw validationError([{ pointer: '/url', code: 'source_url', message: urlProblem }]);
      if (b.effective_from !== undefined && !isRealDate(b.effective_from)) throw validationError([{ pointer: '/effective_from', code: 'format', message: 'Must be a real date' }]);
      if (b.affected_prefixes.some((p) => !RULE_PREFIX_RE.test(p))) throw validationError([{ pointer: '/affected_prefixes', code: 'pattern', message: 'HSN/SAC prefixes' }]);
      const idem = idemFor(request, who.keyId, 'watched.create', b);
      const { proposal: row, replayed } = ctx.storage.tx((repos) =>
        runIdempotent(repos, idem, ctx.clock, 201, () => {
          const now = ctx.clock.now();
          const key = keyForText(b.notification);
          if (key !== null && repos.watched.byKey(key) !== null) {
            throw new AppError('duplicate_notification', `${b.notification.trim()} is already watched (${repos.watched.byKey(key)!.id}).`);
          }
          const w = {
            id: newId('wn', now.getTime()),
            notification_ref: b.notification.trim(),
            source_url: b.url,
            affected_prefixes: b.affected_prefixes,
            effective_from: b.effective_from ?? null,
            detected_at: rfc3339(now),
            state: 'detected' as const,
            expedite: b.expedite ?? false,
            note: b.note ?? null,
            created_by: who.actor,
            resolved_at: null,
            resolved_by: null,
            source: 'manual' as const,
            notification_key: key,
            title: null,
            notification_date: null,
          };
          repos.watched.insert(w);
          appendAudit(repos.audit, ctx.config.auditKey.reveal(), {
            at: w.detected_at, actor: who.actor, key_prefix: who.keyPrefix, action: 'watched_notification.detected', entity_type: 'watched_notification', entity_id: w.id,
            details: { notification: w.notification_ref, url: w.source_url, affected_prefixes: w.affected_prefixes, effective_from: w.effective_from },
          });
          return w;
        }),
      );
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(201).send(row);
    },
  );

  // triage a detected notification (typically one the CBIC watcher found): set the HSN/SAC prefixes it
  // affects, which turns on pending_change_detected for those codes (ruling 10). Never changes a rate.
  app.post<{ Params: { id: string }; Body: { affected_prefixes: string[]; effective_from?: string } }>(
    '/v1/admin/watched-notifications/:id/triage',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: WATCH_ID } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['affected_prefixes'],
          properties: { affected_prefixes: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: PREFIX }, effective_from: dateQ },
        },
        response: { 200: watchOut, 202: watchOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const b = request.body;
      if (b.effective_from !== undefined && !isRealDate(b.effective_from)) throw validationError([{ pointer: '/effective_from', code: 'format', message: 'Must be a real date' }]);
      if (b.affected_prefixes.some((p) => !RULE_PREFIX_RE.test(p))) throw validationError([{ pointer: '/affected_prefixes', code: 'pattern', message: 'HSN/SAC prefixes' }]);
      const idem = idemFor(request, who.keyId, `watched.triage:${request.params.id}`, b);
      const { proposal: out, replayed } = ctx.storage.tx((repos) => runIdempotent(repos, idem, ctx.clock, 200, () => {
        const before = repos.watched.get(request.params.id);
        if (!before || before.state !== 'detected') throw new AppError('not_found', `No pending watched notification ${request.params.id}.`);
        const at = rfc3339(ctx.clock.now());
        const removes = before.affected_prefixes.some((p) => !b.affected_prefixes.includes(p));
        // SA-C2-03: removing prefixes from a watcher row turns warnings off; a second admin must repeat the request.
        // SA-C3-03: so does the FIRST triage of an untriaged row (one admin could point it at unrelated codes), and
        // both apply to every row carrying a CBIC notification key, manual or not (a manual row pre-empts the watcher).
        let confirmedBy: { by: string } | null = null;
        const keyed = before.source === 'cbic_watcher' || before.notification_key !== null;
        if (keyed && (removes || before.affected_prefixes.length === 0)) {
          const pend = before.pending_action ?? null;
          const same = pend !== null && pend.kind === 'triage' && sameSet(pend.affected_prefixes ?? [], b.affected_prefixes)
            && (pend.effective_from ?? null) === (b.effective_from ?? null);
          if (!same) return requestConfirmation(repos, who, before, { kind: 'triage', affected_prefixes: b.affected_prefixes, effective_from: b.effective_from ?? null }, at);
          if (pend.by_actor_id === who.actorId) {
            throw new AppError('maker_checker_violation', `This change to ${before.id} was requested by "${pend.by}"; a different admin must confirm it.`);
          }
          confirmedBy = { by: pend.by };
          b.affected_prefixes = pend.affected_prefixes ?? b.affected_prefixes;
        }
        if (!repos.watched.triage(request.params.id, b.affected_prefixes, b.effective_from ?? null)) {
          throw new AppError('not_found', `No pending watched notification ${request.params.id}.`);
        }
        appendAudit(repos.audit, ctx.config.auditKey.reveal(), {
          at, actor: who.actor, key_prefix: who.keyPrefix, action: 'watched_notification.triaged', entity_type: 'watched_notification', entity_id: request.params.id,
          details: {
            before: before.affected_prefixes, affected_prefixes: b.affected_prefixes, effective_from: b.effective_from ?? before.effective_from,
            ...(confirmedBy ? { requested_by: confirmedBy.by, confirmed_by: who.actor } : {}),
          },
        });
        if (confirmedBy && removes) request.log.warn({ event: 'watcher.row_silenced', alert: true, id: before.id, kind: 'triage', requested_by: confirmedBy.by, confirmed_by: who.actor, removed: before.affected_prefixes.filter((p) => !b.affected_prefixes.includes(p)) }, 'watcher row prefixes removed (two admins)');
        return { row: repos.watched.get(request.params.id)!, awaiting: false };
      }));
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(out.awaiting ? 202 : 200).send(out.row);
    },
  );

  // watcher health: last runs + the freshness alert inputs (00b ruling 27)
  app.get(
    '/v1/admin/watcher/status',
    {
      config: { scope: 'admin' },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              freshness: {
                type: 'object',
                properties: {
                  checked_at: S.str,
                  sources_checked_at: S.strN,
                  hours_since_success: S.numN,
                  watcher_stale: S.bool,
                  alert: S.bool,
                  reasons: { type: 'array', items: S.str },
                  overdue_notifications: {
                    type: 'array',
                    items: { type: 'object', properties: { id: S.str, notification: S.str, detected_at: S.str, due_at: S.str } },
                  },
                },
              },
              last_run: runOut,
              recent_runs: { type: 'array', items: runOut },
              untriaged: S.int,
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', CACHE_NONE);
      const read = ctx.storage.read;
      const recent = read.watcherRuns.recent('cbic', 10);
      return {
        freshness: freshnessFromRepos(read, ctx.clock.now()),
        last_run: recent[0] ?? null,
        recent_runs: recent,
        untriaged: read.watched.pending().filter((w) => w.affected_prefixes.length === 0).length,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { state: 'published' | 'dismissed' } }>(
    '/v1/admin/watched-notifications/:id/resolve',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: WATCH_ID } } },
        body: { type: 'object', additionalProperties: false, required: ['state'], properties: { state: { type: 'string', enum: ['published', 'dismissed'] } } },
        response: { 200: watchOut, 202: watchOut },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const idem = idemFor(request, who.keyId, `watched.resolve:${request.params.id}`, request.body);
      const state = request.body.state;
      const { proposal: out, replayed } = ctx.storage.tx((repos) => runIdempotent(repos, idem, ctx.clock, 200, () => {
        const at = rfc3339(ctx.clock.now());
        const before = repos.watched.get(request.params.id);
        if (!before || before.state !== 'detected') throw new AppError('not_found', `No pending watched notification ${request.params.id}.`);
        // SA-C2-03: resolving a watcher-detected row removes its warnings and SLA alert: two admins needed.
        // SA-C3-03: the same for a manual row with a CBIC notification key, since the watcher then skips that notification.
        let requestedBy: string | null = null;
        if (before.source === 'cbic_watcher' || before.notification_key !== null) {
          const pend = before.pending_action ?? null;
          if (pend === null || pend.kind !== state) return requestConfirmation(repos, who, before, { kind: state }, at);
          if (pend.by_actor_id === who.actorId) {
            throw new AppError('maker_checker_violation', `Resolving ${before.id} as ${state} was requested by "${pend.by}"; a different admin must confirm it.`);
          }
          requestedBy = pend.by;
        }
        if (!repos.watched.resolve(request.params.id, state, at, who.actor)) {
          throw new AppError('not_found', `No pending watched notification ${request.params.id}.`);
        }
        appendAudit(repos.audit, ctx.config.auditKey.reveal(), {
          at, actor: who.actor, key_prefix: who.keyPrefix, action: `watched_notification.${state}`, entity_type: 'watched_notification', entity_id: request.params.id,
          details: requestedBy === null ? {} : { requested_by: requestedBy, confirmed_by: who.actor, source: before.source, notification: before.notification_ref },
        });
        if (requestedBy !== null) {
          request.log.warn({ event: 'watcher.row_silenced', alert: true, id: before.id, kind: state, notification: before.notification_ref, requested_by: requestedBy, confirmed_by: who.actor }, `watcher-detected notification ${state} (two admins)`);
        }
        return { row: repos.watched.get(request.params.id)!, awaiting: false };
      }));
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(out.awaiting ? 202 : 200).send(out.row);
    },
  );

  // SA-K-03: purge a cached product (e.g. poisoned or wrong external data) so the next lookup refetches it
  app.delete<{ Params: { gtin: string } }>(
    '/v1/admin/products/:gtin',
    {
      config: { scope: 'admin' },
      schema: {
        headers: idemHeader,
        params: { type: 'object', additionalProperties: false, required: ['gtin'], properties: { gtin: { type: 'string', pattern: '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$' } } },
        response: { 200: { type: 'object', required: ['gtin', 'deleted'], properties: { gtin: S.str, deleted: S.bool } } },
      },
    },
    async (request, reply) => {
      assertWritable();
      const who = requireAuthActor(request);
      const g = validateGtin(request.params.gtin);
      if (!g.valid) throw validationError([{ pointer: '/gtin', code: 'gtin', message: g.message }]);
      const idem = idemFor(request, who.keyId, `product.purge:${g.gtin14}`, {});
      const { proposal: out, replayed } = ctx.storage.tx((repos) => runIdempotent(repos, idem, ctx.clock, 200, () => {
        const prev = repos.products.get(g.gtin14);
        if (!prev) throw new AppError('not_found', `No cached product for GTIN ${g.gtin14}.`);
        repos.products.delete(g.gtin14);
        appendAudit(repos.audit, ctx.config.auditKey.reveal(), {
          at: rfc3339(ctx.clock.now()), actor: who.actor, key_prefix: who.keyPrefix, action: 'product.purged', entity_type: 'product', entity_id: g.gtin14,
          details: { source: prev.source, found: prev.found, fetched_at: prev.fetched_at },
        });
        return { gtin: g.gtin14, deleted: true };
      }));
      reply.header('Cache-Control', CACHE_NONE);
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return out;
    },
  );

  app.get<{ Querystring: { after_id?: string; limit?: string; entity_type?: string; verify?: 'true' | 'false' } }>(
    '/v1/admin/audit',
    {
      config: { scope: 'admin' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            after_id: digitsQ(15),
            limit: digitsQ(3),
            entity_type: { type: 'string', enum: ['rate_rule', 'rate_proposal', 'dataset_version', 'api_key', 'synonym', 'admin_actor', 'watched_notification', 'product'] },
            verify: { type: 'string', enum: ['true', 'false'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: S.int,
                    at: S.str,
                    actor: S.str,
                    key_prefix: S.strN,
                    action: S.str,
                    entity_type: S.str,
                    entity_id: S.str,
                    details: { type: 'object', additionalProperties: true },
                    prev_hash: S.str,
                    hash: S.str,
                  },
                },
              },
              next_after_id: S.int,
              // SA-C-11: compare with logged / exported heads to detect truncation of the newest rows
              head_id: S.int,
              head_hash: S.strN,
              chain_ok: { type: ['boolean', 'null'] },
              chain_broken_at: S.intN,
              verify_note: S.strN,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const afterId = intParam(request.query.after_id, 0, 0, Number.MAX_SAFE_INTEGER, '/after_id');
      const limit = intParam(request.query.limit, 100, 1, 500, '/limit');
      const repo = ctx.storage.read.audit;
      const entries = repo.list(afterId, limit, request.query.entity_type);
      const head = repo.head();
      let chainOk: boolean | null = null;
      let brokenAt: number | null = null;
      let note: string | null = null;
      if (request.query.verify === 'true') {
        const v = verifyFromRepo(repo, ctx.config.auditKey.reveal(), entries);
        chainOk = v.ok;
        brokenAt = v.broken_at;
        if (v.span_too_large) note = 'filtered page spans more than 10000 entries; verify with scripts/verify-audit.ts';
        else if (!v.ok) request.log.error({ event: 'audit.chain_broken', broken_at: v.broken_at }, 'audit chain verification failed');
      }
      reply.header('Cache-Control', CACHE_NONE);
      return {
        entries,
        next_after_id: entries.length > 0 ? entries[entries.length - 1]!.id : afterId,
        head_id: head?.id ?? 0,
        head_hash: head?.hash ?? null,
        chain_ok: chainOk,
        chain_broken_at: brokenAt,
        verify_note: note,
      };
    },
  );
}
