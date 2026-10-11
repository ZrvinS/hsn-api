# Code, round 2: CBIC notification watcher and `add_code`

Scope: `server/`. This covers two items from the "Not done" list in `code-fix-core-round2.md`:
- the CBIC watcher and `sources_checked_at` (validator items 11 and 25);
- adding HSN codes after the seed.

Result: `tsc --noEmit` is clean and `vitest run` passes **563 of 563** tests in 23 files (it was 529 in 21). The two new test files are `test/watcher.test.ts` (29 tests) and `test/add-code.test.ts` (5 tests).

## 1. CBIC notification watcher

### What it does
1. It fetches the two CBIC index pages from research/sources.md §1.1 and §6.1:
   - `https://cbic-gst.gov.in/central-tax-rate.html`
   - `https://cbic-gst.gov.in/integrated-tax-rate.html`
2. It parses each page into rows of `{series, number, year, date, title, url}`.
3. It queues every notification it has not seen before as a `watched_notifications` row with:
   - state `detected`;
   - `source = 'cbic_watcher'`;
   - `affected_prefixes = []`.

   Each insert writes an audit entry (`watched_notification.detected`, actor `system:cbic-watcher`).
4. It records the run in `watcher_runs`.
5. **It never changes a rate.** Rates still change only through maker–checker proposals.

### Ruling 10 flow
1. The watcher inserts a row in state `detected`. Meta counts it in `untriaged_notifications`.
2. An admin calls `POST /v1/admin/watched-notifications/:id/triage {affected_prefixes, effective_from?}`. The call is audited as `watched_notification.triaged`.
3. Once triaged, the row appears in `/v1/meta/dataset` `pending_notifications[]`. Rate responses for matching codes then carry `pending_change_detected`.
4. The existing `/resolve` route (`published` or `dismissed`) closes the row.

An untriaged row is not listed in `pending_notifications` and does not warn on any code, because its scope is not known yet. It is counted and it drives the freshness alert.

### Files
| File | Purpose |
|---|---|
| `src/adapters/cbicWatcher.ts` | Parser and `CbicWatcherAdapter`. Each page is fetched at most twice per run (one retry on timeout or network error). |
| `src/adapters/httpClient.ts` | New `getText()` and a per-client `textContentTypes` allow-list (see below). |
| `src/services/watcher.ts` | `runCbicWatch`, `computeFreshness`, `checkFreshness`, `addBusinessDaysIst`, `startWatcherInterval`. |
| `src/watcherDeps.ts` | Composition root, shared by `main.ts` and the script. |
| `scripts/watch-cbic.ts` | One run for cron (`npm run watch-cbic`). |
| `src/db/migrations.ts` | Schema v3 as an in-place step on top of `schema.sql` (the v2 base). A v2 database upgrades in place and keeps its data. |
| `src/routes/admin.ts` | New `.../:id/triage` and `GET /v1/admin/watcher/status`. Manual entries now get a `notification_key`; a duplicate returns 409 `duplicate-notification`. |
| `src/routes/meta.ts` | New `sources_checked_at` (finished_at of the last successful run, or null) and `untriaged_notifications`. |
| `test/fixtures/cbic/*.html` | Synthetic pages: CT listing, IT listing with a different layout, SPA redesign, maintenance page, malformed dates. |

### Parser: defensive and fail-closed
**How rows are read**
- The parser is regex-based over at most 256 KiB of text. There is no DOM and nothing is executed.
- Before matching, it removes `<script>`, `<style>`, `<template>`, `<noscript>` and comments. Rows hidden in them do not count; this is tested.
- It is column-agnostic. A row is any `<tr>` whose text holds `<n>/<yyyy>-Central|Integrated|Union Territory Tax (Rate)`. The short forms `CT(Rate)` and `IT(Rate)` are also accepted.
- Dates are read in Indian order (`17.09.2025`, `30-04-2026`) or with a month name (`30th April, 2026`). Impossible dates count as malformed.
- A row whose text says "corrigendum" gets its own key: `…:corrigendum:<date>`.

**When a page fails**

A page is **failed**, never reported as "nothing new", when any of these holds:

| Reason | Condition |
|---|---|
| `not_html` | The response is not HTML. |
| `shape_changed` | The page has no table rows. |
| `no_items` | No notification rows of the page's series. |
| `wrong_series` | The page lists only another series. |
| `too_many_malformed` | More than 20% of matched rows have no usable date. |
| `shrunk` | The page yields fewer than half the items of its last good run. |

A fetch error also fails the page: not allow-listed, blocked address, redirect, non-200 status, wrong content type, too large, or timeout.

**What a failed page does**
- The run is marked `failed`.
- The error is logged at error level: `{"event":"watcher.failed","alert":true,…}`.
- No items from that page are inserted. Items from pages that parsed cleanly are still queued.
- `sources_checked_at` does not move.

