# 01 — Product Requirements (HSN Rate API)

Owner: Amit · Status: draft for review · Date: 2026-10-11
Binding inputs: `00-coordinator-decisions.md`, `00b-coordinator-rulings.md`, `00c-coordinator-rulings-round2.md`, `research/sources.md`. Technical detail: `02-TRD.md`. Flows: `03-app-flow.md`.

---

## 1. Problem

Indian billing apps have to print the correct HSN/SAC code and GST rate on every invoice line. Today each app keeps its own hand-made rate table. Those tables go stale whenever CBIC issues a rate notification: 9/2025-CT(Rate) replaced the whole goods schedule on 22-09-2025, 19/2025 moved tobacco on 01-02-2026, and 01/2026 split heading 2202 on 01-05-2026 (per secondary sources; gazette not yet read). Shop staff also do not know which HSN a product belongs to, so they guess.

Amit's request, in his words: *"an API server where any app that uses HSN numbers can get the GST billing percentage … so my own Sunarone and health app can connect and automatically get the current GST on the product; when a user gives the product name or barcode, the HSN code and GST value should be automatically detected."*

The product is **HSN Rate API**, one shared service that:
1. returns the GST rate rules that apply to an HSN/SAC code on a given date, each with a citation;
2. suggests HSN codes for a product name or barcode, ranked, with a confidence score;
3. calculates CGST/SGST (or UTGST)/IGST/cess for invoice lines;
4. tells client apps when rates change so their caches stay correct.

## 2. Data sourcing and what "real-time" means here

> **Short version:** there is no official, free, real-time GST rate API. We publish rates **curated from CBIC notifications**, versioned by effective date, with a citation and a `last_verified_at` on every rate. When a new notification is published, we aim to reflect it **within 2 business days, after human review**. HSN detection from a name or barcode is a **best guess** with a confidence score. It is never a silent answer.

### 2.1 What exists officially (research findings)
- **No official rate API.** No public CBIC or GSTN API returns GST rates. The GST portal's "Search HSN Code" is a UI with no rate field, and commercial APIs describe themselves as "aggregating publicly available GST data" on a "best effort" basis (`research/sources.md` §1.2; confidence H).
- **Rates exist only as PDF notifications** in the e-Gazette and on CBIC's portal. Schedules are tables inside the PDFs, with no XML or CSV version (§1.2).
- **The HSN master (codes and descriptions, no rates)** is downloadable from the GST portal as Excel (`HSN_SAC.xlsx`). Its contents have not yet been verified (§1.2).
- **GST Council outcomes are recommendations.** They do not change the law until CBIC issues a notification (§1.1). The 57th meeting (08-10-2026) made no rate changes, and rates are now to be reviewed once a year (§2.3).
- **No barcode database returns HSN.** Open Food Facts, UPCitemdb and others give a product name and category only. GS1 India DataKart has no public third-party API (§4).

### 2.2 Our approach
| Step | What happens | Frequency |
|---|---|---|
| Watch | A job (`npm run watch-cbic`) polls the CBIC Central Tax (Rate) and Integrated Tax (Rate) notification pages, diffs the notification numbers, and records each new one as a `detected` watched notification for a reviewer to triage. It never changes a rate. The UTGST (Rate) and Compensation Cess (Rate) listings are not watched yet and are checked by hand. GST Council press releases are tracked as "announced", not "in force". 2–3 secondary sources (taxguru, taxmann, ICAI branches) give early warning but **never** trigger a publish on their own. | Every 6 hours (cron `17 */6 * * *`) |
| Transcribe (maker) | A reviewer reads the notification PDF and records each changed entry as a **rate proposal**: HSN prefix, rate, conditions, `effective_from`, notification number (canonical form, e.g. `9/2025-CT(Rate), Schedule IV`), `schedule_serial`, PDF URL and the PDF's sha256 (`pdf_sha256`). All are required. | Per notification |
| Check (checker) | A **different admin actor** reads the proposal (with its `content_sha256`), compares it with the PDF and approves it, sending the same `content_sha256` back so the approval is bound to what was reviewed. Approval publishes a new `dataset_version` and writes change-feed and audit entries. | Per proposal |
| Serve | The API answers only from published, effective-dated rules. History is never overwritten. A query for any date returns the rule in force on that date. | Always |
| Notify | Clients poll `GET /v1/rates/changes` and refresh their caches. Webhooks come later. | Client polls every 15 min with `If-None-Match` |

**Freshness target: N = 2 business days** from the day a notification appears on the CBIC site to publication in our dataset (NFR-07).

