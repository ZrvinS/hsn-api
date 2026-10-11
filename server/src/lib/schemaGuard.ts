/**
 * SA-C5-01 / SA-C5-05: bounds on request validation work and on what a validation problem echoes back.
 *
 * Ajv runs with allErrors (validator round 3), which makes it check every element of an oversized array and
 * every unknown key. preValidateShape walks the route's body schema alongside the parsed body first and refuses,
 * with a short error list, any array longer than its maxItems (without looking inside it) and any body with more
 * than MAX_UNKNOWN_PROPERTIES unknown keys. Within those bounds Ajv's work is proportional to a legitimate request.
 */
import type { FieldError } from './problem.js';

/** a property name echoed in a pointer is cut to this many characters (SA-C5-05) */
export const MAX_ECHOED_NAME = 64;
/** a whole pointer is cut to this many characters */
export const MAX_POINTER = 256;
/** the errors[] list is trimmed until its JSON fits this many bytes (SA-C5-05) */
export const MAX_ERRORS_BYTES = 12 * 1024;
/** more unknown keys than this anywhere in a body: refused before Ajv runs */
export const MAX_UNKNOWN_PROPERTIES = 50;

/** One RFC 6901 reference token for a client-supplied name: escaped (~0, ~1) and truncated. */
export function pointerToken(name: string): string {
  const cut = name.length > MAX_ECHOED_NAME ? `${name.slice(0, MAX_ECHOED_NAME)}…` : name;
  return cut.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Cap every token of an Ajv instancePath (already escaped by Ajv) and the pointer as a whole. */
export function capPointer(pointer: string): string {
  const capped = pointer
    .split('/')
    .map((t) => (t.length > MAX_ECHOED_NAME ? `${t.slice(0, MAX_ECHOED_NAME)}…` : t))
    .join('/');
  return capped.length > MAX_POINTER ? `${capped.slice(0, MAX_POINTER)}…` : capped;
}

/** Keep the leading errors whose JSON stays within MAX_ERRORS_BYTES. */
export function fitErrors(errors: FieldError[]): FieldError[] {
  let bytes = 2;
  const out: FieldError[] = [];
  for (const e of errors) {
    bytes += Buffer.byteLength(JSON.stringify(e)) + 1;
    if (bytes > MAX_ERRORS_BYTES) break;
    out.push(e);
  }
  return out;
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  maxItems?: number;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural pre-check of `data` against `schema` (only properties / additionalProperties:false / items /
 * maxItems are looked at). Returns the problems (at most 50, plus their total) that would make Ajv's allErrors
 * work unbounded, or no errors when
 * the body may go to Ajv. Cost: one pass over the keys of each object the schema describes, and over the
 * elements of arrays within their maxItems.
 */
export function preValidateShape(schema: unknown, data: unknown): { errors: FieldError[]; total: number } {
  const oversized: FieldError[] = [];
  const unknown: FieldError[] = [];
  let unknownCount = 0;
  const walk = (s: Schema | undefined, d: unknown, ptr: string): void => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(d)) {
      if (typeof s.maxItems === 'number' && d.length > s.maxItems) {
        oversized.push({ pointer: ptr || '/', code: 'maxItems', message: `Has ${d.length} items; at most ${s.maxItems} are allowed` });
        return;
      }
      if (s.items && typeof s.items === 'object') for (let i = 0; i < d.length; i++) walk(s.items, d[i], `${ptr}/${i}`);
      return;
    }
    if (isPlainObject(d) && s.properties) {
      for (const k of Object.keys(d)) {
        const sub = Object.prototype.hasOwnProperty.call(s.properties, k) ? s.properties[k] : undefined;
        if (sub) walk(sub, d[k], `${ptr}/${pointerToken(k)}`);
        else if (s.additionalProperties === false) {
          unknownCount++;
          if (unknown.length < MAX_UNKNOWN_PROPERTIES) unknown.push({ pointer: `${ptr}/${pointerToken(k)}`, code: 'additionalProperties', message: 'Unknown field is not allowed' });
        }
      }
    }
  };
  walk(schema as Schema, data, '');
  if (oversized.length > 0) return { errors: oversized.slice(0, MAX_UNKNOWN_PROPERTIES), total: oversized.length };
  if (unknownCount > MAX_UNKNOWN_PROPERTIES) return { errors: unknown, total: unknownCount };
  return { errors: [], total: 0 };
}
