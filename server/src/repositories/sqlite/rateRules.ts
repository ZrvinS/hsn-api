import type { RateRuleRepo, RateRuleRow } from '../types.js';
import type { Stmts } from './base.js';

const COLS = `rule_id, hsn_prefix, igst_rate_bp, cess_rate_bp, cess_specific_paise, cess_specific_unit,
  condition_kind, condition_text, condition_code, min_unit_price_paise, max_unit_price_paise, effective_from, effective_to,
  notification_ref, source_url, source_pdf_sha256, schedule_serial, verified_by, last_verified_at, verification_status,
  status, voided_at, voided_in_version, voided_by_rule, retroactive_reason, created_in_version,
  end_dated_in_version, superseded_by, proposal_id, seed_batch_id, citation_note`;
const ACTIVE = `status = 'active'`;

export class SqliteRateRuleRepo implements RateRuleRepo {
  constructor(private readonly q: Stmts) {}

  get(ruleId: string): RateRuleRow | null {
    return this.q.get<RateRuleRow>(`SELECT ${COLS} FROM rate_rules WHERE rule_id = ?`, ruleId);
  }

  rulesInForce(code: string, date: string): { ancestorOrSelf: RateRuleRow[]; descendants: RateRuleRow[] } {
    const rows = this.q.all<RateRuleRow & { rel: 'a' | 'd' }>(
      `SELECT ${COLS},
              CASE WHEN substr(?, 1, length(hsn_prefix)) = hsn_prefix THEN 'a' ELSE 'd' END AS rel
         FROM rate_rules
        WHERE ${ACTIVE} AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
          AND (substr(?, 1, length(hsn_prefix)) = hsn_prefix
               OR (length(hsn_prefix) > length(?) AND substr(hsn_prefix, 1, length(?)) = ?))
        ORDER BY length(hsn_prefix) DESC, rule_id ASC`,
      code, date, date, code, code, code, code,
    );
    const strip = (r: RateRuleRow & { rel: string }): RateRuleRow => {
      const { rel: _rel, ...rest } = r;
      return rest;
    };
    return {
      ancestorOrSelf: rows.filter((r) => r.rel === 'a').map(strip),
      descendants: rows.filter((r) => r.rel === 'd').map(strip),
    };
  }

  byPrefix(prefix: string): RateRuleRow[] {
    return this.q.all<RateRuleRow>(`SELECT ${COLS} FROM rate_rules WHERE hsn_prefix = ? AND ${ACTIVE} ORDER BY effective_from, rule_id`, prefix);
  }