Why 2 business days:
- **Effective dates usually leave room.** 9/2025 was notified 17-09 and took effect 22-09 (5 days). 19/2025 was notified 31-12 and took effect 01-02 (32 days). In these cases a 2-day SLA means the rule is published *before* it takes effect, and clients can preload it.
- **The tight case is the binding one.** 01/2026 was notified 30-04 and took effect 01-05, one day later, and a corrigendum followed on 06-05 (per secondary sources; gazette not yet read, research confidence M). A 1-day SLA would need an on-call reviewer pair every day, which a two-person team cannot staff. A 2-day SLA can be met with two reviewers.
- **Short-notice changes go faster.** When `effective_from` is ≤ 2 business days after publication, the notification is marked **expedite** and the target becomes the **same business day**, best effort.
- **Accuracy beats speed.** A wrong rate published fast does more harm to a billing client than a correct rate published one day later. During the gap, clients can see the state honestly: `GET /v1/meta/dataset` returns `sources_checked_at` (last successful watcher run), `pending_notifications` (detected but not yet published, with `effective_from` and `expedite`) and `freshness_sla_business_days: 2`, and every rate response for an affected code carries the warning `pending_change_detected`.
- This matches the target already set in `07-best-practices.md` §12.

What we never claim: "official", "government", "real-time", "live", "guaranteed" or "100% accurate" (honesty rule 1, AG-05).

### 2.3 Classification by name or barcode is a best guess
- Name → HSN uses curated synonym rules plus full-text search over the HSN master, combined by a fixed, explainable formula (`design/architecture.md` §5).
- Barcode → HSN validates the GTIN, looks up the product name and category (local cache first, then an opt-in external adapter), and then runs the name classifier.
- Every response returns **ranked candidates** with `confidence` (0–1), `confidence_band` (`high` ≥ 0.85, `medium` 0.60–<0.85, `low` < 0.60), `reasons`, and `needs_review: true` unless the band is high. Client apps must ask a person to confirm anything that is not high.
- What each band honestly means (rulings 2 and 22): **`high` requires an exact curated synonym on the name the client sent.** Without a synonym, a strong text match plus chapter agreement reaches at most medium (0.84). A **barcode-only scan is never high**, because the product name and category come from publicly editable data (Open Food Facts); send the product name as well to allow high. Until synonyms are curated for a tenant's catalogue, expect most results to be medium or low.
- AI (an optional LLM re-ranker, off by default) may only reorder codes we already retrieved. It never produces or changes a rate (honesty rule 2, `06-ai-restrictions.md`).

### 2.4 Research caveat: seed rates are unverified
The research sandbox could not reach any official host (cbic-gst.gov.in, taxinformation.cbic.gov.in, gstcouncil.gov.in and others were blocked). **Every seed rate was gathered from secondary sources** (KPMG, ICAI branches, tax portals) and the gazette PDFs were not read (`research/sources.md`, access caveat). Therefore:
- every seed rule is stored with `verification_status = "unverified"`, and the API returns that status on every rule;
- a rule becomes `verified` only when a named human compares it against the CBIC PDF through maker–checker (AG-03);
- known conflicts stay unresolved until someone reads the gazette. These are **7104** (synthetic and lab-grown stones: 0.25% or 1.5%), **7117** (imitation jewellery: 3%, unconfirmed under 9/2025) and the 2026 corrigenda list;
- **launch gate:** every rule covering Sunarone's and the health app's HSN codes must be `verified` before they go live (SM-01), recorded as an explicit go/no-go in `reviews/`;
- **tax gate (00c ruling 24):** `POST /v1/tax/calculate` computes tax on an unverified rule only when the request sets `accept_unverified: true`; otherwise that line returns `tax: null` with `needs_input: accept_unverified`. Lookups and classification still return unverified rules, flagged.

## 3. Users and personas