**Links**
- A link is kept only if it is https, on the default port, has no credentials, and its host is in `HSN_SOURCE_HOSTS`.
- `javascript:` links and off-list hosts are dropped.
- Links are stored for the reviewer. The server never fetches them.

**Idempotency**
- Identity is `notification_key`, e.g. `central_tax_rate:1/2026`.
- It is checked before insert and backed by a UNIQUE partial index.
- Manual admin entries compute the same key. Whichever comes first, the watcher and an admin never create a duplicate.
- A dismissed notification is not queued again.

**Baseline**
- Notifications dated before `HSN_WATCHER_NOT_BEFORE` are counted but not queued. The default is `2025-09-17`, the date of 9/2025-CT(Rate), which the seed transcribes.
- So the first run in production queues 9/2025–17/2025, 01/2026 and its corrigendum, plus anything newer.
- An admin dismisses the ones the dataset already covers, once.

### Outbound client changes (SSRF items SEC-32..36)
**What changed**
- `OutboundHttpClient` gains `getText()`. It works only on a client built with an exact `textContentTypes` allow-list.
  - The watcher's list is `text/html, application/xhtml+xml`.
  - The OFF/OBF clients have none, so they cannot receive HTML.
  - `getJson` stays JSON-only.
- Charsets accepted: utf-8, us-ascii and latin-1 / windows-1252. Any other charset is `bad_content_type`.

**What is unchanged**
- Exact-host allow-list.
- Private-address refusal through the custom `lookup` hook (no rebinding).
- No redirects.
- Identity encoding only.
- 256 KiB cap.
- 3 s total timeout.
- Circuit breaker.

**Separation from the product lookups**
- The watcher has its own client and its own allow-list (`HSN_WATCHER_HOSTS`). The OFF client cannot reach CBIC, and the watcher cannot reach OFF.
- Watcher page URLs are validated at config load: https, default port, no credentials, a path, and a host in both `HSN_WATCHER_HOSTS` and `HSN_SOURCE_HOSTS`.
- IP-literal watcher hosts are rejected.

Tests run against a local TLS server:
- non-allow-listed host, http, wrong port, credentials and IP literal are refused before any DNS lookup;
- an allow-listed name resolving to 127.0.0.1 is refused with no request made;
- a 302 is not followed;
- a 404 fails;
- a body over 256 KiB fails;
- JSON sent to the watcher fails;
- HTML sent to a JSON client fails;
- utf-16 fails;
- end-to-end fetch → parse → queue works.

### Freshness (00b ruling 27)
`computeFreshness` raises an alert when either of these holds:
- the last successful run is more than **36 h** old, or there has never been a successful run;
- a `detected` notification is still unresolved more than **2 business days** after `detected_at`. Business days are Mon–Fri in IST; public holidays are not modelled.

The result is returned by `GET /v1/admin/watcher/status`:
- freshness, with reasons and the list of overdue notifications;
- the last 10 runs;
- the untriaged count.

`checkFreshness` logs `{"event":"watcher.freshness_alert","alert":true,…}` at error level after every scheduled or cron run. The tests cover the 35 h / 37 h boundary, weekend and IST-midnight business-day arithmetic, and the SLA boundary minute.

## 2. Adding HSN/SAC codes after the seed

New `refdata_change` operation:

```json
{"action":"refdata_change","refdata":{"table":"hsn_code","op":"add_code","code":"71131920","description":"…","keywords":"…","type":"goods"},"rationale":"…"}
```

Validation when the proposal is created:
- The code has 2, 4, 6 or 8 digits, or 5 digits for 99xxx.
- The code does not exist yet.
- The chapter exists.
- The parent is the nearest existing ancestor (8→6→5 (SAC only)→4→2), computed the same way as in the seed. Codes of 6 or 8 digits need at least their 4-digit heading.
- The type matches the chapter: chapter 99 is service, everything else is goods.
- Description is 1–2000 characters.
- No other pending proposal adds the same code.

The payload shows the computed `parent` and `level` to the checker.

On approval (maker ≠ checker, `expected_sha256`, a single transaction):
- the existence and the parent are checked again (otherwise `proposal_stale`);
- the row is inserted with `added_by_proposal`;
- the FTS index updates through the existing trigger;
- the feed gets `hsn_added`;
- a new dataset version is published, and the content hash covers `hsn_codes`;
- an HMAC audit entry records the payload.

DB guard: the `hsn_codes` insert trigger now accepts a post-seed insert only when `added_by_proposal` names an **approved** `refdata_change` proposal whose payload has `op = add_code` and the **same code**. `added_by_proposal` is immutable.

Also fixed: `op: deactivate` on `hsn_code` or `hsn_description` used to fall through to chapter-keyword deactivation. It is now a 400.