  insert(r: RateRuleRow): void {
    this.q.run(
      `INSERT INTO rate_rules(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.rule_id, r.hsn_prefix, r.igst_rate_bp, r.cess_rate_bp, r.cess_specific_paise, r.cess_specific_unit,
      r.condition_kind, r.condition_text, r.condition_code, r.min_unit_price_paise, r.max_unit_price_paise, r.effective_from, r.effective_to,
      r.notification_ref, r.source_url, r.source_pdf_sha256, r.schedule_serial, r.verified_by, r.last_verified_at, r.verification_status,
      r.status, r.voided_at, r.voided_in_version, r.voided_by_rule, r.retroactive_reason, r.created_in_version,
      r.end_dated_in_version, r.superseded_by, r.proposal_id, r.seed_batch_id, r.citation_note ?? null,
    );
  }

  endDate(ruleId: string, effectiveTo: string, version: string, supersededBy: string | null): void {
    this.q.run(
      `UPDATE rate_rules SET effective_to = ?, end_dated_in_version = ?, superseded_by = COALESCE(?, superseded_by) WHERE rule_id = ?`,
      effectiveTo, version, supersededBy, ruleId,
    );
  }

  markVerified(ruleId: string, verifiedBy: string, at: string, pdfSha256: string, scheduleSerial: string, citation: { url: string | null; notification: string | null } = { url: null, notification: null }): void {
    // citation_note (seed caveat) is cleared by a verify. verified_by is set once (first verifier); re-verification only moves last_verified_at forward (ruling 9/19).
    this.q.run(
      `UPDATE rate_rules SET verification_status = 'verified', verified_by = COALESCE(verified_by, ?), last_verified_at = ?,
              source_pdf_sha256 = COALESCE(source_pdf_sha256, ?), schedule_serial = COALESCE(schedule_serial, ?),
              citation_note = NULL, source_url = COALESCE(?, source_url), notification_ref = COALESCE(?, notification_ref)
        WHERE rule_id = ?`,
      verifiedBy, at, pdfSha256, scheduleSerial, citation.url, citation.notification, ruleId,
    );
  }

  void(ruleId: string, at: string, version: string, replacementRuleId: string): void {
    this.q.run(
      `UPDATE rate_rules SET status = 'voided', voided_at = ?, voided_in_version = ?, voided_by_rule = ? WHERE rule_id = ?`,
      at, version, replacementRuleId, ruleId,
    );
  }

  overdueCount(today: string, cutoff: string): number {
    return (
      this.q.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM rate_rules WHERE ${ACTIVE} AND verification_status = 'verified' AND last_verified_at < ?
            AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
        cutoff, today, today,
      )?.n ?? 0
    );
  }

  codesWithoutRules(today: string): number {
    // SA-C5-02: O(codes + rules) instead of a correlated substr() join. A code is covered when a rule in force
    // today has a prefix that is a prefix of the code (rule at or above it) or that the code is a prefix of
    // (rule below it).
    const prefixes = this.q.all<{ p: string }>(
      `SELECT DISTINCT hsn_prefix AS p FROM rate_rules WHERE ${ACTIVE} AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
      today, today,
    );
    const exact = new Set<string>();
    const below = new Set<string>(); // every leading part of every rule prefix (incl. the prefix itself)
    for (const { p } of prefixes) {
      exact.add(p);
      for (let k = 1; k <= p.length; k++) below.add(p.slice(0, k));
    }
    let n = 0;
    for (const { code } of this.q.all<{ code: string }>(`SELECT code FROM hsn_codes WHERE level >= 4`)) {
      if (below.has(code)) continue;
      let covered = false;
      for (let k = 1; k < code.length && !covered; k++) covered = exact.has(code.slice(0, k));
      if (!covered) n++;
    }
    return n;
  }


  stats(today: string, verifiedSince: string) {
    const active = `${ACTIVE} AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`;
    const r = this.q.get<{ active: number; unverified: number; verified: number; chapters: number; recent: number; oldest: string | null }>(
      `SELECT COUNT(*) AS active,
              COALESCE(SUM(verification_status = 'unverified'), 0) AS unverified,
              COUNT(DISTINCT substr(hsn_prefix, 1, 2)) AS chapters,
              COALESCE(SUM(verification_status = 'verified' AND last_verified_at >= ?), 0) AS recent,
              COALESCE(SUM(verification_status = 'verified'), 0) AS verified,
              MIN(last_verified_at) AS oldest
         FROM rate_rules WHERE ${active}`,
      verifiedSince, today, today,
    ) ?? { active: 0, unverified: 0, verified: 0, chapters: 0, recent: 0, oldest: null };
    // validator r4 polish: how many in-force rules cite each source, and how many of those are verified
    const sources = this.q.all<{ notification: string; url: string; rule_count: number; verified_count: number }>(
      `SELECT notification_ref AS notification, source_url AS url, COUNT(*) AS rule_count,
              COALESCE(SUM(verification_status = 'verified'), 0) AS verified_count
         FROM rate_rules WHERE ${active} GROUP BY notification_ref, source_url ORDER BY notification_ref, source_url LIMIT 200`,
      today, today,
    );
    return {
      active: r.active,
      activeUnverified: r.unverified,
      activeVerified: r.verified,
      chaptersWithRules: r.chapters,
      verifiedRecentlyPercent: r.active === 0 ? 0 : Math.round((r.recent * 1000) / r.active) / 10,
      oldestLastVerifiedAt: r.oldest,
      sources,
    };
  }
}
