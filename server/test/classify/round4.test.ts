/**
 * Round-4 regression tests: validator R2 (a synonym is exact only when it IS the product name)
 * and the imitation-jewellery qualifier. Run against the real data/seed (no rates involved).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { seededClassifier } from '../../scripts/eval-classifier.js';
import { isGenericSingle, uncovered } from '../../src/classify/coverage.js';
import { imitationQualified } from '../../src/classify/qualifiers.js';
import { SynonymMatcher } from '../../src/classify/synonyms.js';
import { normaliseName, referenceTokens } from '../../src/classify/normalise.js';

const c = seededClassifier();
afterAll(() => c.close());
const hay = (s: string) => normaliseName(s).matchTokens.flatMap((t) => t.split('-'));

describe('validator R2 on the real seed: one curated word inside a longer name is never high', () => {
  it.each([
    // the validator's five
    ['Samsung Galaxy tablet 10 inch', '3004'],
    ['lenovo android tablet', '3004'],
    ['shirt button', '6205'],
    ['chocolate biscuit', '1806'],
    ['cotton t-shirt', '6205'],
    // ten more adversarial names
    ['dishwasher tablets 60 pcs', '3004'],
    ['plastic injection moulding machine', '3004'],
    ['ceramic tea cup set of 6', '0902'],
    ['coffee table wooden', '0901'],
    ['electric rice cooker', '1006'],
    ['peanut butter crunchy', '0405'],
    ['pearl millet bajra 1 kg', '7101'],
    ['himalayan salt lamp', '2501'],
    ['wooden shirt hanger set', '6205'],
    ['AC voltage stabilizer', '8415'],
    ['charger cable usb type c', '8504'],
  ])('"%s" → no high answer; the misleading code %s is low at most', async (name, wrong) => {
    const r = await c.classify(name);
    for (const x of r.candidates) expect(x.confidence_band).not.toBe('high');
    expect(r.needs_review).toBe(true);
    for (const x of r.candidates.filter((k) => k.hsn.startsWith(wrong))) expect(x.confidence_band).toBe('low');
  });

  it('"Samsung Galaxy tablet" does not return 3004 above low', async () => {
    const r = await c.classify('Samsung Galaxy tablet');
    const med = r.candidates.find((x) => x.hsn.startsWith('3004'));
    if (med !== undefined) expect(med.confidence_band).toBe('low');
  });

  it('a phrase that IS the name (quantities aside) is still high: "22K gold ring 10 gm"', async () => {
    const r = await c.classify('22K gold ring 10 gm');
    expect(r.candidates[0]).toMatchObject({ hsn: '7113', confidence_band: 'high' });
  });

  it('generic single words alone are at most medium: "tablet", "chocolate"', async () => {
    for (const n of ['tablet', 'tablets', 'chocolate']) {
      const r = await c.classify(n);
      for (const x of r.candidates) expect(x.confidence_band).not.toBe('high');
    }
  });

  it('"gold plated brass bangles" → 7117 on top, 7113 low', async () => {
    const r = await c.classify('gold plated brass bangles');
    expect(r.candidates[0]!.hsn).toBe('7117');
    expect(r.candidates[0]!.confidence_band).not.toBe('high');
    expect(r.candidates.find((x) => x.hsn === '7113')?.confidence_band ?? 'low').toBe('low');
    expect(r.candidates[0]!.reasons.some((x) => x.code === 'review_hint' && /imitation jewellery \(7117\)/.test(x.detail))).toBe(true);
  });

  it('"gold plated 925 silver ring" stays precious (silver substrate)', async () => {
    const r = await c.classify('gold plated 925 silver ring');
    expect(r.candidates[0]!.hsn).toBe('7113');
  });
});

describe('coverage helpers', () => {
  it('uncovered() drops the phrase run, quantities, form/pack words and brand tokens', () => {
    expect(uncovered(hay('paracetamol 500mg tablet strip'), ['paracetamol'])).toEqual(['strip']);
    expect(uncovered(hay('22k gold ring 10 gm'), ['22k', 'gold', 'ring'])).toEqual([]);
    expect(uncovered(hay('samsung galaxy tablet 10 inch'), ['tablet'])).toEqual(['samsung', 'galaxy']);
    expect(uncovered(hay('amul butter 100 g'), ['butter'], new Set(['amul']))).toEqual([]);
  });
  it('isGenericSingle', () => {
    expect(isGenericSingle(['tablet'])).toBe(true);
    expect(isGenericSingle(['potato'])).toBe(false);
    expect(isGenericSingle(['gold', 'ring'])).toBe(false);
  });
  it('matcher: brand tokens passed as ignore restore exactness', () => {
    const m = new SynonymMatcher([{ phrase: 'butter', hsn_code: '0405', strength: 'primary', note: null, active: true }]);
    expect(m.match(hay('Amul butter 100 g')).get('0405')?.score).toBe(0.3);
    expect(m.match(hay('Amul butter 100 g'), new Set(referenceTokens('Amul'))).get('0405')?.score).toBe(1);
  });
  it('imitationQualified', () => {
    for (const n of ['gold plated brass bangles', 'one gram gold chain', 'american diamond earrings', 'oxidised german silver jhumka', 'imitation necklace'])
      expect(imitationQualified(normaliseName(n).tokens), n).toBe(true);
    for (const n of ['22k gold ring', 'gold plated 925 silver ring', 'rhodium plated silver chain', 'sterling silver plated ring'])
      expect(imitationQualified(normaliseName(n).tokens), n).toBe(false);
  });
});
