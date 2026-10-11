/**
 * Round-7 regression tests: accessory / packaging qualifier (rules-fts-2.3), on the real data/seed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { seededClassifier } from '../../scripts/eval-classifier.js';
import type { ClassifyCandidate } from '../../src/classify/types.js';

const c = seededClassifier();
afterAll(() => c.close());
const accessoryHinted = (x: ClassifyCandidate) => x.reasons.some((r) => r.code === 'review_hint' && /Accessories and parts/.test(r.detail));
const packagingHinted = (x: ClassifyCandidate) => x.reasons.some((r) => r.code === 'review_hint' && /classified by their contents/.test(r.detail));

describe('accessory qualifier: the main article is capped at low when the name is an accessory for it', () => {
  it.each([
    ['mobile phone stand', '8517'],
    ['stand for mobile phone', '8517'],
    ['tv wall mount', '8528'],
    ['tablet stand', '3004'],
  ])('"%s" → %s low (≤ 0.45) with an accessory hint', async (name, code) => {
    const r = await c.classify(name);
    const x = r.candidates.find((k) => k.hsn.startsWith(code))!;
    expect(x.confidence).toBeLessThanOrEqual(0.45);
    expect(x.confidence_band).toBe('low');
    expect(accessoryHinted(x)).toBe(true);
    for (const k of r.candidates) expect(k.confidence_band).not.toBe('high');
  });

  it('the accessory word that IS the evidence is not capped: "phone charger" keeps 8504 uncapped; 8517 is hinted', async () => {
    const r = await c.classify('phone charger');
    const charger = r.candidates.find((k) => k.hsn === '8504')!;
    expect(accessoryHinted(charger)).toBe(false);
    expect(r.candidates[0]!.hsn).toBe('8504');
  });

  it('garment and linen words are not accessories: "men\'s linen shirt half sleeve", "pillow cover printed"', async () => {
    const shirt = await c.classify("men's linen shirt half sleeve");
    expect(shirt.candidates[0]!.hsn).toBe('6205');
    expect(accessoryHinted(shirt.candidates[0]!)).toBe(false);
    const pillow = await c.classify('pillow cover printed');
    expect(pillow.candidates[0]!.hsn).toBe('6302');
    expect(accessoryHinted(pillow.candidates[0]!)).toBe(false);
  });

  it('names without accessory words are untouched: "22K gold ring 10 gm" is still high', async () => {
    const r = await c.classify('22K gold ring 10 gm');
    expect(r.candidates[0]).toMatchObject({ hsn: '7113', confidence_band: 'high' });
  });
});

describe('packaging: contents keep their heading, with a review hint', () => {
  it('"chocolate gift box" keeps 1806 (not capped) with a packaging hint', async () => {
    const r = await c.classify('chocolate gift box');
    expect(r.candidates[0]!.hsn).toBe('1806');
    expect(r.candidates[0]!.confidence).toBeGreaterThan(0.45);
    expect(packagingHinted(r.candidates[0]!)).toBe(true);
  });
  it('"dry fruits gift box" keeps chapter 08 in the list', async () => {
    const r = await c.classify('dry fruits gift box');
    expect(r.candidates.some((k) => k.hsn === '08' && packagingHinted(k))).toBe(true);
  });
});
