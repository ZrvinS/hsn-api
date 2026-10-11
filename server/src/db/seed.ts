/**
 * Seed loader for data/seed/*.json (format: data/seed/FORMAT.md). Validates every row with zod
 * and aborts the whole seed on any error (fail closed). Only allowed into an empty dataset.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Repos, RateRuleRow, TxRunner, HsnRow } from '../repositories/types.js';
import { deterministicId, newId, ULID_ID } from '../lib/ids.js';
import type { KeyObject } from 'node:crypto';
import { isRealDate, GST_START } from '../lib/dates.js';
import { rfc3339 } from '../lib/clock.js';
import { bpToPercent } from '../lib/money.js';
import { appendAudit } from '../services/audit.js';
import { beginPublish, finishPublish } from '../services/dataset.js';
import { normaliseNotificationRef, notificationRefProblem, rulesOverlap, sourceUrlProblem, CONDITION_CODES, RULE_PREFIX_RE } from '../services/proposals.js';

const CODE_RE = /^(\d{2}|\d{4}|99\d{3}|\d{6}|\d{8})$/;
const CODE_MSG = 'must be 2, 4, 6 or 8 digits (5 only for SAC groups 99xxx)';

const digits = (min: number, max: number) => z.string().regex(new RegExp(`^\\d{${min},${max}}$`));
const date = z.string().refine(isRealDate, 'must be a real date YYYY-MM-DD');
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, 'must be RFC 3339 UTC, e.g. 2026-10-01T00:00:00Z');
const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const HsnSeed = z
  .object({
    code: z.string().regex(CODE_RE, CODE_MSG),
    type: z.enum(['goods', 'service']).optional(),
    description: z.string().trim().min(1).max(2000),
    keywords: z.string().max(2000).optional(),
  })
  .strict();

const RuleSeed = z
  .object({
    rule_id: z.string().regex(ULID_ID('rr'), 'must match ^rr_[0-9A-HJKMNP-TV-Z]{26}$ (or omit it)').optional(),
    hsn_prefix: z.string().regex(RULE_PREFIX_RE, CODE_MSG),
    igst_rate_bp: z.number().int(),
    cess_rate_bp: z.number().int().min(0).max(30000).optional(),
    cess_specific_paise: z.number().int().positive().nullable().optional(),
    cess_specific_unit: z.string().min(1).max(100).nullable().optional(),
    condition_kind: z.enum(['none', 'price', 'other']).optional(),
    condition_text: z.string().trim().min(1).max(500).nullable().optional(),
    condition_code: z.enum(CONDITION_CODES).nullable().optional(),
    min_unit_price_paise: paise.nullable().optional(),
    max_unit_price_paise: paise.nullable().optional(),
    effective_from: date,
    effective_to: date.nullable().optional(),
    notification_ref: z.string().trim().min(3).max(300),
    source_url: z.string().max(2000),
    /** ruling 12: nullable on the seed path */
    source_pdf_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
    schedule_serial: z.string().trim().min(1).max(100).nullable().optional(),
    verified_by: z.string().min(1).max(100).nullable().optional(),
    last_verified_at: timestamp.nullable().optional(),
    verification_status: z.enum(['verified', 'unverified']).optional(),
    research_ref: z.string().max(500).optional(),
    /** seed caveat shown with the rule until a verify approval clears it (round 5) */
    citation_note: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();

