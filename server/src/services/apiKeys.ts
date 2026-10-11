/**
 * API keys and admin actors (ruling 17, SEC-14/17/18, SA-C-03/06/09).
 * - Admin keys are ["admin"] only, bound to an admin_actors row; maker ≠ checker compares actor ids.
 * - The first two actors (and one key each) come from scripts/bootstrap-admins.ts in one run; every later
 *   admin actor or admin key needs an approved `admin_grant` proposal decided by a different admin.
 * - Residual risk (documented): anyone with host or database access can bypass this; it protects
 *   against single-actor changes through the API, not against the host owner.
 */
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import { canonicalScopes, generateApiKey, hashApiKey, type Scope } from '../lib/apiKey.js';
import { newId } from '../lib/ids.js';
import type { Repos, TxRunner } from '../repositories/types.js';
import { appendAudit } from './audit.js';

export const ADMIN_KEY_MAX_DAYS = 90;
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;

export class KeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyInputError';
  }
}

/** NFKC → trim → lower-case → [a-z0-9_-]{3,32} (ruling 17). Throws KeyInputError. */
export function normaliseHandle(raw: string): string {
  const h = raw.normalize('NFKC').trim().toLowerCase();
  if (!HANDLE_RE.test(h)) throw new KeyInputError(`actor handle "${h.slice(0, 40)}" must match [a-z0-9_-]{3,32} after NFKC, trim and lower-casing`);
  return h;
}

/** Strict RFC 3339 UTC, normalised, in the future (SA-C-09). */
export function normaliseExpiry(raw: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(raw)) throw new KeyInputError('expires must be RFC 3339 UTC, e.g. 2027-01-31T00:00:00Z');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new KeyInputError('expires is not a real timestamp');
  if (d.getTime() <= now.getTime()) throw new KeyInputError('expires must be in the future');
  return rfc3339(d);
}

export interface CreateKeyInput {
  tenant: string;
  scopes: Scope[];
  /** admin keys: the actor handle (normalised here) */
  actor: string | null;
  /** admin keys after bootstrap: the approved admin_grant proposal this key consumes */
  adminGrantId?: string | null;
  label: string;
  rateLimitPerMin: number;
  dailyQuota: number | null;
  llmOptOut: boolean;
  /** RFC 3339 UTC; admin keys default to and are capped at 90 days (SA-D-09) */
  expiresAt: string | null;
  createdBy: string;
}

export interface KeyServiceSecrets {
  /** the NEWEST pepper (config.keyPepper); new keys are always hashed with it (ruling 29) */
  pepper: string;
  /** its id (config.keyPepperId); default "default" (the single HSN_KEY_PEPPER) */
  pepperId?: string;
  auditKey: string;
  /** SA-C2-05: an approved admin_grant must be redeemed within this many hours (default 72; the DB caps it at 72) */
  grantTtlHours?: number;
}

function insertKey(repos: Repos, clock: Clock, s: KeyServiceSecrets, input: CreateKeyInput, actorId: string | null): { id: string; key: string; prefix: string } {
  const now = clock.now();
  const scopesJson = canonicalScopes(input.scopes); // throws for admin+other (SA-C-06)
  const isAdmin = scopesJson === '["admin"]';
  let expires = input.expiresAt === null ? null : normaliseExpiry(input.expiresAt, now);
  if (isAdmin) {
    const max = now.getTime() + ADMIN_KEY_MAX_DAYS * 86_400_000;
    if (expires === null || new Date(expires).getTime() > max) expires = rfc3339(new Date(max));
  }
  const { key, prefix } = generateApiKey();
  const id = newId('key', now.getTime());
  repos.keys.insert({
    id,
    prefix,
    key_hash: hashApiKey(key, s.pepper),
    scopes: JSON.parse(scopesJson) as Scope[],
    tenant: input.tenant,
    actor_id: actorId,
    admin_grant_id: isAdmin ? (input.adminGrantId ?? null) : null,
    pepper_id: s.pepperId ?? 'default',
    label: input.label,
    rate_limit_per_min: input.rateLimitPerMin,
    daily_quota: input.dailyQuota,
    llm_opt_out: input.llmOptOut,
    created_at: rfc3339(now),
    expires_at: expires,
    revoked_at: null,
    last_used_at: null,
  });
  appendAudit(repos.audit, s.auditKey, {
    at: rfc3339(now),
    actor: input.createdBy,
    key_prefix: null,
    action: 'api_key.created',
    entity_type: 'api_key',
    entity_id: id,
    details: {
      prefix, tenant: input.tenant, scopes: JSON.parse(scopesJson) as unknown, pepper_id: s.pepperId ?? 'default', actor_id: actorId, admin_grant_id: input.adminGrantId ?? null, expires_at: expires,
      // SA-C4-01: the key's policy, so the cross-check can detect a changed opt-out, limit or quota
      llm_opt_out: input.llmOptOut, rate_limit_per_min: input.rateLimitPerMin, daily_quota: input.dailyQuota,
    },
  });
  return { id, key, prefix };
}

