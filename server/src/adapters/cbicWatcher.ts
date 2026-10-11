/**
 * CBIC notification watcher adapter (research/sources.md §6.1; 00c ruling 10; 00b ruling 27).
 *
 * Fetches the CBIC "Central Tax (Rate)" and "Integrated Tax (Rate)" notification index pages through the
 * hardened OutboundHttpClient (exact-host allow-list, private-address refusal, no redirects, 3 s timeout,
 * 256 KiB cap, identity encoding) and parses them into {series, number, year, date, title, url}.
 *
 * The page is untrusted text. Parsing is a linear indexOf-based scan over a bounded input (no DOM, nothing
 * executed, no backtracking regex over markup; SA-C2-01), optionally isolated in a worker thread with a hard timeout,
 * column-agnostic (a row is any <tr> whose text holds "<n>/<yyyy>-<Series> Tax (Rate)"), and FAILS CLOSED:
 * a page that no longer looks like a notification listing is reported as `shape_changed` / `no_items` /
 * `too_many_malformed` / `wrong_series`, never as "no new notifications". Links found on the page are
 * kept only when they are https on an allow-listed source host; they are stored for the reviewer and
 * never fetched by the server.
 *
 * Nothing here writes rates. New items become watched_notifications in state `detected` (services/watcher.ts).
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OutboundHttpClient, type OutboundErrorCode } from './httpClient.js';

export type CbicSeries = 'central_tax_rate' | 'integrated_tax_rate' | 'union_territory_tax_rate';

export const SERIES_LABEL: Readonly<Record<CbicSeries, string>> = {
  central_tax_rate: 'Central Tax (Rate)',
  integrated_tax_rate: 'Integrated Tax (Rate)',
  union_territory_tax_rate: 'Union Territory Tax (Rate)',
};

export interface CbicPage {
  url: string;
  series: CbicSeries;
}

export interface CbicNotificationItem {
  series: CbicSeries;
  number: number;
  year: number;
  /** date of issue, YYYY-MM-DD */
  date: string;
  title: string | null;
  /** allow-listed https link to the notification document, or null (the reviewer uses the index page) */
  url: string | null;
  corrigendum: boolean;
  /** "01/2026-Central Tax (Rate)" (+ " corrigendum") */
  ref: string;
  /** idempotency key, e.g. "central_tax_rate:1/2026" or "central_tax_rate:1/2026:corrigendum:2026-05-06" */
  key: string;
}

export type ParseFailure = 'not_html' | 'shape_changed' | 'no_items' | 'too_many_malformed' | 'wrong_series';

export type ParseResult =
  | { ok: true; items: CbicNotificationItem[]; stats: ParseStats }
  | { ok: false; error: ParseFailure; detail: string; stats: ParseStats };

export interface ParseStats {
  rows: number;
  /** rows that carry a notification number of the expected series */
  matched: number;
  /** matched rows without a usable date of issue */
  malformed: number;
  /** rows whose notification belongs to another series (e.g. a CT page listing IT notifications) */
  foreign: number;
  duplicates: number;
  /** rows, cells or other elements skipped because the page hides them (hidden attribute, display:none) */
  hidden: number;
}

export interface ParseOptions {
  /** hosts a stored document link may point at (HSN_SOURCE_HOSTS) */
  linkHosts: readonly string[];
  /** fraction of matched rows allowed to be malformed before the page is rejected (default 0.2) */
  maxMalformedRatio?: number;
  /** ignore anything after this many items (default 3000) */
  maxItems?: number;
  /** plausibility window for dates: [2017-01-01, maxDate] (default: none above) */
  maxDate?: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}


function realDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** First date in the text: DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY (Indian order) or "17th September, 2025". */
export function findDate(text: string): string | null {
  const num = /(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?!\d)/.exec(text);
  const named = /(?<!\d)(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})(?!\d)/i.exec(text);
  const cands: { at: number; iso: string | null }[] = [];
  if (num) cands.push({ at: num.index, iso: realDate(Number(num[3]), Number(num[2]), Number(num[1])) });
  if (named) cands.push({ at: named.index, iso: realDate(Number(named[3]), MONTHS[named[2]!.toLowerCase().slice(0, 3)]!, Number(named[1])) });
  cands.sort((a, b) => a.at - b.at);
  return cands.find((c) => c.iso !== null)?.iso ?? null;
}

