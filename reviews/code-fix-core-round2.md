# Code fixes, core, round 2

Scope: `server/` outside `src/classify/` and `src/adapters/`. `src/routes/classify.ts` is owned by the classify worker; I did not edit it. It already passes `rule_hint`, `keyId` and `scoring`.

Inputs:
- `docs/00c-coordinator-rulings-round2.md` (parts A and B);
- `reviews/security-code-core-round1.md` (SA-C-01..20);
- `reviews/validator-docs-round1.md` (the items that need code);
- the coordinator's later addition: an admin purge of a cached product (SA-K-03 remainder).

Result: `tsc --noEmit` is clean. `vitest run` passes 529 of 529 tests in 21 files (round 1 had 350).

New test files:
- `test/rulings-round2.test.ts`: test names start with "ruling N".
- `test/security-core-round2.test.ts`: test names start with "SA-C-NN".

Existing tests in admin, auth, seed, rates, tax, feed and security were updated for the new behaviour. Their ids are in their names where relevant.

## Rulings (00c)

| # | Change | Test(s) |
|---|---|---|
| 1 | New `correct` action. It voids the target (`status='voided'`, `voided_at`, `voided_in_version`, `voided_by_rule`) and inserts the replacement in the same transaction. Feed type `rule_corrected` carries `rule_id` and `related_rule_id`. Voided rules are excluded from resolution and are immutable (trigger). Files: `services/proposals.ts`, `schema.sql`, `repositories/sqlite/rateRules.ts`. | ruling 1: correct → target voided (kept), replacement live, rule_corrected carries both ids |
| 2 | Classifier only (classify worker). | n/a |
| 3 | `change_feed.affected_prefix` is set on every change. `prefixRelated()` matches in both directions; it is also used for the pending-change warning. | ruling 3: prefixRelated matches both directions; ruling 3: each change carries affected_prefix… |
| 4 | `makeEtag(dataset_version, resolved as-of IST date, body)` gives 16 hex. Lookup `max-age` is `min(3600, seconds to next IST midnight)`. Files: `lib/etag.ts`, `routes/common.ts`. | ruling 4: same dataset, clock crosses IST midnight → new ETag…; ruling 4: secondsUntilNextIstMidnight |
| 5 | Fixture 3004 now has a general 5% rule plus an `other` 0% rule with `condition_code='nil_rate_list'`. Resolution: `coverage='ambiguous'`, `default_rule_id` = the general rule. `resolve(…, {conditionCode})` selects the hinted rule (warning `selected_by_hint`). Tax accepts `rule_id` or `condition:"general"` on a line; without one the line gets `needs_input: ['rule_id']`; a bad choice returns 422 `rule_choice_invalid`. `synonyms.rule_hint` added. | ruling 5 (three tests) |
| 6 | Codes and prefixes may be 2, 4, 6 or 8 digits, or 5 digits for `99xxx`. Applied in the schema CHECKs, seed, routes and `RULE_PREFIX_RE`. `parentOf` also tries length 5. Fixtures added: 9997, 99972 (rule), 999721. | ruling 6: 99972 is a valid code…; seed: ruling 6 / SA-C-14 |
| 7 | `parseQuantity` accepts at most 3 decimals and returns `qty_milli`. `deriveUnitPricePaise = roundHalfUp(taxable×1000, qty_milli)`. `line_id` defaults to the zero-based index. `igst_rate_bp` is in the tax line. | ruling 7 (two tests); tax: money parsing |
| 8 | New `idempotency_keys` table (key_id, idem_key, route, request_sha256, status, response_json, created_at; 24 h TTL), written inside the write transaction. A replay returns the stored response. Any other approve or reject of a non-pending proposal returns 409 (validator item 21). | ruling 8: stored per key…; admin: idempotency…; admin: re-approving with the same Idempotency-Key replays… |
| 9 | `reverify_due_at = last_verified_at + 12 months`. New warning `verification_overdue`. Meta gains `rate_rules_verification_overdue`. `verify` on a verified rule moves `last_verified_at` forward only. | ruling 9 (two tests) |
| 10 | `watched_notifications` table and admin routes: GET, POST and `:id/resolve`. Meta gains `pending_notifications[]`; rate responses get the warning `pending_change_detected`. | ruling 10: a detected notification shows in meta… |
| 11 | Meta `content_sha256` (and `sha256`). The hash covers rules and active reference data. | ruling 11: …changes when reference data changes; feed: reports version, hash… |
| 12 | Rules and proposals carry `source_pdf_sha256` and `schedule_serial`. Both are required for create, supersede, correct and verify; they are nullable on the seed path. | ruling 12; admin: verify action…; seed: ruling 12 |
| 13 | `coverage` (ok, no_rate_rule, ambiguous) and `default_rule_id` are required in the response schema. | ruling 13 |
| 14 | Headers `RateLimit-Limit` (600), `-Remaining` (tokens), `-Reset`, `-Cost` and `-Policy` (`600;w=60;burst=100`). | ruling 14; auth: valid key → 200 with RateLimit headers |
| 15 | `supply_type: intra_ut` returns CGST + UTGST; every amounts object now includes `utgst`. | ruling 15 |
| 16 | Docs only. | n/a |
| 17 | `admin_actors` table with handles normalised by NFKC, lower-casing and `[a-z0-9_-]{3,32}`. Admin keys carry `actor_id`, and maker ≠ checker compares `actor_id`. `bootstrapAdmins` creates two actors once and audits it (`scripts/bootstrap-admins.ts`). After that, a new actor or admin key needs an approved `admin_grant` from a different admin; a grant covers a single key (UNIQUE `admin_grant_id`, enforced by a trigger). | ruling 17 (two tests); admin: same actor cannot approve… |
| 18 | The audit chain is an HMAC chain keyed by `HSN_AUDIT_KEY`. Approval entries include the full rule and `rule_sha256`. New `services/auditExport.ts` and the scripts `export-audit-head.ts` and `verify-audit.ts` (the export has its own MAC). `/admin/audit` returns `head_id` and `head_hash`. | ruling 18 (three tests); admin: audit hash chain |
| 19 | Triggers (listed in full in my round-2 notes):<br>• rule insert needs an approved proposal that names it, or the seed batch of an empty database;<br>• `verified_by`, `superseded_by`, `effective_to`, the PDF sha and the serial are set once;<br>• `last_verified_at` only moves forward;<br>• terminal proposals are immutable, and proposal content never changes;<br>• `dataset_state` only moves forward;<br>• version stats are written once. | ruling 19 (three tests); admin: integrity triggers |
| 20 | `expected_sha256` (= `content_sha256`) is required on approve and reject. `target_sha256` binds the target rule: a stale target gives 409 `proposal_stale`. The DTO includes a summary of the target rule. There is no bulk approve and no key cache. | ruling 20 (two tests); admin: approval requires…; auth: revoked key → 401 |
| 21 | No admin UI exists. | n/a |
| 22 | Classifier only. | n/a |
| 23 | New `refdata_change` action for synonyms, category_map, chapter_keywords (add or deactivate) and HSN description updates. Triggers make rows deactivate-only; `hsn_code_history` keeps old descriptions. Changes publish a version and go into the feed. | ruling 23 (two tests) |
| 24 | `/v1/tax/calculate` refuses an unverified line with `needs_input: ['accept_unverified']` unless the request sets `accept_unverified: true`; accepted lines are flagged `unverified_accepted`. Lookup and classify are unchanged. | ruling 24; tax: unverified rule (ruling 24)… |
| 25 | • Separate admin listener on `HSN_ADMIN_HOST`/`HSN_ADMIN_PORT`, default 127.0.0.1:3001 (`AppSurface`; limiter state is shared).<br>• Admin key CHECK requires `actor_id`, whatever the spelling of the scopes JSON; admin keys last at most 90 days.<br>• `retroactive_reason` is required for effects before today (IST), and the feed carries a `retroactive` flag.<br>• `feed_epoch`, with `scripts/rotate-feed-epoch.ts`.<br>• Tax cost = 1 + floor(lines/50), charged in a preHandler.<br>• Config for outbound and LLM budgets (`HSN_OUTBOUND_*`, `HSN_LLM_CALLS_PER_*`).<br>• Brute-force tracking keyed on IP (or /64) + key prefix.<br>• `source_url` host checked as the exact parsed hostname.<br>• Required `HSN_LOG_KEY`; `nameFingerprint` returns `name_hmac`.<br>• Optional Ed25519 dataset signature (`HSN_DATASET_SIGNING_KEY`). | ruling 25 (seven tests); auth: …not on the public listener (404)…; admin: source url… |

## SA-C findings