/** Creates a key; returns the plaintext ONCE. Only prefix + HMAC are stored; an audit entry is written (SEC-17). */
export function createApiKey(tx: TxRunner, clock: Clock, s: KeyServiceSecrets, input: CreateKeyInput): { id: string; key: string; prefix: string } {
  if (input.scopes.length === 0) throw new KeyInputError('at least one scope is required');
  const isAdmin = input.scopes.includes('admin');
  if (isAdmin && input.scopes.some((x) => x !== 'admin')) throw new KeyInputError('admin keys are distinct keys: "admin" cannot be combined with other scopes');
  if (!isAdmin && (input.actor || input.adminGrantId)) throw new KeyInputError('only admin keys carry an actor or an admin grant');
  return tx((repos) => {
    let actorId: string | null = null;
    if (isAdmin) {
      if (!input.actor) throw new KeyInputError('admin keys need --actor (a registered admin actor handle)');
      const actor = repos.actors.byHandle(normaliseHandle(input.actor));
      if (!actor) throw new KeyInputError(`no admin actor "${normaliseHandle(input.actor)}"; actors are added by bootstrap or an approved admin_grant`);
      if (actor.disabled_at !== null) throw new KeyInputError(`admin actor "${actor.handle}" is disabled`);
      if (input.adminGrantId) {
        const g = repos.proposals.get(input.adminGrantId);
        if (!g || g.action !== 'admin_grant' || g.status !== 'approved' || g.payload?.['op'] !== undefined || g.payload?.['handle'] !== actor.handle) {
          throw new KeyInputError(`${input.adminGrantId} is not an approved admin_grant for "${actor.handle}"`);
        }
        const ttlMs = Math.min(s.grantTtlHours ?? 72, 72) * 3_600_000;
        if (g.decided_at === null || clock.now().getTime() - Date.parse(g.decided_at) > ttlMs) {
          throw new KeyInputError(`${input.adminGrantId} expired: grants must be redeemed within ${Math.min(s.grantTtlHours ?? 72, 72)} h of approval; propose a new admin_grant`);
        }
      }
      actorId = actor.id;
    }
    return insertKey(repos, clock, s, input, actorId);
  });
}

export interface BootstrapAdmin {
  handle: string;
  display_name: string;
}

/**
 * One-time bootstrap (ruling 17): creates the first two admin actors and one admin key each, in one
 * transaction, and records it in the audit log. Refused once any actor exists.
 */
export function bootstrapAdmins(
  tx: TxRunner,
  clock: Clock,
  s: KeyServiceSecrets,
  admins: [BootstrapAdmin, BootstrapAdmin],
  opts: { tenant: string; by: string; expiresAt?: string | null },
): { actor_id: string; handle: string; key_id: string; key: string; prefix: string }[] {
  const handles = admins.map((a) => normaliseHandle(a.handle));
  if (handles[0] === handles[1]) throw new KeyInputError('bootstrap needs two different people (two distinct handles)');
  return tx((repos) => {
    if (repos.actors.count() > 0) throw new KeyInputError('admin actors already exist; use an admin_grant proposal to add more');
    const at = rfc3339(clock.now());
    const out = admins.map((a, i) => {
      const id = newId('act', clock.now().getTime());
      repos.actors.insert({ id, handle: handles[i]!, display_name: a.display_name.trim().slice(0, 100), created_at: at, created_via: 'bootstrap', grant_proposal_id: null, disabled_at: null });
      const k = insertKey(
        repos,
        clock,
        s,
        { tenant: opts.tenant, scopes: ['admin'], actor: handles[i]!, label: `bootstrap ${handles[i]}`, rateLimitPerMin: 600, dailyQuota: null, llmOptOut: true, expiresAt: opts.expiresAt ?? null, createdBy: opts.by },
        id,
      );
      return { actor_id: id, handle: handles[i]!, key_id: k.id, key: k.key, prefix: k.prefix };
    });
    appendAudit(repos.audit, s.auditKey, {
      at, actor: opts.by, key_prefix: null, action: 'admin.bootstrapped', entity_type: 'admin_actor', entity_id: out.map((o) => o.actor_id).join(','),
      details: { handles, key_ids: out.map((o) => o.key_id) },
    });
    return out;
  });
}

export function revokeApiKey(tx: TxRunner, clock: Clock, auditKey: string, keyId: string, by: string): boolean {
  const at = rfc3339(clock.now());
  return tx((repos) => {
    const ok = repos.keys.revoke(keyId, at);
    if (ok) appendAudit(repos.audit, auditKey, { at, actor: by, key_prefix: null, action: 'api_key.revoked', entity_type: 'api_key', entity_id: keyId, details: {} });
    return ok;
  });
}
