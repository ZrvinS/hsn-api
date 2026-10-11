/**
 * CBIC watcher run + freshness (00c ruling 10, 00b ruling 27, research/sources.md §6).
 *
 * One run: fetch + parse every configured listing page (adapters/cbicWatcher.ts), then in ONE write
 * transaction insert each unseen notification as a watched_notifications row in state `detected`
 * (affected_prefixes [] until an admin triages it), audit each insert, and append a watcher_runs row.
 *
 * - Idempotent: identity is the notification key ("central_tax_rate:1/2026"); a key already present
 *   (from the watcher or entered manually) is skipped. A UNIQUE index backs this up.
 * - Fail closed: a page that cannot be fetched or no longer parses as a listing marks the run `failed`
 *   and logs `watcher.failed` at error level. Items from such a page are not inserted. A page whose item
 *   count drops below half of its last successful count is treated as a shape change too.
 * - Never changes a rate: rates change only through maker–checker proposals.
 * - Freshness alert (ruling 27): last successful run older than 36 h, or a detected notification still
 *   unresolved past 2 business days (Mon–Fri, IST; public holidays are not modelled).
 */
import type { Clock } from '../lib/clock.js';
import { rfc3339 } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { istDate } from '../lib/dates.js';
import type { Repos, TxRunner, WatchedNotificationRow, WatcherRunRow } from '../repositories/types.js';
import type { CbicFetchResult, CbicNotificationItem, CbicPage } from '../adapters/cbicWatcher.js';
import { appendAudit } from './audit.js';

export { keyForText } from '../adapters/cbicWatcher.js';

export const WATCHER_ACTOR = 'system:cbic-watcher';
export const WATCHER_MAX_AGE_HOURS = 36;
export const NOTIFICATION_SLA_BUSINESS_DAYS = 2;
/** a page shrinking below this fraction of its last successful item count is a shape change */
export const SHRINK_RATIO = 0.5;

export interface WatcherLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WatcherSource {
  readonly pages: readonly CbicPage[];
  fetchAll(maxDate?: string): Promise<CbicFetchResult[]>;
}

export interface WatcherDeps {
  tx: TxRunner;
  read: Repos;
  clock: Clock;
  auditKey: string;
  source: WatcherSource;
  log: WatcherLogger;
  /** notifications dated before this (YYYY-MM-DD) are counted but not inserted */
  notBefore: string;
}

export interface PageOutcome {
  url: string;
  series: string;
  ok: boolean;
  error: string | null;
  items: number;
  new: number;
  skipped_old: number;
  malformed: number;
  /** elements the page hid from readers (display:none, hidden): skipped, never queued (SA-C2-08) */
  hidden: number;
}

export interface WatchRunResult {
  run_id: number;
  status: 'ok' | 'failed';
  items_seen: number;
  items_new: number;
  new_keys: string[];
  pages: PageOutcome[];
  error: string | null;
}

function lastGoodCount(prev: WatcherRunRow | null, url: string): number | null {
  const pages = prev?.details['pages'];
  if (!Array.isArray(pages)) return null;
  for (const p of pages as unknown[]) {
    if (p && typeof p === 'object' && (p as { url?: unknown }).url === url && (p as { ok?: unknown }).ok === true) {
      const n = (p as { items?: unknown }).items;
      return typeof n === 'number' ? n : null;
    }
  }
  return null;
}