const SynonymSeed = z
  .object({
    phrase: z.string().min(1).max(200).refine((s) => s === s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '), 'must be normalised (NFKC, lower-case, single spaces)'),
    hsn_code: z.string().regex(CODE_RE, CODE_MSG),
    strength: z.enum(['primary', 'related']).optional(),
    note: z.string().max(1000).nullable().optional(),
    rule_hint: z.enum(CONDITION_CODES).nullable().optional(),
    created_by: z.string().min(1).max(100).optional(),
  })
  .strict();

const CategorySeed = z.object({ source: z.string().min(1).max(64), category: z.string().min(1).max(200), hsn_prefix: z.string().regex(RULE_PREFIX_RE, CODE_MSG) }).strict();
const ChapterKeywordSeed = z.object({ keyword: z.string().regex(/^[\p{Ll}\p{N}][\p{Ll}\p{N}-]{0,63}$/u, 'single lower-case token'), chapter: digits(2, 2) }).strict();

export class SeedError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Seed rejected:\n  ${issues.slice(0, 50).join('\n  ')}${issues.length > 50 ? `\n  … and ${issues.length - 50} more` : ''}`);
    this.name = 'SeedError';
  }
}

function readItems(dir: string, file: string, required: boolean, warn: (m: string) => void): { items: unknown[]; sha256: string | null } {
  const p = join(dir, file);
  if (!existsSync(p)) {
    if (required) throw new SeedError([`${file}: missing (required)`]);
    warn(`${file}: not found, skipped`);
    return { items: [], sha256: null };
  }
  const raw = readFileSync(p, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SeedError([`${file}: invalid JSON (${(e as Error).message})`]);
  }
  if (Array.isArray(parsed)) return { items: parsed, sha256 };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return { items: (parsed as { items: unknown[] }).items, sha256 };
  }
  throw new SeedError([`${file}: must be an array or an object with an "items" array`]);
}

function parseAll<T>(file: string, items: unknown[], schema: z.ZodType<T>, issues: string[]): T[] {
  const out: T[] = [];
  items.forEach((it, i) => {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
    else for (const iss of r.error.issues) issues.push(`${file}[${i}].${iss.path.join('.') || '(row)'}: ${iss.message}`);
  });
  return out;
}

export interface SeedOptions {
  dir: string;
  allowedRatesBp: readonly number[];
  sourceHosts: readonly string[];
  now: Date;
  /** HMAC key for the audit chain (ruling 18) */
  auditKey: string;
  signingKey?: KeyObject | null;
  /**
   * SA-C-17: seed rows must be `unverified` (the seed bypasses maker–checker). Only test/dev fixtures
   * may pass true; the verifier list is then recorded in the dataset.seeded audit entry.
   */
  allowVerified?: boolean;
  warn?: (msg: string) => void;
}

export interface SeedSummary {
  version: string;
  hsn_codes: number;
  rate_rules: number;
  unverified_rules: number;
  synonyms: number;
  category_map: number;
  chapter_keywords: number;
  content_hash: string;
}

export function seedRuleId(r: { hsn_prefix: string; effective_from: string; condition_kind: string; min_unit_price_paise: number | null; max_unit_price_paise: number | null; condition_text: string | null }): string {
  return deterministicId('rr', [r.hsn_prefix, r.effective_from, r.condition_kind, r.min_unit_price_paise ?? '', r.max_unit_price_paise ?? '', r.condition_kind === 'other' ? r.condition_text ?? '' : ''].join('|'));
}

/** A validated seed directory, ready to apply (round 5: shared by loadSeed and scripts/import-dataset.ts). */
export interface PreparedSeed {
  /** sha256 of each file as read (null = optional file absent) */
  files: Record<string, string | null>;
  counts: { hsn_codes: number; rate_rules: number; synonyms: number; category_map: number; chapter_keywords: number };
  /** @internal */
  rows: {
    hsnRows: Omit<HsnRow, 'added_in_version'>[];
    ruleRows: Omit<RateRuleRow, 'created_in_version'>[];
    syns: z.infer<typeof SynonymSeed>[];
    cats: z.infer<typeof CategorySeed>[];
    chks: z.infer<typeof ChapterKeywordSeed>[];
  };
}

export interface ApplySeedHooks {
  /** called inside the transaction right after the new version is created, before any row is written */
  onVersion?: (repos: Repos, version: string) => void;
  /** dataset.seeded audit actor (default 'seed') */
  by?: string;
  /** dataset_versions.reason (default 'seed') */
  reason?: string;
  /** extra details for the dataset.seeded audit entry */
  auditDetails?: Record<string, unknown>;
}

export function loadSeed(tx: TxRunner, opts: SeedOptions): SeedSummary {
  const prepared = prepareSeed(opts);
  return tx((repos: Repos) => applySeed(repos, prepared, opts));
}

/** Read and validate a seed directory (no database access). Throws SeedError listing every problem. */
export function prepareSeed(opts: Omit<SeedOptions, 'now' | 'auditKey' | 'signingKey'>): PreparedSeed {
  const warn = opts.warn ?? (() => undefined);
  const issues: string[] = [];
  const files = {
    hsn: readItems(opts.dir, 'hsn_codes.json', true, warn),
    rules: readItems(opts.dir, 'rate_rules.json', false, warn),
    syn: readItems(opts.dir, 'synonyms.json', false, warn),
    cat: readItems(opts.dir, 'category_map.json', false, warn),
    chk: readItems(opts.dir, 'chapter_keywords.json', false, warn),
  };
  const hsn = parseAll('hsn_codes.json', files.hsn.items, HsnSeed, issues);
  const rules = parseAll('rate_rules.json', files.rules.items, RuleSeed, issues);
  const syns = parseAll('synonyms.json', files.syn.items, SynonymSeed, issues);
  const cats = parseAll('category_map.json', files.cat.items, CategorySeed, issues);
  const chks = parseAll('chapter_keywords.json', files.chk.items, ChapterKeywordSeed, issues);

  // ---- HSN hierarchy
  const codes = new Set<string>();
  for (const [i, h] of hsn.entries()) {
    if (codes.has(h.code)) issues.push(`hsn_codes.json[${i}].code: duplicate ${h.code}`);
    codes.add(h.code);
    if (h.type === 'goods' && h.code.startsWith('99')) issues.push(`hsn_codes.json[${i}].type: chapter 99 codes are services (SAC)`);
  }
  // nearest existing ancestor among the valid shorter lengths (8→6, 6→5(SAC)→4, 5→4, 4→2)
  const parentOf = (code: string): string | null => {
    if (code.length === 2) return null;
    for (const len of [6, 5, 4, 2]) {
      if (len >= code.length) continue;
      if (len === 5 && !code.startsWith('99')) continue;
      const p = code.slice(0, len);
      if (codes.has(p)) return p;
    }
    return undefined as unknown as null; // signals "missing"
  };
  const hsnRows: Omit<HsnRow, 'added_in_version'>[] = [];
  for (const [i, h] of [...hsn].sort((a, b) => a.code.length - b.code.length || (a.code < b.code ? -1 : 1)).entries()) {
    const parent = parentOf(h.code);
    if (h.code.length > 2 && !codes.has(h.code.slice(0, 2))) issues.push(`hsn_codes.json: ${h.code} has no chapter ${h.code.slice(0, 2)}`);
    else if (parent === undefined) issues.push(`hsn_codes.json: ${h.code} has no parent (row ${i})`);
    hsnRows.push({
      code: h.code,
      level: h.code.length as 2 | 4 | 5 | 6 | 8,
      parent: parent ?? null,
      chapter: h.code.slice(0, 2),
      type: h.type ?? (h.code.startsWith('99') ? 'service' : 'goods'),
      description: h.description,
      keywords: h.keywords ?? '',
    });
  }

  // ---- rate rules
  const ruleRows: Omit<RateRuleRow, 'created_in_version'>[] = [];
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    const at = `rate_rules.json[${i}]`;
    const kind = r.condition_kind ?? 'none';
    const minP = r.min_unit_price_paise ?? null;
    const maxP = r.max_unit_price_paise ?? null;
    const text = r.condition_text ?? null;
    const status = r.verification_status ?? 'unverified';
    if (status === 'verified' && !opts.allowVerified) {
      issues.push(`${at}.verification_status: seed rows must be unverified; a reviewer verifies them through a maker–checker "verify" proposal (SA-C-17)`);
    }
    const code = r.condition_code ?? null;
    if (code !== null && kind !== 'other') issues.push(`${at}.condition_code: only for condition_kind "other"`);
    if (!opts.allowedRatesBp.includes(r.igst_rate_bp)) issues.push(`${at}.igst_rate_bp: ${r.igst_rate_bp} is not an allowed slab (${opts.allowedRatesBp.join(', ')})`);
    if (r.effective_from < GST_START) issues.push(`${at}.effective_from: before 2017-07-01`);
    if (r.effective_to && r.effective_to < r.effective_from) issues.push(`${at}.effective_to: before effective_from`);
    if ((kind === 'price') !== (minP !== null || maxP !== null)) issues.push(`${at}: condition_kind "price" ⇔ at least one price bound`);
    if (kind !== 'none' && text === null) issues.push(`${at}.condition_text: required when condition_kind is ${kind}`);
    if (minP !== null && maxP !== null && minP > maxP) issues.push(`${at}: min_unit_price_paise > max_unit_price_paise`);
    if ((r.cess_specific_paise ?? null) === null !== ((r.cess_specific_unit ?? null) === null)) issues.push(`${at}: cess_specific_paise and cess_specific_unit go together`);
    const urlProblem = sourceUrlProblem(r.source_url, opts.sourceHosts);
    if (urlProblem) issues.push(`${at}.source_url: ${urlProblem}`);
    const notifProblem = notificationRefProblem(normaliseNotificationRef(r.notification_ref));
    if (notifProblem) issues.push(`${at}.notification_ref: ${notifProblem}`);
    if (!codes.has(r.hsn_prefix)) issues.push(`${at}.hsn_prefix: ${r.hsn_prefix} not in hsn_codes.json (rule prefixes must be existing codes, SA-C-14)`);
    const vb = r.verified_by ?? null;
    const lv = r.last_verified_at ?? null;
    if (status === 'verified' && (vb === null || lv === null)) issues.push(`${at}: verified rules need verified_by and last_verified_at`);
    if (status === 'unverified' && (vb !== null || lv !== null)) issues.push(`${at}: verified_by/last_verified_at must be null while unverified (ruling 17)`);
    if (vb === 'seed-unreviewed') issues.push(`${at}.verified_by: "seed-unreviewed" is not a reviewer; leave the rule unverified`);
    const base = { hsn_prefix: r.hsn_prefix, effective_from: r.effective_from, condition_kind: kind, min_unit_price_paise: minP, max_unit_price_paise: maxP, condition_text: text };
    const id = r.rule_id ?? seedRuleId(base);
    if (ids.has(id)) issues.push(`${at}.rule_id: duplicate ${id}${r.rule_id ? '' : ' (derived: same prefix/date/condition as another row)'}`);
    ids.add(id);
    ruleRows.push({
      rule_id: id,
      hsn_prefix: r.hsn_prefix,
      igst_rate_bp: r.igst_rate_bp,
      cess_rate_bp: r.cess_rate_bp ?? 0,
      cess_specific_paise: r.cess_specific_paise ?? null,
      cess_specific_unit: r.cess_specific_unit ?? null,
      condition_kind: kind,
      condition_text: kind === 'none' ? null : text,
      condition_code: code,
      min_unit_price_paise: minP,
      max_unit_price_paise: maxP,
      effective_from: r.effective_from,
      effective_to: r.effective_to ?? null,
      notification_ref: normaliseNotificationRef(r.notification_ref), // '01/2026-…' → '1/2026-…'
      source_url: r.source_url,
      source_pdf_sha256: r.source_pdf_sha256 ?? null,
      schedule_serial: r.schedule_serial ?? null,
      verified_by: vb,
      last_verified_at: lv,
      verification_status: status,
      status: 'active',
      voided_at: null,
      voided_in_version: null,
      voided_by_rule: null,
      retroactive_reason: null,
      end_dated_in_version: null,
      superseded_by: null,
      proposal_id: null,
      seed_batch_id: null,
      citation_note: r.citation_note ?? null,
    });
  });
  for (let i = 0; i < ruleRows.length; i++) {
    for (let j = i + 1; j < ruleRows.length; j++) {
      if (rulesOverlap(ruleRows[i]!, ruleRows[j]!)) {
        issues.push(`rate_rules.json: ${ruleRows[i]!.rule_id} and ${ruleRows[j]!.rule_id} overlap (prefix ${ruleRows[i]!.hsn_prefix}); end-date the older one`);
      }
    }
  }

  // ---- curation tables
  const synKeys = new Set<string>();
  syns.forEach((s, i) => {
    if (!codes.has(s.hsn_code)) issues.push(`synonyms.json[${i}].hsn_code: ${s.hsn_code} not in hsn_codes.json`);
    const k = `${s.phrase}|${s.hsn_code}`;
    if (synKeys.has(k)) issues.push(`synonyms.json[${i}]: duplicate (phrase, hsn_code)`);
    synKeys.add(k);
  });
  const catKeys = new Set<string>();
  cats.forEach((c, i) => {
    const k = `${c.source}|${c.category}`;
    if (catKeys.has(k)) issues.push(`category_map.json[${i}]: duplicate (source, category)`);
    catKeys.add(k);
    if (!codes.has(c.hsn_prefix)) issues.push(`category_map.json[${i}].hsn_prefix: ${c.hsn_prefix} not in hsn_codes.json`);
  });
  const chkKeys = new Set<string>();
  chks.forEach((c, i) => {
    const k = `${c.keyword}|${c.chapter}`;
    if (chkKeys.has(k)) issues.push(`chapter_keywords.json[${i}]: duplicate`);
    chkKeys.add(k);
  });

  if (issues.length > 0) throw new SeedError(issues);
  return {
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.sha256])),
    counts: { hsn_codes: hsnRows.length, rate_rules: ruleRows.length, synonyms: syns.length, category_map: cats.length, chapter_keywords: chks.length },
    rows: { hsnRows, ruleRows, syns, cats, chks },
  };
}

/**
 * Write a prepared seed as one new dataset version. Call inside a write transaction on an empty
 * dataset. Rules get the seed batch id (the DB insert guard's seed path); a dataset.seeded audit entry
 * anchors the content hash and file hashes.
 */
export function applySeed(repos: Repos, prepared: PreparedSeed, opts: Pick<SeedOptions, 'now' | 'auditKey' | 'signingKey' | 'warn'>, hooks: ApplySeedHooks = {}): SeedSummary {
  const warn = opts.warn ?? (() => undefined);
  const { hsnRows, ruleRows, syns, cats, chks } = prepared.rows;
  {
    if (repos.dataset.current() !== null) throw new SeedError(['database already has a dataset; seeding is only allowed into an empty database']);
    const now = opts.now;
    const at = rfc3339(now);
    const version = beginPublish(repos, now, hooks.by ?? 'seed', hooks.reason ?? 'seed');
    hooks.onVersion?.(repos, version);
    const fileHashes = prepared.files;
    const batchId = newId('sb', now.getTime());
    repos.dataset.insertSeedBatch({ id: batchId, dataset_version: version, created_at: at, files: fileHashes });
    for (const h of hsnRows) {
      repos.hsn.insert({ ...h, added_in_version: version });
      repos.dataset.appendChange({ dataset_version: version, published_at: at, change_type: 'hsn_added', hsn_prefix: h.code, rule_id: null, effective_from: null, effective_to: null, summary: `${h.code} added` });
    }
    for (const r of ruleRows) {
      repos.rules.insert({ ...r, seed_batch_id: batchId, created_in_version: version });
      repos.dataset.appendChange({
        dataset_version: version, published_at: at, change_type: 'rule_added', hsn_prefix: r.hsn_prefix, rule_id: r.rule_id,
        effective_from: r.effective_from, effective_to: r.effective_to,
        summary: `${r.hsn_prefix} ${bpToPercent(r.igst_rate_bp)}% from ${r.effective_from}${r.effective_to ? ` to ${r.effective_to}` : ''} (${r.notification_ref})${r.verification_status === 'unverified' ? ' [unverified]' : ''}`,
      });
    }
    for (const s of syns) {
      repos.synonyms.insert({ phrase: s.phrase, hsn_code: s.hsn_code, strength: s.strength ?? 'primary', note: s.note ?? null, rule_hint: s.rule_hint ?? null, created_by: s.created_by ?? 'seed', created_at: at, active: true });
    }
    for (const c of cats) repos.synonyms.insertCategory(c.source, c.category, c.hsn_prefix);
    for (const c of chks) repos.synonyms.insertChapterKeyword(c.keyword, c.chapter);
    const { contentHash } = finishPublish(repos, version, now, opts.signingKey);
    const verified = ruleRows.filter((r) => r.verification_status === 'verified');
    if (verified.length > 0) warn(`${verified.length} seed rules are marked verified (fixture/dev only); verifiers recorded in the audit log`);
    appendAudit(repos.audit, opts.auditKey, {
      at, actor: hooks.by ?? 'seed', key_prefix: null, action: 'dataset.seeded', entity_type: 'dataset_version', entity_id: version,
      details: {
        ...hooks.auditDetails,
        content_hash: contentHash,
        seed_batch_id: batchId,
        verified_rules: verified.map((r) => ({ rule_id: r.rule_id, verified_by: r.verified_by })),
        // SA-C3-07: the seed caveats, so the cross-check can detect an edited or removed citation_note
        citation_notes: Object.fromEntries(ruleRows.filter((r) => r.citation_note !== null).map((r) => [r.rule_id, r.citation_note])),
        files: fileHashes,
        counts: prepared.counts,
      },
    });
    return {
      version,
      hsn_codes: hsnRows.length,
      rate_rules: ruleRows.length,
      unverified_rules: ruleRows.filter((r) => r.verification_status === 'unverified').length,
      synonyms: syns.length,
      category_map: cats.length,
      chapter_keywords: chks.length,
      content_hash: contentHash,
    };
  }
}
