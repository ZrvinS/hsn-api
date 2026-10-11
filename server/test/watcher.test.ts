/**
 * CBIC notification watcher (00c ruling 10, 00b ruling 27, research/sources.md §6).
 * Fixtures in test/fixtures/cbic/ are SYNTHETIC: they imitate the shape of the CBIC "Central Tax (Rate)" /
 * "Integrated Tax (Rate)" index pages, which this sandbox cannot reach (proxy 403). Numbers and dates for
 * 2025–2026 follow research/sources.md; subjects are paraphrased and links are illustrative.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  CbicWatcherAdapter, findDate, htmlText, keyForText, parseCbicListing, safeDocumentUrl,
  type CbicFetchResult, type CbicPage,
} from '../src/adapters/cbicWatcher.js';
import { OutboundHttpClient } from '../src/adapters/httpClient.js';
import {
  addBusinessDaysIst, checkFreshness, computeFreshness, runCbicWatch, startWatcherInterval,
  WATCHER_ACTOR, type WatcherDeps, type WatcherLogger, type WatcherSource,
} from '../src/services/watcher.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { migrate, SCHEMA_VERSION, currentSchemaVersion } from '../src/db/migrate.js';
import { bearer, makeEnv, SRC_URL, type TestEnv } from './helpers.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cbic');
const fixture = (name: string) => readFileSync(join(FIX, `${name}.html`), 'utf8');
const HOSTS = ['cbic-gst.gov.in', 'www.cbic-gst.gov.in', 'taxinformation.cbic.gov.in', 'cbic.gov.in', 'www.cbic.gov.in'];
const CT: CbicPage = { url: 'https://cbic-gst.gov.in/central-tax-rate.html', series: 'central_tax_rate' };
const IT: CbicPage = { url: 'https://cbic-gst.gov.in/integrated-tax-rate.html', series: 'integrated_tax_rate' };

// ------------------------------------------------------------------------------------------------ parser

describe('CBIC listing parser', () => {
  it('parses the Central Tax (Rate) table: number, year, date, title, allow-listed link, corrigendum key', () => {
    const r = parseCbicListing(fixture('central-tax-rate'), CT, { linkHosts: HOSTS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => i.key)).toEqual([
      'central_tax_rate:1/2026:corrigendum:2026-05-06', 'central_tax_rate:1/2026', 'central_tax_rate:17/2025', 'central_tax_rate:16/2025',
      'central_tax_rate:15/2025', 'central_tax_rate:10/2025', 'central_tax_rate:9/2025', 'central_tax_rate:2/2017', 'central_tax_rate:1/2017',
    ]);
    const n1 = r.items[1]!;
    expect(n1).toMatchObject({ number: 1, year: 2026, date: '2026-04-30', ref: '01/2026-Central Tax (Rate)', corrigendum: false });
    // relative English link resolved against the page; Hindi link not preferred
    expect(n1.url).toBe('https://cbic-gst.gov.in/pdf/2026/notfctn-01-2026-ctr-eng.pdf');
    expect(n1.title).toBe('Seeks to amend notification No. 9/2025-Central Tax (Rate) so as to re-map tariff items under heading 2202 (beverages)');
    expect(r.items[0]!.ref).toBe('01/2026-Central Tax (Rate) corrigendum dated 2026-05-06');
    // dotted dates, entity decoding, a link on another allow-listed host
    const n9 = r.items.find((i) => i.key === 'central_tax_rate:9/2025')!;
    expect(n9.date).toBe('2025-09-17');
    expect(n9.url).toBe('https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications');
    expect(r.items.find((i) => i.number === 16)!.title).toContain('& exempt');
    // javascript: links and links to hosts outside HSN_SOURCE_HOSTS are dropped (never stored, never fetched)
    expect(r.items.find((i) => i.number === 16)!.url).toBeNull();
    expect(r.items.find((i) => i.number === 15)!.url).toBeNull();
    // rows inside <script> and HTML comments are ignored
    expect(r.items.some((i) => i.number === 98 || i.number === 99)).toBe(false);
    expect(r.stats).toMatchObject({ matched: 9, malformed: 0, foreign: 0 });
  });

  it('parses the Integrated Tax (Rate) page with a different layout (number + "dated 30th April, 2026" in one cell, no </tr>)', () => {
    const r = parseCbicListing(fixture('integrated-tax-rate'), IT, { linkHosts: HOSTS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => [i.key, i.date])).toEqual([
      ['integrated_tax_rate:1/2026', '2026-04-30'],
      ['integrated_tax_rate:9/2025', '2025-09-17'],
      ['integrated_tax_rate:1/2017', '2017-06-28'],
    ]);
    expect(r.items[0]!.url).toBe('https://cbic-gst.gov.in/pdf/igst-rate/notfctn-01-2026-igst-rate-eng.pdf');
    expect(r.items[0]!.title).toBe('Seeks to amend notification No. 9/2025-Integrated Tax (Rate) for beverages of heading 2202');
  });

  it('page-shape change: a JavaScript app shell fails as shape_changed (never "no new notifications")', () => {
    const r = parseCbicListing(fixture('redesigned-spa'), CT, { linkHosts: HOSTS });
    expect(r).toMatchObject({ ok: false, error: 'shape_changed' });
  });

  it('page-shape change: a maintenance page fails as no_items', () => {
    expect(parseCbicListing(fixture('maintenance'), CT, { linkHosts: HOSTS })).toMatchObject({ ok: false, error: 'no_items' });
  });

  it('malformed rows: most dates unusable (missing, "TBD", 31-02) → too_many_malformed', () => {
    const r = parseCbicListing(fixture('malformed-dates'), CT, { linkHosts: HOSTS });
    expect(r).toMatchObject({ ok: false, error: 'too_many_malformed', stats: { matched: 4, malformed: 3 } });
  });

  it('wrong page: a Central Tax (Rate) listing served for the Integrated Tax (Rate) URL → wrong_series', () => {
    expect(parseCbicListing(fixture('central-tax-rate'), IT, { linkHosts: HOSTS })).toMatchObject({ ok: false, error: 'wrong_series' });
  });

  it('not HTML (JSON, plain text, empty) → not_html', () => {
    for (const body of ['{"notifications":[]}', 'Service Unavailable', '']) {
      expect(parseCbicListing(body, CT, { linkHosts: HOSTS })).toMatchObject({ ok: false, error: 'not_html' });
    }
  });

  it('duplicate rows are counted once; implausible future dates are malformed', () => {
    const row = '<tr><td>03/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>Seeks to amend something</td></tr>';
    const html = `<html><table>${row}${row}<tr><td>04/2026-Central Tax (Rate)</td><td>01-10-2026</td><td>x</td></tr></table></html>`;
    const r = parseCbicListing(html, CT, { linkHosts: HOSTS });
    expect(r.ok && r.items.length).toBe(2);
    expect(r.stats.duplicates).toBe(1);
    const future = parseCbicListing(html, CT, { linkHosts: HOSTS, maxDate: '2026-09-30' });
    expect(future).toMatchObject({ ok: false, error: 'too_many_malformed' });
  });

  it('helpers: entities, bidi/zero-width stripping, dates, keys, safe links', () => {
    expect(htmlText('<b>A&amp;B</b>&nbsp;&#x41;&#66;‮​ <i>c</i>')).toBe('A&B AB c');
    expect(findDate('dated 17.09.2025')).toBe('2025-09-17');
    expect(findDate('dated 30 th April, 2026')).toBe('2026-04-30');
    expect(findDate('31-02-2025')).toBeNull();
    expect(keyForText('12/2026-Central Tax (Rate)')).toBe('central_tax_rate:12/2026');
    expect(keyForText('Notification No. 012/2026 - CT(Rate)')).toBe('central_tax_rate:12/2026');
    expect(keyForText('1/2026-Integrated Tax (Rate)')).toBe('integrated_tax_rate:1/2026');
    expect(keyForText('GST Council press release')).toBeNull();
    expect(safeDocumentUrl('pdf/a.pdf', CT.url, HOSTS)).toBe('https://cbic-gst.gov.in/pdf/a.pdf');
    expect(safeDocumentUrl('http://cbic-gst.gov.in/a.pdf', CT.url, HOSTS)).toBeNull();
    expect(safeDocumentUrl('https://user:pw@cbic-gst.gov.in/a.pdf', CT.url, HOSTS)).toBeNull();
    expect(safeDocumentUrl('https://cbic-gst.gov.in:8443/a.pdf', CT.url, HOSTS)).toBeNull();
    expect(safeDocumentUrl('//169.254.169.254/latest', CT.url, HOSTS)).toBeNull();
    expect(safeDocumentUrl('javascript:alert(1)', CT.url, HOSTS)).toBeNull();
    expect(safeDocumentUrl('https://cbic-gst.gov.in.evil.example/a.pdf', CT.url, HOSTS)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ run service

class CaptureLog implements WatcherLogger {
  lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  info(obj: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'info', obj, msg });
  }
  warn(obj: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'warn', obj, msg });
  }
  error(obj: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'error', obj, msg });
  }
  events(level?: string) {
    return this.lines.filter((l) => level === undefined || l.level === level).map((l) => l.obj['event']);
  }
}

/** A source that parses fixture HTML (no network). `pagesHtml` can be swapped between runs. */
function fixtureSource(pagesHtml: Map<string, string | Error>): WatcherSource {
  const pages = [CT, IT];
  return {
    pages,
    async fetchAll(maxDate?: string): Promise<CbicFetchResult[]> {
      return pages.map((page) => {
        const body = pagesHtml.get(page.url);
        if (body === undefined || body instanceof Error) return { page, result: { ok: false, error: 'network', detail: 'fetch failed: network' } };
        const r = parseCbicListing(body, page, { linkHosts: HOSTS, ...(maxDate ? { maxDate } : {}) });
        return { page, result: r.ok ? { ok: true, items: r.items, stats: r.stats } : { ok: false, error: r.error, detail: r.detail } };
      });
    },
  };
}

