/**
 * Classifier evaluation (06 AI-40..42, validator R9).
 *
 * Runs the deterministic classifier (no adapters, no LLM) over test/eval/classify-eval.jsonl against a
 * database loaded from the real seed (data/seed). Prints top-1 / top-3 at the 4-digit heading,
 * precision and recall per confidence band, high-band precision and coverage, and checks the AI-42
 * gates. Items marked `uncertain: true` are reported but excluded from every gated metric.
 *
 * LABELS ARE LLM DRAFTS PENDING HUMAN REVIEW (AI-40); every gate here is PROVISIONAL until then.
 *
 * Usage: tsx scripts/eval-classifier.ts [--seed data/seed] [--eval test/eval/classify-eval.jsonl] [--json]
 *        [--write-baseline --approved-by <name> [--allow-same-version]]
 *   --write-baseline records the current metrics as the regression baseline. Run it on the released
 *   version BEFORE bumping CLASSIFIER_VERSION: the gate requires the baseline to be a previous
 *   version, unless the baseline carries an explicit, attributed `allow_same_version` (re-baseline).
 * Exit code 1 when a gate fails or the leakage check (AI-45) finds an eval input equal to a synonym.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { openDb, migrate } from '../src/db/migrate.js';
import { createStorage } from '../src/repositories/sqlite/index.js';
import { loadSeed } from '../src/db/seed.js';
import { loadConfig } from '../src/config.js';
import { fixedClock } from '../src/lib/clock.js';
import { ClassifierPipeline } from '../src/classify/pipeline.js';
import { CLASSIFIER_VERSION } from '../src/classify/fusion.js';
import { normaliseName, referenceTokens, tokenEq } from '../src/classify/normalise.js';
import { uncovered } from '../src/classify/coverage.js';
import type { ClassifyResult } from '../src/classify/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SEED_DIR = join(ROOT, 'data', 'seed');
export const DEFAULT_EVAL_FILE = join(ROOT, 'test', 'eval', 'classify-eval.jsonl');
export const BASELINE_FILE = join(ROOT, 'test', 'eval', 'baseline.json');

/** AI-42 gates (fixed by 06; never lowered without coordinator sign-off, AG-12). */
export const GATES = { highPrecision: 0.97, top3Recall4: 0.9, maxRegression: 0.01 } as const;

/** Printed with every eval output (text and JSON) and recorded in baseline.json. */
export const PROVISIONAL_NOTICE =
  'PROVISIONAL: eval labels are LLM drafts pending human review (AI-40); the AI-42 gates are provisional until the labels are human-reviewed.';
/** SA-K3-02 coordinator ruling (round 5). */
export const TOP3_SCOPE_RULING =
  'AI-42 top-3 recall is gated on in-master items only: coordinator-approved provisional scope under AG-12, pending Amit/human review. Top-3 over all positives is reported, not gated.';
/** SA-K4-01: below this many high answers the precision gate is not statistically meaningful. */
export const MIN_HIGH_SAMPLE = 50;

/** Wilson score interval lower bound (95%, z = 1.96) for k successes out of n. */
export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.round(((centre - margin) / (1 + z2 / n)) * 10_000) / 10_000;
}

/** SA-K4-01: the loud warning printed (text and JSON) when the high-band sample is too small. */
export function sampleWarning(m: Pick<Metrics, 'sample_sufficient' | 'bands' | 'high_precision_lower_bound'>): string | null {
  return m.sample_sufficient
    ? null
    : `INSUFFICIENT SAMPLE — precision gate not statistically meaningful (n=${m.bands.high.answered}, lower bound=${m.high_precision_lower_bound})`;
}

/** the set of high-band probe items added in round 5 (realistic phrasings, not derived from synonyms) */
export const HIGH_PROBE_SET = 'r5_high_probe';