const NOTIFICATION_RE =
  /(?<!\d)(\d{1,3})\s*\/\s*(\d{4})\s*[-–—]?\s*(?:(central|integrated|union\s+territory)\s+tax|(ct|it|ut))\s*\(\s*r(?:ate)?\s*\)/i;

function seriesOf(word: string): CbicSeries {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  if (w === 'central' || w === 'ct') return 'central_tax_rate';
  if (w === 'integrated' || w === 'it') return 'integrated_tax_rate';
  return 'union_territory_tax_rate';
}

/** Parse "01/2026-Central Tax (Rate)" style references; null when the text holds none. */
export function parseNotificationRef(text: string): { series: CbicSeries; number: number; year: number; index: number; length: number } | null {
  const m = NOTIFICATION_RE.exec(text);
  if (!m) return null;
  const number = Number(m[1]);
  const year = Number(m[2]);
  if (number < 1 || year < 2017 || year > 2100) return null;
  return { series: seriesOf(m[3] ?? m[4]!), number, year, index: m.index, length: m[0].length };
}

export function notificationRef(series: CbicSeries, number: number, year: number): string {
  return `${String(number).padStart(2, '0')}/${year}-${SERIES_LABEL[series]}`;
}

export function notificationKey(series: CbicSeries, number: number, year: number, corrigendumDate?: string | null): string {
  const base = `${series}:${number}/${year}`;
  return corrigendumDate === undefined ? base : `${base}:corrigendum:${corrigendumDate ?? 'undated'}`;
}

/** Key for free text entered by an admin ("12/2026-Central Tax (Rate)"), or null when not recognisable. */
export function keyForText(text: string): string | null {
  const p = parseNotificationRef(text);
  if (!p) return null;
  if (/corrigendum/i.test(text)) return notificationKey(p.series, p.number, p.year, findDate(text.slice(p.index + p.length)));
  return notificationKey(p.series, p.number, p.year);
}

/** Resolve an href against the page; keep it only if https, default port, no credentials, allow-listed host. */
export function safeDocumentUrl(href: string, pageUrl: string, hosts: readonly string[]): string | null {
  const raw = decodeEntities(href).trim();
  if (raw.length === 0 || raw.length > 2000 || /^\s*(javascript|data|vbscript|file):/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.port !== '' && u.port !== '443') || u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) return null;
  if (u.pathname === '/' || u.pathname === '') return null;
  u.hash = '';
  return u.toString();
}

/**
 * Title text of one cell: a leading "Notification No. <ref> dated <date>" (number and date merged into the
 * subject cell) is removed, references inside the subject are kept, link labels are dropped.
 */
// ------------------------------------------------------------------------------------------------ linear scanner
//
// SA-C2-01: every step below is indexOf/charCode based and visits each input character a bounded number of
// times; no regex runs over unbounded markup. Unterminated constructs (a tag without '>', an unclosed
// comment or script) end the scan: the rest of the page is dropped (fail closed), never re-scanned.

/** Only the first 4 KiB of a tag's attribute text is examined (href, style, hidden). */
const MAX_TAG_INSPECT = 4096;
/** Text kept per table row (all cells together); the rest of a longer row is ignored. */
export const MAX_ROW_TEXT = 16 * 1024;
/** Cells kept per row. */
export const MAX_ROW_CELLS = 64;
/** Tags processed per row; a row with more is truncated at that point. */
export const MAX_ROW_TAGS = 2048;
/** Anchors considered per row. */
const MAX_ROW_ANCHORS = 10;

/** Elements whose content is not markup: dropped whole so their text cannot pose as rows. */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'noembed', 'noframes', 'xmp']);
const VOID: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; attrs: string; selfClose: boolean }
  | { kind: 'close'; name: string };