function deps(env: TestEnv, source: WatcherSource, log: WatcherLogger): WatcherDeps {
  return { tx: env.storage.tx, read: env.storage.write, clock: env.clock, auditKey: env.config.auditKey.reveal(), source, log, notBefore: '2025-09-17' };
}

const adminGet = (env: TestEnv, url: string) => env.admin.inject({ method: 'GET', url, headers: bearer(env.keys['amit']!) });
const adminPost = (env: TestEnv, key: string, url: string, payload: object) => env.admin.inject({ method: 'POST', url, headers: bearer(env.keys[key]!), payload });
const readGet = (env: TestEnv, url: string) => env.app.inject({ method: 'GET', url, headers: bearer(env.keys['read']!) });

describe('CBIC watcher run', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.close());

  it('first run queues every notification dated on/after HSN_WATCHER_NOT_BEFORE as detected (no prefixes yet), audits it, records the run; never touches rates', async () => {
    const rulesBefore = env.storage.writeDb.prepare('SELECT COUNT(*) AS n FROM rate_rules').get() as { n: number };
    const versionBefore = env.storage.read.dataset.current()?.current_version;
    const log = new CaptureLog();
    const html = new Map<string, string | Error>([[CT.url, fixture('central-tax-rate')], [IT.url, fixture('integrated-tax-rate')]]);
    const res = await runCbicWatch(deps(env, fixtureSource(html), log));
    expect(res.status).toBe('ok');
    expect(res.items_seen).toBe(12);
    // 7 CT items ≥ 2025-09-17 (incl. the corrigendum) + 2 IT items; 2017 items are skipped as old
    expect(res.items_new).toBe(9);
    expect(res.pages.map((p) => [p.series, p.items, p.new, p.skipped_old])).toEqual([
      ['central_tax_rate', 9, 7, 2],
      ['integrated_tax_rate', 3, 2, 1],
    ]);
    const pending = env.storage.read.watched.pending();
    expect(pending).toHaveLength(9);
    const n1 = pending.find((w) => w.notification_key === 'central_tax_rate:1/2026')!;
    expect(n1).toMatchObject({
      state: 'detected', source: 'cbic_watcher', affected_prefixes: [], created_by: WATCHER_ACTOR, notification_date: '2026-04-30',
      source_url: 'https://cbic-gst.gov.in/pdf/2026/notfctn-01-2026-ctr-eng.pdf', notification_ref: '01/2026-Central Tax (Rate)',
    });
    // no document link on the listing → the index page is stored instead, with a note for the reviewer
    const n16 = pending.find((w) => w.notification_key === 'central_tax_rate:16/2025')!;
    expect(n16.source_url).toBe(CT.url);
    expect(n16.note).toMatch(/link not found/);
    const audit = env.storage.read.audit.all().filter((a) => a.actor === WATCHER_ACTOR);
    expect(audit).toHaveLength(9);
    expect(audit.every((a) => a.action === 'watched_notification.detected')).toBe(true);
    expect(log.events('warn')).toContain('watcher.new_notifications');
    expect(log.events('error')).toEqual([]);
    // rates untouched
    expect(env.storage.writeDb.prepare('SELECT COUNT(*) AS n FROM rate_rules').get()).toEqual(rulesBefore);
    expect(env.storage.read.dataset.current()?.current_version).toBe(versionBefore);
    // meta: sources_checked_at = this run; untriaged rows are counted, not listed as client-facing pending changes
    const meta = (await readGet(env, '/v1/meta/dataset')).json();
    expect(meta.sources_checked_at).toBe(env.storage.read.watcherRuns.lastSuccess('cbic')!.finished_at);
    expect(meta.untriaged_notifications).toBe(9);
    expect(meta.pending_notifications).toEqual([]);
    // an untriaged notification does not yet warn on any code
    expect((await readGet(env, '/v1/hsn/2202')).statusCode).toBe(404);
    expect((await readGet(env, '/v1/hsn/7113')).json().rate.warnings).not.toContain('pending_change_detected');
  });

  it('duplicate run is idempotent; a newly listed notification is the only insert', async () => {
    const html = new Map<string, string | Error>([[CT.url, fixture('central-tax-rate')], [IT.url, fixture('integrated-tax-rate')]]);
    const again = await runCbicWatch(deps(env, fixtureSource(html), new CaptureLog()));
    expect(again).toMatchObject({ status: 'ok', items_new: 0, items_seen: 12 });
    const newRow = '<tr><td>0</td><td>02/2026-Central Tax (Rate)</td><td>05-10-2026</td><td>Seeks to amend notification No. 9/2025-Central Tax (Rate) (illustrative test row)</td><td><a href="pdf/2026/notfctn-02-2026-ctr-eng.pdf">English</a></td></tr>';
    html.set(CT.url, fixture('central-tax-rate').replace('<tbody>', `<tbody>\n${newRow}`));
    const third = await runCbicWatch(deps(env, fixtureSource(html), new CaptureLog()));
    expect(third.items_new).toBe(1);
    expect(third.new_keys).toEqual(['central_tax_rate:2/2026']);
    expect(env.storage.read.watched.pending()).toHaveLength(10);
    // the DB enforces the identity too
    const row = env.storage.read.watched.byKey('central_tax_rate:2/2026')!;
    expect(() => env.storage.write.watched.insert({ ...row, id: 'wn_01J0000000000000000000000Z' })).toThrow();
  });

  it('admin triage sets affected prefixes → pending_notifications + pending_change_detected (ruling 10); resolve clears it; resolved rows are frozen', async () => {
    const row = env.storage.read.watched.byKey('central_tax_rate:2/2026')!;
    // SA-C3-03: the first triage of a watcher row is requested by one admin and confirmed by another
    const r = await adminPost(env, 'amit', `/v1/admin/watched-notifications/${row.id}/triage`, { affected_prefixes: ['7113'], effective_from: '2026-11-01' });
    expect(r.statusCode).toBe(202);
    expect((await readGet(env, '/v1/meta/dataset')).json().pending_notifications).toEqual([]);
    const t = await adminPost(env, 'priya', `/v1/admin/watched-notifications/${row.id}/triage`, { affected_prefixes: ['7113'], effective_from: '2026-11-01' });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ affected_prefixes: ['7113'], effective_from: '2026-11-01', source: 'cbic_watcher', notification_key: 'central_tax_rate:2/2026', notification_date: '2026-10-05' });
    const meta = (await readGet(env, '/v1/meta/dataset')).json();
    expect(meta.pending_notifications.map((p: { notification: string }) => p.notification)).toEqual(['02/2026-Central Tax (Rate)']);
    expect(meta.untriaged_notifications).toBe(9);
    expect((await readGet(env, '/v1/hsn/71131910')).json().rate.warnings).toContain('pending_change_detected');
    expect((await readGet(env, '/v1/hsn/6109')).json().rate.warnings).not.toContain('pending_change_detected');
    expect(env.storage.read.audit.all().at(-1)).toMatchObject({ action: 'watched_notification.triaged', actor: 'priya', entity_id: row.id, details: { requested_by: 'amit', confirmed_by: 'priya' } });
    // identity fields stay immutable even while detected
    expect(() => env.storage.writeDb.prepare('UPDATE watched_notifications SET notification_key = ? WHERE id = ?').run('x:1/2026', row.id)).toThrow();
    expect(() => env.storage.writeDb.prepare('UPDATE watched_notifications SET title = ? WHERE id = ?').run('changed', row.id)).toThrow();
    // bad input
    expect((await adminPost(env, 'amit', `/v1/admin/watched-notifications/${row.id}/triage`, { affected_prefixes: ['123'] })).statusCode).toBe(400);
    expect((await adminPost(env, 'amit', `/v1/admin/watched-notifications/${row.id}/triage`, { affected_prefixes: [] })).statusCode).toBe(400);
    // SA-C2-03: dismissing a watcher row takes two admins (priya requests → 202, amit confirms → 200)
    const req = await adminPost(env, 'priya', `/v1/admin/watched-notifications/${row.id}/resolve`, { state: 'dismissed' });
    expect(req.statusCode).toBe(202);
    expect(req.json()).toMatchObject({ state: 'detected', pending_action: { kind: 'dismissed', by: 'priya' } });
    const res = await adminPost(env, 'amit', `/v1/admin/watched-notifications/${row.id}/resolve`, { state: 'dismissed' });
    expect(res.statusCode).toBe(200);
    expect((await readGet(env, '/v1/hsn/7113')).json().rate.warnings).not.toContain('pending_change_detected');
    expect((await adminPost(env, 'amit', `/v1/admin/watched-notifications/${row.id}/triage`, { affected_prefixes: ['6109'] })).statusCode).toBe(404);
    expect(() => env.storage.writeDb.prepare("UPDATE watched_notifications SET affected_prefixes = '[\"6109\"]' WHERE id = ?").run(row.id)).toThrow();
    // a dismissed notification is not re-queued by the next run
    const html = new Map<string, string | Error>([[CT.url, fixture('central-tax-rate').replace('<tbody>', '<tbody><tr><td>02/2026-Central Tax (Rate)</td><td>05-10-2026</td><td>again</td></tr>')], [IT.url, fixture('integrated-tax-rate')]]);
    expect((await runCbicWatch(deps(env, fixtureSource(html), new CaptureLog()))).items_new).toBe(0);
  });

  it('a manual entry and the watcher share one identity: no duplicate either way', async () => {
    const m = await adminPost(env, 'amit', '/v1/admin/watched-notifications', { notification: '05/2026-Central Tax (Rate)', url: SRC_URL, affected_prefixes: ['6109'] });
    expect(m.statusCode).toBe(201);
    expect(m.json()).toMatchObject({ source: 'manual', notification_key: 'central_tax_rate:5/2026' });
    const html = new Map<string, string | Error>([[CT.url, fixture('central-tax-rate').replace('<tbody>', '<tbody><tr><td>5/2026-Central Tax (Rate)</td><td>07-10-2026</td><td>Seeks to amend (illustrative)</td></tr>')], [IT.url, fixture('integrated-tax-rate')]]);
    expect((await runCbicWatch(deps(env, fixtureSource(html), new CaptureLog()))).items_new).toBe(0);
    const dup = await adminPost(env, 'priya', '/v1/admin/watched-notifications', { notification: 'Notification No. 5/2026-CT(Rate)', url: SRC_URL, affected_prefixes: ['6109'] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().type).toMatch(/duplicate-notification/);
  });

  it('page-shape change on one page → run FAILED with an alert log; the other page still queues; sources_checked_at does not move', async () => {
    const lastOk = env.storage.read.watcherRuns.lastSuccess('cbic')!;
    env.clock.advance(3_600_000);
    const log = new CaptureLog();
    const extra = '<tr><td>03/2026-Integrated Tax (Rate)</td><td>08-10-2026</td><td>Seeks to amend (illustrative)</td></tr>';
    const html = new Map<string, string | Error>([[CT.url, fixture('redesigned-spa')], [IT.url, fixture('integrated-tax-rate').replace('</table>', `${extra}</table>`)]]);
    const res = await runCbicWatch(deps(env, fixtureSource(html), log));
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/central-tax-rate\.html: no table rows found/);
    expect(res.pages[0]).toMatchObject({ ok: false, error: 'shape_changed', new: 0 });
    expect(res.new_keys).toEqual(['integrated_tax_rate:3/2026']);
    const alert = log.lines.find((l) => l.obj['event'] === 'watcher.failed')!;
    expect(alert.level).toBe('error');
    expect(alert.obj['alert']).toBe(true);
    expect(env.storage.read.watcherRuns.last('cbic')).toMatchObject({ status: 'failed', items_new: 1 });
    expect(env.storage.read.watcherRuns.lastSuccess('cbic')!.id).toBe(lastOk.id);
    expect((await readGet(env, '/v1/meta/dataset')).json().sources_checked_at).toBe(lastOk.finished_at);
  });

  it('unreachable page and a listing that shrinks to under half of its last good size both fail the run', async () => {
    const down = await runCbicWatch(deps(env, fixtureSource(new Map([[IT.url, fixture('integrated-tax-rate')]])), new CaptureLog()));
    expect(down.status).toBe('failed');
    expect(down.pages[0]).toMatchObject({ ok: false, error: 'network' });
    const shrunk = fixture('central-tax-rate').replace(/<tr>\s*<td>[3-9]<\/td>[\s\S]*?<\/tr>/g, '');
    const parsed = parseCbicListing(shrunk, CT, { linkHosts: HOSTS });
    expect(parsed.ok && parsed.items.length).toBe(2);
    const res = await runCbicWatch(deps(env, fixtureSource(new Map([[CT.url, shrunk], [IT.url, fixture('integrated-tax-rate')]])), new CaptureLog()));
    expect(res.status).toBe('failed');
    expect(res.pages[0]).toMatchObject({ ok: false, error: 'shrunk' });
    expect(res.error).toMatch(/shrank from 1\d to 2/);
  });

  it('watcher runs are append-only', () => {
    expect(() => env.storage.writeDb.exec("UPDATE watcher_runs SET status = 'ok'")).toThrow();
    expect(() => env.storage.writeDb.exec('DELETE FROM watcher_runs')).toThrow();
  });

  it('GET /v1/admin/watcher/status reports runs and freshness; the interval scheduler never overlaps runs', async () => {
    const s = await adminGet(env, '/v1/admin/watcher/status');
    expect(s.statusCode).toBe(200);
    const body = s.json();
    expect(body.last_run.status).toBe('failed');
    expect(body.recent_runs.length).toBeGreaterThanOrEqual(5);
    expect(body.freshness.sources_checked_at).toBe(env.storage.read.watcherRuns.lastSuccess('cbic')!.finished_at);
    expect(body.freshness.watcher_stale).toBe(false);
    expect(body.untriaged).toBeGreaterThan(0);
    expect((await env.app.inject({ method: 'GET', url: '/v1/admin/watcher/status', headers: bearer(env.keys['amit']!) })).statusCode).toBe(404);

    let calls = 0;
    let release: () => void = () => {};
    const slow: WatcherSource = {
      pages: [CT],
      fetchAll: () => {
        calls++;
        return new Promise((r) => {
          release = () => r([{ page: CT, result: { ok: false, error: 'timeout', detail: 'slow' } }]);
        });
      },
    };
    const log = new CaptureLog();
    const sched = startWatcherInterval(deps(env, slow, log), 3_600_000, 3_600_000);
    const first = sched.runNow();
    expect(await sched.runNow()).toBeNull(); // overlapping tick is skipped
    release();
    expect((await first)?.status).toBe('failed');
    sched.stop();
    expect(calls).toBe(1);
    expect(log.events('error')).toContain('watcher.failed');
  });
});

