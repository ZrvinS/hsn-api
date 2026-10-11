/**
 * GTIN validation (GS1 mod-10 check digit) for GTIN-8 (EAN-8), GTIN-12 (UPC-A),
 * GTIN-13 (EAN-13) and GTIN-14. Pure functions, no I/O.
 *
 * The GS1 company prefix only says which GS1 member organisation issued the number.
 * Prefix 890 = GS1 India. It is reported as a hint only and is never used as evidence of
 * country of origin, manufacturer, or HSN classification.
 */

export type GtinKind = 'GTIN-8' | 'GTIN-12' | 'GTIN-13' | 'GTIN-14';

export type GtinResult =
  | {
      valid: true;
      kind: GtinKind;
      /** the input digits, unchanged */
      input: string;
      /** left-padded with zeros to 14 digits (products cache key) */
      gtin14: string;
      checkDigit: number;
    }
  | {
      valid: false;
      reason: 'not_digits' | 'bad_length' | 'checksum';
      input: string;
      /** set when reason = checksum */
      expected?: number;
      actual?: number;
      message: string;
    };

const KINDS: Record<number, GtinKind> = { 8: 'GTIN-8', 12: 'GTIN-12', 13: 'GTIN-13', 14: 'GTIN-14' };

/**
 * GS1 check digit for the body (all digits except the check digit).
 * Weights alternate 3,1,3,... starting from the rightmost body digit.
 */
export function gtinCheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new Error('gtinCheckDigit: body must be digits');
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function validateGtin(raw: string): GtinResult {
  const input = raw;
  if (!/^\d+$/.test(input)) {
    return { valid: false, reason: 'not_digits', input, message: 'Barcode must contain digits only.' };
  }
  const kind = KINDS[input.length];
  if (kind === undefined) {
    return { valid: false, reason: 'bad_length', input, message: 'Barcode must have 8, 12, 13 or 14 digits (GTIN-8/12/13/14).' };
  }
  const expected = gtinCheckDigit(input.slice(0, -1));
  const actual = input.charCodeAt(input.length - 1) - 48;
  if (expected !== actual) {
    return {
      valid: false,
      reason: 'checksum',
      input,
      expected,
      actual,
      // SA-K-14 / SEC-75: do not reflect the submitted value
      message: `The barcode's check digit should be ${expected}, got ${actual}.`,
    };
  }
  return { valid: true, kind, input, gtin14: input.padStart(14, '0'), checkDigit: actual };
}

export interface GtinHint {
  code: 'gs1_prefix_india';
  detail: string;
}

/**
 * Hint only. For GTIN-12/13/14 the GS1 prefix is digits 2–4 of the GTIN-14 form
 * (after the indicator digit). GTIN-8 uses a separate prefix scheme and gets no hint.
 */
export function gs1PrefixHint(g: Extract<GtinResult, { valid: true }>): GtinHint | null {
  if (g.kind === 'GTIN-8') return null;
  if (g.gtin14.slice(1, 4) === '890') {
    return {
      code: 'gs1_prefix_india',
      detail:
        'GS1 prefix 890: the number was allotted through GS1 India. This is not proof of country of origin, manufacturer, or classification.',
    };
  }
  return null;
}

/**
 * The barcode string sent to product databases: GTIN-8 stays 8 digits, GTIN-12/13 are sent
 * as 13 digits, GTIN-14 with a non-zero indicator stays 14. Digits only (SEC-37).
 */
export function lookupCode(g: Extract<GtinResult, { valid: true }>): string {
  if (g.gtin14.startsWith('000000') && g.kind === 'GTIN-8') return g.gtin14.slice(6);
  if (g.gtin14.startsWith('0')) return g.gtin14.slice(1);
  return g.gtin14;
}