export const EvalItem = z
  .object({
    id: z.string().regex(/^ev\d{4}$/),
    input: z.string().min(1).max(200),
    label: z.union([z.string().regex(/^\d{4}$/), z.literal('none')]),
    expected_codes: z.array(z.string().regex(/^\d{4}$/)).max(1),
    category: z.enum(['jewellery', 'pharmacy_health', 'grocery', 'apparel_home', 'electronics', 'other']),
    adversarial: z.boolean(),
    uncertain: z.boolean(),
    source_of_label: z.string().min(1),
    labelled_by: z.string().min(1),
    reviewed_by: z.string().nullable(),
    /** reason the item is left out of every metric and of the AI-45 leakage check (labels unchanged) */
    excluded: z.string().min(1).max(300).optional(),
    /** 8-digit tariff item, only where the name determines it (top-1@8, AI-41) */
    label8: z.string().regex(/^\d{8}$/).optional(),
    /** named subset, e.g. 'r5_high_probe' */
    set: z.string().min(1).max(40).optional(),
  })
  .strict()
  .refine((i) => (i.label === 'none' ? i.expected_codes.length === 0 : i.expected_codes[0] === i.label), 'expected_codes must match label')
  .refine((i) => i.label8 === undefined || i.label8.startsWith(i.label), 'label8 must extend label');
export type EvalItem = z.infer<typeof EvalItem>;

export function loadEvalItems(file = DEFAULT_EVAL_FILE): EvalItem[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      const r = EvalItem.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`eval line ${i + 1}: ${r.error.issues.map((x) => x.message).join('; ')}`);
      return r.data;
    });
}

export interface SeededClassifier {
  classify(name: string): Promise<ClassifyResult>;
  masterCodes: ReadonlySet<string>;
  synonymPhrases: string[];
  close(): void;
}

/** In-memory DB loaded from the real seed; deterministic classifier only (no adapters, no LLM). */
export function seededClassifier(seedDir = DEFAULT_SEED_DIR): SeededClassifier {
  // eval-only placeholder secrets: nothing is signed or persisted
  const config = loadConfig({
    NODE_ENV: 'test',
    HSN_DB_PATH: ':memory:',
    HSN_KEY_PEPPER: 'eval-only-pepper-not-a-secret-000000000',
    HSN_AUDIT_KEY: 'eval-only-audit-key-not-a-secret-0000000',
    HSN_LOG_KEY: 'eval-only-log-key-not-a-secret-000000000',
  });
  const db = openDb(':memory:');
  migrate(db);
  const storage = createStorage(db);
  loadSeed(storage.tx, {
    dir: seedDir, allowedRatesBp: config.allowedRatesBp, sourceHosts: config.sourceHosts,
    now: new Date('2026-10-10T00:00:00Z'), auditKey: config.auditKey.reveal(), allowVerified: false,
  });
  const repos = storage.read;
  const p = new ClassifierPipeline({
    hsn: repos.hsn, synonyms: repos.synonyms, products: repos.products, clock: fixedClock('2026-10-10T06:00:00Z'),
    log: { info: () => undefined, warn: () => undefined }, adapters: [],
  });
  const masterCodes = new Set(db.prepare('SELECT code FROM hsn_codes').all().map((r) => String((r as { code: string }).code)));
  const synonymPhrases = repos.synonyms.allActive().map((s) => s.phrase);
  return {
    classify: (name) => p.classify({ name, barcode: null, date: '2026-10-10', maxCandidates: 5, allowLlm: false, keyId: null }, { requestId: 'eval', log: { info: () => undefined, warn: () => undefined } }),
    masterCodes,
    synonymPhrases,
    close: () => storage.close(),
  };
}

export interface ItemOutcome {
  item: EvalItem;
  top: string | null;
  band: 'high' | 'medium' | 'low' | null;
  confidence: number | null;
  top1: boolean;
  top3: boolean;
  /** top candidate equals label8 (only meaningful when label8 is set) */
  top1_8: boolean;
  inMaster: boolean;
  /** some active synonym covers the whole name (coverage-equivalent to a synonym, SA-K3-02 §3) */
  synonymEquivalent: boolean;
}

