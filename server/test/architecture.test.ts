import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const all = files(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

describe('module boundaries (architecture §3)', () => {
  it('only db/ and repositories/sqlite/ import node:sqlite', () => {
    const bad = all.filter((f) => /from 'node:sqlite'/.test(f.text) && !/^(db|repositories\/sqlite)\//.test(f.rel) && !/import type/.test(f.text.match(/.*from 'node:sqlite'.*/)?.[0] ?? ''));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
  it('routes never import repository implementations', () => {
    expect(all.filter((f) => f.rel.startsWith('routes/') && /repositories\/sqlite/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });
  it('classify/ never imports proposal, tax or rate-writing code (SEC-56)', () => {
    const bad = all.filter((f) => f.rel.startsWith('classify/') && /services\/(proposals|tax|rates)|rules\.(insert|endDate|markVerified)/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
  it('no outbound HTTP outside adapters/ (SEC-32)', () => {
    const bad = all.filter((f) => !f.rel.startsWith('adapters/') && /\bfetch\(|https?\.request\(|from 'undici'/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
  it('no SQL built with template literals containing interpolation (SEC-39)', () => {
    const bad = all.filter((f) => /(prepare|exec|all|get|run)\(\s*`[^`]*\$\{(?!COLS)/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});
