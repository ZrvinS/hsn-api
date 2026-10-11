import { describe, expect, it } from 'vitest';
import { bandFor, fuse, rawScore, MEDIUM_CAP, type SignalInput } from '../../src/classify/fusion.js';

const s = (code: string, syn: number, fts: number, chap: number, bar: number | null = null): SignalInput => ({ code, syn, fts, chap, bar });
/** same, with a curated exact synonym on the caller's name (the only way to reach high) */
const sx = (code: string, fts: number, chap: number, bar: number | null = null): SignalInput => ({ code, syn: 1, fts, chap, bar, highEligible: true });

describe('confidence bands (AI-03)', () => {
  it.each([
    [0.85, 'high'],
    [0.8499, 'medium'],
    [0.84, 'medium'],
    [0.6, 'medium'],
    [0.5999, 'low'],
    [0, 'low'],
    [1, 'high'],
  ])('%d → %s', (c, band) => {
    expect(bandFor(c)).toBe(band);
  });
});

describe('fusion formula (architecture §5.4)', () => {
  it('reproduces the worked example for "22K gold ring"', () => {
    const r = fuse([sx('7113', 0.62, 1), s('7117', 0, 0.41, 1)], false);
    const [a, b] = r.candidates;
    expect(a?.code).toBe('7113');
    expect(a?.confidence).toBe(0.91);
    expect(a?.confidence_band).toBe('high');
    expect(a?.needs_review).toBe(false);
    expect(b?.confidence).toBe(0.27);
    expect(b?.confidence_band).toBe('low');
    expect(r.needs_review).toBe(false);
    expect(a?.signals).toEqual({ synonym: 1, fts: 0.62, chapter_keyword: 1, barcode_category: null, margin_penalty: 0 });
  });

  it('reproduces the paracetamol example (contested synonym → medium)', () => {
    const r = fuse([s('3004', 0.7, 0.55, 1), s('2924', 0.3, 0.2, 0)], false);
    expect(r.candidates[0]?.confidence).toBe(0.72);
    expect(r.candidates[0]?.confidence_band).toBe('medium');
    expect(r.candidates[1]?.confidence).toBe(0.22);
    expect(r.needs_review).toBe(true);
  });

  it('renormalises over 1.00 when the barcode category is available (biscuits example)', () => {
    const r = fuse([sx('1905', 0.71, 1, 1)], true);
    expect(r.candidates[0]?.confidence).toBe(0.94);
    expect(r.candidates[0]?.signals.barcode_category).toBe(1);
    expect(rawScore(s('x', 1, 1, 1, null), false).raw).toBeCloseTo(1, 10);
    expect(rawScore(s('x', 1, 1, 1, 1), true).raw).toBeCloseTo(1, 10);
  });

  it('reason weights sum to the confidence before rounding/caps (explainable)', () => {
    const r = fuse([sx('7113', 0.62, 1), s('7117', 0, 0.41, 1)], false);
    for (const c of r.candidates) {
      const sum = c.reasons.reduce((acc, x) => acc + x.weight, 0);
      expect(Math.abs(sum - c.confidence)).toBeLessThan(0.006);
    }
  });

  it('ruling 00c-2/22: without a curated exact synonym on the caller name, confidence is capped at 0.84', () => {
    // every signal maxed, barcode category exact, synonym 1.0 but from third-party text (not eligible)
    const r = fuse([s('9999', 1, 1, 1, 1)], true);
    expect(r.candidates[0]?.confidence).toBe(MEDIUM_CAP);
    expect(r.candidates[0]?.confidence_band).toBe('medium');
    // the same signals with an eligible exact synonym reach high
    expect(fuse([sx('9999', 1, 1, 1)], true).candidates[0]?.confidence_band).toBe('high');
  });

  it('nothing but an eligible exact synonym ever produces high (grid)', () => {
    for (const syn of [0, 0.3, 0.7, 1]) {
      for (let f = 0; f <= 1.0001; f += 0.1) {
        for (const chap of [0, 1]) {
          for (const bar of [null, 0, 0.5, 1]) {
            const r = fuse([s('1234', syn, f, chap, bar)], bar !== null);
            expect(r.candidates[0]?.confidence ?? 0).toBeLessThanOrEqual(MEDIUM_CAP);
          }
        }
      }
    }
  });

  it('ruling 00c-2: without any synonym hit the synonym weight is not applicable, so FTS + chapter can reach medium', () => {
    const r = fuse([s('7113', 0, 1, 1), s('7117', 0, 0.3, 0)], false);
    expect(r.applicable).toEqual({ syn: false, bar: false });
    expect(r.denominator).toBeCloseTo(0.35, 10);
    expect(r.candidates[0]?.code).toBe('7113');
    expect(r.candidates[0]?.confidence).toBe(MEDIUM_CAP);
    expect(r.candidates[0]?.confidence_band).toBe('medium');
    // FTS-only weak match stays low
    expect(fuse([s('7117', 0, 0.5, 0)], false).candidates[0]?.confidence_band).toBe('low');
    // as soon as some synonym matched, the 0.50 weight is in the denominator for every candidate
    expect(fuse([s('7113', 0, 1, 1), s('3004', 0.3, 0, 0)], false).denominator).toBeCloseTo(0.85, 10);
  });

  it('applies the margin penalty and caps the top at medium when the top two are within 0.10', () => {
    // raw A = 1.0, raw B = (0.5 + 0.2·0.6 + 0.15)/0.85 = 0.9059 → gap 0.0941 → penalty 0.00294
    const r = fuse([sx('1111', 1, 1), sx('2222', 0.6, 1)], false);
    const a = r.candidates.find((c) => c.code === '1111')!;
    const b = r.candidates.find((c) => c.code === '2222')!;
    expect(a.signals.margin_penalty).toBeCloseTo(0.0029, 4);
    expect(b.signals.margin_penalty).toBe(0);
    expect(a.confidence).toBe(0.84);
    expect(a.confidence_band).toBe('medium');
    expect(a.reasons.some((x) => x.code === 'close_runner_up')).toBe(true);
    expect(r.needs_review).toBe(true);
  });

  it('penalty = (0.10 − gap)/2 for a small gap and is bounded by 0.05', () => {
    const r = fuse([s('1111', 0.7, 0.5, 1), s('2222', 0.7, 0.3, 1)], false); // gap 0.0471
    const top = r.candidates.find((c) => c.code === '1111')!;
    const gap = (0.2 * 0.2) / 0.85;
    expect(top.signals.margin_penalty).toBeCloseTo((0.1 - gap) / 2, 4);
    const tie = fuse([s('1111', 0.7, 0.5, 1), s('2222', 0.7, 0.5, 1)], false);
    expect(Math.max(...tie.candidates.map((c) => c.signals.margin_penalty))).toBeCloseTo(0.05, 6);
    expect(tie.candidates.every((c) => c.confidence_band !== 'high')).toBe(true);
  });

  it('no penalty when the gap is ≥ 0.10', () => {
    const r = fuse([sx('7113', 0.62, 1), s('7117', 0, 0.41, 1)], false);
    expect(r.candidates.every((c) => c.signals.margin_penalty === 0)).toBe(true);
    expect(r.candidates[0]?.reasons.some((x) => x.code === 'close_runner_up')).toBe(false);
  });

  it('drops candidates below 0.10 and flags a weak best (< 0.30) with a message', () => {
    const r = fuse([s('1111', 0.3, 0.2, 0), s('2222', 0, 0.1, 0)], false);
    expect(r.candidates.map((c) => c.code)).toEqual(['1111']);
    expect(r.weak).toBe(true);
    expect(r.message).toBe('no_confident_match');
    expect(r.candidates.every((c) => c.confidence_band === 'low' && c.needs_review)).toBe(true);
    const none = fuse([s('2222', 0, 0.1, 0)], false);
    expect(none.candidates).toEqual([]);
    expect(none.needs_review).toBe(true);
  });

  it('keeps the better of a heading and its 8-digit child', () => {
    const r = fuse([s('7113', 1, 0.5, 1), s('71131910', 0, 0.9, 1)], false);
    expect(r.candidates.map((c) => c.code)).toEqual(['7113']);
  });

  it('returns at most 5 candidates and is deterministic (AI-32)', () => {
    const inputs = Array.from({ length: 12 }, (_, i) => s(String(1000 + i), i % 2 ? 0.3 : 0, (i % 7) / 7, i % 3 === 0 ? 1 : 0));
    const a = fuse(inputs, false, 10);
    const b = fuse([...inputs].reverse(), false, 10);
    expect(a.candidates.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('band property test (AI-03)', () => {
  it('random scores: band boundaries and needs_review always agree', () => {
    let seed = 42;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const x = Math.round(rnd() * 10000) / 10000;
      const b = bandFor(x);
      expect(b).toBe(x >= 0.85 ? 'high' : x >= 0.6 ? 'medium' : 'low');
      const n = 1 + Math.floor(rnd() * 6);
      const inputs = Array.from({ length: n }, (_, k) => ({ code: String(1000 + k), syn: [0, 0.3, 0.7, 1][Math.floor(rnd() * 4)]!, fts: rnd(), chap: rnd() < 0.5 ? 0 : 1, bar: null, highEligible: rnd() < 0.3 }));
      const r = fuse(inputs, false);
      for (const c of r.candidates) {
        expect(c.confidence_band).toBe(bandFor(c.confidence));
        expect(c.needs_review).toBe(c.confidence_band !== 'high');
        expect(c.confidence).toBeGreaterThanOrEqual(0.1);
        const inp = inputs.find((q) => q.code === c.code)!;
        if (!inp.highEligible) expect(c.confidence).toBeLessThanOrEqual(MEDIUM_CAP);
      }
      for (let k = 1; k < r.candidates.length; k++) expect(r.candidates[k]!.confidence).toBeLessThanOrEqual(r.candidates[k - 1]!.confidence);
      expect(r.needs_review).toBe(r.candidates.length === 0 || r.candidates[0]!.confidence_band !== 'high');
    }
  });
});
