/**
 * Classifier evaluation gate (06 AI-40..42, AI-45; validator R9), run against the real data/seed.
 * Uncertain items are excluded from every gated metric (see scripts/eval-classifier.ts).
 * PROVISIONAL: the labels are LLM drafts pending human review (AI-40), so these gates are
 * provisional until then (PROVISIONAL_NOTICE is printed with every run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineHash, checkGates, compareVersions, computeMetrics, equalsSynonym, GATES, HIGH_PROBE_SET, leakage, loadEvalItems, MIN_HIGH_SAMPLE,
  PROVISIONAL_NOTICE, readBaseline, runEval, sampleWarning, seededClassifier, TOP3_SCOPE_RULING, unjustifiedExclusions, wilsonLower,
  type Metrics, type SeededClassifier,
} from '../../scripts/eval-classifier.js';
import { CLASSIFIER_VERSION } from '../../src/classify/fusion.js';

const here = dirname(fileURLToPath(import.meta.url));

const items = loadEvalItems();
let c: SeededClassifier;
let m: Metrics;
beforeAll(async () => {
  c = seededClassifier();
  m = computeMetrics(await runEval(items, c));
  console.info(`${sampleWarning(m) ?? ''}\n${PROVISIONAL_NOTICE}\n${TOP3_SCOPE_RULING}\n${JSON.stringify({ version: m.classifier_version, top1_4: m.top1_4, top3_4_all: m.top3_4, top3_4_in_master: m.top3_4_in_master, top1_8: m.top1_8, high: m.bands.high, high_probe: m.high_probe, high_non_synonym: m.high_non_synonym })}`);
}, 120_000);
afterAll(() => c.close());

describe('eval set (AI-40 / R9)', () => {
  it('has ≥ 300 items, ≥ 60 adversarial, all five retail areas, unique ids and inputs', () => {
    expect(items.length).toBeGreaterThanOrEqual(300);
    expect(items.filter((i) => i.adversarial).length).toBeGreaterThanOrEqual(60);
    const cats = new Set(items.map((i) => i.category));
    for (const k of ['jewellery', 'pharmacy_health', 'grocery', 'apparel_home', 'electronics']) expect(cats.has(k as never)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.input.toLowerCase())).size).toBe(items.length);
  });
  it('gates on ≥ 300 certain items', () => {
    expect(items.filter((i) => !i.uncertain).length).toBeGreaterThanOrEqual(300);
  });
  it('AI-45: no eval input equals an active synonym phrase (items marked `excluded` are skipped and counted)', () => {
    const excluded = items.filter((i) => i.excluded !== undefined);
    // reported, so a growing exclusion list is visible in the test output
    console.info(`AI-45: ${excluded.length} eval item(s) excluded: ${excluded.map((i) => `${i.id} (${i.excluded})`).join('; ') || 'none'}`);
    expect(excluded.every((i) => /^leakage: /.test(i.excluded!))).toBe(true);
    // SA-K4-04: an exclusion is only valid when the input really equals an active synonym
    expect(unjustifiedExclusions(items, c.synonymPhrases)).toEqual([]);
    for (const i of excluded) expect(equalsSynonym(i.input, c.synonymPhrases), i.id).toBe(true);
    expect(m.excluded).toBe(excluded.length);
    expect(leakage(items, c.synonymPhrases)).toEqual([]);
  });
});

describe('AI-42 gates', () => {
  it('high-band precision ≥ 0.97 (on a non-empty high band)', () => {
    expect(m.bands.high.answered).toBeGreaterThan(0);
    expect(m.high_precision).not.toBeNull();
    expect(m.high_precision!).toBeGreaterThanOrEqual(GATES.highPrecision);
    expect(m.none_items_answered_high).toBe(0);
  });
  it('SA-K4-01: the high-band sample flag and Wilson lower bound are reported truthfully', () => {
    expect(m.sample_sufficient).toBe(m.bands.high.answered >= MIN_HIGH_SAMPLE);
    expect(m.high_precision_lower_bound).toBe(wilsonLower(m.bands.high.correct, m.bands.high.answered));
    expect(wilsonLower(16, 16)).toBeCloseTo(0.8064, 3);
    const w = sampleWarning(m);
    if (m.sample_sufficient) expect(w).toBeNull();
    else expect(w).toBe(`INSUFFICIENT SAMPLE — precision gate not statistically meaningful (n=${m.bands.high.answered}, lower bound=${m.high_precision_lower_bound})`);
    const b = readBaseline()!;
    // the recorded baseline also states its own sample truthfully
    expect(b.sample_sufficient).toBe(false);
    expect(typeof b.high_precision_lower_bound).toBe('number');
  });
  it('SA-K4-02: baseline was written by the script (hash + approver) and is strictly older', () => {
    const b = readBaseline()!;
    expect(b.approved_by ?? '').not.toBe('');
    expect(b.content_sha256).toBe(baselineHash(b));
    expect(compareVersions(b.classifier_version, CLASSIFIER_VERSION)).toBe(-1);
    expect(checkGates(m, b).find((g) => g.name.startsWith('baseline content hash'))?.ok).toBe(true);
    // a hand edit breaks the hash
    const edited = { ...b, metrics: { ...b.metrics, top1_4: 0 } };
    expect(checkGates(m, edited).find((g) => g.name.startsWith('baseline content hash'))?.ok).toBe(false);
  });
  it('compareVersions is numeric per component and refuses different names', () => {
    expect(compareVersions('rules-fts-2.1', 'rules-fts-2.2')).toBe(-1);
    expect(compareVersions('rules-fts-2.10', 'rules-fts-2.9')).toBe(1);
    expect(compareVersions('rules-fts-2.2', 'rules-fts-2.2')).toBe(0);
    expect(compareVersions('rules-fts-3', 'rules-fts-2.9')).toBe(1);
    expect(compareVersions('other-2.1', 'rules-fts-2.2')).toBeNull();
    const b = readBaseline()!;
    const newer = { ...b, classifier_version: 'rules-fts-9.0' };
    newer.content_sha256 = baselineHash(newer);
    expect(checkGates(m, newer).find((g) => g.name === 'regression baseline is a previous classifier version')?.ok).toBe(false);
  });
  it('the regression baseline is a previous classifier version (SA-K3-02)', () => {
    const b = readBaseline();
    expect(b).not.toBeNull();
    expect(b!.allow_same_version).toBeUndefined();
    expect(b!.classifier_version).not.toBe(CLASSIFIER_VERSION);
    expect(checkGates(m, b).find((g) => g.name === 'regression baseline is a previous classifier version')?.ok).toBe(true);
  });
  it('a same-version baseline fails unless explicitly re-baselined', () => {
    const same = { classifier_version: CLASSIFIER_VERSION, metrics: readBaseline()!.metrics };
    expect(checkGates(m, same).find((g) => g.name === 'regression baseline is a previous classifier version')?.ok).toBe(false);
    const re = { ...same, allow_same_version: { approved_by: 'x', reason: 'test' } };
    expect(checkGates(m, re).find((g) => g.name === 'regression baseline is a previous classifier version')?.ok).toBe(true);
  });
  it('no metric regresses by more than 1 point against the previous version', () => {
    const regress = checkGates(m, readBaseline()).filter((g) => g.name.startsWith('no regression') && !g.ok);
    expect(regress).toEqual([]);
  });
  it('top-3 recall (4-digit, in-master — coordinator-approved provisional scope, AG-12) ≥ 0.90', () => {
    expect(m.top3_4_in_master).toBeGreaterThanOrEqual(GATES.top3Recall4);
  });
});

describe('AI-41 reported metrics (not gated)', () => {
  it('reports top-3 over all positives, top-1@4, top-1@8 and per-category numbers', () => {
    expect(m.top3_4).toBeGreaterThan(0);
    expect(m.top1_4).toBeGreaterThan(0);
    expect(m.top1_8_items).toBeGreaterThanOrEqual(10);
    expect(m.top1_8).not.toBeNull();
    for (const k of ['jewellery', 'pharmacy_health', 'grocery', 'apparel_home', 'electronics']) expect(m.per_category[k]?.gated ?? 0).toBeGreaterThan(0);
  });
  it('reports the round-5 high-band probe set (≥ 40 items) separately', () => {
    expect(items.filter((i) => i.set === HIGH_PROBE_SET).length).toBeGreaterThanOrEqual(40);
    expect(m.high_probe.items).toBeGreaterThanOrEqual(40);
  });
  it('every output carries the provisional / LLM-draft notice', () => {
    expect(PROVISIONAL_NOTICE).toMatch(/LLM drafts pending human review/);
    expect(readFileSync(join(here, 'README.md'), 'utf8')).toMatch(/LLM draft pending human review/);
    expect((readBaseline() as { notice?: string }).notice).toBe(PROVISIONAL_NOTICE);
    expect((readBaseline() as { top3_scope?: string }).top3_scope).toBe(TOP3_SCOPE_RULING);
  });
});