| Persona | Who | Needs | Pain today |
|---|---|---|---|
| **P1 App developer** (primary integrator) | Backend developer at any billing, POS, ERP or e-commerce app | Stable REST contract, clear errors, a cacheable change feed, a sandbox key | Maintains their own rate table and has no reliable signal when rates change |
| **P2 Sunarone** (jewellery billing, Amit's app) | Jeweller and counter staff billing gold, silver and diamond items | Correct 3% on jewellery, 1.5% on cut diamonds, 0.25% on rough stones, the making-charges and job-work treatment, invoices with citations | Mixed items (gold plus studded stones plus making charges); the cut-diamond rate changed in 2022 and many tables still show 0.25% |
| **P3 Health app** (Amit's app) | Pharmacy or health-product seller, possibly consumer-facing | HSN and GST for medicines (3004: general 5% rule plus the nil-rate drug list, so the line must say which applies), the 33 nil-rated named drugs, devices (glucometer, thermometer), diagnostic kits | Drug-level exemptions that the HSN alone cannot decide; many changes from 12% to 5% in Sept 2025 |
| **P4 Small retailer** (served through P1's app) | Kirana or general store scanning barcodes | Scan → HSN and rate in one step; plain-language prompts when unsure | Does not know HSN; price-threshold items (apparel ≤ ₹2,500) |
| **P5 Rate reviewer** (internal: Amit plus one more person) | Maintains the dataset | Notification watcher alerts, a proposal diff view, two-person approval, an audit trail | No tooling; a single person has no check on their work |

## 4. Goals and non-goals

### Goals
- G1: Any authorised app gets the GST rate rules for an HSN/SAC on a date, with citation, effective dates and verification status, in one call.
- G2: A product name or barcode returns ranked HSN candidates with rates attached and an honest confidence.
- G3: Invoice-line tax calculation (intra-state, intra-UT, inter-state, cess) with deterministic, documented rounding.
- G4: Rate changes reach client caches within 2 business days of CBIC publication (NFR-07), with a change feed.
- G5: Every published rate can be traced to a notification (with the PDF's sha256 and schedule serial) and two distinct admin actors.

### Non-goals (v1)
- Being an official source or giving legal or tax advice. Correct classification and time of supply remain the client's responsibility.
- Filing returns, e-invoicing (IRN), e-way bills, GSTR-1 preparation, or GSTIN validation.
- Deciding composite versus mixed supply. Clients send lines the way they invoice them.
- Computing specific (per-unit) cess. It is returned as data only, and GST cess is zero for all goods from 01-02-2026.
- Non-GST levies such as the tobacco excise and pan masala health cess from 01-02-2026.
- State-specific levies. Determining place of supply: the client sends `intra`, `intra_ut` (a Union Territory without legislature, e.g. Chandigarh, Ladakh; returns CGST + UTGST) or `inter`.
- An admin web UI (00c ruling 21): admin is API/CLI only in v1.
- Storing end-customer data (PII) of any kind.
- Browser or mobile apps calling the API directly. Keys stay on client backends.
- Automatic publication of rates from scraping, AI or secondary sources.

## 5. User stories and acceptance criteria

**US-01 HSN lookup (P1).** As a developer, I call `GET /v1/hsn/7113` and get the current rate rules so I can bill.
- AC1: Returns 200 with `code`, `description`, `rate.coverage`, `rate.applicable_rule` (IGST/CGST/SGST %, `effective_from`, `effective_to`, `source{notification,url,schedule_serial,pdf_sha256}`, `last_verified_at`, `verification_status`, `reverify_due_at`), `rate.warnings`, `dataset_version` and `disclaimer`.
- AC2: `?date=2025-09-01` for 3004 returns the 12% **fixture** rule; today returns `ambiguous: true` with the general 5% rule (`default_rule_id`) and the 0% nil-rate-list rule (00c ruling 5). The 12% value is a fixture simplification (under 1/2017 some 3004 items were at 5%), not a statement of law.
- AC3: A code that is not in the HSN master but has a known parent → 200 answered under that parent, with `code_in_master: false`, `resolved_via` and the warning `code_not_in_master` (validator R3). A code whose chapter does not exist → 404 `hsn-not-found`. A code that exists but has no rule → 200 with `coverage: "no_rate_rule"` and no rate. The API never invents a default.
- AC4: Sending the `ETag` back unchanged → 304.

**US-02 Price-threshold items (P1, P4).** As a retailer, I bill a T-shirt and get the right slab for its price.
- AC1: `GET /v1/hsn/6109` without `unit_price` → `ambiguous: true`, both rules (5% ≤ ₹2,500; 18% > ₹2,500) with condition text, `applicable_rule: null`.
- AC2: `unit_price=1800` → 5% rule; `unit_price=2500` → 5% (inclusive); `unit_price=2500.01` → 18%.

**US-03 Classify by name (P2, P3).** As counter staff, I type "22K gold ring" and get the HSN and rate.
- AC1: Returns 1–5 candidates sorted by confidence. Each has `confidence`, `confidence_band`, `reasons[]` (≥ 1), `needs_review` and its own rate resolution.
- AC2: "22K gold ring" → top 7113, band high (illustrative scoring in `design/architecture.md` §5.5).
- AC3: "Paracetamol 500 mg tablet" → top 3004, band medium, `needs_review: true`, with a review hint about bulk drug 2924; its rate resolution is ambiguous with `default_rule_id` = the general 5% rule.
- AC7: An input with no curated synonym (e.g. "Knitted cotton T-shirt") can reach medium at most, never high.
- AC4: Nonsense input ("asdfgh") → 200 with `candidates: []` and `needs_review: true` (nothing reaches 0.10). Weak matches (best < 0.30) are still returned, all band `low`, with `needs_review: true` and a `message`.
- AC5: Same input, same `classifier.version` and same `dataset_version` → identical output.
- AC6: If the top two candidates are within 0.10, the top is capped at medium (`needs_review: true`, reason `close_runner_up`).

**US-04 Classify by barcode (P4).** As a retailer, I scan a barcode and get HSN and GST.
- AC1: A bad check digit → 422 `invalid-gtin` naming the expected and actual check digits (not echoing the barcode), with **no** outbound call.
- AC2: A valid GTIN found in the cache or an enabled adapter → `product` block (gtin, `gtin_valid`, name, brand, category, `source`, `fetched_at`; 00c ruling 35) plus candidates. A barcode-only result is **at most medium** (`needs_review: true`, with a `review_hint` reason naming the crowd-edited source). Found products are cached 7 days.
- AC5: If the lookup errored or the outbound budget is spent → `product.source: "lookup_failed"` (not `not_found`), with a message to retry later or send `name`.
- AC3: A valid GTIN not found anywhere → 200 with `product.source: "not_found"`, `candidates: []`, `needs_review: true`, and a hint to send `name`. The negative result is cached for 24 h.
- AC4: If both `name` and `barcode` are sent and they disagree, the top candidate carries reason `barcode_conflict` and cannot be band high.

**US-05 Human confirmation in the client (P2, P3, P4).** As an app, I never auto-apply an uncertain HSN.
- AC1: The client contract (`03-app-flow.md` §6) requires a confirmation UI when `needs_review: true`, and caches the confirmed `(product → HSN)` choice client-side.
- AC2: The API does not store the client's confirmation in v1. The feedback endpoint is future work (AI-52).

**US-06 Tax calculation (P1, P2).** As a billing app, I send invoice lines and get the tax breakdown.
- AC1: `intra` → CGST = SGST = half the rate. `intra_ut` → CGST = UTGST = half the rate. `inter` → IGST. Rounding is half-up per line, per component, to the paisa.
- AC2: A line whose rate is ambiguous → `ambiguous: true`, `tax: null`, candidate rule ids and a `needs_input` note, unless the line names the rule with `rule_id` or `condition: "general"`; the response has `complete: false`, `totals: null`, and `partial_totals` sums only the computed lines with their ids, so no incomplete invoice ever carries a total (validator R13).
- AC5: A line on an `unverified` rule is computed only with `accept_unverified: true` on the request (the line is then flagged `unverified_accepted: true`); otherwise `tax: null` and `needs_input: accept_unverified`.
- AC6: `quantity` (≤ 3 decimals) never changes the tax base. Price thresholds use `unit_price`; when it is absent, the unit price is derived from `taxable_value` ÷ `quantity` for rule selection only.
- AC3: Each line echoes `rule_id`, rate, `effective_from`, `source` and `verification_status`. Amounts come as rupee numbers and integer `*_paise`; an unresolved line's `notes[]` carries `needs_input: …`. Optional `invoice_rounding: nearest_rupee` adds a round-off.
- AC4: 501 lines → 400. A tax request body over 256 KiB → 413 (other routes: 64 KiB; classify 16 KiB).

**US-07 Stay fresh (P1).** As an app, I keep my cached rates current.
- AC1: `GET /v1/rates/changes?since=<seq>` returns changes oldest first with `next_since` and `has_more`.
- AC2: A future-dated rule appears in the feed as soon as it is approved, before its `effective_from`.
- AC3: A cursor older than retention, or beyond the server's last change → 410, and the client resyncs. A changed `feed_epoch` (server restored) also means resync.
- AC4: Each change carries `affected_prefix`; the client invalidates cached code `c` when `c` starts with it or it starts with `c`.

**US-08 Publish a rate change (P5).** As a reviewer, I enter a new notification safely.
- AC1: A proposal without a notification number, an https source URL whose exact host is allow-listed (cbic-gst.gov.in, taxinformation.cbic.gov.in, cbic.gov.in, egazette.gov.in, gstcouncil.gov.in), `pdf_sha256`, `schedule_serial` or `effective_from` → 400. A back-dated change without `retroactive_reason` → 400.
- AC2: The approver must be a different admin actor (`actor_id`) from the proposer → otherwise 403 `maker-checker-violation`. Approve and reject must send `expected_sha256` equal to the proposal's `content_sha256` → otherwise 409 `proposal-hash-mismatch`; a target rule that changed meanwhile → 409 `rule-not-active` (00c ruling 35).
- AC3: Approval in one transaction end-dates the old rule, inserts the new one, bumps `dataset_version`, writes change-feed and audit entries. A failure rolls everything back. A rule wrong from its first day is fixed with a `correct` proposal (the old rule is voided, kept for audit; feed `rule_corrected`).
- AC4: A proposal that overlaps an existing rule in prefix, dates and price → 409 `overlapping-rule`.
- AC5: `GET /v1/admin/audit?verify=true` reports whether the returned span's HMAC chain verifies (`chain_ok`, `chain_broken_at`); `scripts/verify-audit.ts` verifies the whole chain against the exported off-host head.

**US-09 Verify a seed rule (P5).** As a reviewer, I promote an `unverified` seed rule after checking the gazette.
- AC1: A `verify` proposal (maker) plus approval (checker) sets `verification_status = verified`, `verified_by` and `last_verified_at`, and changes no rate field.
- AC2: `/v1/meta/dataset` reports counts of verified, unverified and verification-overdue rules.
- AC3: Re-verification: a `verify` of an already verified rule moves only `last_verified_at` forward; `reverify_due_at` = `last_verified_at` + 12 months; past it, rate responses carry `verification_overdue` (NFR-08).

**US-10 Key management (P1, P5).** As an integrator, I get a key with only the scopes I need, and I can rotate it.
- AC1: The plaintext key is shown once. Only its hash is stored.
- AC2: Two active keys per tenant are allowed during rotation (a third is allowed but logged). A revoked key fails on the very next request (no auth cache).
- AC3: An admin key belongs to one admin actor and expires within 90 days. After the two bootstrap actors, a new admin actor or admin key needs an `admin_grant` approved by a different admin actor.

## 6. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | `GET /v1/hsn/{code}` for 2/4/6/8-digit HSN, 5-digit SAC groups (chapter 99, e.g. 99972) and 6-digit SAC; returns master data, ancestors and rate resolution for `date` (default today, IST) and optional `unit_price`. | MVP |
| FR-02 | Rate resolution uses longest-prefix matching with effective dates and price conditions, and returns `ambiguous: true` with every rule when it cannot decide (`design/data-model.md` §3). | MVP |
| FR-03 | Every rate rule in any response carries `effective_from`, `effective_to`, `source` (notification and URL), `last_verified_at`, `verification_status`, `rule_id`, `dataset_version`; every rate-bearing response carries `disclaimer`. | MVP |
| FR-04 | `GET /v1/hsn/search?q=&limit=` full-text search over HSN/SAC descriptions and curated keywords (limit 1–50). | MVP |
| FR-05 | `POST /v1/classify` accepts `name` and/or `barcode`, plus optional `unit_price`, `date`, `max_candidates` (≤ 5) and `allow_llm` (default false); returns ranked candidates per honesty rule 3, with rates attached, and `llm_used`. | MVP |
| FR-06 | GTIN-8/12/13/14 check-digit validation before any lookup; normalise to GTIN-14. | MVP |
| FR-07 | Product cache for barcodes (found: 7-day TTL with source and fetch time; not found: 24 h; errors not cached as not found; admin purge per GTIN). External adapters (Open Food Facts first) are off unless configured. | MVP (cache) / v1 (OFF adapter on) |
| FR-08 | `POST /v1/tax/calculate`, up to 500 lines; intra / intra_ut / inter split; ad-valorem cess; per-line half-up rounding; ambiguous lines are not taxed unless the line names a rule; unverified rules only with `accept_unverified: true`. | MVP |
| FR-09 | `GET /v1/rates/changes?since=` append-only change feed, paginated (≤ 500 per page). | MVP |
| FR-10 | `GET /v1/meta/dataset`: version, published_at, `content_sha256`, `feed_epoch`, coverage, verified/unverified/overdue counts, oldest `last_verified_at`, notifications included, `sources_checked_at`, `pending_notifications`, `freshness_sla_business_days`. | MVP |
| FR-11 | Admin maker–checker on the admin listener: create, list, get, approve, reject, withdraw proposals (`create`, `supersede`, `end_date`, `verify`, `correct`, `refdata_change`, `admin_grant`); approver ≠ proposer by `actor_id`; approval bound to `content_sha256`; no bulk approval; `Idempotency-Key` required. | MVP (API/CLI); no admin web UI in v1 |
| FR-12 | Append-only, HMAC-chained audit log (`HSN_AUDIT_KEY`) for rate, reference-data and key changes, with an exported off-host head; `GET /v1/admin/audit?verify=true`; `scripts/verify-audit.ts` for the full chain. | MVP |
| FR-13 | API keys: hashed storage, scopes `read` / `classify` / `admin`, per-key rate limits, daily quotas on classify and search, revocation, two concurrent keys for rotation. Issued by an admin CLI in MVP. | MVP |
| FR-14 | Notification watcher: poll of the CBIC Central Tax (Rate) and Integrated Tax (Rate) pages every 6 hours (cron or in-process); fail-closed parsing; new notification numbers become `detected` rows that reviewers triage (`/v1/admin/watched-notifications/{id}/triage`) and resolve; run history and freshness in `GET /v1/admin/watcher/status`; alertable log lines and exit codes. | v1 (built; not yet run against the live CBIC pages) |
| FR-15 | Seed loader: validated JSON seed files (format: `server/data/seed/FORMAT.md`, constrained by `design/data-model.md` §7) published as the first dataset version into an empty database; every seed rule is `unverified`; refused in production. | MVP |
| FR-16 | `GET /healthz` and `/readyz`, unauthenticated, revealing no versions. | MVP |
| FR-17 | Optional LLM re-ranker, constrained to retrieved candidates, off by default, gated by eval (AI-43). | Later |
| FR-18 | Webhooks for change-feed events (signed, retried). | Later |
| FR-19 | Classification feedback endpoint (`POST /v1/classify/feedback`); human-reviewed before it becomes a synonym rule. | Later |

## 7. Non-functional requirements

| ID | Requirement | Target | How measured |
|---|---|---|---|
| NFR-01 | Latency `GET /v1/hsn/{code}`, `/search`, `/rates/changes`, `/meta` | p95 ≤ 100 ms, p99 ≤ 250 ms server-side; alert at p95 > 500 ms | Fastify latency histogram |
| NFR-02 | Latency `POST /v1/classify`, no external lookup | p95 ≤ 300 ms | same |
| NFR-03 | Latency `POST /v1/classify` with an external barcode lookup (cache miss) | p95 ≤ 1.5 s (outbound timeout 3 s → not_found) | same |
| NFR-04 | Latency `POST /v1/tax/calculate`, 50 lines | p95 ≤ 150 ms | same |
| NFR-05 | Availability, `/v1/*` read routes | 99.5% monthly in MVP (single instance, about 3.6 h/month budget); 99.9% after the Postgres multi-instance move | External uptime probe on `/readyz` plus one authenticated lookup |
| NFR-06 | Client resilience | Clients keep billing from cache during an outage (client contract); no client blocks on us | Integration review |
| NFR-07 | **Freshness SLA** | New CBIC rate notification published in our dataset ≤ **2 business days** after it appears on the CBIC site; same business day (best effort) when `effective_from` ≤ 2 business days away; watcher detection ≤ 12 h | Watcher log timestamp → `dataset_versions.published_at`, tracked per notification |
| NFR-08 | Re-verification | Every active rule re-confirmed against its source at least every 12 months (`verify` proposal on a verified rule; `reverify_due_at`), and after each annual Council rate review | `rate_rules_verification_overdue` = 0, `oldest_last_verified_at` |
| NFR-09 | Correctness | 100% of golden-file cases pass (each case cites a notification); tax maths property tests ≥ 1,000 runs per invariant | CI |
| NFR-10 | Classifier quality gates | High-band precision ≥ 0.97; top-3 recall (4-digit) ≥ 0.90 on ≥ 300 labelled items (AI-42) | `npm run eval`. Status 2026-10-11: gates pass on `test/eval/classify-eval.jsonl` (495 items) with the provisional in-master top-3 scope, but the labels are LLM drafts not yet human-reviewed and the high band has only 16 answers (Wilson lower bound 0.806), so this is **not met** for sign-off (06 AI-40, AI-42) |
| NFR-11 | Throughput | ≥ 1,000 rps cached lookups on one 2-vCPU instance | Load test (autocannon or k6, run outside the repo) |
| NFR-12 | Security | All Critical/High items in `05-security-checklist.md` pass | Security audit report in `reviews/` |
| NFR-13 | Privacy | No PII stored; classify names logged only as HMAC with `HSN_LOG_KEY` | Log capture tests (SEC-62) |
| NFR-14 | Determinism | Same inputs + same dataset/classifier versions → byte-identical responses (except `request_id` and timestamps) | Test |
| NFR-15 | Recoverability | RPO 24 h (nightly backup; rate data also re-creatable from audit/proposals); RTO 4 h | Quarterly restore drill (SEC-81) |

## 8. Success metrics

| ID | Metric | Target |
|---|---|---|
| SM-01 | Share of active rules covering launch-set codes (Sunarone Ch. 71 and SAC 9988; health app Ch. 30, 38, 90 items) that are `verified` | 100% before go-live |
| SM-02 | Notifications published within NFR-07 | ≥ 95% per quarter, 0 misses for expedite cases where the effective date is passed before publication |
| SM-03 | Wrong-rate incidents (a published rule later corrected because of a transcription error) | 0 per quarter; each one gets a post-mortem |
| SM-04 | High-band precision in production, sampled from client confirmations | ≥ 0.97 |
| SM-05 | Share of classify calls answered high band (automation rate) | ≥ 60% for Sunarone, ≥ 40% for the health app after 3 months of synonym curation. Only name requests with an exact curated synonym can be high, so this metric measures synonym coverage; barcode-only scans are excluded (always ≤ medium). |
| SM-06 | Client integration time (key → first correct invoice) | ≤ 1 day for a backend developer using the quick start (`server/README.md`: zero to a first lookup, classify and tax call in 10 commands, tested verbatim from a clean copy) |
| SM-07 | Uptime | NFR-05 met each month |
| SM-08 | Clients on the change feed (polled within the last 24 h) | 100% of production tenants |

## 9. Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Seed rates taken from secondary sources are wrong | Wrong tax on invoices | Medium | `unverified` flag, launch gate SM-01, gazette check by two people, golden tests citing notifications |
| A notification is missed or entered late | Clients bill the old rate after it changes | Medium | Watcher every 6 h plus secondary-source early warning, expedite path, freshness metric, alerts on watcher health (no successful run in 36 h) and on notifications unreviewed past the 2-business-day SLA. Known gaps: UTGST (Rate) and Compensation Cess (Rate) listings are not watched (manual check); business days are Mon–Fri IST and Indian public holidays are not modelled, so the SLA clock can run over a holiday |
| Transcription error passes review | Wrong rate published | Low–Medium | Maker–checker with attestation bound to `content_sha256`, PDF sha256 and schedule serial, allowed-slab check, overlap check, correction runbook (`correct` proposal; feed `rule_corrected`) |
| Users treat a classification as authoritative | Wrong HSN on invoices or returns | Medium | Candidates plus bands plus `needs_review`; client contract forbids auto-applying non-high results; disclaimer |
| HSN alone cannot decide the rate (named drugs, pre-packaged vs loose, cc/length for cars) | Ambiguous results frustrate users | High | `ambiguous: true` with condition text and `default_rule_id` for the general rule; tax lines name the rule (`rule_id` or `condition: "general"`); curated synonyms with `rule_hint` for the named nil-rated drugs (later) |
| Crowd-edited barcode data (Open Food Facts) is poisoned | Wrong HSN auto-applied | Medium | Barcode-only results capped at medium; provenance returned; 7-day cache; admin purge per GTIN |
| One person controls both admin identities | Maker–checker bypassed | Medium | `admin_actors`, two-person `admin_grant`, audit plus warn-level log lines (an out-of-band notifier is Later); residual risk: the host owner can bypass the application (stated in `05` §0) |
| Barcode databases cover little Indian retail | Barcode scans often return not found | High | Fallback to name entry; GS1 DataKart partnership later; client-side confirmed-mapping cache |
| Only two reviewers (bus factor) | SLA misses | Medium | Document the runbook; recruit a third reviewer (open question Q3) |
| CBIC site structure changes and breaks the watcher | Silent misses | Medium | Fail-closed parser: a run fails (and alerts) on non-HTML, a changed page shape, no items, the wrong series, > 20% malformed items, or fewer than half the items of the last good run; weekly manual check |
| Legal liability for wrong rates | Claims from clients | Low–Medium | Terms: not tax advice, verify against the citation; disclaimers; audit trail; Q8 |
| Single-instance SQLite outage | Downtime | Low | Client caches, nightly backups, quick redeploy; Postgres path |
| LLM or external adapter leaks product text, or prompt injection | Privacy and integrity | Low | Both off by default, allow-listed hosts, AI-01/02 constraints, disclosure acknowledgement |

## 10. Open questions for Amit

| # | Question | Why it matters | Default if no answer |
|---|---|---|---|
| Q1 | **Making charges and job work at Sunarone.** On an outright sale of jewellery, are making charges billed inside the item value or as a separate line? Does Sunarone also do job work on customer-supplied gold (remaking, repair)? | Research: making charges inside a jewellery sale are part of the 3% supply (7113). Job work on Ch. 71 goods is SAC 9988 at 5% (1.5% for diamonds). `07-best-practices.md` has been corrected to this default (coordinator ruling 12); it remains open until the CA confirms. | Outright sale: making charges included in the 7113 line at 3%. Separate 9988 lines only for genuine job work. To be confirmed with Sunarone's CA. |
| Q2 | Studded jewellery: does Sunarone bill diamonds and stones separately from the gold article? | 7113 (3%) vs 7102 cut diamonds (1.5%) vs 7103 stones (0.25%) | Treat a studded article as 7113 at 3% (research row 3); separate stone lines only if sold loose |
| Q3 | Who is the second reviewer (checker), and is a third available for leave cover? | Maker–checker needs two humans; NFR-07 depends on it | Block launch until a second reviewer is named |
| Q4 | Health app scope: retail pharmacy billing, consumer app, or both? Will it send drug brand names? | Named-drug exemptions need drug-level synonyms; consumer apps raise PII risk in `name` | Pharmacy billing only; names must not contain patient data |
| Q5 | ~~Should production serve `unverified` rules?~~ **Resolved (00c ruling 24):** lookups and classify serve them flagged; tax refuses them unless `accept_unverified: true`; production launch requires the launch set verified. | — | — |
| Q6 | Enable the Open Food Facts adapter in production (ODbL attribution, 15 reads/min/IP limit)? | Barcode coverage | Off in MVP; on in v1 with attribution |
| Q7 | Will third-party apps pay, and are quotas per plan? | Rate limits, terms | Free for Amit's apps; invite-only for others |
| Q8 | Who reviews the disclaimer and API terms (CA or lawyer)? | Liability | Amit approves the text in `07` §11 before launch |
| Q9 | Hosting region and budget (a single VM in India?) | Latency, DPDP, cost | One small VM or PaaS instance in an Indian region |
| Q10 | Which HSN digit level will Sunarone print (AATO ≤ ₹5 cr → 4 digits)? | Which code granularity clients request | 4-digit lookups supported; 8-digit when a rule differs at that level (ambiguity tells them) |

## 11. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **MVP** (internal: Sunarone and health app in staging) | Fastify + SQLite (`node:sqlite`, FTS5); FR-01–13, FR-15, FR-16; HSN master import; seed rules for Ch. 71, SAC 9988, Ch. 30/38/90 health items and the common slabs (all `unverified`); synonyms for jewellery and common medicines; keys via CLI; maker–checker via API/CLI; manual watcher checklist | All MVP tests and golden files pass; security and validator reports show no Critical/High; Amit's apps integrated in staging |
| **v1** (production for Amit's apps, invite-only for others) | Gazette verification of the launch set (SM-01); admin stays API/CLI only (no web UI, 00c ruling 21); automated CBIC watcher (FR-14); Open Food Facts adapter on (Q6); eval set ≥ 300 items with gates (AI-42); daily quotas; `/metrics` and alerts; client quick start and typed client from OpenAPI | SM-01 = 100%; NFR-01–05 met in staging load test; two consecutive notifications handled within NFR-07 (or a dry run) |
| **Later** | **Postgres** repositories plus Redis rate limiting, multi-instance (99.9%); **LLM re-ranker** behind AI-43 gates and DPDP disclosure; **webhooks** for change events (HMAC-signed, retries); an **out-of-band admin notifier** (email or webhook to every admin actor on proposals, grants and verification failures; v1 has audit plus warn-level log lines, 00c ruling 29); watching the UTGST (Rate) and Compensation Cess (Rate) listings; an Indian public-holiday calendar for the freshness SLA; an admin review web UI only with the security requirements of `design/ui-and-dx.md` §2; **GS1 India DataKart** integration if a partner API or licence becomes available; classification feedback loop (FR-19); named-drug synonym pack; bulk CSV classification; client SDKs (TS, Kotlin) | Each item has its own design note and review |
