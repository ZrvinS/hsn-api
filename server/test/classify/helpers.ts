/**
 * Test fixture for the classifier: an in-memory SQLite DB through core's real repositories.
 * ILLUSTRATIVE test data only — HSN descriptions, synonyms and keywords below exist to exercise
 * the scoring code; they are not the curated production seed and carry no rates.
 */
import { openDb, migrate } from '../../src/db/migrate.js';
import { createSqliteRepos } from '../../src/repositories/sqlite/index.js';
import type { Repos } from '../../src/repositories/types.js';
import { fixedClock } from '../../src/lib/clock.js';
import type { ClassifierLogger, ClassifyContext, ClassifyInput } from '../../src/classify/types.js';

const V = '2026.10.01-1';

const CODES: [string, string, string][] = [
  ['71', 'Natural or cultured pearls, precious or semi-precious stones, precious metals, and articles thereof; imitation jewellery; coin', ''],
  ['7113', 'Articles of jewellery and parts thereof, of precious metal or of metal clad with precious metal', 'gold silver ring chain bangle necklace earring'],
  ['7117', 'Imitation jewellery', 'ring bangle artificial fashion'],
  ['30', 'Pharmaceutical products', ''],
  ['3004', 'Medicaments consisting of mixed or unmixed products for therapeutic or prophylactic uses, put up in measured doses or in forms or packings for retail sale', 'tablet capsule syrup medicine'],
  ['29', 'Organic chemicals', ''],
  ['2924', 'Carboxyamide-function compounds; amide-function compounds of carbonic acid', 'paracetamol bulk drug'],
  ['90', 'Optical, photographic, measuring, checking, medical or surgical instruments and apparatus', ''],
  ['9027', 'Instruments and apparatus for physical or chemical analysis', 'glucometer analyser meter'],
  ['19', 'Preparations of cereals, flour, starch or milk; pastrycooks products', ''],
  ['1905', "Bread, pastry, cakes, biscuits and other bakers' wares, whether or not containing cocoa", 'biscuits cookies rusk'],
];

export function makeRepos(): Repos {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO dataset_versions(version, parent_version, published_at, published_by, reason, rule_count, content_hash) VALUES (?,?,?,?,?,?,?)`,
  ).run(V, null, '2026-10-01T00:00:00Z', 'seed', 'seed', 0, '0'.repeat(64));
  const repos = createSqliteRepos(db);
  for (const [code, description, keywords] of CODES) {
    const level = code.length as 2 | 4 | 6 | 8;
    repos.hsn.insert({ code, level, parent: level === 2 ? null : code.slice(0, 2), chapter: code.slice(0, 2), type: 'goods', description, keywords, added_in_version: V });
  }
  const syn = (phrase: string, hsn_code: string, strength: 'primary' | 'related', note: string | null = null): void =>
    repos.synonyms.insert({ phrase, hsn_code, strength, note, created_by: 'test', created_at: '2026-10-01T00:00:00Z', active: true });
  syn('22k gold ring', '7113', 'primary');
  syn('gold ring', '7113', 'primary');
  syn('paracetamol', '3004', 'primary', 'Bulk paracetamol (API, not in dosage form) is classified under 2924; confirm this is a retail dosage form.');
  syn('paracetamol', '2924', 'related', 'Only for bulk drug substance');
  syn('glucometer', '9027', 'primary');
  syn('biscuits', '1905', 'primary');
  syn('glucose biscuits', '1905', 'primary');
  for (const [k, c] of [
    ['gold', '71'],
    ['22k', '71'],
    ['18k', '71'],
    ['silver', '71'],
    ['jewellery', '71'],
    ['tablet', '30'],
    ['capsule', '30'],
    ['mg', '30'],
    ['syrup', '30'],
    ['biscuits', '19'],
    ['glucometer', '90'],
  ] as const) repos.synonyms.insertChapterKeyword(k, c);
  repos.synonyms.insertCategory('open_food_facts', 'en:biscuits', '1905');
  return repos;
}

export interface CapturedLog {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
}

export function captureLogger(): ClassifierLogger & { lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  return {
    lines,
    info: (obj) => lines.push({ level: 'info', obj }),
    warn: (obj) => lines.push({ level: 'warn', obj }),
  };
}

export function ctx(log: ClassifierLogger = captureLogger()): ClassifyContext {
  return { requestId: 'req_test', log };
}

export function input(p: Partial<ClassifyInput>): ClassifyInput {
  return { name: null, barcode: null, date: '2026-10-10', maxCandidates: 5, allowLlm: false, keyId: null, ...p };
}

export const clock = (): ReturnType<typeof fixedClock> => fixedClock('2026-10-10T06:00:00Z');