## How an operator runs it

**Recommended: cron.** Run every 6 hours (well inside the 36 h window), as the service user, from `server/`, with the same environment as the API (`HSN_DB_PATH`, `HSN_AUDIT_KEY`, `NODE_ENV`, …):

```cron
# m  h        dom mon dow  command
17 */6 * * *  cd /srv/hsn-api/server && set -a && . /etc/hsn-api/env && set +a && npm run --silent watch-cbic >> /var/log/hsn-api/watch-cbic.log 2>&1
```

Exit codes:

| Code | Meaning | Action |
|---|---|---|
| 0 | Run ok, no alert | None. |
| 1 | Configuration error | Fix the configuration. |
| 2 | Run failed (page unreachable or its layout changed) | Page someone. The listing must be checked by hand and the parser fixed. |
| 3 | Run ok, but the freshness alert fires (for example, a notification is unreviewed past 2 business days) | Triage. |

Alert lines are JSON with `"alert": true`. Route `event` = `watcher.failed`, `watcher.freshness_alert` or `watcher.new_notifications` to whatever pages the operator.

**Alternative: in-process.** Set `HSN_WATCHER_ENABLED=true` and optionally `HSN_WATCHER_INTERVAL_MIN` (default 360, range 15–1440).
- The first run happens 30 s after boot.
- Runs never overlap.
- The timer is unref'd and stopped on shutdown.
- Use either this or cron, not both. Both are idempotent, but you would double the outbound requests.

**Daily triage loop for the admin**
1. Check the watcher: `GET /v1/admin/watcher/status`.
2. List open notifications: `GET /v1/admin/watched-notifications`. Untriaged rows have `affected_prefixes: []`.
3. Open the `source_url`. If the note says "document link not found", use the index page.
4. Set the scope: `POST …/:id/triage {"affected_prefixes":["2202"],"effective_from":"YYYY-MM-DD"}`. Clients now see `pending_change_detected`.
5. Transcribe the change as `create`, `supersede` or `correct` proposals, with the PDF sha256 and schedule serial. A second admin approves them.
6. Close the row: `POST …/:id/resolve {"state":"published"}`, or `dismissed` when nothing in the dataset changes.

**Environment variables (all optional)**

| Variable | Default |
|---|---|
| `HSN_WATCHER_ENABLED` | false |
| `HSN_WATCHER_INTERVAL_MIN` | 360 |
| `HSN_WATCHER_HOSTS` | cbic-gst.gov.in, www.cbic-gst.gov.in, taxinformation.cbic.gov.in, www.cbic.gov.in |
| `HSN_WATCHER_CT_RATE_URL` and `HSN_WATCHER_IT_RATE_URL` | The two pages above. An empty value disables that page. |
| `HSN_WATCHER_USER_AGENT` | `hsn-api-watcher/0.1 (rate notification watcher)` |
| `HSN_WATCHER_NOT_BEFORE` | 2025-09-17 |

## Known limits and follow-ups
- **Real pages are unverified.** The real CBIC pages could not be fetched from the sandbox (proxy 403; the smoke run of the script here ends with `dns_error`, exit 2, and the alert line). The fixtures are synthetic. The first production run will show whether the live layout parses.
  - If it does not, the run fails loudly (exit 2). It does not silently return "no new notifications".
  - Add a captured copy of the live page to `test/fixtures/cbic/` when one is available.
- **Size and timeout.** The 256 KiB cap and 3 s timeout are kept as required. A long all-years listing or a slow government host will fail the run (`too_large` / `timeout`).
  - The fix is to point `HSN_WATCHER_*_URL` at a per-year page (it must be on an allow-listed host).
  - Do not raise the cap.
- **No egress proxy.** The hardened client connects directly; it does not use `HTTPS_PROXY`. Production needs direct egress to the watcher hosts.
- **Not watched yet.** Union Territory Tax (Rate) and Compensation Cess (Rate) listings, and the secondary early-warning sources (sources.md §6.2).
  - The parser already understands UTGST references.
  - Adding a page is a config and type change.
- **Business days.** Indian public holidays are not modelled; the SLA uses Mon–Fri.
- **Docs to align:**
  - 05-security-checklist SEC-32 names `src/lib/http.ts`; the module is `src/adapters/httpClient.ts`.
  - SEC-33 should mention the per-adapter allow-lists (`HSN_OUTBOUND_ALLOWLIST`, `HSN_WATCHER_HOSTS`) and the content-type allow-list.
  - The data model and OpenAPI should add `watcher_runs`, the new `watched_notifications` columns, `hsn_codes.added_by_proposal`, the meta fields `sources_checked_at` and `untriaged_notifications`, the two admin routes, and `refdata` `table: hsn_code, op: add_code`.
