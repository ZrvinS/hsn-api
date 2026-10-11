import type { ProposalRepo, ProposalRow, ProposalStatus, RuleInput } from '../types.js';
import type { Stmts } from './base.js';

type Raw = Omit<ProposalRow, 'rule' | 'payload'> & { rule_json: string | null; payload_json: string | null };
const COLS = `id, status, action, supersedes_rule_id, end_date, rule_json, payload_json, rationale, retroactive_reason,
  content_sha256, target_sha256, proposed_by, proposed_by_actor_id, proposed_key_id, proposed_at, decided_by,
  decided_by_actor_id, decided_key_id, decided_at, decision_comment, resulting_rule_id, resulting_version`;

function toRow(r: Raw | null): ProposalRow | null {
  if (!r) return null;
  const { rule_json, payload_json, ...rest } = r;
  return {
    ...rest,
    rule: rule_json === null ? null : (JSON.parse(rule_json) as RuleInput),
    payload: payload_json === null ? null : (JSON.parse(payload_json) as Record<string, unknown>),
  };
}

export class SqliteProposalRepo implements ProposalRepo {
  constructor(private readonly q: Stmts) {}
  insert(p: ProposalRow): void {
    this.q.run(
      `INSERT INTO rate_proposals(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.id, p.status, p.action, p.supersedes_rule_id, p.end_date, p.rule === null ? null : JSON.stringify(p.rule),
      p.payload === null ? null : JSON.stringify(p.payload), p.rationale, p.retroactive_reason, p.content_sha256, p.target_sha256,
      p.proposed_by, p.proposed_by_actor_id, p.proposed_key_id, p.proposed_at, p.decided_by, p.decided_by_actor_id,
      p.decided_key_id, p.decided_at, p.decision_comment, p.resulting_rule_id, p.resulting_version,
    );
  }
  get(id: string): ProposalRow | null {
    return toRow(this.q.get<Raw>(`SELECT ${COLS} FROM rate_proposals WHERE id = ?`, id));
  }
  list(status: ProposalStatus, limit: number, afterId: string | null): ProposalRow[] {
    return this.q
      .all<Raw>(
        `SELECT ${COLS} FROM rate_proposals WHERE status = ? AND (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`,
        status, afterId, afterId, limit,
      )
      .map((r) => toRow(r)!);
  }
  pending(): ProposalRow[] {
    return this.q.all<Raw>(`SELECT ${COLS} FROM rate_proposals WHERE status = 'pending' ORDER BY id`).map((r) => toRow(r)!);
  }
  decide(id: string, d: Parameters<ProposalRepo['decide']>[1]): void {
    const r = this.q.run(
      `UPDATE rate_proposals SET status = ?, decided_by = ?, decided_by_actor_id = ?, decided_key_id = ?, decided_at = ?,
              decision_comment = ?, resulting_rule_id = ?, resulting_version = ? WHERE id = ? AND status = 'pending'`,
      d.status, d.decided_by, d.decided_by_actor_id, d.decided_key_id, d.decided_at, d.decision_comment,
      d.resulting_rule_id, d.resulting_version, id,
    );
    if (r.changes !== 1) throw new Error(`proposal ${id} is not pending`);
  }
}