// ------------------------------------------------------------------------------------------------ freshness

describe('freshness (00b ruling 27)', () => {
  const at = (s: string) => new Date(s);
  it('watcher: never succeeded → alert; 35 h → fresh; 37 h → stale', () => {
    expect(computeFreshness(at('2026-10-10T06:00:00Z'), null, [])).toMatchObject({ alert: true, reasons: ['watcher_never_succeeded'], sources_checked_at: null });
    expect(computeFreshness(at('2026-10-10T06:00:00Z'), '2026-10-08T19:00:00Z', [])).toMatchObject({ alert: false, watcher_stale: false, hours_since_success: 35 });
    expect(computeFreshness(at('2026-10-10T06:00:00Z'), '2026-10-08T17:00:00Z', [])).toMatchObject({ alert: true, watcher_stale: true, reasons: ['watcher_stale'], hours_since_success: 37 });
  });

  it('business days are Mon–Fri in IST: Friday 10:00 IST + 2 → Tuesday 10:00 IST; a Saturday-IST evening (Friday UTC) counts from Saturday', () => {
    // 2026-10-09 is a Friday. 04:30Z = 10:00 IST
    expect(addBusinessDaysIst(at('2026-10-09T04:30:00Z'), 2).toISOString()).toBe('2026-10-13T04:30:00.000Z');
    // Friday 20:00Z = Saturday 01:30 IST → Monday (1), Tuesday (2) 01:30 IST = Monday 20:00Z
    expect(addBusinessDaysIst(at('2026-10-09T20:00:00Z'), 2).toISOString()).toBe('2026-10-12T20:00:00.000Z');
    // Monday + 2 → Wednesday
    expect(addBusinessDaysIst(at('2026-10-12T04:30:00Z'), 2).toISOString()).toBe('2026-10-14T04:30:00.000Z');
  });

  it('a detected notification unreviewed past 2 business days raises the alert; not before', () => {
    const p = [{ id: 'wn_X', notification_ref: '02/2026-Central Tax (Rate)', detected_at: '2026-10-09T04:30:00Z' }];
    const ok = '2026-10-12T22:00:00Z';
    expect(computeFreshness(at('2026-10-12T23:00:00Z'), ok, p)).toMatchObject({ alert: false, overdue_notifications: [] });
    const late = computeFreshness(at('2026-10-13T04:31:00Z'), '2026-10-13T00:00:00Z', p);
    expect(late.alert).toBe(true);
    expect(late.reasons).toEqual(['notification_unreviewed_past_sla']);
    expect(late.overdue_notifications[0]).toMatchObject({ id: 'wn_X', due_at: '2026-10-13T04:30:00Z' });
  });

  it('checkFreshness logs an error-level alert line only when the alert fires', async () => {
    const env = await makeEnv();
    try {
      const log = new CaptureLog();
      expect(checkFreshness(env.storage.read, env.clock, log).alert).toBe(true); // never ran
      expect(log.lines[0]).toMatchObject({ level: 'error', obj: { event: 'watcher.freshness_alert', alert: true } });
      const html = new Map<string, string | Error>([[CT.url, fixture('central-tax-rate').replace(/<tr>\s*<td>[1-7]<\/td>[\s\S]*?<\/tr>/g, '')], [IT.url, fixture('integrated-tax-rate').replace(/<tr><td><a href="\/pdf\/igst-rate\/notfctn-0[19]-202[56][\s\S]*?(?=<tr>)/g, '')]]);
      const res = await runCbicWatch(deps(env, fixtureSource(html), new CaptureLog()));
      expect(res).toMatchObject({ status: 'ok', items_new: 0 });
      const quiet = new CaptureLog();
      expect(checkFreshness(env.storage.read, env.clock, quiet).alert).toBe(false);
      expect(quiet.lines).toEqual([]);
      env.clock.advance(37 * 3_600_000);
      expect(checkFreshness(env.storage.read, env.clock, quiet).reasons).toEqual(['watcher_stale']);
    } finally {
      await env.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ SSRF / client

describe('watcher outbound client (SSRF, SEC-33..36)', () => {
  const HOST = 'cbic-gst.gov.in';
  let dir = '';
  let cert = '';
  let server: https.Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hsn-cbic-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
      '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const key = readFileSync(join(dir, 'key.pem'), 'utf8');
    server = https.createServer({ key, cert }, (req, res) => {
      const path = req.url ?? '/';
      hits.push(path);
      if (path === '/central-tax-rate.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
        res.end(fixture('central-tax-rate'));
      } else if (path === '/integrated-tax-rate.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(fixture('integrated-tax-rate'));
      } else if (path === '/json.html') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (path === '/redirect.html') {
        res.writeHead(302, { location: 'https://127.0.0.1/central-tax-rate.html', 'content-type': 'text/html' });
        res.end('<html></html>');
      } else if (path === '/big.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        const chunk = '<tr><td>x</td></tr>'.repeat(1000);
        for (let i = 0; i < 20; i++) res.write(chunk);
        res.end();
      } else if (path === '/utf16.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-16' });
        res.end('<html></html>');
      } else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>not found</html>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const local = { resolver: async () => [{ address: '127.0.0.1', family: 4 as const }], isAddressAllowed: () => true, get port() { return port; }, get ca() { return cert; } };
  const adapter = (pages: CbicPage[], testOnly: object = { resolver: local.resolver, isAddressAllowed: local.isAddressAllowed, port, ca: cert }) =>
    new CbicWatcherAdapter({ pages, allowlist: [HOST], linkHosts: HOSTS, userAgent: 'hsn-api-watcher/test', testOnly: testOnly as never });

  it('end to end over TLS: fetch HTML via the hardened client, parse, queue', async () => {
    const env = await makeEnv();
    try {
      const a = adapter([{ url: `https://${HOST}:${port}/central-tax-rate.html`, series: 'central_tax_rate' }, { url: `https://${HOST}:${port}/integrated-tax-rate.html`, series: 'integrated_tax_rate' }]);
      const res = await runCbicWatch({ ...deps(env, a, new CaptureLog()) });
      expect(res).toMatchObject({ status: 'ok', items_seen: 12, items_new: 9 });
    } finally {
      await env.close();
    }
  });

  it('refuses page hosts outside the watcher allow-list at construction (no socket, no DNS)', () => {
    expect(() => new CbicWatcherAdapter({ pages: [{ url: 'https://169.254.169.254/latest/meta-data', series: 'central_tax_rate' }], allowlist: [HOST], linkHosts: HOSTS, userAgent: 'x/1' })).toThrow(/allow-list/);
    expect(() => new CbicWatcherAdapter({ pages: [{ url: 'https://evil.example/central-tax-rate.html', series: 'central_tax_rate' }], allowlist: [HOST], linkHosts: HOSTS, userAgent: 'x/1' })).toThrow(/allow-list/);
  });

  it('the client refuses non-allow-listed hosts, http, other ports and credentials without resolving DNS', async () => {
    let resolved = 0;
    const c = new OutboundHttpClient({
      allowlist: [HOST], userAgent: 'x/1', textContentTypes: ['text/html'],
      testOnly: { resolver: async () => { resolved++; return [{ address: '127.0.0.1', family: 4 }]; }, isAddressAllowed: () => true, port, ca: cert },
    });
    for (const u of ['https://evil.example/a.html', 'http://cbic-gst.gov.in/a.html', 'https://cbic-gst.gov.in:8443/a.html', `https://u:p@${HOST}:${port}/a.html`, 'https://127.0.0.1/a.html', 'https://[::1]/a.html']) {
      const r = await c.getText(u);
      expect(r.ok).toBe(false);
      expect(['host_not_allowed', 'bad_url']).toContain(!r.ok && r.error);
    }
    expect(resolved).toBe(0);
  });

  it('an allow-listed name that resolves to a private address is refused (DNS rebinding)', async () => {
    const before = hits.length;
    const a = adapter([{ url: `https://${HOST}:${port}/central-tax-rate.html`, series: 'central_tax_rate' }], { resolver: local.resolver, port, ca: cert });
    const [r] = await a.fetchAll();
    expect(r!.result).toMatchObject({ ok: false, error: 'blocked_address' });
    expect(hits.length).toBe(before);
  });

  it('content-type allow-list per adapter: JSON to the HTML watcher fails; HTML to a JSON client fails; getText without an allow-list fails', async () => {
    const a = adapter([{ url: `https://${HOST}:${port}/json.html`, series: 'central_tax_rate' }]);
    expect((await a.fetchAll())[0]!.result).toMatchObject({ ok: false, error: 'bad_content_type' });
    const json = new OutboundHttpClient({ allowlist: [HOST], userAgent: 'x/1', testOnly: { resolver: local.resolver, isAddressAllowed: () => true, port, ca: cert } });
    expect(await json.getJson(`https://${HOST}:${port}/central-tax-rate.html`)).toMatchObject({ ok: false, error: 'bad_content_type' });
    expect(await json.getText(`https://${HOST}:${port}/central-tax-rate.html`)).toMatchObject({ ok: false, error: 'bad_content_type' });
    const utf16 = adapter([{ url: `https://${HOST}:${port}/utf16.html`, series: 'central_tax_rate' }]);
    expect((await utf16.fetchAll())[0]!.result).toMatchObject({ ok: false, error: 'bad_content_type' });
    expect(() => new OutboundHttpClient({ allowlist: [HOST], userAgent: 'x/1', textContentTypes: ['text/html; charset=x'] })).toThrow(/media type/);
  });

  it('redirects are not followed, 404 is a failure, the 256 KiB cap still applies', async () => {
    const before = hits.length;
    const r = await adapter([{ url: `https://${HOST}:${port}/redirect.html`, series: 'central_tax_rate' }]).fetchAll();
    expect(r[0]!.result).toMatchObject({ ok: false, error: 'redirect', status: 302 });
    expect(hits.length).toBe(before + 1);
    expect((await adapter([{ url: `https://${HOST}:${port}/missing.html`, series: 'central_tax_rate' }]).fetchAll())[0]!.result).toMatchObject({ ok: false, error: 'http_status', status: 404 });
    expect((await adapter([{ url: `https://${HOST}:${port}/big.html`, series: 'central_tax_rate' }]).fetchAll())[0]!.result).toMatchObject({ ok: false, error: 'too_large' });
  });

  it('config: watcher URLs must be https on a host in both HSN_WATCHER_HOSTS and HSN_SOURCE_HOSTS; defaults are the CBIC pages, interval off', () => {
    const base = { NODE_ENV: 'test', HSN_DB_PATH: ':memory:' };
    const c = loadConfig(base);
    expect(c.watcher.enabled).toBe(false);
    expect(c.watcher.pages.map((p) => p.url)).toEqual(['https://cbic-gst.gov.in/central-tax-rate.html', 'https://cbic-gst.gov.in/integrated-tax-rate.html']);
    expect(c.watcher.hosts).toContain('taxinformation.cbic.gov.in');
    expect(() => loadConfig({ ...base, HSN_WATCHER_CT_RATE_URL: 'https://evil.example/central-tax-rate.html' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HSN_WATCHER_CT_RATE_URL: 'http://cbic-gst.gov.in/central-tax-rate.html' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HSN_WATCHER_HOSTS: 'cbic-gst.gov.in,169.254.169.254' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, HSN_WATCHER_IT_RATE_URL: '' }).watcher.pages).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ migration

describe('schema migration v2 → v3', () => {
  it('upgrades a version-2 database in place, keeping rows (watched notifications default to source manual)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON;');
    const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'schema.sql'), 'utf8');
    db.exec(schema);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)').run('2026-10-01T00:00:00Z');
    db.prepare("INSERT INTO watched_notifications(id, notification_ref, source_url, affected_prefixes, detected_at, created_by) VALUES ('wn_01J0000000000000000000000A', '12/2026-Central Tax (Rate)', ?, '[\"7113\"]', '2026-10-01T00:00:00Z', 'amit')").run(SRC_URL);
    expect(currentSchemaVersion(db)).toBe(2);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3); // v4 (core round 3) builds on it
    expect(db.prepare('SELECT source, notification_key FROM watched_notifications').get()).toEqual({ source: 'manual', notification_key: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'watcher_runs'").get()).toEqual({ n: 1 });
    expect(migrate(db)).toBe(SCHEMA_VERSION); // idempotent
    db.close();
  });
});
