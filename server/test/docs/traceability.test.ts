/**
 * Validator r3 polish: enforce the TRD §15.2 traceability table (02-TRD.md). Every test ID specified in the
 * TRD must have a row; every `file › "test name"` cited in the table must exist in the suite (the cited file
 * exists under test/ and contains each fragment of the name; "…" marks an elision).
 * The TRD is read from HSN_TRD_PATH, default ../docs/02-TRD.md relative to the server folder. SA-C5-06: a missing TRD FAILS the suite; set HSN_TRD_PATH=skip to skip it explicitly.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TRD = fileURLToPath(new URL('../../../docs/02-TRD.md', import.meta.url));
const TRD = process.env['HSN_TRD_PATH'] ?? DEFAULT_TRD;
const skip = TRD === 'skip';
const present = !skip && existsSync(TRD);
if (skip) console.warn('[traceability] HSN_TRD_PATH=skip: TRD §15.2 traceability check skipped');

it.skipIf(skip)('the TRD is present (set HSN_TRD_PATH to its path, or HSN_TRD_PATH=skip to skip explicitly)', () => {
  expect(existsSync(TRD), `${TRD} not found`).toBe(true);
});

interface Row { id: string; refs: { file: string; names: string[]; atLeast: number }[]; status: string }
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function parse(md: string): { specified: string[]; rows: Row[] } {
  const start = md.indexOf('### 15.2');
  const table = start < 0 ? '' : md.slice(start, md.indexOf('\n## ', start) > 0 ? md.indexOf('\n## ', start) : undefined);
  const before = start < 0 ? md : md.slice(0, start);
  const specified = [...new Set([...before.matchAll(/^- (T-[A-Z]+\d+)\b/gm)].map((m) => m[1]!))];
  const rows: Row[] = [];
  for (const line of table.split('\n')) {
    const m = /^\| (T-[A-Z]+\d+) \| (.*) \| ([^|]*) \|\s*$/.exec(line);
    if (!m) continue;
    const refs: Row['refs'] = [];
    const cell = m[2]!.replace(/\\\|/g, '|'); // markdown-escaped pipes
    for (const seg of cell.split(/;\s*(?=`)/)) {
      const fm = /^`([^`]+\.test\.ts)`\s*(?:›\s*(.*)|\((?:all\s+)?(?:(\w+)\s+)?tests?\))?/.exec(seg.trim());
      if (!fm) continue;
      const names = [...(fm[2] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => q[1]!.replace(/\\"/g, '"'));
      refs.push({ file: fm[1]!, names, atLeast: NUMBERS[fm[3] ?? ''] ?? (fm[2] === undefined ? 1 : 0) });
    }
    rows.push({ id: m[1]!, refs, status: m[3]!.trim() });
  }
  return { specified, rows };
}

/**
 * A cited name → the fragments that must each appear (each as a list of acceptable spellings). "…" elides text;
 * the table's shorthand "path — high/medium/low" (and a fragment "…/medium/low" after an elision) names one test
 * per alternative, so every alternative must exist.
 */
function fragmentsOf(name: string): string[][] {
  const out: string[][] = [];
  const parts = name.split('…').map((x) => x.trim());
  let prefix = '';
  for (const part of parts) {
    if (part.length < 3) continue;
    if (part.startsWith('/')) {
      for (const alt of part.slice(1).split('/')) out.push([`${prefix}${alt.trim()}`]);
      continue;
    }
    const dash = part.lastIndexOf('— ');
    prefix = dash >= 0 ? part.slice(0, dash + 2) : '';
    const slash = part.indexOf('/');
    if (slash > 0 && dash >= 0 && slash > dash && !/\s/.test(part.slice(dash + 2).replace(/\/[^/]*$/, '').split('/').join(''))) {
      for (const alt of part.slice(dash + 2).split('/')) out.push([`${prefix}${alt.trim()}`]);
      continue;
    }
    if (slash > 0 && dash >= 0 && slash > dash) {
      // "medium/low/never high": alternatives separated by "/"
      for (const alt of part.slice(dash + 2).split('/')) out.push([`${prefix}${alt.trim()}`, part]);
      continue;
    }
    out.push([part]);
  }
  return out;
}

describe.skipIf(!present)('TRD §15.2 traceability (02-TRD.md)', () => {
  const { specified, rows } = present ? parse(readFileSync(TRD, 'utf8')) : { specified: [], rows: [] };

  it('the table parses and lists every test ID the TRD specifies', () => {
    expect(rows.length).toBeGreaterThan(50);
    const listed = new Set(rows.map((r) => r.id));
    expect(specified.filter((id) => !listed.has(id))).toEqual([]);
  });

  it('every cited test file exists and contains every cited test name', () => {
    const missing: string[] = [];
    const cache = new Map<string, string | null>();
    const src = (f: string) => {
      if (!cache.has(f)) cache.set(f, existsSync(join(TEST_DIR, f)) ? readFileSync(join(TEST_DIR, f), 'utf8') : null);
      return cache.get(f)!;
    };
    for (const r of rows) {
      for (const ref of r.refs) {
        const text = src(ref.file);
        if (text === null) {
          missing.push(`${r.id}: file ${ref.file} not found`);
          continue;
        }
        const tests = (text.match(/\bit(?:\.each\([^)]*\))?\s*\(/g) ?? []).length;
        if (tests < ref.atLeast) missing.push(`${r.id}: ${ref.file} has ${tests} tests, the table says at least ${ref.atLeast}`);
        for (const name of ref.names) {
          const absent = fragmentsOf(name).filter((alts) => !alts.some((f) => text.includes(f))).map((alts) => alts.join(' | '));
          if (absent.length > 0) missing.push(`${r.id}: ${ref.file} › "${name}" (not found: ${absent.map((a) => JSON.stringify(a)).join(', ')})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every row that claims coverage cites at least one test', () => {
    const empty = rows.filter((r) => /^covered|^partial|^fixture/.test(r.status) && r.refs.length === 0).map((r) => r.id);
    expect(empty).toEqual([]);
  });
});
