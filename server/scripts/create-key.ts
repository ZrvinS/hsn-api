/**
 * Create (or revoke) an API key. The plaintext key is printed ONCE to stdout and never stored.
 *   npx tsx scripts/create-key.ts --tenant sunarone --scopes read,classify --label prod [--expires 2027-01-31T00:00:00Z]
 *   ... --tenant internal --scopes admin --actor priya --grant rp_01J...   (admin key: needs an approved admin_grant)
 *   ... --revoke key_01J... --by priya
 * The first two admin actors and keys come from scripts/bootstrap-admins.ts.
 */
import { parseArgs } from 'node:util';
import { systemClock } from '../src/lib/clock.js';
import { SCOPES, type Scope } from '../src/lib/apiKey.js';
import { createApiKey, KeyInputError, revokeApiKey } from '../src/services/apiKeys.js';
import { cliBoot } from './_common.js';

function main(): number {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      scopes: { type: 'string' },
      actor: { type: 'string' },
      grant: { type: 'string' },
      label: { type: 'string', default: '' },
      'rate-limit': { type: 'string' },
      'daily-quota': { type: 'string' },
      'llm-opt-out': { type: 'boolean', default: false },
      expires: { type: 'string' },
      revoke: { type: 'string' },
      by: { type: 'string', default: process.env['USER'] ?? 'cli' },
    },
  });
  const boot = cliBoot();
  if (!boot) return 1;
  const { config, storage } = boot;
  const secrets = { pepper: config.keyPepper.reveal(), pepperId: config.keyPepperId, auditKey: config.auditKey.reveal(), grantTtlHours: config.adminGrantTtlHours };
  try {
    if (values.revoke) {
      const ok = revokeApiKey(storage.tx, systemClock, secrets.auditKey, values.revoke, values.by ?? 'cli');
      console.log(ok ? `revoked ${values.revoke}` : `no active key ${values.revoke}`);
      return ok ? 0 : 1;
    }
    if (!values.tenant || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(values.tenant)) {
      console.error('--tenant is required (lower-case slug)');
      return 1;
    }
    const scopes = (values.scopes ?? 'read').split(',').map((s) => s.trim());
    if (scopes.some((s) => !(SCOPES as readonly string[]).includes(s))) {
      console.error(`--scopes must be a subset of ${SCOPES.join(',')} (admin alone)`);
      return 1;
    }
    const num = (v: string | undefined, def: number | null): number | null => {
      if (v === undefined) return def;
      if (!/^\d{1,9}$/.test(v) || Number(v) < 1) throw new KeyInputError(`invalid number ${v}`);
      return Number(v);
    };
    const created = createApiKey(storage.tx, systemClock, secrets, {
      tenant: values.tenant,
      scopes: scopes as Scope[],
      actor: values.actor ?? null,
      adminGrantId: values.grant ?? null,
      label: values.label ?? '',
      rateLimitPerMin: num(values['rate-limit'], config.rateLimitPerMin)!,
      dailyQuota: num(values['daily-quota'], null),
      llmOptOut: values['llm-opt-out'] ?? false,
      expiresAt: values.expires ?? null,
      createdBy: values.by ?? 'cli',
    });
    if (scopes.includes('admin')) {
      // ruling 29: admin key issuance is a security event (audit entry api_key.created + this warn line)
      console.error(JSON.stringify({ level: 40, event: 'admin.key_issued', alert: true, key_id: created.id, prefix: created.prefix, actor: values.actor ?? null, admin_grant_id: values.grant ?? null, pepper_id: config.keyPepperId, issued_by: values.by ?? 'cli' }));
    }
    console.error(`created ${created.id} (${created.prefix}); the key below is shown once and is not stored:`);
    console.log(created.key);
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  } finally {
    storage.close();
  }
}

process.exitCode = main();
