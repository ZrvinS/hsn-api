import type { IntegrityRepo, IntegritySnapshot } from '../types.js';
import type { Stmts } from './base.js';

/** Raw rows the state-to-audit cross-check needs (SA-C2-02). Read-only. */
export class SqliteIntegrityRepo implements IntegrityRepo {
  constructor(private readonly q: Stmts) {}
  snapshot(): IntegritySnapshot {
    return {
      versions: this.q.all(`SELECT version, content_hash FROM dataset_versions ORDER BY rowid`),
      seedBatches: this.q.all(`SELECT id, dataset_version FROM seed_batches`),
      proposals: this.q.all(
        `SELECT id, status, action, content_sha256, decided_by_actor_id, resulting_rule_id, resulting_version, supersedes_rule_id,
                end_date, rule_json, payload_json, rationale, retroactive_reason, target_sha256 FROM rate_proposals ORDER BY id`,
      ),
      rules: this.q.all(`SELECT * FROM rate_rules ORDER BY rule_id`),
      keys: this.q.all(`SELECT id, prefix, scopes, actor_id, admin_grant_id, expires_at, revoked_at, tenant, llm_opt_out, rate_limit_per_min, daily_quota FROM api_keys ORDER BY id`),
      watched: this.q.all(`SELECT id, state, affected_prefixes, source, notification_key FROM watched_notifications ORDER BY id`),
      actors: this.q.all(`SELECT id, handle, created_via, grant_proposal_id, disabled_at FROM admin_actors ORDER BY id`),
    };
  }
}
