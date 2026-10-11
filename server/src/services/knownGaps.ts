/**
 * Validator round 3 polish: the curated list of known data gaps (data/seed/known_gaps.json), served in
 * GET /v1/meta/dataset as known_data_gaps[] so a client can tell "not yet curated" from "no rule exists".
 * Read once at boot; a malformed file fails closed (throws), a missing file yields an empty list.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const KNOWN_GAP_KINDS = ['disputed', 'not_researched', 'not_transcribed', 'not_expressible', 'period_gap'] as const;

const Gap = z
  .object({
    prefix: z.string().regex(/^(\d{2}|\d{4}|99\d{3}|\d{6}|\d{8})$/).nullable(),
    kind: z.enum(KNOWN_GAP_KINDS),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
const File = z.object({ _comment: z.string().optional(), items: z.array(Gap).max(200) }).strict();

export type KnownGap = z.infer<typeof Gap>;

/** Default location: <server>/data/seed/known_gaps.json (works from src/ and dist/). */
export const DEFAULT_KNOWN_GAPS_FILE = fileURLToPath(new URL('../../data/seed/known_gaps.json', import.meta.url));

/** SA-C5-04: the file is small curated JSON; anything larger is refused before it is read. */
export const MAX_KNOWN_GAPS_BYTES = 256 * 1024;

/**
 * Load the curated gaps. With no `path` the shipped default is used and may be absent ([]). An explicit path
 * (HSN_KNOWN_GAPS_FILE) must exist (unless opts.required is false) and be a regular file of at most 256 KiB,
 * or this throws (boot refuses).
 * Errors never quote the file's contents.
 */
export function loadKnownGaps(path?: string | null, opts: { required?: boolean } = {}): readonly KnownGap[] {
  const explicit = path !== undefined && path !== null;
  const file = explicit ? path : DEFAULT_KNOWN_GAPS_FILE;
  if (!existsSync(file)) {
    if (opts.required ?? explicit) throw new Error(`HSN_KNOWN_GAPS_FILE ${file}: file not found`);
    return [];
  }
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${file}: not a regular file`);
  if (st.size > MAX_KNOWN_GAPS_BYTES) throw new Error(`${file}: ${st.size} bytes exceeds the ${MAX_KNOWN_GAPS_BYTES}-byte limit`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file}: not valid JSON`);
  }
  const parsed = File.safeParse(json);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message.slice(0, 120)}`).join('; ')}`);
  return Object.freeze(parsed.data.items.map((g) => Object.freeze(g)));
}