export interface BandStats { answered: number; correct: number; precision: number | null; recall: number }
export interface Metrics {
  classifier_version: string;
  items: number;
  gated: number;
  uncertain_excluded: number;
  /** items carrying an `excluded` reason (e.g. AI-45 leakage found after labelling) */
  excluded: number;
  adversarial_gated: number;
  positives: number;
  positives_in_master: number;
  top1_4: number;
  top3_4: number;
  top1_4_in_master: number;
  top3_4_in_master: number;
  /** AI-41 top-1 at 8 digits over items with an 8-digit label */
  top1_8: number | null;
  top1_8_items: number;
  coverage: number;
  high_precision: number | null;
  /** SA-K4-01: Wilson 95% lower bound of high-band precision */
  high_precision_lower_bound: number | null;
  /** SA-K4-01: false when fewer than MIN_HIGH_SAMPLE high answers (gate not statistically meaningful) */
  sample_sufficient: boolean;
  bands: Record<'high' | 'medium' | 'low', BandStats>;
  none_items_answered_high: number;
  /** high answers on items that are not coverage-equivalent to a synonym */
  high_non_synonym: { answered: number; correct: number; precision: number | null; equivalent_items: number };
  /** the round-5 high-band probe set, reported separately */
  high_probe: { items: number; answered: number; correct: number; precision: number | null; recall: number };
  per_category: Record<string, { gated: number; positives: number; top1_4: number; top3_4: number; high_answered: number; high_precision: number | null }>;
}

const heading = (code: string): string | null => (code.length >= 4 ? code.slice(0, 4) : null);
const ratio = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 10_000) / 10_000);

/**
 * True when some active synonym phrase appears as a contiguous run AND covers the whole name
 * (nothing but quantities / ignorable words left): such an item only re-tests the synonym list.
 */
export function synonymEquivalent(input: string, phraseTokens: readonly (readonly string[])[]): boolean {
  const hay = normaliseName(input).matchTokens.flatMap((t) => t.split('-')).filter((t) => t.length > 0);
  return phraseTokens.some((p) => containsRun(hay, p) && uncovered(hay, p).length === 0);
}
function containsRun(hay: readonly string[], p: readonly string[]): boolean {
  if (p.length === 0 || p.length > hay.length) return false;
  outer: for (let i = 0; i + p.length <= hay.length; i++) {
    for (let j = 0; j < p.length; j++) if (!tokenEq(hay[i + j]!, p[j]!)) continue outer;
    return true;
  }
  return false;
}

export async function runEval(items: readonly EvalItem[], c: SeededClassifier): Promise<ItemOutcome[]> {
  const out: ItemOutcome[] = [];
  const phraseTokens = c.synonymPhrases.map((p) => referenceTokens(p));
  for (const item of items) {
    const r = await c.classify(item.input);
    const t = r.candidates[0];
    const ok = (code: string) => item.label !== 'none' && heading(code) === item.label;
    out.push({
      item,
      top: t?.hsn ?? null,
      band: t?.confidence_band ?? null,
      confidence: t?.confidence ?? null,
      top1: t !== undefined && ok(t.hsn),
      top3: r.candidates.slice(0, 3).some((x) => ok(x.hsn)),
      top1_8: item.label8 !== undefined && t !== undefined && t.hsn === item.label8,
      inMaster: item.label !== 'none' && c.masterCodes.has(item.label),
      synonymEquivalent: synonymEquivalent(item.input, phraseTokens),
    });
  }
  return out;
}