/** Run the watcher once. Never throws for fetch/parse problems: they produce a `failed` run. */
export async function runCbicWatch(d: WatcherDeps): Promise<WatchRunResult> {
  const started = d.clock.now();
  const maxDate = istDate(new Date(started.getTime() + 2 * 86_400_000));
  let fetched: CbicFetchResult[];
  try {
    fetched = await d.source.fetchAll(maxDate);
  } catch (e) {
    fetched = d.source.pages.map((page) => ({ page, result: { ok: false as const, error: 'network' as const, detail: `unexpected: ${(e as Error).name}` } }));
  }
  const prevOk = d.read.watcherRuns.lastSuccess('cbic');

  const pages: PageOutcome[] = [];
  const accepted: CbicNotificationItem[] = [];
  const errors: string[] = [];
  for (const f of fetched) {
    const o: PageOutcome = { url: f.page.url, series: f.page.series, ok: false, error: null, items: 0, new: 0, skipped_old: 0, malformed: 0, hidden: 0 };
    if (!f.result.ok) {
      o.error = f.result.error;
      o.hidden = f.result.stats?.hidden ?? 0;
      errors.push(`${f.page.url}: ${f.result.detail}`);
    } else {
      o.items = f.result.items.length;
      o.malformed = f.result.stats.malformed;
      o.hidden = f.result.stats.hidden ?? 0;
      const before = lastGoodCount(prevOk, f.page.url);
      if (before !== null && o.items < Math.floor(before * SHRINK_RATIO)) {
        o.error = 'shrunk';
        errors.push(`${f.page.url}: listing shrank from ${before} to ${o.items} items (page layout changed or truncated?)`);
      } else {
        o.ok = true;
        accepted.push(...f.result.items);
      }
    }
    pages.push(o);
  }
  if (fetched.length === 0) errors.push('no watcher pages configured');

  const status: 'ok' | 'failed' = errors.length === 0 ? 'ok' : 'failed';
  const error = errors.length === 0 ? null : errors.join('; ').slice(0, 2000);
  const newKeys: string[] = [];
  const pageOf = new Map<string, PageOutcome>();
  for (const f of fetched) if (f.result.ok) for (const it of f.result.items) pageOf.set(it.key, pages.find((p) => p.url === f.page.url)!);

  const runId = d.tx((repos) => {
    const now = d.clock.now();
    const at = rfc3339(now);
    for (const it of accepted) {
      const po = pageOf.get(it.key);
      if (it.date < d.notBefore) {
        if (po) po.skipped_old++;
        continue;
      }
      // SA-C3-03: a keyed manual row pre-empts this one, but it can only be closed by two admins (route + trigger v7)
      if (repos.watched.byKey(it.key) !== null) continue;
      const pageUrl = po?.url ?? d.source.pages[0]?.url ?? '';
      const row: WatchedNotificationRow = {
        id: newId('wn', now.getTime()),
        notification_ref: it.ref,
        source_url: it.url ?? pageUrl,
        affected_prefixes: [],
        effective_from: null,
        detected_at: at,
        state: 'detected',
        expedite: false,
        note: it.url === null ? 'document link not found on the listing; open the index page' : null,
        created_by: WATCHER_ACTOR,
        resolved_at: null,
        resolved_by: null,
        source: 'cbic_watcher',
        notification_key: it.key,
        title: it.title,
        notification_date: it.date,
      };
      repos.watched.insert(row);
      appendAudit(repos.audit, d.auditKey, {
        at, actor: WATCHER_ACTOR, key_prefix: null, action: 'watched_notification.detected', entity_type: 'watched_notification', entity_id: row.id,
        details: { notification: row.notification_ref, key: it.key, url: row.source_url, date: it.date, title: it.title, listing: pageUrl },
      });
      newKeys.push(it.key);
      if (po) po.new++;
    }
    return repos.watcherRuns.insert({
      source: 'cbic',
      started_at: rfc3339(started),
      finished_at: at,
      status,
      items_seen: accepted.length,
      items_new: newKeys.length,
      error,
      details: { pages, new_keys: newKeys.slice(0, 200) },
    });
  });

  const result: WatchRunResult = { run_id: runId, status, items_seen: accepted.length, items_new: newKeys.length, new_keys: newKeys, pages, error };
  if (status === 'failed') {
    d.log.error({ event: 'watcher.failed', alert: true, run_id: runId, error, pages }, 'CBIC watcher run FAILED: listing could not be fetched or parsed; rates may be stale until fixed');
  } else {
    d.log.info({ event: 'watcher.ok', run_id: runId, items_seen: result.items_seen, items_new: result.items_new }, 'CBIC watcher run ok');
  }
  const hidden = pages.filter((p) => p.hidden > 0);
  if (hidden.length > 0) {
    d.log.warn(
      { event: 'watcher.hidden_rows', alert: true, run_id: runId, pages: hidden.map((p) => ({ url: p.url, hidden: p.hidden })) },
      'CBIC listing contains hidden rows/elements; they were ignored (a defaced page may be trying to pre-claim notification keys)',
    );
  }
  if (newKeys.length > 0) {
    d.log.warn({ event: 'watcher.new_notifications', alert: true, keys: newKeys.slice(0, 50), count: newKeys.length }, 'new CBIC rate notifications detected: triage them (set affected prefixes) and propose rule changes');
  }
  return result;
}

