import { describe, expect, it } from 'vitest';
import { gs1PrefixHint, gtinCheckDigit, lookupCode, validateGtin } from '../../src/classify/gtin.js';

describe('GTIN check digit', () => {
  it.each([
    ['96385074', 'GTIN-8'], // EAN-8
    ['036000291452', 'GTIN-12'], // UPC-A
    ['4006381333931', 'GTIN-13'], // EAN-13
    ['8901234012345', 'GTIN-13'], // openapi example
    ['10012345678902', 'GTIN-14'],
  ])('accepts valid %s as %s', (code, kind) => {
    const r = validateGtin(code);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.kind).toBe(kind);
      expect(r.gtin14).toHaveLength(14);
      expect(r.gtin14.endsWith(code)).toBe(true);
    }
  });

  it('rejects a wrong check digit and reports expected vs actual', () => {
    const r = validateGtin('8901234012346');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toBe('checksum');
      expect(r.expected).toBe(5);
      expect(r.actual).toBe(6);
    }
  });

  it.each(['', '1234567', '12345678901', '123456789012345', '89012340123a5', '８９０１２３４０１２３４５', ' 8901234012345'])('rejects malformed %j', (code) => {
    expect(validateGtin(code).valid).toBe(false);
  });

  it('every single-digit corruption of a valid code is detected', () => {
    const good = '4006381333931';
    for (let i = 0; i < good.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === good[i]) continue;
        const bad = good.slice(0, i) + d + good.slice(i + 1);
        expect(validateGtin(bad).valid).toBe(false);
      }
    }
  });

  it('computes check digits', () => {
    expect(gtinCheckDigit('890123401234')).toBe(5);
    expect(gtinCheckDigit('03600029145')).toBe(2);
    expect(() => gtinCheckDigit('12a')).toThrow();
  });

  it('notes GS1 India prefix 890 only as a hint', () => {
    const r = validateGtin('8901234012345');
    if (!r.valid) throw new Error('fixture');
    const h = gs1PrefixHint(r);
    expect(h?.code).toBe('gs1_prefix_india');
    expect(h?.detail).toMatch(/not proof/);
    const us = validateGtin('036000291452');
    if (!us.valid) throw new Error('fixture');
    expect(gs1PrefixHint(us)).toBeNull();
  });

  it('builds digit-only lookup codes', () => {
    const cases: [string, string][] = [
      ['96385074', '96385074'],
      ['036000291452', '0036000291452'],
      ['8901234012345', '8901234012345'],
      ['10012345678902', '10012345678902'],
    ];
    for (const [inp, out] of cases) {
      const r = validateGtin(inp);
      if (!r.valid) throw new Error('fixture');
      expect(lookupCode(r)).toBe(out);
    }
  });
});