export function computeMetrics(outcomes: readonly ItemOutcome[]): Metrics {
  const gated = outcomes.filter((o) => !o.item.uncertain && o.item.excluded === undefined);
  const pos = gated.filter((o) => o.item.label !== 'none');
  const posIn = pos.filter((o) => o.inMaster);
  const band = (b: 'high' | 'medium' | 'low'): BandStats => {
    const answered = gated.filter((o) => o.band === b);
    const correct = answered.filter((o) => o.top1).length;
    return { answered: answered.length, correct, precision: answered.length === 0 ? null : ratio(correct, answered.length), recall: ratio(correct, pos.length) };
  };
  const bands = { high: band('high'), medium: band('medium'), low: band('low') };
  const l8 = gated.filter((o) => o.item.label8 !== undefined);
  const highNon = gated.filter((o) => o.band === 'high' && !o.synonymEquivalent);
  const probe = gated.filter((o) => o.item.set === HIGH_PROBE_SET);
  const probeHigh = probe.filter((o) => o.band === 'high');
  return {
    classifier_version: CLASSIFIER_VERSION,
    items: outcomes.length,
    gated: gated.length,
    uncertain_excluded: outcomes.filter((o) => o.item.uncertain && o.item.excluded === undefined).length,
    excluded: outcomes.filter((o) => o.item.excluded !== undefined).length,
    adversarial_gated: gated.filter((o) => o.item.adversarial).length,
    positives: pos.length,
    positives_in_master: posIn.length,
    top1_4: ratio(pos.filter((o) => o.top1).length, pos.length),
    top3_4: ratio(pos.filter((o) => o.top3).length, pos.length),
    top1_4_in_master: ratio(posIn.filter((o) => o.top1).length, posIn.length),
    top3_4_in_master: ratio(posIn.filter((o) => o.top3).length, posIn.length),
    top1_8: l8.length === 0 ? null : ratio(l8.filter((o) => o.top1_8).length, l8.length),
    top1_8_items: l8.length,
    coverage: ratio(gated.filter((o) => o.top !== null).length, gated.length),
    high_precision: bands.high.precision,
    high_precision_lower_bound: wilsonLower(bands.high.correct, bands.high.answered),
    sample_sufficient: bands.high.answered >= MIN_HIGH_SAMPLE,
    bands,
    none_items_answered_high: gated.filter((o) => o.item.label === 'none' && o.band === 'high').length,
    high_non_synonym: {
      answered: highNon.length,
      correct: highNon.filter((o) => o.top1).length,
      precision: highNon.length === 0 ? null : ratio(highNon.filter((o) => o.top1).length, highNon.length),
      equivalent_items: gated.filter((o) => o.synonymEquivalent).length,
    },
    high_probe: {
      items: probe.length,
      answered: probeHigh.length,
      correct: probeHigh.filter((o) => o.top1).length,
      precision: probeHigh.length === 0 ? null : ratio(probeHigh.filter((o) => o.top1).length, probeHigh.length),
      recall: ratio(probeHigh.filter((o) => o.top1).length, probe.filter((o) => o.item.label !== 'none').length),
    },
    per_category: perCategory(gated),
  };
}

function perCategory(gated: readonly ItemOutcome[]): Metrics['per_category'] {
  const out: Metrics['per_category'] = {};
  for (const cat of [...new Set(gated.map((o) => o.item.category))].sort()) {
    const g = gated.filter((o) => o.item.category === cat);
    const pos = g.filter((o) => o.item.label !== 'none');
    const high = g.filter((o) => o.band === 'high');
    out[cat] = {
      gated: g.length,
      positives: pos.length,
      top1_4: ratio(pos.filter((o) => o.top1).length, pos.length),
      top3_4: ratio(pos.filter((o) => o.top3).length, pos.length),
      high_answered: high.length,
      high_precision: high.length === 0 ? null : ratio(high.filter((o) => o.top1).length, high.length),
    };
  }
  return out;
}

/** True when the input equals an active synonym phrase after normalisation (AI-45). */
export function equalsSynonym(input: string, phrases: readonly string[]): boolean {
  const set = new Set(phrases.map((p) => referenceTokens(p).join(' ')));
  return set.has(normaliseName(input).text.split(' ').flatMap((t) => t.split('-')).join(' '));
}