// ---- freshness (ruling 27) ------------------------------------------------------------------------------

const IST_MS = 330 * 60_000;

/** Add n business days (Mon–Fri in IST) to an instant, keeping the IST time of day. */
export function addBusinessDaysIst(instant: Date, n: number): Date {
  let t = instant.getTime();
  let left = n;
  while (left > 0) {
    t += 86_400_000;
    const dow = new Date(t + IST_MS).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(t);
}

export interface FreshnessReport {
  checked_at: string;
  /** finished_at of the last successful watcher run, or null if none */
  sources_checked_at: string | null;
  hours_since_success: number | null;
  watcher_stale: boolean;
  overdue_notifications: { id: string; notification: string; detected_at: string; due_at: string }[];
  alert: boolean;
  reasons: string[];
}

export function computeFreshness(
  now: Date,
  lastSuccessAt: string | null,
  pending: readonly Pick<WatchedNotificationRow, 'id' | 'notification_ref' | 'detected_at'>[],
  opts: { maxAgeHours?: number; slaBusinessDays?: number } = {},
): FreshnessReport {
  const maxAge = opts.maxAgeHours ?? WATCHER_MAX_AGE_HOURS;
  const sla = opts.slaBusinessDays ?? NOTIFICATION_SLA_BUSINESS_DAYS;
  const reasons: string[] = [];
  let hours: number | null = null;
  let stale = true;
  if (lastSuccessAt === null) {
    reasons.push('watcher_never_succeeded');
  } else {
    const ms = Date.parse(lastSuccessAt);
    hours = Number.isFinite(ms) ? Math.round(((now.getTime() - ms) / 3_600_000) * 10) / 10 : null;
    stale = hours === null || hours > maxAge;
    if (stale) reasons.push('watcher_stale');
  }
  const overdue = pending
    .map((w) => ({ id: w.id, notification: w.notification_ref, detected_at: w.detected_at, due_at: rfc3339(addBusinessDaysIst(new Date(w.detected_at), sla)) }))
    .filter((w) => Date.parse(w.due_at) < now.getTime());
  if (overdue.length > 0) reasons.push('notification_unreviewed_past_sla');
  return {
    checked_at: rfc3339(now),
    sources_checked_at: lastSuccessAt,
    hours_since_success: hours,
    watcher_stale: stale,
    overdue_notifications: overdue,
    alert: reasons.length > 0,
    reasons,
  };
}

export function freshnessFromRepos(read: Repos, now: Date): FreshnessReport {
  return computeFreshness(now, read.watcherRuns.lastSuccess('cbic')?.finished_at ?? null, read.watched.pending());
}

/** Log the freshness alert (error level, `alert: true`) when it fires; returns the report. */
export function checkFreshness(read: Repos, clock: Clock, log: WatcherLogger): FreshnessReport {
  const f = freshnessFromRepos(read, clock.now());
  if (f.alert) {
    log.error(
      { event: 'watcher.freshness_alert', alert: true, reasons: f.reasons, sources_checked_at: f.sources_checked_at, hours_since_success: f.hours_since_success, overdue: f.overdue_notifications.slice(0, 20) },
      'freshness alert: CBIC sources not checked within 36 h or a notification is unreviewed past 2 business days',
    );
  }
  return f;
}

/**
 * In-process scheduler behind HSN_WATCHER_ENABLED (default off). Runs once shortly after start, then every
 * `intervalMs`; a run never overlaps the previous one. The timer is unref'd so it never keeps the process up.
 */
export function startWatcherInterval(deps: WatcherDeps, intervalMs: number, firstDelayMs = 30_000): { stop(): void; runNow(): Promise<WatchRunResult | null> } {
  let running: Promise<WatchRunResult> | null = null;
  const tick = async (): Promise<WatchRunResult | null> => {
    if (running) return null;
    running = runCbicWatch(deps);
    try {
      return await running;
    } catch (e) {
      deps.log.error({ event: 'watcher.failed', alert: true, error: (e as Error).name }, 'CBIC watcher run crashed');
      return null;
    } finally {
      running = null;
      try {
        checkFreshness(deps.read, deps.clock, deps.log);
      } catch {
        /* a freshness read failure must not kill the scheduler */
      }
    }
  };
  const first = setTimeout(() => void tick(), firstDelayMs);
  first.unref();
  const every = setInterval(() => void tick(), intervalMs);
  every.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
    runNow: tick,
  };
}