const SPACE: Token = { kind: 'text', text: ' ' };

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isNameChar(c: number): boolean {
  return isAlpha(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x3a || c === 0x5f;
}
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

/** Index just past the `</name ...>` that closes a raw-text element, or -1 when it is never closed. */
function rawTextEnd(html: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const k = html.indexOf('</', i);
    if (k < 0) return -1;
    const end = k + 2 + name.length;
    if (html.slice(k + 2, end).toLowerCase() === name && !isNameChar(html.charCodeAt(end))) {
      const gt = html.indexOf('>', end);
      return gt < 0 ? -1 : gt + 1;
    }
    i = k + 2;
  }
}

/** Linear HTML tokenizer (enough HTML for a listing table; not a conforming parser). */
function* tokenize(html: string): Generator<Token> {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      yield { kind: 'text', text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: 'text', text: html.slice(i, lt) };
    const c = html.charCodeAt(lt + 1);
    if (c === 0x21 /* ! */ || c === 0x3f /* ? */) {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        if (end < 0) return; // unclosed comment: drop the rest
        i = end + 3;
      } else {
        const gt = html.indexOf('>', lt + 2); // doctype, CDATA, processing instruction
        if (gt < 0) return;
        i = gt + 1;
      }
      yield SPACE;
      continue;
    }
    const close = c === 0x2f; /* / */
    const nameStart = close ? lt + 2 : lt + 1;
    if (!isAlpha(html.charCodeAt(nameStart))) {
      yield { kind: 'text', text: '<' }; // "a < b", "<3": plain text
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', nameStart);
    if (gt < 0) return; // unterminated tag: drop the rest
    let j = nameStart;
    while (j < gt && isNameChar(html.charCodeAt(j))) j++;
    const name = html.slice(nameStart, j).toLowerCase();
    i = gt + 1;
    if (close) {
      yield { kind: 'close', name };
      continue;
    }
    const selfClose = html.charCodeAt(gt - 1) === 0x2f;
    if (RAW_TEXT.has(name) && !selfClose) {
      const end = rawTextEnd(html, name, i);
      if (end < 0) return; // unclosed <script>: drop the rest
      i = end;
      yield SPACE;
      continue;
    }
    yield { kind: 'open', name, attrs: html.slice(j, Math.min(gt, j + MAX_TAG_INSPECT)), selfClose };
  }
}

/** Attributes of one (capped) tag string: lower-cased names, raw values; first occurrence wins. */
function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s.charCodeAt(i)) || s.charCodeAt(i) === 0x2f)) i++;
    const ns = i;
    while (i < n && !isSpace(s.charCodeAt(i)) && s[i] !== '=' && s[i] !== '/') i++;
    if (i === ns) {
      i++;
      continue;
    }
    const name = s.slice(ns, i).toLowerCase();
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < n && isSpace(s.charCodeAt(i))) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, i + 1);
        const end = e < 0 ? n : e;
        value = s.slice(i + 1, end);
        i = end + 1;
      } else {
        const vs = i;
        while (i < n && !isSpace(s.charCodeAt(i))) i++;
        value = s.slice(vs, i);
      }
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** SA-C2-08: an element the browser would not show (hidden attribute, display:none, visibility:hidden). */
function isHidden(attrs: Map<string, string>): boolean {
  if (attrs.has('hidden')) return true;
  const style = attrs.get('style');
  if (style === undefined) return false;
  const s = decodeEntities(style).toLowerCase().replace(/\s+/g, '');
  return s.includes('display:none') || s.includes('visibility:hidden') || s.includes('visibility:collapse');
}