/** AI-45: an eval input must not equal an active synonym phrase (compared after normalisation). */
export function leakage(items: readonly EvalItem[], phrases: readonly string[]): string[] {
  const set = new Set(phrases.map((p) => referenceTokens(p).join(' ')));
  return items.filter((i) => i.excluded === undefined && set.has(normaliseName(i.input).text.split(' ').flatMap((t) => t.split('-')).join(' '))).map((i) => i.id);
}

/** SA-K4-04: ids of `excluded` items whose input does NOT actually equal an active synonym. */
export function unjustifiedExclusions(items: readonly EvalItem[], phrases: readonly string[]): string[] {
  return items.filter((i) => i.excluded !== undefined && !equalsSynonym(i.input, phrases)).map((i) => i.id);
}

export interface Baseline {
  classifier_version: string;
  notice?: string;
  top3_scope?: string;
  note?: string;
  /** SA-K4-02: written by --write-baseline */
  approved_by?: string;
  written_at?: string;
  eval_sha256?: string;
  seed_sha256?: string;
  high_precision_lower_bound?: number | null;
  sample_sufficient?: boolean;
  history?: unknown[];
  /** explicit, attributed permission to compare a version with its own baseline (re-baseline) */
  allow_same_version?: { approved_by: string; reason: string };
  metrics: Pick<Metrics, 'top1_4' | 'top3_4' | 'top1_4_in_master' | 'top3_4_in_master' | 'coverage' | 'high_precision'>;
  /** SA-K4-02: sha256 of the canonical JSON of every other field */
  content_sha256?: string;
}

