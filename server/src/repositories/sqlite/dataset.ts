import { createHash } from 'node:crypto';
import type { ChangeInput, ChangeRow, DatasetRepo, DatasetState, DatasetVersionRow } from '../types.js';
import type { Stmts } from './base.js';

const CHANGE_COLS = `seq, dataset_version, published_at, change_type, hsn_prefix, affected_prefix, rule_id, related_rule_id,
  effective_from, effective_to, retroactive, summary`;

export class SqliteDatasetRepo implements DatasetRepo {
  constructor(private readonly q: Stmts) {}

  current(): DatasetState | null {
    return this.q.get<DatasetState>(
      `SELECT s.current_version AS current_version, s.last_change_seq AS last_change_seq, s.feed_epoch AS feed_epoch,
              v.published_at AS published_at, v.content_hash AS content_hash, v.signature AS signature
         FROM dataset_state s JOIN dataset_versions v ON v.version = s.current_version WHERE s.id = 1`,
    );
  }

  versionsOn(datePrefix: string): string[] {
    return this.q
      .all<{ version: string }>(`SELECT version FROM dataset_versions WHERE substr(version, 1, 10) = ?`, datePrefix)
      .map((r) => r.version);
  }

  insertVersion(v: DatasetVersionRow): void {
    this.q.run(
      `INSERT INTO dataset_versions(version, parent_version, published_at, published_by, reason, rule_count, content_hash)
       VALUES (?,?,?,?,?,?,?)`,
      v.version, v.parent_version, v.published_at, v.published_by, v.reason, v.rule_count, v.content_hash,
    );
  }

  updateVersionStats(version: string, ruleCount: number, contentHash: string, signature: string | null): void {
    this.q.run(`UPDATE dataset_versions SET rule_count = ?, content_hash = ?, signature = ? WHERE version = ?`, ruleCount, contentHash, signature, version);
  }

  versionHash(version: string): string | null {
    return this.q.get<{ h: string }>(`SELECT content_hash AS h FROM dataset_versions WHERE version = ?`, version)?.h ?? null;
  }

  setState(version: string, lastChangeSeq: number, feedEpoch?: string): void {
    this.q.run(
      `INSERT INTO dataset_state(id, current_version, last_change_seq, feed_epoch) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version, last_change_seq = excluded.last_change_seq`,
      version, lastChangeSeq, feedEpoch ?? 'unset-epoch',
    );
  }

  rotateFeedEpoch(epoch: string): void {
    this.q.run(`UPDATE dataset_state SET feed_epoch = ? WHERE id = 1`, epoch);
  }

  insertSeedBatch(b: { id: string; dataset_version: string; created_at: string; files: Record<string, string | null> }): void {
    this.q.run(`INSERT INTO seed_batches(id, dataset_version, created_at, files_json) VALUES (?,?,?,?)`, b.id, b.dataset_version, b.created_at, JSON.stringify(b.files));
  }

  appendChange(c: ChangeInput): number {
    return this.q.run(
      `INSERT INTO change_feed(dataset_version, published_at, change_type, hsn_prefix, affected_prefix, rule_id, related_rule_id,
         effective_from, effective_to, retroactive, summary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      c.dataset_version, c.published_at, c.change_type, c.hsn_prefix, c.affected_prefix ?? c.hsn_prefix, c.rule_id,
      c.related_rule_id ?? null, c.effective_from, c.effective_to, c.retroactive ? 1 : 0, c.summary,
    ).lastInsertRowid;
  }

  changes(since: number, limit: number): ChangeRow[] {
    return this.q
      .all<Omit<ChangeRow, 'retroactive'> & { retroactive: number }>(
        `SELECT ${CHANGE_COLS} FROM change_feed WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        since, limit,
      )
      .map((r) => ({ ...r, retroactive: r.retroactive === 1 }));
  }

  minSeq(): number | null {
    return this.q.get<{ m: number | null }>(`SELECT MIN(seq) AS m FROM change_feed`)?.m ?? null;
  }

  maxSeq(): number {
    return this.q.get<{ m: number | null }>(`SELECT MAX(seq) AS m FROM change_feed`)?.m ?? 0;
  }

  computeContentHash(): string {
    const h = createHash('sha256');
    const dump = (label: string, sql: string) => {
      h.update(`--${label}--\n`);
      for (const r of this.q.s(sql).iterate()) h.update(JSON.stringify(r)).update('\n');
    };
    dump('hsn', `SELECT code, level, parent, type, description, keywords FROM hsn_codes ORDER BY code`);
    dump(
      'rules',
      `SELECT rule_id, hsn_prefix, igst_rate_bp, cess_rate_bp, cess_specific_paise, cess_specific_unit, condition_kind,
              condition_text, condition_code, min_unit_price_paise, max_unit_price_paise, effective_from, effective_to,
              notification_ref, source_url, source_pdf_sha256, schedule_serial, verification_status, verified_by,
              last_verified_at, status FROM rate_rules ORDER BY rule_id`,
    );
    dump('synonyms', `SELECT phrase, hsn_code, strength, note, rule_hint FROM synonyms WHERE active = 1 ORDER BY phrase, hsn_code`);
    dump('category_map', `SELECT source, category, hsn_prefix FROM category_map WHERE active = 1 ORDER BY source, category`);
    dump('chapter_keywords', `SELECT keyword, chapter FROM chapter_keywords WHERE active = 1 ORDER BY keyword, chapter`);
    return h.digest('hex');
  }

  activeRuleCount(today: string): number {
    return (
      this.q.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM rate_rules WHERE status = 'active' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
        today, today,
      )?.n ?? 0
    );
  }
}
