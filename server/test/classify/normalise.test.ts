import { describe, expect, it } from 'vitest';
import { normaliseName, sanitiseUntrusted, tokenEq } from '../../src/classify/normalise.js';

describe('normaliseName', () => {
  it('splits units and drops quantity tokens for matching (architecture §5.1 example)', () => {
    const n = normaliseName('Paracetamol 500mg Tablet');
    expect(n.text).toBe('paracetamol 500 mg tablet');
    expect(n.tokens).toEqual(['paracetamol', '500', 'mg', 'tablet']);
    expect(n.matchTokens).toEqual(['paracetamol', 'tablet']);
  });

  it.each(['22K gold ring', '22k Gold Ring', '22 kt gold ring', '22kt gold ring', '22 carat gold ring', '22ct gold ring', '22 Karat gold ring', '22-carat gold ring', '２２Ｋ gold ring'])(
    'karat form %j → "22k gold ring"',
    (s) => {
      expect(normaliseName(s).text).toBe('22k gold ring');
    },
  );

  it('does not turn diamond carat weights into karat', () => {
    expect(normaliseName('1.5 ct diamond').text).toBe('1.5 ct diamond');
    expect(normaliseName('2 carat diamond').text).toBe('2 carat diamond');
  });

  it('uses Indian/British spellings', () => {
    expect(normaliseName('Gold Jewelry Set').text).toBe('gold jewellery set');
    expect(normaliseName('jewelery').text).toBe('jewellery');
    expect(normaliseName('Aluminum foil').text).toBe('aluminium foil');
  });

  it('canonicalises units', () => {
    expect(normaliseName('Rice 5kgs').text).toBe('rice 5 kg');
    expect(normaliseName('Oil 1 Ltr').text).toBe('oil 1 l');
    expect(normaliseName('Biscuits 250 gm').matchTokens).toEqual(['biscuits']);
    expect(normaliseName('Syrup 100ml').tokens).toEqual(['syrup', '100', 'ml']);
  });

  it('handles & and punctuation, keeps intra-word hyphens', () => {
    const n = normaliseName('Salt & Pepper, (T-Shirt)!!');
    expect(n.text).toBe('salt and pepper t-shirt');
    expect(n.ftsTokens).toEqual(['salt', 'pepper', 't', 'shirt']);
  });

  it('strips control, zero-width and bidi characters; NFKC folds homoglyph digits', () => {
    expect(normaliseName('gold​ring').text).toBe('gold ring');
    expect(normaliseName('‮gold ring‬').text).toBe('gold ring');
    expect(normaliseName('gold\u0000\u0007ring').text).toBe('gold ring');
    expect(normaliseName('１８ｋ gold').text).toBe('18k gold');
  });

  it('caps length at 200 characters (10 KB input)', () => {
    const big = 'gold '.repeat(2000);
    expect(normaliseName(big).text.length).toBeLessThanOrEqual(200);
    expect(sanitiseUntrusted('x'.repeat(10_000)).length).toBe(200);
  });

  it('never throws on odd input', () => {
    for (const s of ['', '   ', '"', '*', '^x', 'NOT', 'a:b', '\uD800', '😀😀', 'गोल्ड रिंग', '%%%']) {
      expect(() => normaliseName(s)).not.toThrow();
    }
  });

  it('plural fold', () => {
    expect(tokenEq('rings', 'ring')).toBe(true);
    expect(tokenEq('biscuit', 'biscuits')).toBe(true);
    expect(tokenEq('gas', 'ga')).toBe(false);
  });
});