| Id | Sev | Change | Test(s) |
|---|---|---|---|
| SA-C-01 | High | Auth verifies the key first. The per-client unauth budget and the brute-force block apply only to failing requests. Production refuses an empty `HSN_TRUST_PROXY` unless `HSN_DIRECT_EXPOSURE=true`. | SA-C-01 (three tests); auth: SA-C-01: …a valid key from that IP still works |
| SA-C-02 | High | supersede and correct must use the target's prefix (400 `prefix_mismatch`). A trigger refuses cross-prefix `superseded_by` and `voided_by_rule`. The DTO shows the target rule. Retroactive changes need a reason. | SA-C-02 (three tests); ruling 25 retroactive |
| SA-C-03 | High | Actors are registered and normalised; keys bind `actor_id`. The maker–checker check is enforced in the service and by a CHECK constraint. | SA-C-03 (two tests); ruling 17 |
| SA-C-04 | Medium | `NODE_ENV` is required with no default. The pepper and audit key must be at least 32 characters unless `NODE_ENV=test`, and must differ. | SA-C-04: main.ts without NODE_ENV exits 1… (child process); …development without a 32-char pepper exits 1; loadConfig… |
| SA-C-05 | Medium | Separate key and unauth limiters, LRU eviction one bucket at a time, IPv6 bucketed per /64, `AuthFailureTracker` bounded and swept. | SA-C-05 (four tests) |
| SA-C-06 | Medium | `admin` is exclusive (`canonicalScopes`). Allow-list entries are validated strictly; IPv4 and IPv6 CIDRs are supported. Requests from outside the list get 403 `forbidden_ip`. | SA-C-06 (three tests) |
| SA-C-07 | Medium | Tax cost is 1 + floor(lines/50) (ruling 25 overrides the review's lines/10), charged after validation. Resolution is memoised per request. | SA-C-07; ruling 14 |
| SA-C-08 | Medium | `app.routeTable` records the real routes. Tests now run at the default unauth limit (60) and cover: route snapshot plus a 401 sweep, buildApp's own scope hook, admin `GET :id`, XFF ignored or trusted, block expiry, admin allow-list, actor variants, prefix mismatch, and a child-process boot. | SA-C-08 (five tests) |
| SA-C-09 | Low | Expiry must be RFC 3339 UTC in the future, is normalised, and is compared as epoch ms; unparseable means expired. | auth: expired key → 401; SA-C-09: … |
| SA-C-10 | Low | `truncateIp` expands IPv6 before truncating. | SA-C-10 |
| SA-C-11 | Low | Audit returns `head_id` and `head_hash`. Verification span capped at 10,000 (`span_too_large`); `verifyAll` walks in chunks. Content hash rechecked at boot; on mismatch `/readyz` returns 503. Optional Ed25519 signature. Head export and verify. | SA-C-11 (two tests); ruling 18; ruling 25 signature |
| SA-C-12 | Low | `request_id` is always `req_<ULID>`; the client value goes into `client_request_id`. | auth: SA-C-12 |
| SA-C-13 | Low | The classifier gets `app.log.child` (pino with redaction) via `src/classifierDeps.ts`. | SA-C-13 (two tests) |
| SA-C-14 | Low | Prefix lengths 2, 4, 6, 8 (and 5 for 99). The prefix must exist (service, seed, trigger). | SA-C-14; seed: ruling 6 / SA-C-14 |
| SA-C-15 | Low | `q` is 2–100 characters, following validator item 18; SEC-27 should be aligned in the docs. Tax `bodyLimit` stays at 256 KiB because 500 full lines are about 55 KB plus headroom. **This deviation must be recorded in 00b/05.** | SA-C-15 (two tests) |
| SA-C-16 | Low | engines `22.x`, `.nvmrc`, `tsconfig.build.json` (rootDir src). The build copies `schema.sql`. `npm start` uses `dist/main.js` and was smoke-tested: both listeners came up. | SA-C-16 |
| SA-C-17 | Info | The seed refuses verified rows unless the loader option `allowVerified` is set; only fixtures set it, the CLI never does. The audit entry records the verifier list, the file hashes and `seed_batch_id`. | seed: SA-C-17 |
| SA-C-18 | Info | `Vary: Origin` is sent on every response when CORS is configured. | SA-C-18 |
| SA-C-19 | Info | Key cache removed; revocation takes effect immediately. | SA-C-19; auth: revoked key → 401 |
| SA-C-20 | Info | The FTS5 probe runs once at boot. `/readyz` returns only `{status}` and runs no DDL. Health probes get a per-client budget (600/min). | SA-C-20 (two tests); auth: health probes need no key |
| SA-K-03 | — | `DELETE /v1/admin/products/:gtin` on the admin listener: admin scope, GTIN validated (including the check digit), audited as `product.purged`, 404 when not cached. | SA-K-03 |

## Validator items that needed code

- Done: 3, 4, 6, 7 (including the `line_id` default and `igst_rate_bp`), 8, 9, 10, 12, 14, 15, 16, 21 and 23. Each maps to the ruling with the same subject above.
- 11:
  - done: `freshness_sla_business_days` and `pending_notifications`;
  - not done: `sources_checked_at`, because there is no watcher yet.
- 13: `data/seed/FORMAT.md` now covers the new fields, the unverified-only rule, 5-digit SAC codes, prefixes that must exist, seed batches and refdata change control. The shipped `data/seed` still loads (seed test).
- 18: `q` is 2–100 and tax `unit_price` is capped at 1e9.
- 24: implemented as `rule_corrected` (ruling 1).
- 5: overridden by ruling 5.
- 9: "refresh `verified_by`" is overridden by ruling 19 (set once); only `last_verified_at` moves.

## Not done, or deviations

- **Pepper rotation (`pepper_id`):** not implemented. Rotating the pepper means re-issuing keys.
- **Out-of-band admin notifications:** not implemented; the security docs list them as an operator task.
- **`sources_checked_at` and the CBIC watcher (validator items 11 and 25):** no watcher code exists in v1. Watched notifications are entered manually through the admin API.
- **Adding new HSN codes after the seed:** refdata_change can update descriptions but cannot add codes. A new code needs a new seed or a later action.
- **Dataset integrity:** checked at boot and by `verify-audit`, not continuously while the server runs.
- **Tax body limit:** stays at 256 KiB instead of 64 KiB (see SA-C-15). The coordinator should record it in 00b/05.
- **Classifier side of ruling 5:** selecting by a synonym's `rule_hint` belongs to the classify worker. The core accepts `conditionCode`, and the route already passes it.

## Round 3 (00c Part C: rulings 26, 28, 29, 30)

This round builds on the watcher worker's round 2 (schema v3, 563 tests).

Result:
- `tsc --noEmit` is clean.
- `vitest run` passes **575 of 575** tests in 24 files.
- `npm run build` succeeds.

New test file: `test/core-round3.test.ts` (12 tests, named "ruling N: …").

### Schema v4 (`src/db/migrations.ts`)
v4 is an in-place step on top of v3, and a v3 database upgrades without losing data. It does two things:
- adds `api_keys.pepper_id`:
  - `NOT NULL DEFAULT 'default'`, with a CHECK of `[a-z0-9_-]{1,32}`;
  - existing keys get `default`;
  - trigger `api_keys_pepper_id_immutable` stops it being changed;
- adds the index `products(fetched_at, gtin)`, used for eviction.

### Changes and tests

| Ruling | Change | Test(s) |
|---|---|---|
| 26 | `POST /v1/admin/rate-proposals/{id}/withdraw` with body `{reason}`, served on the admin listener.<br>• Only the proposer may withdraw. "Proposer" means the same `actor_id`, so any of that actor's keys works. Anyone else gets 403 `not-proposer`.<br>• Only a pending proposal can be withdrawn; otherwise 409 `proposal-not-pending`.<br>• Sets status `withdrawn`; `decided_by_actor_id` stays NULL, as the existing CHECK already allows.<br>• Audited as `rate_proposal.withdrawn`, and idempotent.<br>• `ProposalService.withdraw`. | ruling 26: the proposer (any of their keys) withdraws…; ruling 26: another actor gets 403 not-proposer… |
| 28 | A `preValidation` hook in `routes/admin.ts` covers every admin-scope POST, PUT, PATCH and DELETE.<br>• No header → 400 `idempotency-key-required`. A malformed header → 400 validation error.<br>• The hook runs after authentication, so an unauthenticated request still gets 401.<br>• Triage, resolve and product purge now replay like the other writes: the same key with the same body returns the stored response, and a different body returns 409.<br>• Test helper: `withAutoIdempotencyKey` adds a fresh UUID to admin writes; `NO_IDEM_KEY` sends none. | ruling 28: each admin write without the header → 400…; ruling 28: triage, resolve and product purge replay… |
| 29 | **Pepper rotation**<br>• Format: `HSN_KEY_PEPPERS="id:secret,…"`, newest first.<br>• Validation:<br>&nbsp;&nbsp;– ids are unique and match `[a-z0-9_-]{1,32}`;<br>&nbsp;&nbsp;– no secret is repeated;<br>&nbsp;&nbsp;– outside test, every secret is at least 32 characters and differs from `HSN_AUDIT_KEY`;<br>&nbsp;&nbsp;– it cannot be set together with `HSN_KEY_PEPPER`.<br>• `HSN_KEY_PEPPER` alone is treated as `default:<secret>`.<br>• New keys use the newest pepper (`config.keyPepperId`) and record it in `pepper_id` and in the `api_key.created` audit entry.<br>• Auth verifies a key with the pepper its row names. If that pepper has been removed, the key fails and the server logs `api_key.pepper_missing` at error level. Unknown prefixes still get a constant-work dummy compare.<br>• Rotation procedure: put the new pepper first and keep the old one → re-issue keys → remove the old one.<br><br>**Admin grants**<br>• An approved `admin_grant` writes an `admin.granted` audit entry and a warn-level line `{event:"admin.grant_approved", alert:true, handle, proposed_by, approved_by}`.<br>• `create-key` prints a warn line `admin.key_issued` for every admin key.<br>• The out-of-band notifier is deferred, as the ruling says. | ruling 29: HSN_KEY_PEPPERS parsing and validation; ruling 29: end to end — old keys verify during rotation…; ruling 29: migration v4 upgrades a v3 database…; ruling 29: approving an admin_grant writes admin.granted… |
| 30 | **Product cache bound**<br>• `HSN_PRODUCT_CACHE_MAX_ROWS`: default 50,000, range 100–10,000,000.<br>• After each upsert, `SqliteProductRepo` evicts the oldest `fetched_at` rows down to the bound, never the row just written.<br>• Wired through `createStorage(…, {productCacheMaxRows})` in `main.ts`, the scripts and the test helper.<br><br>**Metrics**<br>• `GET /metrics` in Prometheus text format, registered only when `surface === 'admin'`. It shares the admin host and port; there is no `HSN_METRICS_HOST`.<br>• It needs no key, but `HSN_ADMIN_IP_ALLOWLIST` applies when set.<br>• Series:<br>&nbsp;&nbsp;– `hsn_http_requests_total{listener,method,route,status}`;<br>&nbsp;&nbsp;– `hsn_http_request_duration_seconds` histogram;<br>&nbsp;&nbsp;– `hsn_classify_top_band_total{band}`, counted from the classify response in an app hook, so `routes/classify.ts` is untouched;<br>&nbsp;&nbsp;– gauges: `hsn_watcher_last_success_timestamp_seconds`, `hsn_rate_rules_unverified`, `hsn_rate_rules_active`, `hsn_dataset_info{version}`, `hsn_product_cache_rows` and `hsn_product_cache_max_rows`.<br>• Labels use route templates only; each metric is capped at 2,000 series.<br>• Code in `src/lib/metrics.ts` (no dependency) and `src/routes/metrics.ts`. | ruling 30: oldest-first eviction…; ruling 30: never on the public listener; ruling 30: request counts by route/status, latency histogram, classify bands, watcher last success, unverified rules; ruling 30: HSN_ADMIN_IP_ALLOWLIST applies to /metrics |

### Existing tests touched
- The SA-C-08 route snapshot now lists `/metrics` and `/withdraw`.
- `test/watcher.test.ts` (the watcher worker's file) asserted `SCHEMA_VERSION` is exactly 3. It now asserts at least 3, because v4 builds on v3.
- `ProductRepo` gained `count()`. The classify worker's code still type-checks.

### Docs to align (for the docs worker)
- **New environment variables:** `HSN_KEY_PEPPERS` (and the `default` id for keys issued under `HSN_KEY_PEPPER`) and `HSN_PRODUCT_CACHE_MAX_ROWS`.
- **New problem codes:** `idempotency-key-required` (400) and `not-proposer` (403).
- **New API:** the withdraw route and the `/metrics` series list.
- **Schema:** the `api_keys.pepper_id` column.
- **Removed:** `HSN_ADMIN_NOTIFY_HOSTS` and `HSN_METRICS_HOST` should be dropped from the docs.

### Round 3 follow-ups (coordinator)
Result: `tsc` is clean and `vitest run` passes **606 of 606** tests in 25 files. That count includes the classify worker's changes, which brought the suite to 602 before these.

| Item | Change | Test |
|---|---|---|
| (a) SA-K2-01 | A classifier `rule_hint` still selects `applicable_rule`, but the resolution now keeps all candidate `rules[]` and the general `default_rule_id`. A new `rule_selected_by` field says how the rule was chosen: `"rule_hint:nil_rate_list"`, or `null` when no hint applied. The `selected_by_hint` warning stays. The field is in `RateResolutionDto` and the response schema. | round 3 follow-ups › SA-K2-01 / ruling 5: a rule_hint selection keeps rules[] and default_rule_id… |
| (b) | `GET /v1/admin/audit?entity_type=` now accepts `product`, so product purges can be filtered. | round 3 follow-ups › audit entity_type filter accepts product |
| (c) | The unused `HSN_METRICS_PORT` was removed from config; metrics share the admin listener (ruling 30). | round 3 follow-ups › HSN_METRICS_PORT is no longer parsed |
| (d) ruling 33 | `data/seed/FORMAT.md` now says, in a callout and in the field table, that seed rows are always `unverified`. The `allowVerified` loader flag is for test fixtures only; `scripts/seed.ts` never sets it. | round 3 follow-ups › ruling 33: FORMAT.md says… |

Docs to align: openapi `RateResolution` gains `rule_selected_by` (nullable string), and the audit `entity_type` enum gains `product`.

## Round 4 (security-code-core-round2.md: SA-C2-01 … SA-C2-09, plus 405)
Result: `tsc` is clean, `npm run build` succeeds, and `vitest run` passes **672 tests, plus 1 expected fail**, in 28 files. The count includes other workers' files. The new tests are in `test/core-round4.test.ts` (36 tests, one or more per id).

### Schema v5 (`src/db/migrations.ts`)
v5 is an in-place step on top of v4; a v4 database upgrades without losing data. It adds or replaces these guards:

| Guard | What it enforces |
|---|---|
| `rate_proposals_guard_insert` | A new proposal must be pending, with every `decided_*` and `resulting_*` column NULL. It must be made with the proposer's own active admin key. An `admin_grant` with `new_actor:false` must be proposed by the actor it names. |
| `rate_proposals_guard_decide` | An approval must use an active checker key. A disabled actor's proposal cannot be approved. |
| `rate_rules_guard_bind` | Each of these updates needs the approved proposal that does exactly that change:<br>• **void:** an approved `correct` of this rule whose resulting rule is `voided_by_rule`, in the same version;<br>• **`effective_to` / `end_dated_in_version`:** an approved `end_date` (same date) or `supersede` (the day before the new rule starts, with `superseded_by` set to the new rule), in the same version;<br>• **`verified_by` / `last_verified_at` / status:** an approved `verify` decided at that instant;<br>• **`superseded_by`:** cannot be set without end-dating;<br>• **source PDF hash or serial:** cannot change without a verification. |
| `rate_rules_guard_insert` | The inserted rule must match the proposal's `rule_json` (prefix, rate, cess, dates, notification and source URL). `verified_by` and `last_verified_at` must be the checker and the decision time. |
| `dataset_state_guard_bind` | The current version may only move to a version that an approved proposal published. |
| `hsn_codes` guards | `add_code` binds table, op, code, parent, type, description, keywords and version. A description update binds its code, description and keywords. |
| Reference-data guards | Synonyms, category_map and chapter_keywords inserts are bound to a proposal for that table and row. Deactivations are bound to the proposal for that row id. |
| `admin_actors_guard_insert` | A new actor needs a grant with `new_actor:true` for that handle, and the grant must not be a disable request. |
| `api_keys_guard_admin_insert` | A grant key must be created within 72 h of the grant's approval. |
| `watched_notifications.pending_action` (column) and `watched_notifications_guard_confirm` | Resolving a `cbic_watcher` row, or removing prefixes from it, needs a stored request for exactly that change. See SA-C2-03. |

### Changes and tests

| Id | Change | Test(s) (`core-round4.test.ts` unless noted) |
|---|---|---|
| SA-C2-01 | **Linear parser** in `src/adapters/cbicWatcher.ts`. Tokenizing uses `indexOf` and charCodes only.<br>• Comments, `script`, `style`, `template`, `noscript`, `textarea`, `iframe` and similar elements are cut at their terminator. A missing terminator drops the rest of the page.<br>• A tag with no `>` ends the scan.<br>• Attributes are parsed linearly from at most 4 KiB per tag.<br>• No regex runs over markup. `htmlText` and the trailing-title trim are linear too.<br>• Caps per row: 16 KiB of text, 64 cells, 2048 tags and 10 anchors.<br>• The parse result is unchanged: every existing fixture expectation still holds.<br><br>**Worker isolation:** `parseCbicListingIsolated` runs the parse in a `worker_threads` worker (new file `src/adapters/cbicParseWorker.ts`).<br>• The worker has a 64 MB heap, and a hard 2 s timeout starts once the worker is up.<br>• A timeout, crash or exit fails closed as `shape_changed`.<br>• `watcherDeps` always sets `isolateParse: {timeoutMs: 2000}`, for both the in-process interval and the cron script. | 12 adversarial pages of 256 KiB each, each under 250 ms (in practice 0.1–70 ms): unclosed `<a href=`, `<a href=x>` without `</a>`, unclosed `<!--`, `<tr` with no `>`, `<tr>` × 65k, `<td` with no `>`, `<td>` × 64k, `<b` with no `>`, `<b>` × 85k, unclosed `<script>`, `\| ` runs, and unclosed `href="`. Also: caps; isolated result equals inline; a stuck worker is terminated → `shape_changed`; `watcherDeps` isolates. The `test/watcher.test.ts` parser tests pass unchanged. |
| SA-C2-08 | Hidden content is skipped: rows, cells and any element with the `hidden` attribute, `display:none`, or `visibility:hidden` or `collapse` (matched case- and space-insensitively, entities decoded).<br>• Skipped elements are counted in the new `ParseStats.hidden` and `PageOutcome.hidden`.<br>• A run logs `{event:"watcher.hidden_rows", alert:true, pages:[{url, hidden}]}` at warn level. | hidden rows, cells, spans and containers never become items, and are counted; the run logs `watcher.hidden_rows` |
| SA-C2-02 | **Detection: `src/services/integrity.ts` `crossCheckState`** runs after the HMAC chain verifies. Every one of the following must have a matching HMAC'd entry:<br>• each dataset version: a `dataset.seeded` or `rate_proposal.approved` entry with the same content hash. Approvals now record `details.dataset_content_hash`. Versions approved before round 4 are checked by name only and reported in `legacy`.<br>• each proposal: its `created` entry with the same `content_sha256`, and its decision entry. An approval entry must match the version, rule, checker and content.<br>• each rule: it must match the immutable fields of its approval snapshot.<br>• each voided, end-dated or superseded rule, and each verification: the approval of the proposal that made the change.<br>• each API key and admin actor: its creation entry.<br><br>**Where it runs:**<br>• `verifyAgainstHead`, so `scripts/verify-audit.ts` exits 3 and reports `state without matching audit entry: …`;<br>• the boot checks in `runBootChecks`. `BootChecks` gains `auditIntegrity`, and `/readyz` gains the check `audit_integrity`, which returns 503 on failure. Boot logs `audit.state_mismatch` or `audit.chain_broken` at error level with `alert:true`.<br><br>**Prevention:** the v5 guards above. | Legitimate history cross-checks clean; the DB guards refuse an approved insert, void, end-date, verify and description edit. **The auditor's DB11 forgery** (triggers dropped; fake approved proposal + verified rule + version with a recomputed hash + pointer moved) passes the old hash check but is reported by `crossCheckState`, by `verifyAgainstHead`, and by boot → `/readyz` 503. A raw key insert and a dropped-trigger end-date are reported. |
| SA-C2-03 | Resolving a `cbic_watcher` row (published or dismissed), or a triage that **removes** prefixes from one, takes two admins:<br>• The first request stores `pending_action`, is audited as `watched_notification.confirmation_requested`, and returns **202** with the row.<br>• The same request from a different actor applies the change. It is audited with `requested_by` and `confirmed_by`, and logs `{event:"watcher.row_silenced", alert:true}` at warn level.<br>• The same actor, even with another key, gets 403 `maker-checker-violation`.<br>• A different request replaces the pending one.<br>• Adding prefixes, and resolving manual rows, stay single-admin.<br>• The DB trigger refuses a direct resolve or prefix removal. | two-step triage removal; dismiss and publish with 202, 403 and the trigger; manual rows unchanged. `test/watcher.test.ts` now expects the 202 → 200 flow. |
| SA-C2-04 | **Proposal action:** `disable_actor`, body `{action:"disable_actor", disable:{handle}, rationale}`.<br>• It is stored as an `admin_grant` row with `payload.op="disable_actor"`, because the action CHECK cannot change without a table rebuild. The DTO shows `disable_actor`.<br>• It is refused if it would leave fewer than two active admins.<br>• On approval, `disableActorInTx` does the following:<br>&nbsp;&nbsp;– sets `disabled_at`, so the actor's keys get 401 at once;<br>&nbsp;&nbsp;– withdraws the actor's pending proposals, each audited as `rate_proposal.withdrawn`;<br>&nbsp;&nbsp;– writes an `admin.disabled` audit entry;<br>&nbsp;&nbsp;– logs `{event:"admin.actor_disabled", alert:true}` at warn level.<br><br>**Script:** `scripts/disable-actor.ts --handle --by --note` (npm `disable-actor`) does the same in one transaction. It warns when fewer than two admins remain.<br><br>**Approval of a disabled proposer's proposal:** `loadForDecision` refuses it with 409 `proposer-disabled`, and the DB trigger refuses it too. | API flow (keys 401, proposals withdrawn, audit, alert, cross-check clean, last-two refusal); legacy-disabled proposer → 409 plus trigger; the script |
| SA-C2-05 | • An `admin_grant` with `new_actor:false` must be proposed by that actor. Otherwise it gets 400 with error code `not_self`, and the DB trigger refuses it too.<br>• Grants expire if not redeemed: `createApiKey` refuses after `HSN_ADMIN_GRANT_TTL_HOURS` (default 72), and the DB enforces a 72 h ceiling.<br>• The `admin.key_issued` line prints `issued_by`. | not_self (service and DB); expiry after 73 h (service and DB); `issued_by` |
| SA-C2-06 | `src/services/restoreGuard.ts` keeps a sidecar file, `HSN_STATE_HWM_FILE` (default `<HSN_DB_PATH>.hwm.json`), MAC'd with `HSN_AUDIT_KEY`. It records the audit head id and hash, `last_change_seq` and `feed_epoch`.<br><br>**At boot, a restore is detected when any of these holds:**<br>• the audit head id is lower than recorded;<br>• the recorded head entry's hash differs;<br>• the sequence is lower within the same epoch.<br><br>**On a detected restore:**<br>• the feed epoch is rotated;<br>• the audit entry `dataset.restore_detected` is written;<br>• `{event:"dataset.restore_detected", alert:true}` is logged at error level;<br>• `/readyz` check `state_continuity` returns 503 until `scripts/ack-restore.ts --by --note` (npm `ack-restore`) rewrites the sidecar (audited as `dataset.restore_acknowledged`) and the server restarts.<br><br>**Other behaviour:**<br>• A sidecar whose MAC fails gives `dataset.hwm_invalid` and 503.<br>• The sidecar only moves forward: after each audited admin write (post-commit) and every 60 s in `main.ts`. | a real `VACUUM INTO` backup restored behind the mark → epoch rotated, alert, audit, 503 → ack → 200; an edited sidecar → 503; a mark ahead of the DB → 503; production refuses `off` |
| SA-C2-07 | In production, a non-loopback `HSN_ADMIN_HOST` without `HSN_ADMIN_IP_ALLOWLIST` fails at boot. Loopback means `127.0.0.0/8`, `::1` or `localhost`. | 0.0.0.0 refused; allowed with an allow-list or on loopback |
| SA-C2-09 | **Accepted, no change.** The LRU bounds on limiter, unauth and auth-fail state cap memory. A client controlling about 100k /64s can evict its own unauthenticated bucket or block. Valid keys are unaffected (they are checked first, on their own limiter). The block is a nuisance control, not a security boundary. | the evicted bucket starts full and the size stays bounded (documents the behaviour) |
| 405 | The not-found handler matches the path against this listener's route table. For a known path with the wrong method it returns **405** `method-not-allowed` with an `Allow` header (GET implies HEAD). Unknown paths still return 404, and admin paths are unknown on the public listener. | wrong method → 405 + Allow; unknown → 404 |

### Docs to align (for the docs worker)
- **New proposal action:** `disable_actor`, with body `disable: {handle}`. It is listed as `action: "disable_actor"` in DTOs. Approval writes `admin.disabled`, and withdraws the actor's pending proposals as `rate_proposal.withdrawn`.
- **Changed admin API (SA-C2-03):**
  - `POST /v1/admin/watched-notifications/{id}/resolve` returns **202** for a `cbic_watcher` row until a second admin repeats it.
  - `/triage` behaves the same way when it removes prefixes from a `cbic_watcher` row.
  - The watched-notification object gains `pending_action` (`{kind, affected_prefixes?, effective_from?, by, at}` or null).
  - New audit action: `watched_notification.confirmation_requested`.
- **New problem types:** `proposer-disabled` (409) and `method-not-allowed` (405, with `Allow`), which is now actually raised. New validation error codes: `not_self` (grant for another actor) and `last_actors` (disable would leave fewer than two admins).
- **New environment variables:**
  - `HSN_ADMIN_GRANT_TTL_HOURS` (1–72, default 72).
  - `HSN_STATE_HWM_FILE`: path, default `<HSN_DB_PATH>.hwm.json`; `off` disables it and is refused in production. Keep it outside the DB backup set.
- **Changed environment validation:** in production, a non-loopback `HSN_ADMIN_HOST` requires `HSN_ADMIN_IP_ALLOWLIST`.
- **New scripts:** `scripts/disable-actor.ts` (npm `disable-actor`) and `scripts/ack-restore.ts` (npm `ack-restore`). The restore runbook becomes:
  1. Restore the backup.
  2. The server detects it, rotates the epoch and fails readiness.
  3. Run `ack-restore`.
  4. Restart.

  `rotate-feed-epoch` remains for manual use.
- **Readiness:** `/readyz` gains the internal checks `audit_integrity` and `state_continuity`. Publicly it still returns only a status. Boot runs the full HMAC chain and the state cross-check, which costs O(audit log) at start-up.
- **New log events:**
  - error, with `alert:true`: `audit.state_mismatch`, `audit.chain_broken`, `dataset.restore_detected`, `dataset.hwm_invalid`;
  - warn, with `alert:true`: `watcher.hidden_rows`, `watcher.row_silenced`, `admin.actor_disabled`;
  - warn: `audit.legacy_state`.
- **New audit actions:** `admin.disabled`, `dataset.restore_detected`, `dataset.restore_acknowledged`, `watched_notification.confirmation_requested`. Approval details gain `dataset_content_hash`.
- **Watcher:**
  - Hidden rows and elements are ignored and counted in `PageOutcome.hidden`.
  - The parser is linear with the per-row caps above, and runs in a worker thread with a 2 s limit that fails closed as `shape_changed`.
  - SEC-79 can be marked as fixed.
- **Residual risk (be explicit, SEC-53 / ruling 18):** the cross-check detects a database writer who lacks `HSN_AUDIT_KEY`. Someone who holds **both** the database and `HSN_AUDIT_KEY` can still forge matching HMAC'd entries, and also a matching high-water-mark sidecar.
  - That remains the documented residual risk.
  - Mitigations: keep the audit key off the DB host's backups and volumes, and anchor the head off-host daily (`export-audit-head`, `verify-audit --head`).
  - Versions approved before v5 have no audited content hash and are checked by name only (`legacy`) until the next publish.
- **SA-C2-09:** document it as accepted, using the wording in the table above.

### Existing tests touched
- In `test/watcher.test.ts`, dismissing a watcher row now expects 202 from priya and then 200 from amit.
- No other existing test changed.

---

## Round 5 (validator-round2 R3, R13, R11, seed caveats, eval)

Schema is now **v6**, added in place by migration step 6. tsc, build and the full suite are green: 30 files, 686 tests, no `it.fails`.

### API changes (doc-facing)

**R3: codes outside the HSN master**
- `GET /v1/hsn/{code}` handles a code that is not in the master but has a known ancestor in the prefix chain (6, then 5 for SAC 99xxx, then 4, then 2):
  - It now returns **200**, resolved against that nearest known parent.
  - New fields: `code_in_master: false` and `resolved_via: "<parent>"`. On every code in the master these are `code_in_master: true` and `resolved_via: null`.
  - `rate.warnings` includes `code_not_in_master`, and `rate.matched_at_level` is reported as usual.
  - `description` reads ``"<code> is not in the HSN master; shown under <parent>: <parent description>"``.
  - `level` is the code's own length, and `ancestors` is the parent's chain plus the parent.
- Only a code whose **chapter** does not exist still returns 404 (`chapter XX does not exist`).
- `POST /v1/tax/calculate` lines behave the same way:
  - The line is computed, not refused with a 422, and gains `code_in_master` and `resolved_via`.
  - Its `notes` include `code_not_in_master: … resolved under its nearest known parent X`.
  - `422 unknown_hsn` remains only for codes with no known ancestor.

**R13: partial totals**
- When any line has `needs_input` or is refused, the invoice is incomplete:
  - `totals` and `totals_paise` are **null**.
  - `partial_totals` is `{complete: false, included_line_ids, excluded_line_ids, totals, totals_paise}` and sums the resolved lines only.
  - With `invoice_rounding: nearest_rupee`, `grand_total_paise` and `round_off_paise` are also null.
- A complete invoice keeps `totals` and `complete: true`, and its `partial_totals` is `null`.
- OpenAPI: `totals`, `totals_paise`, `grand_total_paise` and `round_off_paise` become nullable; add the `partial_totals` schema and the per-line `code_in_master` and `resolved_via`.

**citation_note (seed caveat)**
- Every rule DTO (`rate.rules[]`, `rate.applicable_rule`, proposal target rules) has a new `citation_note: string | null` field.
- It is the caveat shown with a seed rule while it is unverified, for example "gazette not read; S.No. not verified".
- A **verify** approval sets it to null.

### Data and format
- `data/seed/FORMAT.md` documents a new rule field, **`citation_note`**: string or null, 1–1000 characters, optional.
  - The loader maps it to `rate_rules.citation_note`. `research_ref` is still ignored.
  - **The seed worker can now fill it** by moving the consumer-facing part of each `research_ref` caveat into it.
- Database (migration 6) adds the column `rate_rules.citation_note` (CHECK ≤ 1000) and two guards:
  - the column can be non-null only on a seed-batch insert;
  - an update can only clear it, and only together with a change of `last_verified_at` (a verify).
- `markVerified` clears it. It is **not** part of the dataset content hash, so existing versions keep their hashes; a verify changes the hash anyway through `last_verified_at`.

### R11: production data load (`scripts/import-dataset.ts`, npm `import-dataset`)
- The load is a new proposal kind, **`dataset_import`**. It is stored as `refdata_change` with `payload = {op: "dataset_import", files: {name: sha256}, counts}`, and the API shows `action: "dataset_import"`.
- It can be listed and rejected through the API. `POST …/approve` refuses it with **409 proposal_stale** ("approve it with scripts/import-dataset.ts"), because only the host can re-hash the files.
- Audit trail:
  - `rate_proposal.created` when it is proposed;
  - `dataset.seeded` (actor = the checker, plus `proposal_id`) and `rate_proposal.approved` (with `dataset_version`, `dataset_content_hash` and `actor_id`) when it is approved.
- The `seed.ts` refactor is internal: `loadSeed` is now `prepareSeed` + `applySeed`, and its behaviour is unchanged.

**Runbook: first production load**
1. Set up the empty production database by booting the server once or running any CLI. Then run `npm run bootstrap-admins` for the two first admins (ruling 17). `npm run seed` stays refused in production.
2. **Maker** (admin A), on the host:
   `HSN_ADMIN_KEY=<A's admin key> npm run import-dataset -- propose --dir data/seed --rationale "Initial load, data/seed @ <commit>"`
   - The script validates the directory (fail closed, with the same checks as the seed; every rule must be unverified). It records each file's sha256 and the row counts.
   - It prints `proposal_id` and `content_sha256`.
   - It is refused if the DB already has a dataset or another `dataset_import` is pending.
3. **Checker** (admin B, a different actor) reviews the proposal (`GET /v1/admin/rate-proposals/{id}` or the printed JSON) against the same commit, then runs:
   `HSN_ADMIN_KEY=<B's admin key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed [--comment "…"]`
   - The script refuses if B is the maker, if the hash is wrong, if the proposer is disabled, or if any file's sha256 or row count differs from the proposal.
   - Otherwise one transaction publishes the first dataset version (all rules **unverified**, seed batch recorded), marks the proposal approved with that version, and writes the HMAC audit entries.
   - It then runs the state-to-audit cross-check and exits with code 3 if the check reports a problem.
4. Start or restart the server. `/readyz` should return 200. Rates are served with `rate_unverified`, and tax calculation needs `accept_unverified: true` until each rule is promoted with a `verify` proposal, which also clears its `citation_note`.
- Exit codes: 0 ok; 1 refused (auth, maker = checker, stale, non-empty DB); 2 seed validation failed; 3 imported but the integrity check reported problems (investigate before serving).
- Authentication is your own key in `HSN_ADMIN_KEY`, checked as the API checks it: pepper by `pepper_id`, not revoked or expired, active admin actor. Never pass the key on the command line.

### Eval (AI-40 / AI-45)
- **npm scripts:**
  - `eval` runs `tsx scripts/eval-classifier.ts`.
  - `import-dataset` is new (see above).
- **Rename:** `test/eval/labelled.jsonl` is now **`test/eval/classify-eval.jsonl`**. Docs that still reference the old name must be updated, for example `reviews/code-fix-classify-round2.md` and any PRD/TRD/eval docs; that is for the docs worker.
- **Excluded items:** an item may carry `"excluded": "<reason>"`. Excluded items are left out of every gated metric and of the AI-45 leakage check, and are counted (`excluded` in the metrics, plus a line in the console summary).
  - ev0010 ("platinum couple bands") is excluded as `leakage: identical to curated synonym added after labelling`. The synonym is kept and no labels changed.
  - The AI-45 test reports the excluded items and requires every reason to start with `leakage: `.
- **Known miss resolved:** the `it.fails` top-3 test is now a normal `it('top-3 recall (4-digit, in-master) ≥ 0.90')`.
- **Baseline:** `test/eval/baseline.json` was re-recorded from the round-5 seed: top1_4 0.7753, top3_4 0.8466, top1_4_in_master 0.8602, top3_4_in_master 0.9392, coverage 0.9602, high_precision 1.
- **Regression test semantics:** "no metric regresses by more than 1 point against the recorded baseline". It no longer requires the baseline's `classifier_version` to differ from the current one.

### New tests
- `test/core-round5.test.ts` covers:
  - `citation_note`: load, DTO, the direct-edit guard, cleared by verify, and the cross-check passing afterwards;
  - `import-dataset` refusals: non-admin key, short rationale, duplicate pending import, API approve (409), maker = checker, wrong hash, changed file;
  - `import-dataset` success: a second admin approves, rules stay unverified, the cross-check passes, `/readyz` returns 200, and a second import is refused.
- `test/seed-shipped.test.ts` runs against the real `data/seed`:
  - all rules are unverified;
  - 3004 is ambiguous (5% default plus a 0% `nil_rate_list` rule);
  - 7113 is 3%;
  - 6109 at ₹2,500 is 5% and at ₹2,500.01 is 18% (ambiguous without a price);
  - 999721 is 5% via 99972;
  - R3: 30049099, 61091000 with a unit price, and 85171300 resolve under their parents, and chapter 00 returns 404;
  - a mixed tax invoice with partial totals, and a 422 for a missing chapter.
- **Existing tests touched:**
  - `rates.test.ts`: 7199 now returns 200 via 71, and 7799 returns 404.
  - `tax.test.ts`: the openapi example and the no-rule case expect `totals: null` plus `partial_totals`; the unknown code is 7799; the complete invoice asserts `complete: true`.
  - `eval.test.ts`: as described in the Eval section.

---

## Round 6 (reviews/security-code-core-round3.md: SA-C3-01 … 08)

The schema is now **v7**: migration step 7 replaces one trigger, and the upgrade runs in place. tsc, the build and the full suite are green: 32 files, 719 tests. Regression tests are in `test/core-round6.test.ts`; the SA-C3-03 tests are in `test/core-round4.test.ts`.

| Id | Fix | Regression |
|---|---|---|
| SA-C3-01 (Medium) | `loadForDecision` recomputes `proposalContentSha256` from the row's stored content (action, target, end_date, rule, payload, rationale, retroactive_reason, target_sha256). It refuses with **409 `proposal_hash_mismatch`** ("stored content no longer matches its content_sha256") unless the result equals the stored hash; `expected_sha256` is still checked against it. Approve and reject both use it, and `import-dataset approve` shares the same function. The cross-check (1) recomputes every proposal's hash from its stored content, (2) requires the stored rule and payload to equal those in the HMAC'd `rate_proposal.created` entry, and (3) for approvals, requires the published rule snapshot (every created-rule field) and the approved payload to equal the created entry. The integrity snapshot now loads `rule_json`, `payload_json`, `rationale`, `retroactive_reason`, `target_sha256` and `end_date`. | Auditor's X1: the swapped pending proposal gets a 409, nothing is published, and the cross-check flags it. Editing an approved proposal with a recomputed hash is detected. |
| SA-C3-02 | The cross-check compares current state with the audit log. A key with `api_key.revoked` must have `revoked_at`, and `revoked_at` needs that entry. `expires_at` must equal the value in `api_key.created`. An actor with `admin.disabled` must have `disabled_at`, and the reverse. A pending proposal must have no decision entry, and a decided proposal's status must equal its latest decision entry. (Grants were already compared through `api_key.created.admin_grant_id` and `admin.granted`.) | X2 (un-revoke plus cleared expiry), X3 (re-enabled actor) and X4 (rejected proposal set back to pending) are all detected. |
| SA-C3-03 | Simplest change that closes X5 and X6: **every watched row that carries a CBIC notification key** (watcher or manual) needs the two-admin confirmation to be resolved, to remove prefixes, or to **set its first prefixes** (first triage of an untriaged row). Later additions stay single-admin. Manual rows without a parsable notification key (free-text entries) keep single-admin resolve; the watcher never matches them, so they cannot pre-empt it. Enforced in the route and in DB trigger v7 (`watched_notifications_guard_confirm`, replaced). Why not "the watcher raises its own row": `notification_key` is UNIQUE, so a second row needs a schema rebuild and would duplicate rows. With two-admin dismissal a manual pre-emption simply stays open, warning and on the SLA clock, until a second admin agrees. | X5: a keyed manual row gets 202 from one admin, the DB refuses a direct dismiss, and a second admin gets 200. X6: first triage gets 202, the DB refuses a direct first triage to "0406", and confirmation gets 200. |
| SA-C3-04 | The first sidecar creation writes a `dataset.hwm_initialised` audit entry. A **missing** sidecar for a DB whose log has that entry (or a `dataset.restore_acknowledged`) is a possible restore: log `dataset.hwm_missing` (error, `alert:true`), rotate the feed epoch, write a `dataset.restore_detected` audit entry, and `/readyz` returns 503 until `ack-restore` runs. Only a database that never had a sidecar (fresh install, or one upgraded from before round 4) initialises one silently, after the CLIs (seed, import-dataset, bootstrap-admins) have run. **Production config refuses** an unset `HSN_STATE_HWM_FILE`, and one whose directory is the DB's directory. | Deleting the sidecar gives 503 plus the alert and a rotated epoch, then ack-restore gives 200. Production config cases are tested. |
| SA-C3-05 | `scripts/disable-actor.ts` refuses, like the API, when fewer than two active admins would remain. The error explains the path that actually works: grant a third admin first through an admin_grant proposal, or revoke just the leaked key with `create-key --revoke <id> --by <you>`. The false "until a new admin is bootstrapped" warning is gone. | With two admins the script returns 1, the actor stays active and nothing is audited. |
| SA-C3-06 | Info. No change, as the auditor recommended. | none |
| SA-C3-07 | `dataset.seeded` audit details gain `citation_notes: {rule_id: note}`. The cross-check requires: a seed rule's `citation_note` equals that note; a null note for a seeded caveat requires the rule to be verified (`last_verified_at` set, and that verification is itself cross-checked); a proposal-published rule has no note. Seeds from before round 6 have no map, and their notes are reported as `legacy`. `citation_note` stays **out of the dataset content hash** on purpose, so existing dataset version hashes stay stable. Its integrity comes from the cross-check and the v6 triggers. | Editing the note and removing it without a verify are both detected; the content hash is unchanged. |
| SA-C3-08 | Kept `complete: true` for computed not-in-master lines. Each line has a new `warnings: string[]` field: `["code_not_in_master"]` or `[]`. The `POST /v1/tax/calculate` response has a new top-level `warnings: string[]`, which contains `code_not_in_master` when any line does. | Mixed invoice: complete, with top-level and line warnings; a clean invoice has `warnings: []`. |

### Doc-facing changes (for the docs worker; I did not touch README.md or .env.example)
- **Config:** in production `HSN_STATE_HWM_FILE` is **required** and must be outside the DB's directory, for example `/var/lib/hsn-state/hwm.json` next to `HSN_DB_PATH=/var/lib/hsn/hsn.db`. Put it on a different volume and backup set from the DB: a directory-level backup that restores both together defeats restore detection. `.env.example` and README need this.
- **Restore runbook:** a missing sidecar is now treated like a restore. Readiness fails with the alert `dataset.hwm_missing`; check, then run `ack-restore` and restart. The first boot of a database that never had a sidecar creates one and writes the audit entry `dataset.hwm_initialised`.
- **New audit actions:** `dataset.hwm_initialised`. `dataset.seeded` details gain `citation_notes`.
- **New log event:** `dataset.hwm_missing` (error, `alert:true`).
- **API:**
  - Approve or reject can return 409 `proposal_hash_mismatch` when stored content was altered.
  - Tax responses have top-level `warnings[]` and per-line `warnings[]`.
  - Watched notifications: any row with a notification key, manual too, needs a second admin to resolve it, to remove its prefixes, or to set its first prefixes. The first admin gets 202 with `pending_action`.
- **`disable-actor`:** refuses below two active admins. This replaces the documented "may leave fewer than two".
- **Cross-check coverage list** (`/readyz` `audit_integrity`, `verify-audit`): proposal content hashes, created-versus-approved content, revocations, disablements, decisions, expiry, citation notes.

### Existing tests touched
- `core-round4.test.ts`, SA-C2-03:
  - the first triage is now two-step;
  - "manual entries keep single-admin resolve" is split into a keyed manual row (two admins, X5) and an unkeyed manual row (single admin);
  - the production `PROD` env sets `HSN_STATE_HWM_FILE`.
- `watcher.test.ts`: the first triage is requested by amit and confirmed by priya.
- `rulings-round2.test.ts` and `core-round3.test.ts`: dismissing a keyed manual row is now two-step.
- `core-round3.test.ts` and `security-core-round2.test.ts`: the production envs set `HSN_STATE_HWM_FILE`.

---

## Round 7 (reviews/security-code-core-round4.md)

No schema change; the schema stays at v7. tsc, the build and the full suite are green: 33 files, 727 tests. The regression tests are in `test/core-round7.test.ts`.

| Id | Resolution | Regression |
|---|---|---|
| SA-C4-01 (Low) | `api_key.created` audit details now also record `llm_opt_out`, `rate_limit_per_min` and `daily_quota`; `tenant` was already there. The integrity snapshot loads these columns. The cross-check flags any difference ("…: llm_opt_out, … differ from its api_key.created audit entry"). A field is compared only when the created entry records it, so keys from before round 7 are checked on `tenant` only. No code path changes a key's policy after creation, so there is no "policy changed" entry to follow. | P1: flipping `llm_opt_out`, raising the rate limit, removing the quota and changing the tenant are each detected; restoring the original values makes the check clean again. |
| SA-C4-02 (Low) | Cross-check of each `watched_notifications` row against its history:<br>• a `watched_notification.detected` entry must exist;<br>• `affected_prefixes` must equal, as a set, the last `detected`/`triaged` entry (a watcher-detected row starts as `[]`);<br>• a `dismissed`/`published` row needs the matching entry, and keyed rows (watcher, or manual with a notification key) need `requested_by`/`confirmed_by` in it;<br>• a row still `detected` must not have a resolve entry. | P3: a SQL dismiss of a keyed row and emptied prefixes are detected. The same prefix set in a different order is not flagged. Legitimate triage plus a two-admin resolve stays clean. A resolved row set back to `detected` is detected. |
| SA-C4-05 (Info) | The API `last_actors` message now reads "grant a third admin first (admin_grant), then disable. To cut off a leaked key now, revoke that key (create-key --revoke)". The script hint is gone. | 400 with the new text, and no `disable-actor.ts` in it. |
| SA-C4-03 (Info) | **Accepted residual.** One admin still chooses the prefixes of a keyed manual row when creating it. The row cannot be resolved, or narrowed, without a second admin, and it stays `detected`, so the SLA alert fires after the SLA period. The worst case is a delayed warning on the real codes, not silence. The creation is HMAC-audited with its prefixes, and the row is listed under pending notifications with its creator. The `pending()` cap of 200 can hide newer rows only behind other open rows, which alert themselves. A possible follow-up is to treat creation prefixes on a keyed manual row as a pending triage. | none (documented) |
| SA-C4-04 (Info) | **Accepted residual.** A backup taken before the first boot of the round-6 code, restored with the sidecar deleted, initialises silently: its audit log has neither `dataset.hwm_initialised` nor `dataset.restore_acknowledged`. **Runbook:** after upgrading to round 6 or later, boot once (which writes `dataset.hwm_initialised`), then take a fresh off-host audit-head export (`export-audit-head`). Discard or label older backups as needing `verify-audit --head` against an export before use. Production already forces the sidecar onto a separate path, outside the DB's directory. | none (documented) |

### Doc-facing changes
- **Audit:** `api_key.created` details gain `llm_opt_out`, `rate_limit_per_min` and `daily_quota`.
- **Cross-check coverage** (`/readyz` `audit_integrity`, `verify-audit`): now also key policy and watched-notification state and prefixes.
- **API:** the text of the `disable_actor` `last_actors` 400 changed.
- **Restore runbook:** add the SA-C4-04 step (boot once after the upgrade, then export the audit head off-host).

---

## Round 8 (02-TRD §15.2 traceability)

No schema change; the schema stays at v7. tsc, the build and the full suite are green: 35 files, 866 tests, of which **139 are new** (105 in `test/db/ddl.test.ts`, 34 in `test/trd-round8.test.ts`). Every new test name starts with its TRD id.

| TRD id | Test | Status |
|---|---|---|
| T-A14 | `test/db/ddl.test.ts`: all checks of `reviews/round2-tools/test-ddl.cjs`, ported. They run against the **code** schema (schema.sql plus every `MIGRATIONS` step), in order, on one in-memory DB, one `it` per check. A further check confirms that this schema equals what `migrate()` builds at `SCHEMA_VERSION`, and that `foreign_key_check` is clean at the end. The comparison of the data-model.md blocks with the code stays in the docs tool, because the docs live outside the server repo. | covered (103 trigger/constraint checks + 2) |
| T-U04 | `roundHalfUp` at 5/10, 4/10 and 15/10, and on the BigInt path at 2^53·10+5 → 2^53+1 (a value no Number can hold). | covered |
| T-U06 | Full pipeline on the shipped seed, **observed bands** rather than desired ones (see below). | covered (honest) |
| T-U10 | `todayIst` at 2026-10-09T19:00Z is 2026-10-10. Also 18:29:59Z → 9th and 18:30Z → 10th. | covered |
| T-T02 | Inter-state 7113 on ₹68,500 → IGST 2055.00 (205,500 paise), with zero CGST/SGST. | covered |
| T-T11 | `RateLimit-Cost` is 1 for 49 lines, 2 for 50, 2 for 99, 3 for 100 and 11 for 500. | covered |
| T-A07 | 400 for each of: `.evil.example` suffix, `@evil.example` userinfo, trailing dot, Cyrillic IDN, punycode form, port 8443, non-allowed host, http. The canonical URL is accepted, as are an explicit `:443` and an upper-case host. | covered, **bug fixed** |
| T-S09 | `loadConfig` refuses `HSN_LLM_ENABLED=true` when `HSN_LLM_DATA_DISCLOSURE_ACK` is missing or false. Booting `src/main.ts` that way exits non-zero and names the variable. | covered |
| T-S12 | Writes to rate_rules, rate_proposals, audit_log, synonyms, hsn_codes and dataset_state fail on the read-only connection and on the **new** cache-writer connection. The cache writer can write products, `api_keys.last_used_at` and idempotency_keys, but no other api_keys column. All three connections have `foreign_keys=1`, `trusted_schema=0` and no extension loading. | covered, **gap fixed** |

### Real issues the new tests uncovered (fixed)
1. **T-A07, trailing dot accepted.**
   - `sourceUrlProblem` stripped a trailing dot, so `https://cbic-gst.gov.in./n.pdf` passed and was stored and served to clients as the citation.
   - It is now refused: "Host must not end with a dot". The seed and the watcher are unaffected; seed URLs have no trailing dot.
2. **T-S12 / SEC-91, there was no cache-writer connection.**
   - The code had two connections. Product-cache writes, `last_used_at` updates and the classifier's cache used the full admin-writer connection, contrary to SEC-91 / SA-D-13.
   - Added `openCacheDb(path)` in `src/db/migrate.ts`. node:sqlite has no authorizer, so the restriction uses per-connection **TEMP triggers**: they refuse INSERT/UPDATE/DELETE on every table except `products` and `idempotency_keys`, and any change to `api_keys` other than `last_used_at`. FTS shadow tables are skipped; they are fed only by `hsn_codes` triggers.
   - `Storage` gains `cache` and `cacheDb`. They default to the write connection for in-memory databases and the scripts.
   - `main.ts` and the test `makeEnv` open the cache writer. `app.ts` (`touchLastUsed`) and `classifierDeps.ts` (product cache) now use it. `/metrics` counts products on the read connection.

### T-U06 observations (shipped seed, `rules-fts-2.2`; for the classify worker)

| Input | Design example (§5.5) | Shipped seed today |
|---|---|---|
| "dry fruits gift box" | 0813 0.45 low | no confident match: top 8450 0.15, all low, message, **no 0813** |
| "knitted cotton T-shirt" | 6109 0.84 medium (capped) | 6109 0.79 medium ✓ |
| "mobile phone stand" | 8517 0.17 low with message, 3926 dropped | **8517 0.78 medium**, over-confident for an accessory |
| category-only barcode (en:biscuits) | 0.30 low | 1905 0.30 low ✓ |

The dry-fruits and mobile-stand rows are honest gaps, with the observed values asserted. A seed synonym or curation change will move them; that should be reviewed, not "fixed" in the test.

### Other changes
- The proposal `target_rule` summary has a new `citation_note` field (string or null), in the DTO and the admin response schema.

### Doc-facing changes
- **SEC-91 / TRD §3:** the three connections now exist as specified; the cache writer is enforced by TEMP triggers.
- **T-A07:** a trailing-dot host in `source.url` now returns 400.
- **Admin API:** the proposal `target_rule` summary gains `citation_note`.
- **TRD §15.2:** T-A14, T-U04, T-U06, T-U10, T-T02, T-T11, T-A07, T-S09 and T-S12 are covered. Note the T-U06 observed-versus-design differences above.

## Round 9 (validator-round3 N1 / ruling 36, and the polish items)

Suite: 38 files, 895 tests passing; tsc and the build are clean. The new tests are in `test/core-round9.test.ts` and `test/docs/traceability.test.ts`.

### N1 / ruling 36: verify can replace an index-page citation
- A verify proposal's `source` takes two optional fields:
  - `url`: 8–2000 characters.
  - `notification`: 3–300 characters.
- The index-page set is listed explicitly and is configurable:
  - Defaults: `central-tax-rate.html`, `integrated-tax-rate.html` and `gst-goods-services-rates.html`, plus the watcher pages.
  - New env var `HSN_SOURCE_INDEX_PAGES` (CSV of absolute URLs) adds to that set.
  - A URL counts as a document when it is not in the set and its path contains `/view-pdf/` or ends in `.pdf`.
- Verify of an **unverified** rule:
  - If the current `source_url` is not a document and the proposal has no `source.url`, it returns 400 with the new problem type `source-url-not-document`. The error is `errors[0] = {pointer:'/source/url', code:'required'}`.
  - A `source.url` must be on an allowed host, include a path, and be a document. Otherwise it returns 400 `validation-failed` with pointer `/source/url`.
- `url` and `notification` are allowed only on the **first** verify, while the rule is unverified. On an already-verified rule they return 400 with pointer `/source` and code `forbidden`.
- On approval, one statement sets `source_url`, `notification_ref`, the verification fields and `citation_note = NULL` together.
- **Migration v8:** `rate_rules_guard_update` allows a `source_url`/`notification_ref` change only when all of these hold:
  - the rule goes from unverified to verified;
  - `last_verified_at` equals the `decided_at` of an approved verify proposal for the rule;
  - the new values equal that proposal's `payload.source.url` / `.notification`, or are unchanged where the proposal left them out.
  Any other change is refused.
- **Integrity cross-check:** a rule's citation must equal the one in its latest verify approval's audit snapshot.
- **Proposals that create rules:** create, supersede and correct proposals must also cite a document. An index-page `rule.source.url` returns 400.
- **End-to-end test** on the shipped 3004 nil rule (`nil_rate_list`, which cites `central-tax-rate.html`):
  - verify without a url returns 400;
  - an index-page or non-document url returns 400;
  - direct SQL is refused;
  - url plus notification is approved by the second admin, and GET /v1/hsn/3004 then shows the rule verified with the new citation and `citation_note: null`;
  - the cross-check is ok after that;
  - a re-verify with a url returns 400;
  - a change made behind the trigger is flagged.

### Polish
- **Validation errors:** Ajv now runs with `allErrors`.
  - The problem's `errors[]` lists every problem, deduplicated by pointer and keyword, up to 50.
  - `detail` reads `Request validation failed: N problem(s). See errors[].`. When the list is truncated, it reads `…: N problems; the first 50 are in errors[].`.
  - It is still RFC 9457.
- **Ambiguous lines:** an ambiguous line on a non-price condition now returns `needs_input: ["rule_id", "condition"]` when a default rule exists, meaning either `rule_id` or `condition: "general"` is accepted. Without a default rule it returns `["rule_id"]`. The `hsn` value still appears for the more-specific-code case.
- **Notification numbers:** the canonical form is `N/YYYY` without zero padding (`1/2026-CT(Rate)`). Whitespace is collapsed. The form is applied by:
  - the seed loader;
  - create, supersede and correct proposals;
  - verify `source.notification`.
  Content hashes change only for data loaded after this change.
- **Dataset metadata:** `GET /v1/meta/dataset` gains:
  - `known_data_gaps[]` with `{prefix|null, kind, reason}`. Kinds are `disputed`, `not_researched`, `not_transcribed`, `not_expressible` and `period_gap`.
  - `coverage.codes_without_rules`: master codes of 4 or more digits with no in-force rule at, above or below them.
- **Known-gaps file:** the gaps come from the new `data/seed/known_gaps.json`, which has 12 curated items: 7104 and 7117 disputed, the 3004 nil list not transcribed, cess, and others.
  - It is read once at boot and is not part of the dataset hash.
  - A missing file gives `[]`; a malformed file fails the boot.
  - The new optional env var `HSN_KNOWN_GAPS_FILE` overrides the path.
  - The file is documented in `data/seed/FORMAT.md`.
- **README:** quick-start step 7 now mentions `HSN_PORT` / `HSN_ADMIN_PORT` for when 3000/3001 are taken. This is the only README edit.
- **Traceability test:** `test/docs/traceability.test.ts` enforces the TRD §15.2 table. It checks that:
  - every T-id has a row;
  - every cited `file › "test name"` exists;
  - covered and partial rows cite a test.
  It reads `HSN_TRD_PATH`, which defaults to `docs/02-TRD.md`, and skips with a warning if the file is absent.

### Doc-facing changes (for the docs worker)
- **openapi:**
  - verify `source.url` and `source.notification`;
  - the problem type `source-url-not-document`;
  - `errors[]` can now hold several entries (cap 50) and the new detail text;
  - `needs_input` can include `condition`;
  - meta `known_data_gaps` and `coverage.codes_without_rules`.
- **.env.example / README config table:** `HSN_SOURCE_INDEX_PAGES` and `HSN_KNOWN_GAPS_FILE`.
- **Data model §4:**
  - migration v8 (the trigger rule above);
  - the notification_ref canonical form;
  - known_gaps.json.
- **TRD:**
  - T-A10 now covers the ruling 36 path;
  - add the round 9 tests to §15.2. The traceability test fails if a cited test name drifts.
- **Seed generator change request:** the generator still emits zero-padded refs such as `01/2026-CT(Rate), Schedule I/III`. The loader normalises them, but the generator should emit the unpadded form. The seed worker should also keep `known_gaps.json` in step with the README's gap list.
- **N2 (AG-12 sign-off in 00-coordinator-decisions.md):** this is a coordinator or docs task; no code is needed.

## Round 10 (validator-round4 N3, optional sources polish)

Suite: 39 files, 904 tests passing; tsc and the build are clean. The new tests are in `test/core-round10.test.ts`.

### Changes
- **Canonical citation is enforced:** `notification_ref` / `source.notification` must match `^[1-9][0-9]{0,3}/(19|20)[0-9]{2}-(CT|IT|UTT|Cess)\(Rate\)(, Schedule (I|II|III|IV|V|VI|VII))?$` after normalisation. This is the data-model §1 form. The validator's optional `, S.No. …` suffix is left out because the serial belongs in `schedule_serial`.
- **Normalisation:**
  - strips zero padding;
  - collapses whitespace;
  - rewrites the long series names (`Central Tax (Rate)`, `Integrated Tax (Rate)`, `Union Territory Tax (Rate)`, `(Compensation) Cess (Rate)`, `CT (Rate)`) to the short form. For example, `09/2025-Central Tax (Rate), Schedule I` becomes `9/2025-CT(Rate), Schedule I`.
- **Where it applies, with the response on failure:**

  | Entry point | Response on failure |
  |---|---|
  | create, supersede, correct proposals | 400 `validation-failed`, pointer `/rule/source/notification`, code `pattern` |
  | verify `source.notification` | 400 `validation-failed`, pointer `/source/notification`, code `pattern` |
  | seed loader | `SeedError` naming `rate_rules[i].notification_ref` |
  | `import-dataset propose` / `approve` (uses the same `prepareSeed`) | exit code 2 |

  The shipped seed conforms. No new problem type was needed.
- **Verify feed summary:** the `rule_verified` summary now names the citation as it stands after the approval. A verify that changes `10/2025` to `11/2025` shows `11/2025-CT(Rate)`.
- **Optional polish (done):** each `/v1/meta/dataset` `sources[]` entry gains `rule_count` and `verified_count`, the number of in-force rules citing that notification and URL and how many of them are verified.
- **Test fixtures:** the fixture seed's `(fixture)` suffixes became canonical refs (`1/2017-IT(Rate)`, `11/2017-CT(Rate)`). A seed test's `01/2017-IT(R)` became `01/2017-IT(Rate), Schedule V`. A round 9 test now uses `010/2025-Integrated Tax (Rate)`, which is stored as `10/2025-IT(Rate)`.

### Doc-facing changes (for the docs worker)
- **openapi:**
  - the `notification` fields document the pattern and the accepted long forms;
  - the 400 pointers `/rule/source/notification` and `/source/notification`;
  - meta `sources[].rule_count` and `sources[].verified_count`;
  - the `rule_verified` summary uses the post-approval citation.
- **Data model §1:** the long-name normalisation, and enforcement at every entry point including the seed and import-dataset. I already updated `data/seed/FORMAT.md` (the notification_ref row).
- **TRD §15:**
  - add the N3 case under T-A07 or T-A10, citing the `test/core-round10.test.ts` tests "create / supersede / correct refuse free text with /rule/source/notification", "verify refuses free text with /source/notification", "\"01/2026-CT(Rate), Schedule I\" is accepted and stored as \"1/2026-CT(Rate), Schedule I\"" and "a verify that changes the citation puts the new one in the rule_verified feed summary";
  - the seed and import-dataset cases are "a free-text notification_ref is refused by the loader; a padded one is normalised" and "import-dataset propose refuses a seed with a free-text citation".
- **Seed generator:** it can keep emitting long names or padding, since the loader normalises them. Anything else now fails the load.

### Round 10, part 2: security-code-core-round5.md (SA-C5-01 … 06)

The final suite is 40 files and 922 tests, all passing; tsc and the build are clean. The regression tests are in `test/security-core-round5.test.ts`.

- **SA-C5-01 (Medium, fixed):**
  - **Cost charged before validation:** the work-proportional cost hook moved from `preHandler` to `preValidation`. The tax route charges `1 + floor(n/50)` tokens from the raw `lines` length, so an oversized invalid body pays for its size: 85k items cost 1701 tokens.
  - **Structural pre-check:** a new guard (`src/lib/schemaGuard.ts`) runs before Ajv on every route with a body schema. It walks the schema alongside the parsed body and refuses with a short list:
    - any array over its `maxItems`, as one `maxItems` error per array, without looking inside it;
    - any body with more than 50 unknown keys, listing 50 of them with the total in `detail`.
  - **Ajv unchanged:** Ajv keeps `allErrors` with the 50 cap, and its work is now bounded by legitimate sizes.
  - **Measured:** 85k empty items take about 15 ms in total, of which about 10 ms is body parsing that any 256 KiB body pays. Before the fix this took about 430 ms. 85k bare numbers take under 10 ms.
  - **Test:** the test requires each case to take at most 10 ms beyond 2 × `JSON.parse` time, and under 50 ms absolute.
  - **On a default 600/min key**, the 85k body is answered 429 with "costs 1701 tokens".
- **SA-C5-02 (Medium, fixed):**
  - `codesWithoutRules` is now O(codes + rules), using sets of rule prefixes and their leading parts, instead of the correlated `substr()` SQL. It is equivalence-tested against the old SQL on random data.
  - At 20k codes and 3k rules it takes well under 50 ms.
  - `/v1/meta/dataset` caches the value per `(dataset_version, IST date)`, so repeats and 304s reuse it.
  - The meta body is still built per request, because the ETag hashes the body and the body includes watcher state. Its remaining queries are indexed and cheap.
- **SA-C5-03 (Info, fixed):** a document URL now must meet all of the following:
  - no query string or fragment;
  - a path exactly as written: no `;`, `..`, `//`, `%2e`, `%2f` or `%5c`;
  - the path is `/view-pdf/<id>[/…]` or a `*.pdf` file.

  Index pages are compared on origin plus a lower-cased path with repeated slashes collapsed and query and fragment ignored. Proposal citations (create, supersede, correct and verify, through `sourceUrlProblem(…, requirePath)`) refuse a query or fragment, so none is ever stored. Seed URLs are unchanged.
- **SA-C5-04 (Info, fixed):**
  - `HSN_KNOWN_GAPS_FILE` must be an absolute path in production; config refuses otherwise.
  - An explicitly set file must exist, be a regular file and be at most 256 KiB, or the boot refuses.
  - Parse errors say "not valid JSON" without quoting the contents; schema errors show at most 5 issues of 120 characters each.
  - The shipped default file may be absent, which gives `[]`.
- **SA-C5-05 (Info, fixed):**
  - Echoed property names are RFC 6901 escaped (`~0`, `~1`) and cut to 64 characters, and each pointer is capped at 256 characters.
  - `errors[]` is trimmed to at most 12 KiB of JSON, so the problem body stays under 16 KiB.
  - `detail` still gives the total count.
- **SA-C5-06 (Info, fixed):**
  - The traceability test now **fails** when the TRD is missing, and is skipped only with `HSN_TRD_PATH=skip`.
  - The default path is `/mnt/project-files/hsn-api/docs/02-TRD.md`. This corrects the Round 9 note, which said `docs/02-TRD.md`.
  - The test has already caught one drift: TRD row T-F04 cites a round 9 test by name, so that name is kept.

**Doc-facing changes (for the docs worker):**
- **openapi / API docs:**
  - the 400 for an array over `maxItems` (one error per array);
  - the 400 for more than 50 unknown fields;
  - tax tokens are charged before validation, so an invalid oversized request still costs `1 + floor(lines/50)`;
  - echoed names are truncated to 64 characters and `errors[]` is size-capped;
  - the stricter document-URL rule, with no query or fragment on proposal citations.
- **README / .env.example:**
  - `HSN_KNOWN_GAPS_FILE`: absolute in production, must exist, at most 256 KiB;
  - `HSN_TRD_PATH`: default `/mnt/project-files/hsn-api/docs/02-TRD.md`, `skip` to skip the test; a missing TRD fails the suite.
- **TRD §15.2:** cite the `test/security-core-round5.test.ts` tests for SEC-22 and SEC-75.