function normaliseText(raw: string): string {
  return decodeEntities(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tag-free, entity-decoded, whitespace-collapsed text; control and bidi characters removed. Linear. */
export function htmlText(fragment: string): string {
  const parts: string[] = [];
  for (const t of tokenize(fragment)) parts.push(t.kind === 'text' ? t.text : ' ');
  return normaliseText(parts.join(''));
}

interface RowBuf {
  /** raw text parts per cell */
  cells: string[][];
  /** raw text of a row without cells */
  loose: string[];
  anchors: { href: string; text: string }[];
  open: { href: string; parts: string[] } | null;
  size: number;
  tags: number;
}

interface RawRow {
  cells: string[];
  text: string;
  anchors: { href: string; text: string }[];
}

/** One pass over the page: visible table rows with their cell texts and anchors. */
function scanRows(html: string, stats: ParseStats): { rows: RawRow[]; sawRow: boolean } {
  const rows: RawRow[] = [];
  let sawRow = false;
  let row: RowBuf | null = null;
  let skipRow = false; // inside a hidden <tr>
  let skipCell = false; // inside a hidden <td>/<th>
  let skip: { name: string; depth: number } | null = null; // inside any other hidden element

  const finish = (): void => {
    if (row !== null) {
      const cells = row.cells.map((c) => normaliseText(c.join('')));
      rows.push({ cells, text: cells.length > 0 ? cells.join(' | ') : normaliseText(row.loose.join('')), anchors: row.anchors });
    }
    row = null;
    skipRow = false;
    skipCell = false;
  };
  const add = (r: RowBuf, text: string): void => {
    if (r.size >= MAX_ROW_TEXT) return;
    const t = text.length > MAX_ROW_TEXT - r.size ? text.slice(0, MAX_ROW_TEXT - r.size) : text;
    r.size += t.length;
    (r.cells.length > 0 ? r.cells[r.cells.length - 1]! : r.loose).push(t);
    if (r.open !== null) r.open.parts.push(t);
  };

  for (const t of tokenize(html)) {
    if (skip !== null) {
      if (t.kind === 'open' && t.name === skip.name && !t.selfClose && !VOID.has(t.name)) skip.depth++;
      else if (t.kind === 'close' && t.name === skip.name && --skip.depth === 0) skip = null;
      continue;
    }
    if (t.kind === 'open' && t.name === 'tr') {
      finish();
      sawRow = true;
      if (isHidden(parseAttrs(t.attrs))) {
        stats.hidden++;
        skipRow = true;
      } else {
        stats.rows++;
        row = { cells: [], loose: [], anchors: [], open: null, size: 0, tags: 0 };
      }
      continue;
    }
    if (t.kind === 'close' && (t.name === 'tr' || t.name === 'tbody' || t.name === 'thead' || t.name === 'tfoot' || t.name === 'table')) {
      finish();
      continue;
    }
    if (skipRow) continue;
    if (t.kind === 'open' && (t.name === 'td' || t.name === 'th')) {
      skipCell = false;
      if (row === null) continue;
      if (isHidden(parseAttrs(t.attrs))) {
        stats.hidden++;
        skipCell = true;
        continue;
      }
      if (row.cells.length < MAX_ROW_CELLS) row.cells.push([]);
      else row.size = MAX_ROW_TEXT; // too many cells: ignore the rest of the row
      continue;
    }
    if (skipCell) continue;
    if (t.kind === 'open' && !t.selfClose && !VOID.has(t.name) && isHidden(parseAttrs(t.attrs))) {
      stats.hidden++;
      skip = { name: t.name, depth: 1 };
      continue;
    }
    if (row === null) continue;
    if (t.kind === 'text') {
      add(row, t.text);
      continue;
    }
    if (++row.tags > MAX_ROW_TAGS) {
      row.size = MAX_ROW_TEXT;
      continue;
    }
    if (t.kind === 'open' && t.name === 'a') {
      if (row.open !== null) row.anchors.push({ href: row.open.href, text: normaliseText(row.open.parts.join('')) });
      row.open = null;
      const href = parseAttrs(t.attrs).get('href');
      if (href !== undefined && row.anchors.length < MAX_ROW_ANCHORS) row.open = { href, parts: [] };
    } else if (t.kind === 'close' && t.name === 'a' && row.open !== null) {
      row.anchors.push({ href: row.open.href, text: normaliseText(row.open.parts.join('')) });
      row.open = null;
    }
    add(row, ' ');
  }
  finish();
  return { rows, sawRow };
}

function trimTrailingSpaceAndBars(t: string): string {
  let e = t.length;
  while (e > 0 && (t[e - 1] === '|' || /\s/.test(t[e - 1]!))) e--;
  return t.slice(0, e);
}

/**
 * Title text of one cell: a leading "Notification No. <ref> dated <date>" (number and date merged into the
 * subject cell) is removed, references inside the subject are kept, link labels are dropped.
 */
function cleanTitle(cell: string): string | null {
  let t = cell.replace(/\b(english|hindi)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const lead = /^(?:notification\s*(?:no\.?|number)?\s*:?\s*)?/i.exec(t)![0];
  const ref = parseNotificationRef(t.slice(lead.length));
  if (ref && ref.index === 0) {
    t = t.slice(lead.length + ref.length);
    const dated = /^\s*(?:corrigendum\s*)?(?:dated\s*)?/i.exec(t)![0];
    const after = t.slice(dated.length);
    const d = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}|\d{1,2}\s*(?:st|nd|rd|th)?\s+[a-z]+\.?,?\s+\d{4})/i.exec(after);
    t = d && findDate(d[0]) !== null ? after.slice(d[0].length) : t;
  }
  t = trimTrailingSpaceAndBars(t.replace(/^[\s\-–—:|,.]+/, '')).trim();
  if (t.length < 4 || /^\d{1,4}\.?$/.test(t) || (findDate(t) !== null && t.length <= 25) || /^(download|view|pdf|corrigendum)$/i.test(t)) return null;
  return t.slice(0, 500);
}

function pickLink(anchors: readonly { href: string; text: string }[], pageUrl: string, hosts: readonly string[]): string | null {
  const order = [
    ...anchors.filter((a) => /english|eng\b/i.test(a.text) || /eng/i.test(a.href)),
    ...anchors.filter((a) => /\.pdf(?:$|[?#])|view-pdf/i.test(a.href)),
    ...anchors,
  ];
  for (const a of order) {
    const u = safeDocumentUrl(a.href, pageUrl, hosts);
    if (u !== null) return u;
  }
  return null;
}

/**
 * Parse one listing page. Fails closed: when the page does not look like a listing of `page.series`
 * notifications, returns ok:false with a reason instead of an empty list. Linear in the input (SA-C2-01);
 * rows, cells and other elements hidden from a reader are skipped and counted in `stats.hidden` (SA-C2-08).
 */
export function parseCbicListing(html: string, page: CbicPage, opts: ParseOptions): ParseResult {
  const stats: ParseStats = { rows: 0, matched: 0, malformed: 0, foreign: 0, duplicates: 0, hidden: 0 };
  const fail = (error: ParseFailure, detail: string): ParseResult => ({ ok: false, error, detail, stats });
  if (typeof html !== 'string' || !/<(?:!doctype\s+html|html|body|table)\b/i.test(html)) return fail('not_html', 'response is not an HTML document');

  // scripts, styles, comments and templates are dropped by the tokenizer so their text cannot pose as rows
  const { rows, sawRow } = scanRows(html, stats);
  if (!sawRow) return fail('shape_changed', 'no table rows found (page layout changed?)');

  const maxItems = opts.maxItems ?? 3000;
  const items = new Map<string, CbicNotificationItem>();
  for (const row of rows) {
    const text = row.text;
    const ref = parseNotificationRef(text);
    if (!ref) continue;
    if (ref.series !== page.series) {
      stats.foreign++;
      continue;
    }
    stats.matched++;
    const rest = text.slice(0, ref.index) + ' ' + text.slice(ref.index + ref.length);
    const date = findDate(rest);
    const yearGap = date === null ? 0 : Math.abs(Number(date.slice(0, 4)) - ref.year);
    if (date === null || date < '2017-01-01' || (opts.maxDate !== undefined && date > opts.maxDate) || yearGap > 1) {
      stats.malformed++;
      continue;
    }
    const corrigendum = /corrigendum/i.test(text);
    // title: the longest cell left after removing the number/date, serials and link labels
    const title =
      row.cells
        .map(cleanTitle)
        .filter((c): c is string => c !== null)
        .sort((a, b) => b.length - a.length)[0] ?? null;
    const item: CbicNotificationItem = {
      series: ref.series,
      number: ref.number,
      year: ref.year,
      date,
      title,
      url: pickLink(row.anchors, page.url, opts.linkHosts),
      corrigendum,
      ref: `${notificationRef(ref.series, ref.number, ref.year)}${corrigendum ? ` corrigendum dated ${date}` : ''}`,
      key: corrigendum ? notificationKey(ref.series, ref.number, ref.year, date) : notificationKey(ref.series, ref.number, ref.year),
    };
    if (items.has(item.key)) {
      stats.duplicates++;
      continue;
    }
    items.set(item.key, item);
    if (items.size >= maxItems) break;
  }

  if (stats.matched === 0) {
    if (stats.foreign > 0) return fail('wrong_series', `page lists ${stats.foreign} notifications of another series, none of ${SERIES_LABEL[page.series]}`);
    return fail('no_items', `no ${SERIES_LABEL[page.series]} notifications found in ${stats.rows} rows (page layout changed?)`);
  }
  const ratio = opts.maxMalformedRatio ?? 0.2;
  if (stats.malformed / stats.matched > ratio) {
    return fail('too_many_malformed', `${stats.malformed} of ${stats.matched} notification rows have no usable date of issue`);
  }
  if (items.size === 0) return fail('no_items', 'no usable notification rows');
  return { ok: true, items: [...items.values()], stats };
}


export interface IsolatedParseOptions {
  /** hard limit for the parse itself, measured from worker start-up (default 2000 ms) */
  timeoutMs?: number;
  /** limit for the worker to start (module load), default 15000 ms */
  startupTimeoutMs?: number;
  /** test seam: make the worker spin before parsing */
  testOnlyBusyMs?: number;
}

/**
 * parseCbicListing in a worker thread with a hard timeout (SA-C2-01). A parse that does not finish in time,
 * crashes or runs out of its (small) heap FAILS CLOSED as `shape_changed`; the worker is terminated.
 */
export function parseCbicListingIsolated(html: string, page: CbicPage, opts: ParseOptions, iso: IsolatedParseOptions = {}): Promise<ParseResult> {
  const timeoutMs = iso.timeoutMs ?? 2000;
  const startupMs = iso.startupTimeoutMs ?? 15_000;
  const failed = (detail: string): ParseResult => ({
    ok: false, error: 'shape_changed', detail, stats: { rows: 0, matched: 0, malformed: 0, foreign: 0, duplicates: 0, hidden: 0 },
  });
  return new Promise<ParseResult>((resolve) => {
    let worker: Worker;
    try {
      const data = { html, page, opts: { ...opts, linkHosts: [...opts.linkHosts] }, ...(iso.testOnlyBusyMs !== undefined ? { testOnlyBusyMs: iso.testOnlyBusyMs } : {}) };
      const wopts = { resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true } as const;
      if (import.meta.url.endsWith('.ts')) {
        // running from source (tests, tsx scripts): load the TypeScript entry through tsx's API
        const entry = new URL('./cbicParseWorker.ts', import.meta.url).href;
        // tsx's ESM API (its CJS build and its --import hook do not register inside worker threads)
        const api = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api').replace(/index\.cjs$/, 'index.mjs')).href;
        const boot = `const { workerData } = require('node:worker_threads'); import(workerData.api).then((m) => { m.register(); return import(workerData.entry); });`;
        worker = new Worker(boot, { ...wopts, eval: true, workerData: { ...data, api, entry } });
      } else {
        worker = new Worker(new URL('./cbicParseWorker.js', import.meta.url), { ...wopts, workerData: data });
      }
    } catch (e) {
      resolve(failed(`parser worker could not start: ${(e as Error).name}`));
      return;
    }
    let settled = false;
    const done = (r: ParseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    let timer = setTimeout(() => done(failed(`parser worker did not start within ${startupMs} ms`)), startupMs);
    worker.on('message', (m: { ready?: true; result?: ParseResult }) => {
      if (m.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => done(failed(`parser timed out after ${timeoutMs} ms (hostile or pathological page?)`)), timeoutMs);
      } else if (m.result) {
        done(m.result);
      }
    });
    worker.on('error', (e) => done(failed(`parser worker failed: ${e.name}`)));
    worker.on('exit', (code) => done(failed(`parser worker exited (${code}) without a result`)));
  });
}

export type FetchFailure = OutboundErrorCode | ParseFailure;

export interface CbicFetchResult {
  page: CbicPage;
  result: { ok: true; items: CbicNotificationItem[]; stats: ParseStats } | { ok: false; error: FetchFailure; detail: string; status?: number; stats?: ParseStats };
}

export interface CbicWatcherAdapterOptions {
  pages: readonly CbicPage[];
  /** exact hosts the watcher may contact (HSN_WATCHER_HOSTS) */
  allowlist: readonly string[];
  /** hosts a stored document link may point at (HSN_SOURCE_HOSTS) */
  linkHosts: readonly string[];
  userAgent: string;
  now?: () => number;
  /**
   * Parse each page in a worker thread with a hard timeout (SA-C2-01). watcherDeps always sets it, so the
   * in-process watcher (HSN_WATCHER_ENABLED) can never block the API's event loop. Unset: parse inline.
   */
  isolateParse?: IsolatedParseOptions;
  /** test seam only, passed through to the client */
  testOnly?: ConstructorParameters<typeof OutboundHttpClient>[0]['testOnly'];
}

const RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'network', 'dns_error', 'busy']);

/** Fetches + parses each configured listing page. Each page is attempted at most twice. */
export class CbicWatcherAdapter {
  private readonly client: OutboundHttpClient;
  constructor(private readonly opts: CbicWatcherAdapterOptions) {
    for (const p of opts.pages) {
      let host = '';
      try {
        host = new URL(p.url).hostname.toLowerCase();
      } catch {
        throw new Error(`watcher page URL is not a URL: ${p.url}`);
      }
      if (!opts.allowlist.includes(host)) throw new Error(`watcher page host ${host} is not in the watcher allow-list`);
    }
    this.client = new OutboundHttpClient({
      allowlist: opts.allowlist,
      userAgent: opts.userAgent,
      textContentTypes: ['text/html', 'application/xhtml+xml'],
      acceptStatuses: [200],
      maxConcurrent: 2,
      // a handful of pages a day; the budget only bounds a runaway loop
      hostPerMin: Object.fromEntries(opts.allowlist.map((h) => [h, 6])),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.testOnly ? { testOnly: opts.testOnly } : {}),
    });
  }

  get pages(): readonly CbicPage[] {
    return this.opts.pages;
  }

  async fetchPage(page: CbicPage, maxDate?: string): Promise<CbicFetchResult> {
    let res = await this.client.getText(page.url);
    if (!res.ok && RETRYABLE.has(res.error)) res = await this.client.getText(page.url);
    if (!res.ok) {
      return { page, result: { ok: false, error: res.error, detail: `fetch failed: ${res.error}${res.status ? ` (HTTP ${res.status})` : ''}`, ...(res.status ? { status: res.status } : {}) } };
    }
    const popts: ParseOptions = { linkHosts: this.opts.linkHosts, ...(maxDate ? { maxDate } : {}) };
    const parsed = this.opts.isolateParse ? await parseCbicListingIsolated(res.body, page, popts, this.opts.isolateParse) : parseCbicListing(res.body, page, popts);
    return { page, result: parsed.ok ? { ok: true, items: parsed.items, stats: parsed.stats } : { ok: false, error: parsed.error, detail: parsed.detail, stats: parsed.stats } };
  }

  async fetchAll(maxDate?: string): Promise<CbicFetchResult[]> {
    const out: CbicFetchResult[] = [];
    for (const p of this.opts.pages) out.push(await this.fetchPage(p, maxDate));
    return out;
  }
}