/** Canonical JSON (sorted keys, recursively) so the hash does not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SA-K4-02: content hash over every baseline field except content_sha256 itself. */
export function baselineHash(b: Baseline): string {
  const { content_sha256: _ignored, ...rest } = b;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

/**
 * SA-K4-02: semver-like comparison of classifier versions such as "rules-fts-2.1" < "rules-fts-2.10".
 * Returns null when the name prefixes differ or a version has no numeric part.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): { name: string; nums: number[] } | null => {
    const m = /^(.*?)-?(\d+(?:\.\d+)*)$/.exec(v);
    return m === null ? null : { name: m[1]!, nums: m[2]!.split('.').map(Number) };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null || x.name !== y.name) return null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function sha256Dir(dir: string): string {
  const h = createHash('sha256');
  for (const f of ['hsn_codes.json', 'rate_rules.json', 'synonyms.json', 'category_map.json', 'chapter_keywords.json']) {
    const p = join(dir, f);
    h.update(`${f}\0`);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest('hex');
}

export function readBaseline(file = BASELINE_FILE): Baseline | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Baseline) : null;
}

export interface GateResult { name: string; ok: boolean; detail: string }

/**
 * AI-42 gates (all PROVISIONAL, see PROVISIONAL_NOTICE). Top-3 recall is gated on in-master items
 * under the coordinator's AG-12 ruling (TOP3_SCOPE_RULING); recall over all positives is reported.
 * The regression baseline must be a previous classifier version unless explicitly re-baselined.
 */
export function checkGates(m: Metrics, baseline: Baseline | null): GateResult[] {
  const g: GateResult[] = [];
  g.push({
    name: 'baseline content hash matches (written by --write-baseline)',
    ok: baseline !== null && baseline.content_sha256 !== undefined && baseline.content_sha256 === baselineHash(baseline) && (baseline.approved_by ?? '').length > 0,
    detail: baseline === null ? 'no baseline recorded' : `approved_by ${baseline.approved_by ?? '(missing)'}, sha256 ${baseline.content_sha256?.slice(0, 16) ?? '(missing)'}`,
  });
  const cmp = baseline === null ? null : compareVersions(baseline.classifier_version, m.classifier_version);
  g.push({
    name: 'regression baseline is a previous classifier version',
    ok: baseline !== null && ((cmp !== null && cmp < 0) || (cmp === 0 && baseline.allow_same_version !== undefined)),
    detail:
      baseline === null
        ? 'no baseline recorded'
        : cmp === null
          ? `versions not comparable: ${baseline.classifier_version} vs ${m.classifier_version}`
          : cmp > 0
            ? `baseline ${baseline.classifier_version} is NEWER than current ${m.classifier_version}`
            : cmp < 0
          ? `${baseline.classifier_version} → ${m.classifier_version}`
          : baseline.allow_same_version !== undefined
            ? `same version, re-baselined by ${baseline.allow_same_version.approved_by}: ${baseline.allow_same_version.reason}`
            : `baseline version equals current (${m.classifier_version}) without an explicit re-baseline`,
  });
  g.push({
    name: 'high-band precision >= 0.97',
    ok: m.high_precision !== null && m.high_precision >= GATES.highPrecision && m.bands.high.answered > 0,
    detail: `${m.high_precision} over ${m.bands.high.answered} high answers`,
  });
  g.push({ name: 'top-3 recall (4-digit, in-master; coordinator-approved provisional scope, AG-12) >= 0.90', ok: m.top3_4_in_master >= GATES.top3Recall4, detail: `${m.top3_4_in_master} over ${m.positives_in_master} items (all positives: ${m.top3_4} over ${m.positives})` });
  if (baseline !== null) {
    for (const k of Object.keys(baseline.metrics) as (keyof Baseline['metrics'])[]) {
      const before = baseline.metrics[k];
      const now = m[k];
      if (before === null || now === null) continue;
      g.push({ name: `no regression > 1 pt on ${k} vs ${baseline.classifier_version}`, ok: now >= before - GATES.maxRegression, detail: `${before} → ${now}` });
    }
  }
  return g;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' }, eval: { type: 'string' }, json: { type: 'boolean' }, 'write-baseline': { type: 'boolean' },
      'approved-by': { type: 'string' }, 'allow-same-version': { type: 'boolean' }, reason: { type: 'string' },
    },
  });
  if (values['write-baseline'] && (values['approved-by'] ?? '').trim().length === 0) {
    console.error('--write-baseline needs --approved-by <name> (AG-12)');
    return 2;
  }
  const items = loadEvalItems(values.eval ? resolve(values.eval) : DEFAULT_EVAL_FILE);
  const c = seededClassifier(values.seed ? resolve(values.seed) : DEFAULT_SEED_DIR);
  try {
    const leaks = leakage(items, c.synonymPhrases);
    const outcomes = await runEval(items, c);
    const m = computeMetrics(outcomes);
    const gates = checkGates(m, readBaseline());
    const insufficient = sampleWarning(m);
    if (values.json) console.log(JSON.stringify({ notice: PROVISIONAL_NOTICE, top3_scope: TOP3_SCOPE_RULING, sample_warning: insufficient, metrics: m, gates, leakage: leaks }, null, 2));
    else {
      if (insufficient !== null) console.log(`\n${'!'.repeat(100)}\n!!! ${insufficient}\n${'!'.repeat(100)}\n`);
      console.log(PROVISIONAL_NOTICE);
      console.log(TOP3_SCOPE_RULING);
      console.log(`high-band precision ${m.high_precision} (Wilson 95% lower bound ${m.high_precision_lower_bound}, n=${m.bands.high.answered}, sample_sufficient=${m.sample_sufficient})`);
      console.log(`classifier ${m.classifier_version}: ${m.items} items, ${m.gated} gated (${m.uncertain_excluded} uncertain excluded, ${m.excluded} excluded by reason, ${m.adversarial_gated} adversarial)`);
      console.log(`top-1@4 ${m.top1_4}  top-3@4 ${m.top3_4} (all ${m.positives} positives; reported, not gated)  in-master: top-1@4 ${m.top1_4_in_master} / top-3@4 ${m.top3_4_in_master} over ${m.positives_in_master}  coverage ${m.coverage}`);
      console.log(`top-1@8 ${m.top1_8 ?? 'n/a'} over ${m.top1_8_items} items with an 8-digit label`);
      console.log(`high band on items NOT coverage-equivalent to a synonym: ${m.high_non_synonym.correct}/${m.high_non_synonym.answered} (precision ${m.high_non_synonym.precision}); ${m.high_non_synonym.equivalent_items} gated items are coverage-equivalent to a synonym`);
      console.log(`high-band probe set (${HIGH_PROBE_SET}, ${m.high_probe.items} items): high answered ${m.high_probe.answered}, correct ${m.high_probe.correct}, precision ${m.high_probe.precision}, recall ${m.high_probe.recall}`);
      for (const [cat, x] of Object.entries(m.per_category)) {
        console.log(`  ${cat.padEnd(16)} gated ${String(x.gated).padStart(4)}  top-1@4 ${x.top1_4}  top-3@4 ${x.top3_4}  high ${x.high_answered} (precision ${x.high_precision})`);
      }
      for (const b of ['high', 'medium', 'low'] as const) {
        const s = m.bands[b];
        console.log(`  ${b.padEnd(6)} answered ${String(s.answered).padStart(4)}  correct ${String(s.correct).padStart(4)}  precision ${s.precision}  recall ${s.recall}`);
      }
      for (const x of gates) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}: ${x.detail}`);
      if (insufficient !== null) console.log(`!!! ${insufficient}`);
      if (leaks.length > 0) console.log(`FAIL AI-45 leakage: ${leaks.join(', ')}`);
      const wrongHigh = outcomes.filter((o) => !o.item.uncertain && o.band === 'high' && !o.top1);
      for (const o of wrongHigh) console.log(`  wrong high: ${o.item.id} "${o.item.input}" → ${o.top} (label ${o.item.label})`);
    }
    if (values['write-baseline']) {
      const prev = readBaseline();
      const evalFile = values.eval ? resolve(values.eval) : DEFAULT_EVAL_FILE;
      const b: Baseline = {
        classifier_version: m.classifier_version,
        notice: PROVISIONAL_NOTICE,
        top3_scope: TOP3_SCOPE_RULING,
        note: values.reason ?? 'written by --write-baseline',
        approved_by: values['approved-by']!,
        written_at: new Date().toISOString(),
        eval_sha256: sha256File(evalFile),
        seed_sha256: sha256Dir(values.seed ? resolve(values.seed) : DEFAULT_SEED_DIR),
        high_precision_lower_bound: m.high_precision_lower_bound,
        sample_sufficient: m.sample_sufficient,
        // the replaced baseline (a different version) is kept in history with its hash
        ...(prev !== null
          ? { history: [...(prev.history ?? []), ...(prev.classifier_version !== m.classifier_version ? [{ classifier_version: prev.classifier_version, approved_by: prev.approved_by, written_at: prev.written_at, content_sha256: prev.content_sha256, metrics: prev.metrics }] : [])] }
          : {}),
        ...(values['allow-same-version'] ? { allow_same_version: { approved_by: values['approved-by']!, reason: values.reason ?? 'explicit re-baseline' } } : {}),
        metrics: { top1_4: m.top1_4, top3_4: m.top3_4, top1_4_in_master: m.top1_4_in_master, top3_4_in_master: m.top3_4_in_master, coverage: m.coverage, high_precision: m.high_precision },
      };
      b.content_sha256 = baselineHash(b);
      writeFileSync(BASELINE_FILE, `${JSON.stringify(b, null, 2)}\n`);
    }
    return gates.every((x) => x.ok) && leaks.length === 0 ? 0 : 1;
  } finally {
    c.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => (process.exitCode = code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
