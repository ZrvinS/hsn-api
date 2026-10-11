# 07 — Engineering Best Practices (HSN Rate API)

Status: binding conventions for `server/`. Subordinate to `00-coordinator-decisions.md`, `00b-coordinator-rulings.md` and `00c-coordinator-rulings-round2.md`. Security specifics live in `05-security-checklist.md`, AI rules in `06-ai-restrictions.md`.
Where this doc makes a choice (e.g. rounding), the choice is the contract; changing it is a breaking change.

## 1. TypeScript and project setup

- Node.js 22 LTS, ESM (`"type": "module"`), TypeScript with these flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`.
- `npm run typecheck` = `tsc --noEmit`, and it must pass with zero errors. No `any` in `src/` except at a validated boundary with a comment.
- Use branded types for domain primitives so they cannot be mixed up: `type HsnCode = string & { __brand: 'HsnCode' }`, `Paise` (integer), `RateBp` (integer basis points), `IsoDate` (`YYYY-MM-DD`), `DatasetVersion`. Their constructors (`HsnCode.parse`, `Paise.fromRupeeString`) are the only way to create them.
- No floating-point money or rates anywhere in the domain layer (see §6).
- One config module (`src/config.ts`) parses `process.env` with zod once at boot, exports a frozen typed object, and exits non-zero on failure (fail closed).

## 2. Module boundaries

The layout is the one in `design/architecture.md` §3 (00b ruling 1) and TRD §2:

```
src/
  main.ts             Entrypoint: loadConfig → openDb → migrate → buildApp → listen (public + admin listeners)
  app.ts              buildApp(deps): Fastify instance, hooks (auth, rate limit, request id, error handler), no plugins
  config.ts           zod env schema, frozen, fail closed
  routes/*.ts         HTTP only: schemas, parse → call service → map to response DTO
  services/*.ts       Business logic: rates (resolver), tax, proposals, audit, auditExport, dataset, idempotency, apiKeys, watcher
  repositories/       types.ts (interfaces) + sqlite/ implementations
  classify/*.ts       Normalise, GTIN, synonyms, FTS, chapter keywords, barcode category, fusion, rerank, pipeline (06-ai-restrictions)
  adapters/*.ts       Product lookup port, Open Food Facts, Open Beauty Facts, LLM, cbicWatcher,
                      and httpClient.ts: the only outbound HTTP client (SEC-32)
  jobs/               Schedulers (in-process watcher run when HSN_WATCHER_ENABLED, nightly verify); they call adapters and never import httpClient themselves
  lib/*.ts            Pure helpers and plumbing: problem (error registry), auth/apiKey, rateLimit, etag, money, dates, ids, ip, requestId, redact
  db/                 openDb (three connections: read-only, cache writer, admin writer; SEC-91), migrate, schema, seed loader
scripts/              seed, create-key, bootstrap-admins, export-audit-head, verify-audit, rotate-feed-epoch, disable-actor,
                      ack-restore, watch-cbic, eval-classifier (npm eval), import-dataset
                      (operator CLIs; npm scripts of the same names, 00c ruling 31; no keys.ts, no restore.ts)
```

Rules:

- **Dependency direction:** `routes → services | classify → repositories`. Everyone may import the pure helpers in `lib` (money, dates, ids). Never the reverse.
- **Outbound HTTP:** only `src/adapters/*` may import `adapters/httpClient.ts`, and no other file calls `fetch`, `http(s).request` or `undici` (SEC-32). A scheduler in `jobs/` calls an adapter function and never imports the client.
- **Layer rules:** routes never import repositories or `node:sqlite`. Services never import Fastify types (`FastifyRequest`, `reply`). Repositories never contain business rules (no threshold logic in SQL). SQL text is literal (SEC-39).
- **Storage-agnostic interfaces:** repository interfaces have no SQLite-only types in their signatures, so Postgres can replace SQLite. FTS specifics stay inside the SQLite HSN repository's `search()`.
- **Injection:** services receive dependencies by constructor injection (plain objects, no DI framework). `buildApp({ config, repos, clock, llm })` makes everything testable; `clock` is injected so "today" is controllable.
- **Enforcement:** the T-X01 test scans imports (e.g. `routes/**` must not match `from '../repositories`; `httpClient` imported only under `adapters/`). Convention alone is not enough.
- **Pure code:** the pure helpers in `lib/` (`money`, `dates`, `ids`) and the scoring code in `classify/fusion.ts` have no I/O, no `Date.now()` and no env access. Property tests focus here.

## 3. Error model — RFC 9457 problem details

All non-2xx responses are `Content-Type: application/problem+json`:

```json
{
  "type": "https://hsn-api.example/problems/hsn-not-found",
  "title": "HSN/SAC code not found",
  "status": 404,
  "detail": "No HSN/SAC \"7199\" in dataset 2026.10.03-1. Try GET /v1/hsn/search?q=…",
  "instance": "/v1/hsn/7199",
  "request_id": "req_01J9ZQ4V6W0F3K2H8M5N1P7R9X",
  "code": "hsn_not_found"
}
```

- **`type`** URIs end in a stable kebab-case suffix, and clients switch on it.
- **Members:** `instance` is the request path. `request_id` (always the server's `req_` ULID), `client_request_id` (when sent), `code` (the server's snake_case machine code, a convenience only) and `errors[]` are extension members.
- **Registry:** the table in `design/ui-and-dx.md` §1 is the registry, mirrored in `openapi.yaml` (`Problem`); in code it is `src/lib/problem.ts`. Suffixes:

| Status | Suffixes |
|---|---|
| 400 | `validation-failed` (plus `errors: [{ pointer, code, message }]`, every problem up to 50 and 12 KiB, with the total in the detail text; core round 9. Since core round 10 an oversized array gets one `maxItems` error and more than 50 unknown keys get 50 errors, before full validation; echoed key names are escaped and cut to 64 characters), `idempotency-key-required`, `source-url-not-document` (ruling 36) |
| 401 | `unauthenticated` |
| 403 | `insufficient-scope`, `forbidden-ip`, `maker-checker-violation`, `not-proposer` |
| 404 | `hsn-not-found`, `not-found`, `proposal-not-found` |
| 405 | `method-not-allowed` |
| 409 | `overlapping-rule`, `proposal-not-pending`, `proposal-hash-mismatch`, `proposal-stale`, `rule-not-active`, `proposer-disabled`, `idempotency-conflict`, `duplicate-notification` |
| 410 | `feed-window-expired` |
| 413 | `payload-too-large` |
| 415 | `unsupported-media-type` |
| 422 | `invalid-gtin`, `unknown-hsn`, `rule-choice-invalid` |
| 429 | `rate-limited`, `quota-exceeded` |
| 500 | `internal` |
| 503 | `not-ready`, `dataset-not-loaded`, `classifier-unavailable`, `admin-writes-disabled` |

  `no-rate-for-date` was removed (validator fix 22): an HSN with no rule on the date is a `200` with `coverage: "no_rate_rule"`.
- Throw a typed `AppError(code, detail?)` from services; one Fastify `setErrorHandler` maps it to problem+json. Unknown errors become `internal` with a generic detail (SEC-73).
- `detail` may echo only values that passed a strict format check (digit-only codes, ids). Never echo free text (`name`, `q`, `rationale`, URLs) or a GTIN that failed its check digit (SEC-75, validator fix 20).
- Classification uncertainty is **not** an error: low confidence returns 200 with `needs_review: true`. Ambiguous rates return 200 with `coverage: "ambiguous"`.

## 4. Versioning

### 4.1 API versioning
- Path-based major version `/v1`. Within v1, only additive changes: new optional request fields, new response fields, and new values in documented open enums (problem `type`s, reason codes, warnings). Clients must ignore unknown fields and tolerate new enum values.
- Breaking changes (renaming or removing fields, changing rounding, band thresholds or types) require `/v2`. `/v1` is kept ≥ 12 months after `/v2` GA, with `Deprecation` and `Sunset` headers (RFC 9745 / RFC 8594).
- The contract is `docs/design/openapi.yaml` (OpenAPI 3.1). CI checks that the route table matches it (SEC-09).

### 4.2 Dataset versioning
- `dataset_version` = `YYYY.MM.DD-N` (e.g. `2026.10.10-1`), incremented on every approved publish. `dataset_versions` stores `content_sha256` (RFC 8785 JCS export of active rules, codes and reference data; 00c ruling 11), counts and the reason (SEC-54).
- Every rate, search and classify response includes `dataset_version`, so a client can reproduce an answer later.
- `classifier.version` (currently `rules-fts-2.3`) versions the classification logic and weights separately. Bump it on any change a caller could observe; the eval baseline must be a strictly older version (06 AI-42).
- `feed_epoch` identifies the dataset lineage; it changes only on restore (detected automatically, or rotated by hand) (§13).

## 5. Effective-date modelling

- **`rate_rules` columns** (DDL names; exact DDL in `design/data-model.md` §2; validator fix 27):
  - `rule_id`, `hsn_prefix`, `igst_rate_bp` (IGST rate; CGST and SGST/UTGST are each half);
  - `cess_rate_bp` (ad valorem), `cess_specific_paise` and `cess_specific_unit` (a specific cess is returned as data but not computed in v1);
  - `condition_kind` (`none`, `price`, `other`), `condition_text`, `condition_code` (`other` only, e.g. `nil_rate_list`), and `min_unit_price_paise` / `max_unit_price_paise` (both inclusive);
  - `effective_from` (inclusive) and `effective_to` (inclusive; NULL = open-ended);
  - `notification_ref` (API: `source.notification`; canonical form such as `9/2025-CT(Rate), Schedule IV`: `N/YYYY` without zero padding, whitespace collapsed and long series names such as `Central Tax (Rate)` shortened to `CT(Rate)`; since core round 10 anything that then fails the data-model §1 pattern is refused by the seed loader, `import-dataset` and every proposal input), `source_url` (https, exact host from `HSN_SOURCE_HOSTS`; a notification document, `/view-pdf/<id>` or a `.pdf` file with no query, fragment or encoded path tricks, never a listing/index page: ruling 36, core round 10), `schedule_serial`, `source_pdf_sha256`;
  - `verification_status` (`verified` | `unverified`), `verified_by` and `last_verified_at` (both null while unverified), `reverify_due_at`;
  - `status` (`active` | `voided`), `superseded_by`, `proposal_id` or `seed_batch_id`.
- **Civil dates.** Dates are civil dates in India (Asia/Kolkata). If `?date` is omitted, "today" is computed in `Asia/Kolkata` from the injected clock — never server-local time or UTC date.
- **No overlaps.** For a given `hsn_prefix` and condition key, active intervals do not overlap (checked at proposal time, 409 `overlapping-rule`, and by a DB-level test). Gaps are allowed and reported by `/v1/meta/dataset` coverage stats.
- **History is never edited** (SEC-52). A change closes the old row (`effective_to` = new `effective_from` − 1 day, set once) and inserts the new row with a `supersede` proposal.
- **Corrections (00c ruling 1).** A wrong row is fixed with a `correct` proposal. It sets the target `status = voided` (kept forever and excluded from resolution) and inserts the replacement in the same transaction. The feed emits one `rule_corrected` row carrying `rule_id` (the replacement) and `related_rule_id` (the voided rule). There is no `reason` field and no other correction mechanism.
- **Hierarchy.** A rule may be defined at the 2-, 4-, 6- or 8-digit level, or at 5 digits for SAC groups in chapter 99 (00c ruling 6); the prefix must exist as a code. Resolution picks the most specific code that has a rule for the date, and the response states `matched_at_level`. Never extrapolate an 8-digit rate down to siblings that have their own rule.
- **Price thresholds** (a rate that depends on value per piece): `condition_kind = 'price'` with inclusive `min_`/`max_unit_price_paise` bounds derived from the notification wording ("not exceeding ₹2,500" → max 250000; "exceeding ₹2,500" → min 250001); `condition_text` quotes the notification. Without `unit_price` (or a derivable one, §6) → all rules returned with `coverage: "ambiguous"` and `default_rule_id` when a general rule exists.
- **Non-price conditions** ("branded/pre-packaged", "for specified use", the nil-rate drug list) cannot be resolved automatically. Return all rules with `coverage: "ambiguous"`, the condition text and `default_rule_id`. The client picks with `rule_id` or `condition: "general"`. One exception: an exact curated synonym `rule_hint` on the caller's name may select a rule (warning `selected_by_hint`, 00c ruling 5, `06` AI-09).
- **Retroactive changes** need `retroactive_reason`, and their feed rows carry `retroactive: true` and `affects_from` (SEC-93).
- **Time of supply.** Determining which date applies to an invoice is the client's legal responsibility; we resolve for the date they pass. Say so in the docs.

## 6. Money and tax maths

- **Representation:** all amounts are integer **paise** (`Paise`, a safe integer; max per line 1e12 per SEC-30). Rates are integer **basis points** (`3% = 300`, `0.25% = 25`). Inputs are INR JSON numbers with ≤ 2 decimals (OpenAPI `multipleOf: 0.01`, checked on the decimal string). They are converted to paise from the number's decimal string form, never `x * 100` on floats. Outputs give every amount twice (00c ruling 32): rupee numbers in `tax` / `totals` (`cgst`, 2 decimals) and integer paise under the same keys in `tax_paise` / `totals_paise` (`tax_paise.cgst`).
- **Formula (per line, per component):**
  - Intra-state (`supply_type: intra`): `cgst = roundHalfUp(taxable_paise × rate_bp, 20000)`; `sgst` the same (computed independently, identical values). Dividing by 20000 avoids fractional basis points for odd splits (0.25% → 0.125% each).
  - Intra-UT (`supply_type: intra_ut`, a Union Territory without legislature; 00c ruling 15): CGST + **UTGST**, each computed as above; `sgst` is 0. Every amounts object carries both `sgst` and `utgst`.
  - Inter-state (`supply_type: inter`): `igst = roundHalfUp(taxable_paise × rate_bp, 10000)`.
  - Ad-valorem cess: `roundHalfUp(taxable_paise × cess_bp, 10000)`. A specific cess is returned as data on the rule and not computed in v1; the line gets a note.
  - `roundHalfUp(n, d)` uses integer arithmetic. With our caps, `1e12 × 4000 = 4e15` fits below 2^53, but the helper uses `BigInt` anyway for safety.
- **Rounding choice (documented contract):** round **per line, per tax component, half-up to the paisa**. Invoice totals are sums of rounded line values, with no re-rounding at invoice level by default. Consequence: CGST+SGST for a line can differ by 1 paisa from the IGST for the same line. This is expected and documented.
- **Rupee rounding:** optional request flag `invoice_rounding: "none" | "nearest_rupee"` (default `none`). When set, the response adds `round_off_paise` and `grand_total_paise` (taxable value plus tax), rounded to the nearest rupee (half-up), leaving tax components untouched. Whether and how to round the printed invoice is the client's accounting decision; we only compute.
- **Quantity (00c ruling 7, validator fix 7):** a decimal with ≤ 3 places, held as `qty_milli`. It never changes the tax base. When `unit_price` is absent and `quantity` is given, the unit price used **only to pick a price-threshold rule** is `roundHalfUp(taxable_paise × 1000, qty_milli)`.
- **Line identity:** `line_id` defaults to the zero-based index as a string (`"0"`, `"1"`, …). Each result line carries `igst_rate_bp`; persist it with `rule_id` and `dataset_version`.
- **Taxable value:** `taxable_value` is what the client provides (after discounts, including making charges where they form part of the supply). We do not split mixed or composite supplies. Default reading (per research; open question PRD Q1 for Sunarone's CA): making charges billed with a jewellery sale are part of that 3% supply and go inside the Chapter 71 line. SAC 9988 job work at 5% applies only to work on customer-owned metal.
- **Unresolved lines:** each response line echoes `hsn`, the rule used (`rule_id`, `igst_rate_bp`, `igst_rate_percent`, `effective_from`, `source`, `verification_status`) and `ambiguous`. If the rule could not be resolved, or is unverified without `accept_unverified: true` (00c ruling 24), then:
  - no tax is computed for that line (`tax: null`);
  - `needs_input[]` names what would resolve the line, any one entry being enough (`unit_price`, `rule_id`, `condition`, `hsn` or `accept_unverified`; 3004 without a choice gives `["rule_id", "condition"]`, core round 9), mirrored in `notes[]`;
  - the line is excluded from totals (`complete: false`).
  A line computed on an unverified rule because the client accepted it carries `unverified_accepted: true`.

## 7. Caching and ETags

The table is copied verbatim from TRD §11 (validator fix 19; 00c ruling 4):

| Route | ETag | Cache-Control |
|---|---|---|
| `GET /v1/hsn/{code}`, `GET /v1/hsn/search` | yes | `private, max-age=<min(3600, seconds to next IST midnight)>, must-revalidate` |
| `GET /v1/rates/changes`, `GET /v1/meta/dataset` | yes | `private, no-cache` |
| `POST /v1/classify`, `POST /v1/tax/calculate`, all `/v1/admin/*`, `/healthz`, `/readyz` | no | `no-store` |

- **ETag (weak):** `W/"ds-{dataset_version}-{sha256(dataset_version, as_of_ist, body)[:16]}"`. `as_of_ist` is the resolved date, so the tag changes at IST midnight when a pre-loaded rule takes effect, even if the dataset did not change. Honour `If-None-Match` → 304.
- **Server side:** an in-process LRU of resolved rule sets keyed by `(dataset_version, code, as_of)`. The `unit_price` filter is applied after the cache, so varying prices cannot evict other tenants' entries. Invalidated wholesale on publish. There is no API-key cache (revocation is immediate, SEC-16).

## 8. Idempotency

- `GET` routes, `/v1/classify` and `/v1/tax/calculate` have no side effects on rate data (pure for a given dataset and classifier version), so they are safe to retry.
- **Admin writes** require an `Idempotency-Key` header (UUID; 00c ruling 28): proposal create, approve, reject, withdraw; watched-notification create, triage, resolve; product purge. A missing header is 400 `idempotency-key-required`.
  - Storage: `idempotency_keys` (00c ruling 8) per `(key_id, idem_key)` with `route`, `request_sha256`, `status_code` and `response_json`, for 24 h. It is written inside the write transaction.
  - Same key + same body → the stored response is replayed with the header `Idempotent-Replayed: true`. Same key + different body → 409 `idempotency-conflict`. The same key under another API key is independent.
- **Approving twice** (validator fix 21): a replay with the same `Idempotency-Key` and body returns the stored 200. Any other approve or reject of a non-pending proposal returns 409 `proposal-not-pending`. There is never a second publish.
- **Approval binding:** approve and reject also carry `expected_sha256` (the proposal's `content_sha256`); a mismatch is 409 `proposal-hash-mismatch` (SEC-44).

## 9. Observability

- **Request id** (validator fix 23): the server always generates `request_id` = `req_` + ULID. It returns it in `X-Request-Id`, in every problem body and in logs. A client `X-Request-Id` matching `^[A-Za-z0-9._-]{1,64}$` is kept separately as `client_request_id` (echoed in problems and logged); anything else is ignored.
- **Structured logs** (pino): one line per request with `request_id`, `client_request_id`, `key_id`, `tenant`, route pattern (not the raw URL), status, `latency_ms` and `dataset_version`. Domain events:
  - `classify.decision` (AI-50; `input_hash` is HMAC with `HSN_LOG_KEY`);
  - `rate.resolved_ambiguous`, `tax.unverified_accepted`;
  - `outbound.call` (host, status, ms), `outbound.throttled`;
  - `ai.fallback` (cause code only);
  - `admin.proposal_created`, `admin.proposal_approved`, `admin.proposal_withdrawn`, `admin.grant_approved` (warn, `alert: true`; v1 has no out-of-band notifier, 00c ruling 29);
  - `watcher.failed`, `watcher.freshness_alert`, `watcher.new_notifications` (each with `"alert": true`);
  - `auth.failed`, `auth.bruteforce_suspected`.
  Redaction per SEC-61/62.
- **Metrics:** minimal Prometheus text at `GET /metrics` on the admin listener only (`HSN_ADMIN_HOST:HSN_ADMIN_PORT`; never on the public listener; 00c ruling 30, SEC-100). The metric list is TRD §14 (`hsn_http_requests_total`, `hsn_http_request_duration_seconds`, `hsn_classify_top_band_total`, `hsn_watcher_last_success_timestamp_seconds`, `hsn_rate_rules_unverified`, product-cache size, …).
- **Health:** `/healthz` = process alive. `/readyz` = DB open, FTS5 probe passed at boot, dataset `content_sha256` rechecked at boot, config valid. Publicly it returns only `{status}`, and a 503 has a generic detail. Neither endpoint reveals dependency versions.
- **Alerts:**
  - 5xx rate > 1 % for 5 min;
  - p95 latency > 500 ms (`/hsn`) or > 1.5 s (`/classify`);
  - freshness: the watcher's last successful run is older than 36 h, or a watched notification is unreviewed past the 2-business-day SLA (watcher exit code 3, `watcher.freshness_alert`, `GET /v1/admin/watcher/status`). Never alert on dataset age, which can legitimately stay unchanged for months;
  - audit chain or `rule_sha256` verification failure (page immediately);
  - meta `coverage.rate_rules_verification_overdue` > 0.

## 10. Testing pyramid

| Layer | Scope | Tooling / location | Must cover |
|---|---|---|---|
| Unit | `lib/` pure helpers (money, dates, ids), `classify/` pure functions | vitest, `test/unit` | GTIN check digits; FTS query builder (escaping, zero tokens); band boundaries and the high gate; effective-date resolution; rounding helper; IP classifier (SEC-34) |
| Property | Tax maths and money parsing | vitest + a small hand-written generator (no new deps), or `fast-check` if approved | see below |
| Golden-file | Rate resolution against a fixture dataset | `test/golden/*.json` | each fixture is `{ code, date, unit_price?, expected: { igst_rate_bp, effective_from, source: { notification } } }`, with its source cited (AG-01) or labelled a fixture value |
| DDL | Triggers and constraints | `test/db` (the DDL in data-model §2) | each SEC-52 guard; admin key CHECKs; maker ≠ checker |
| Integration (HTTP) | Whole app via `app.inject()` on both listeners, with a temp SQLite file | `test/http` | every route: auth, scopes, validation errors, problem+json, headers, ETag/304, rate limit, idempotency |
| Security | Checklist-driven | `test/security` | one test per SEC item marked "Test" |
| Eval | Classifier quality | `npm run eval` | gates AI-42/43 |

Property tests for tax maths (≥ 1 000 runs each):
- `cgst == sgst` (or `cgst == utgst`) for every line; `|cgst + sgst − igst| ≤ 1` paisa for the same input.
- Monotonic: a higher `taxable_paise` never yields lower tax for the same rate.
- Zero rate → zero tax; `rate_bp = 10000` → tax equals the taxable value.
- The invoice total equals the sum of line totals exactly (no drift).
- `Paise.fromRupeeString(Paise.toRupeeString(p)) === p` round-trip.
- No result is non-integer or exceeds `Number.MAX_SAFE_INTEGER`.
- `quantity` never changes the tax amounts for a fixed rule.

Rules:
- Tests use an injected clock and fixture datasets, never the network. Outbound calls are mocked at the `adapters/httpClient.ts` dispatcher or at the adapter ports.
- Coverage target ≥ 90 % lines for `lib/` pure helpers, `classify/` and `services/`.
- CI runs `typecheck`, `test`, `eval`, `npm audit` and the secret scan.

## 11. Documentation

- `docs/` holds the numbered design docs. `server/README.md` covers run, test and configure. `docs/design/openapi.yaml` is the API reference, with examples for every route, including `needs_review: true` and `coverage: "ambiguous"` responses.
- Every response example in the docs uses illustrative data clearly labelled as such, or real data with its notification citation.
- The `disclaimer` text lives in one constant, is returned in every rate, classify and calculate response, and is reviewed by the owner (Amit). It states that rates are curated from CBIC notifications, may lag new notifications, are not legal or tax advice, and that the user should verify against the cited notification.
- `CHANGELOG.md` for code (semver) and `DATASET_CHANGELOG.md` for data (one entry per `dataset_version`, listing the notifications applied).
- The seed file format is the shared `server/data/seed/FORMAT.md`; `design/data-model.md` §7 lists the DDL constraints that win where the two differ.

## 12. Release and data-update process

**Code release**
1. PR → CI green (typecheck, tests, eval gates, audit, secret scan).
2. Validator and security auditor reports in `reviews/` with no open Critical/High (AG-20/21).
3. Tag, build, deploy to staging, run smoke tests (`/readyz`, golden subset over HTTP), then deploy to production.

**Data update (new CBIC notification)**

1. The CBIC watcher (`npm run watch-cbic` from cron every 6 h, or in-process) records new Central Tax (Rate) and Integrated Tax (Rate) notifications as `detected` rows. Daily triage on the admin listener: `GET /v1/admin/watcher/status` → `GET /v1/admin/watched-notifications` → open the source → `POST …/{id}/triage` with the affected prefixes. UTGST (Rate) and Compensation Cess (Rate) notifications are not watched; check those listings by hand. The researcher then records the notification in `research/`: number, date, URL, effective date, affected HSN, old → new rate. No source → no change.
2. The maker submits one proposal per change via `POST /v1/admin/rate-proposals` on the admin listener. Each carries the citation, `schedule_serial`, the PDF's `source_pdf_sha256`, the effective date and, if retroactive, `retroactive_reason`.
3. The checker (a different admin actor) fetches each proposal (`GET …/{id}`) and compares it against the notification PDF. They approve **one proposal per call** with its `expected_sha256`. There are no bulk approvals (00c ruling 20).
4. Publishing creates the new `dataset_version`, `content_sha256`, HMAC audit entries (with `rule_sha256`) and change-feed events. There is no out-of-band notice in v1 (deferred to Later, 00c ruling 29); the approval is audited and logged. Golden tests for affected codes are updated in the same cycle.
5. Post-publish:
   - run `scripts/export-audit-head.ts` and copy the head off the host (SEC-97);
   - `/v1/meta/dataset` shows the new version;
   - the change feed shows the events;
   - spot-check 5 codes;
   - resolve the watched notification: `POST /v1/admin/watched-notifications/{id}/resolve {state: published}` (or `dismissed` if nothing changes for us).
6. Future-dated changes are entered as soon as they are notified (with a future `effective_from`), so clients can pre-load them.
7. Re-verification (00c ruling 9): a verified rule is due again at `reverify_due_at` (`last_verified_at` + 12 months). Overdue rules carry the `verification_overdue` warning until a `verify` proposal re-confirms them. Re-verify each rule against its notification; never in bulk.

Target: notifications reflected within 2 working days of publication on the CBIC site (NFR-07).

New HSN codes go through the same maker–checker path as a `refdata_change` with `{table: hsn_code, op: add_code, …}` (published with an `hsn_added` feed row); a description change is `{table: hsn_description, op: update, …}`.

**First production load:** `npm run seed` is refused in production. Load `data/seed` with `npm run import-dataset -- propose …` by one admin and `… approve …` by another (02-TRD §13, `server/README.md`). Every loaded rule is `unverified`; the go-live gate (ruling 24) still requires each rule in a live tenant's chapters to be verified through a `verify` proposal first.

**After a restore:** start the service; it detects the restore (database behind the high-water mark in `HSN_STATE_HWM_FILE`, or a missing sidecar), rotates `feed_epoch` so clients resync, and fails `/readyz` until `npm run ack-restore -- --by <actor> --note "<incident note>"` and a restart (SEC-81). After upgrading to round 6 or later, boot once (it writes `dataset.hwm_initialised`) and then export a fresh audit head off-host; treat older backups as needing `verify-audit --head` against an export before use (SA-C4-04).

## 13. Client integration best practices (publish to clients)

- **Cache locally; sync with the change feed.** On first run, pull rates for the HSN codes you use. Then poll `GET /v1/rates/changes?since=<seq>` every 15 min (and at startup) with `If-None-Match`, and apply the events. Keep working from cache if the API is down — do not block billing on our availability.
- **Invalidate in both directions (00c ruling 3).** For each change with `affected_prefix` p, drop every cached code c where `c.startsWith(p) || p.startsWith(c)`. For a `rule_corrected` change, also drop anything that used `related_rule_id`.
- **Resync when the lineage changes (SEC-49).** Store `feed_epoch` from the feed and `/v1/meta/dataset`. If it changes, or you get `410 feed-window-expired`, discard the cache and do a full resync from `since=0`. Your stored `dataset_version` must never go backwards; if the server reports an older one, treat it as a lineage change and resync.
- **Store what you used.** Persist `rule_id`, `igst_rate_bp`, `effective_from`, `source` and `dataset_version` with each invoice line, so the invoice can be explained later.
- **Always show source and date to end users** where a rate is displayed or chosen, e.g. "GST 3% · CBIC Notification <no.> · effective <date> · verified <last_verified_at>" when `verification_status` is `verified`, otherwise "· unverified". Never present our rate as "official".
- **Handle warnings.** Show `rate_unverified`, `verification_overdue` and `pending_change_detected` next to the rate. Do not hide them.
- **Handle `needs_review`.** For classify results with `needs_review: true`, show the candidates with reasons and ask the user to confirm the HSN; don't auto-apply. Barcode-only results are never `high`; send the product name too. Remember the user's confirmed choice per product (client-side), so they are asked once.
- **Handle `coverage: "ambiguous"`.** Pass `unit_price` (per piece, in rupees, on the same basis as the notification) when you have it. Otherwise show all applicable rules with their condition text and let the user choose, then send that `rule_id` (or `condition: "general"`) on the tax line.
- **Decide on unverified rates explicitly.** Send `accept_unverified: true` only if the business accepts tax computed on a rule no reviewer has checked yet.
- **Pass the right date.** Send `date` = the time-of-supply date for back-dated or future invoices; omitting it means "today in IST".
- **Keep keys server-side.** Never ship an API key in a browser or mobile app bundle; call us from your backend. Use separate `test` and `live` keys, and rotate per SEC-15.
- **Retry politely.** Retry idempotent calls on 429/503, honouring `Retry-After` and the `RateLimit-*` headers, with exponential backoff and jitter. Do not retry 4xx validation errors.
- **Don't send personal data** in `name` (customer names, phone numbers, order notes). Send the product description only.
- **Example (Sunarone, jewellery; illustrative workflow — the rates themselves come from the API):**
  - Cache Chapter 71 codes at startup, plus SAC 9988 if Sunarone does job work.
  - For an outright jewellery sale, send one Chapter 71 line whose `taxable_value` includes the making charges (they are part of the 3% supply).
  - Send a separate SAC 9988 line only for genuine job work on customer-owned metal.
  - Print the source notification and dataset version in the invoice audit trail.
  This is the default reading per research and remains open question PRD Q1 for Sunarone's CA.
