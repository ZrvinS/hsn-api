# Validator review: documents, round 1

Date: 2026-10-10 · Reviewer: validator · Scope: `docs/README.md`, `00`, `00b`, `01-PRD`, `02-TRD`, `03-app-flow`, `05`, `06`, `07`, `design/{architecture,data-model,openapi.yaml,ui-and-dx}`, `research/sources.md`.

What I actually ran: read every file above in full. I recomputed GTIN check digits (`4006381333931` valid, `8901234012346` expects 5, `8901234012345` valid, `96385074` valid), the tax examples (T-T01 102,750 paise, T-T03 125 paise, the openapi tax example totals) and the fusion worked examples (0.911, 0.273, 0.718, 0.224, 0.942) by script or by hand. All of them are correct. I also checked that `server/data/seed/FORMAT.md` exists. It does not: `server/` holds only `package.json`.

## Verdict: **NOT YET**

| # | Dimension | Score |
|---|---|---|
| 1 | Fidelity to the ask; honesty about "real-time" and "official" | **8** |
| 2 | Internal consistency across docs | **6** |
| 3 | Completeness and testability of requirements | **7** |
| 4 | GST correctness against the research (and uncertain-as-fact) | **7** |
| 5 | Developer experience for client apps | **7** |
| 6 | Can a builder implement without guessing | **7** |

**What is already excellent:**
- The honesty framing in PRD §2: no official API, a 2-business-day SLA with a reasoned justification, seed rows `unverified`, and a launch gate.
- The resolver algorithm, the maker–checker DDL with triggers, and the hash-chained audit log.
- An explainable confidence formula with worked examples that recompute exactly.
- A concrete test list with real numbers.
- The client flows for Sunarone and the health app.

This is well above typical draft quality. It is held back by about 30 cross-doc contradictions and by several real design bugs that a staff engineer or a tax-tech lead would catch in review. The worst of these:
- Corrections are impossible under the DDL.
- Fusion makes medium unreachable without synonyms, so the gate is dead code.
- Change-feed invalidation misses descendant rules.
- ETags are blind to the "today" date.
- 5-digit SAC codes are rejected.

## REQUIRED fixes

Each fix lists the file, the location, the problem and the exact fix.

### A. Design bugs (behaviour would be wrong if built as written)

1. **Corrections from a rule's first day are impossible.**
   - **Where:** `design/data-model.md` §2 (`rate_rules` CHECK `effective_to >= effective_from`) and §3 "supersede end-dates the old rule to `new.effective_from − 1 day`". Also `03` §8 correction path and `07` §5.
   - **Problem:** Say a rule effective 2025-09-22 is found to carry the wrong rate. Correcting it needs a new rule from 2025-09-22, so the old rule would get `effective_to = 2025-09-21 < effective_from`. The CHECK aborts and the correction cannot be made, yet the correction runbook (SEC-82) depends on it.
   - **Fix:** add `voided_at TEXT` / `voided_in_version TEXT` (or `status IN ('active','voided')`) to `rate_rules`, updatable only NULL→value by the trigger. Add proposal action `correct`, which voids the target and inserts a replacement with any `effective_from`. The resolver ignores voided rules, and the feed emits `rule_voided` + `rule_added`. Add test T-A09: correct a rule on its first effective day; history query returns the replacement, and audit shows both.

2. **Fusion makes "medium" unreachable without a synonym, and the gate is dead code.**
   - **Where:** `design/architecture.md` §5.3–5.4; `02-TRD` §5 and T-U07; `06` AI-07.
   - **Problem:** Because `syn` is always in A, a candidate with `s_syn = 0` has these ceilings:
     - name only: raw ≤ (0.20+0.15)/0.85 = **0.41**;
     - with a matching barcode category: raw ≤ (0.20+0.15+0.15)/1.0 = **0.50**;
     - with only a `related` synonym: raw ≤ 0.59.

     So the gate (`s_syn < 0.7 and s_bar ≠ 1.0 → ≤ 0.84`) can never bind, and T-U07 is vacuous. A perfect description match ("cotton t-shirt") or a mapped barcode category is always band `low`. Nothing documents that.
   - **Fix:** choose one of these and write it down.
     - (a) Keep the weights. State explicitly in arch §5.4 and PRD §2.3 that "without a curated synonym the best possible band is `low` (max 0.59)". Delete the gate, or keep it as a guard for future weight changes and say so. Replace T-U07 with a test that pins the ceilings 0.41 / 0.50 / 0.59. Reflect this in SM-05 and the retailer persona (barcode scans are never auto-filled until synonyms exist).
     - (b) Recalibrate the weights so that FTS plus chapter can reach medium. Update the §5.5 worked examples, T-U06 and the openapi examples to match.

3. **Change-feed cache invalidation misses rules at more specific codes.**
   - **Where:** `02-TRD` §12, `design/architecture.md` §2.5, `03` §8, `07` §13.
   - **Problem:** The text says "invalidate entries whose HSN starts with `hsn_prefix`". A new rule at `71131910` changes the cached answer for `7113`, because the descendant check makes it ambiguous. But `"7113"` does not start with `"71131910"`, so the client keeps a stale "3% applicable" answer.
   - **Fix:** in all four places, invalidate cached code `c` when `c.startsWith(prefix) || prefix.startsWith(c)`. Add a client-contract test vector in TRD §15: rule added at 71131910 → cached 7113 invalidated.

4. **ETags and the LRU ignore the implicit "today".**
   - **Where:** `02-TRD` §11, `07` §7, `openapi.yaml` `components.headers.ETag`, `design/architecture.md` §2.1.
   - **Problem:** When `date` is omitted, the ETag is `hash(dataset_version, route, params)`. It does not change at IST midnight when a pre-loaded future rule takes effect, so the client gets `304` and keeps billing the old rate. This is exactly the 22-09-2025 / 01-05-2026 scenario the product exists for.
   - **Fix:** define "normalised params" to **include the resolved `as_of` date** (and the resolved `unit_price`) in every rate-bearing GET. Additionally cap `max-age` so it never crosses the next IST midnight, or document that. Add test T-F05: clock moves across `effective_from` with the same dataset → new ETag and new rule.

5. **3004 / named nil-rated drugs: the docs contradict each other on the health app's core case.**
   - **Where:** `03` §3 says "the rule set returns that as a non-price condition, which makes the result ambiguous". But PRD US-01 AC2, TRD T-R02, `03` §7.2, openapi `paracetamol` example and `ui-and-dx` §3.2 all show 3004 → 5% `applicable`, `ambiguous: false`.
   - **Problem:** If the `03` reading is built, every pharmacy line becomes `tax: null`. If the other reading is built, the 33 exempt drugs are silently billed at 5%. Research §2.4 row 13 says "the HSN code alone is not enough".
   - **Fix (recommended):**
     - Keep a single 3004 5% rule applicable.
     - Add an open-enum warning `exemptions_may_apply` to `RateResolution.warnings`, plus a new `RateRule.exemption_note` (text citing 10/2025 and the list) set on the rule.
     - Have `/v1/tax/calculate` add note `exemptions_may_apply` to the line.
     - Fix `03` §3 and §7.2 to match, and add a golden test.
     - Use the same mechanism for "pre-packaged and labelled vs loose" food (research §3.2).
   - **Also:** US-01 AC2 / T-R02 assert "3004 on 2025-09-21 → 12%" as "historical correctness". Under 1/2017 many 3004 items (List 1 drugs, insulin) were at 5%. Mark this as a **fixture simplification** in T-R02 and AC2, not as a statement of law.

6. **5-digit SAC groups are rejected.**
   - **Where:** `openapi.yaml` `HsnCode` pattern and `TaxLineInput.hsn` pattern; `design/data-model.md` `hsn_codes` CHECK `length IN (2,4,6,8)` and conventions row "SAC = 6 digits"; PRD FR-01; SEC-26.
   - **Problem:** The SAC scheme is heading (4) → group (5) → service code (6). Research itself cites **SAC 99972** (beauty/wellness, 5 digits). Service rates are often set at group level.
   - **Fix:**
     - Allow length 5 when `chapter = '99'`: CHECK `(length IN (2,4,6,8)) OR (substr(code,1,2)='99' AND length(code)=5)`.
     - Use the openapi pattern `^(\d{2}|\d{4}|\d{6}|\d{8}|99\d{3})$` in the path param, `TaxLineInput.hsn` and `RateRuleInput.hsn_prefix`.
     - Update FR-01, SEC-26 (whose regex `^[0-9]{2,8}$` currently also lets 3/5/7-digit goods codes through) and data-model §1.
     - Add T-R11: rule at `99972`, query `999721`.

7. **The tax quantity divide is unspecified for decimal quantities.**
   - **Where:** `openapi.yaml` `TaxLineInput.quantity` (a `number`, fractional allowed); `02-TRD` §6 "paise integer division, half-up".
   - **Problem:** A BigInt division of paise by `8.250` is undefined. A builder will either float it (which violates the money rules) or guess.
   - **Fix:** either make `quantity` an `integer` (pieces or pairs, which is what thresholds are written in), or specify `quantity` with ≤ 3 decimals, parsed as `qty_milli` and `unit_paise = roundHalfUp(taxable_paise × 1000, qty_milli)`. State it in TRD §6, `07` §6 and openapi.
   - **Same item:**
     - `line_id` is optional on input but required on output. Specify the default: the zero-based index as a string.
     - Add `igst_rate_bp` to `TaxLineResult`, because `07` §13 and `03` §7.1 tell clients to persist `igst_rate_bp`, but the response only gives a percent.

8. **Idempotency has no storage.**
   - **Where:** `07` §8 says store `(key_id, idempotency_key) → (request_hash, response)` for 24 h, on create **and approve**. `design/data-model.md` only has `rate_proposals.idempotency_key UNIQUE`, which is global, not per key, has no request hash, and does not exist for approve.
   - **Fix:** add a DDL table `idempotency_keys(key_id, idem_key, route, request_sha256, status, response_json, created_at, PRIMARY KEY(key_id, idem_key))` with 24 h expiry. Reference it in TRD §13. T-A04 then becomes implementable.

9. **There is no mechanism for NFR-08 re-verification.**
   - **Where:** PRD NFR-08 ("every active rule re-confirmed at least every 12 months"), `07` §12 ("`last_verified_at` updated when a reviewer re-confirms"); `design/data-model.md` §4; TRD A1.
   - **Problem:** `verify` is defined only as unverified → verified. Nothing defines how a verified rule's `last_verified_at` is refreshed, or whether that goes through maker–checker or writes a feed row.
   - **Fix:**
     - Allow `verify` on an already-verified rule. It refreshes `verified_by` / `last_verified_at` and emits `rule_verified`.
     - Allow the trigger to change `last_verified_at` only to a later value.
     - Add test T-A10.

### B. Missing contract pieces

10. **`/v1/meta/dataset` lacks `sha256`.**
    - **Where:** `openapi.yaml` `DatasetMeta`. FR-10 and SEC-54 both require it ("`/v1/meta/dataset` exposes `version` and `sha256`").
    - **Fix:** add a required `sha256` (and `signature` nullable, for SEC-54). Map it to `dataset_versions.content_hash` in data-model.

11. **Clients cannot see source freshness, which matters for the "real-time" honesty.**
    - **Where:** `openapi.yaml` `DatasetMeta`; PRD §2.2 says "`last_verified_at` and the `dataset_version` date show clients how fresh the data is".
    - **Problem:** Neither field tells a client whether a CBIC notification is detected but not yet published. That is the one fact that matters during the 2-day gap.
    - **Fix:** add `sources_checked_at` (the last successful watcher run, or the manual checklist date in MVP), `notifications_pending_review` (an array of `{notification, detected_at, effective_from?, expedite}`) and `freshness_sla_business_days: 2`. Reference these in PRD §2.2, US-07 and the `ui-and-dx` §3.6 banner.

12. **The proposal does not carry the PDF sha256 or the serial number.**
    - **Where:** PRD §2.2 (the maker records "serial number, PDF URL and the PDF's sha256"), TRD §13 ("Maker: reads PDF, records sha256"), research §6.3. But TRD A3 says "Not yet in the DDL", and `RateProposalCreate` / `RateRuleInput` have no such fields.
    - **Fix:** add `source.sha256` (64 hex, required for `create` / `supersede` / `verify`) and `source.serial_no` (string, e.g. "Sch IV Sr 3") to `Source` / `RateRuleInput`, and add `source_sha256` and `serial_no` columns to `rate_rules`. Remove the "optional / not yet" wording in TRD A3.

13. **The seed format is referenced but does not exist.**
    - **Where:** README, FR-15 and TRD §20 point to `server/data/seed/FORMAT.md`, which does not exist (`server/` holds only `package.json`).
    - **Fix:** specify the seed file format in `design/data-model.md` §7 (or create the file):
      - files, JSON schema per row, and how the HSN master xlsx maps to `hsn_codes`;
      - `verification_status` forced to `unverified`, with `verified_by` and `last_verified_at` null;
      - the 7113 citation per ruling 18;
      - sha256 of the seed files into audit `dataset.seeded`.

14. **`RateResolution.coverage` is optional with default `ok`, and the examples contradict the data.**
    - **Where:** `openapi.yaml` `RateResolution`, and the classify examples for `7117` and `2924`. Both have `applicable_rule: null`, `rules: []` and no `coverage`, so they read as `ok`.
    - **Fix:** make `coverage` **required**, set `coverage: no_rate_rule` (and `matched_at_level: null`, `warnings: []`) in those examples, and require `warnings` and `matched_at_level` too.

15. **Rate-limit header semantics are undefined.**
    - **Where:** `02-TRD` §10 (capacity = burst = ⌈limit/6⌉ = 100), `openapi.yaml` `RateLimitLimit` ("600 tokens per 60 s"), and `RateLimitRemaining` ("requests remaining", which is wrong because classify costs 5).
    - **Fix:** state exactly that `RateLimit-Limit` = bucket capacity in tokens (100 by default), `RateLimit-Remaining` = tokens left (floor), and `RateLimit-Reset` = seconds until the bucket is full. Then quote the policy, for example with `RateLimit-Policy: 600;w=60;burst=100`. Add the header values to T-S04.

16. **Intra-state supply in Union Territories (UTGST) is not addressed.**
    - **Where:** PRD §4 non-goals, TRD §6, `openapi` `TaxAmounts`, `03` §7.3.
    - **Problem:** In UTs without a legislature (e.g. Chandigarh, Ladakh, Andaman) the second component is UTGST, not SGST. Research §1.1 lists the UTGST (Rate) notifications. Billing apps print the label.
    - **Fix:** add one sentence in each place: "`sgst` carries SGST or UTGST, at the same rate; the client labels it by place of supply". Optionally add `supply_type: intra_ut` to return a `utgst` key. Either way, decide it explicitly.

### C. Cross-document contradictions (pick one value and make every doc say it)

17. **GTIN failure status.** SEC-28 says "bad check digit → **400**". PRD US-04 AC1, TRD T-C04, `03` §4/§10, openapi and `ui-and-dx` say **422 `invalid-gtin`**. Fix SEC-28 to read 422 `invalid-gtin`.

18. **Body and field limits.**
    - **Body size:** openapi `PayloadTooLarge` says "16 KiB (classify) or 256 KiB / 500 lines (tax)", while TRD §16, SEC-24 and PRD US-06 AC4 say a global 64 KiB. Fix openapi to say 64 KiB everywhere (or make TRD, SEC and PRD per-route; pick one).
    - **`q` length:** openapi `q` is minLength 2 / maxLength 200, against SEC-27's 1–100. Align (2–100 is recommended).
    - **`unit_price` minimum:** SEC-28 says `unit_price ≥ 0`, but openapi has `exclusiveMinimum: 0`. Align SEC-28 to "> 0".
    - **`TaxLineInput.unit_price`:** it has no `maximum`. Add 1e9.

19. **ETag and Cache-Control.**
    - **ETag hash:** TRD §11 says `…[:16]` over `(route, params)`, while architecture §2.1 and the openapi header/example say 8 hex over `(code,date,unit_price)`.
    - **Cache-Control:** openapi `CacheControl` is `private, max-age=300, must-revalidate`, while TRD §11 and `07` §7 say `private, max-age=3600` (and `no-cache` for `/rates/changes` and `/meta`).
    - **Which routes get an ETag:** openapi says "every GET under /v1 returns an ETag" (admin included), TRD lists three routes, and `07` adds `/meta`.
    - **Fix:** one table in TRD §11 (route → ETag yes/no → Cache-Control), copied verbatim into openapi and `07` §7.

20. **Echoing input in errors.** SEC-75 says "list field paths and constraint names, **not the rejected value**", but `ui-and-dx` §1 rule 2 says "**Echo the offending value** (truncated to 64 chars)", and the openapi examples echo it (`"8901234012346"`, `"7199"`). Fix by deciding (I recommend allowing an echo of *validated-format* values such as digits-only codes and GTINs, and never free text such as `name` or `q`), then updating both SEC-75 and `ui-and-dx` rule 2.

21. **Approving a proposal twice.** `07` §8 says "approving an already-approved proposal returns the existing result (200)". openapi approve `409` says "Proposal is not pending", and the registry has `proposal-not-pending`. Fix with one rule: a replay with the same `Idempotency-Key` returns 200 (the stored response), and any other approve or reject of a non-pending proposal returns 409 `proposal-not-pending`. Update `07` §8.

22. **`no-rate-for-date` has no defined trigger.**
    - **Where:** `ui-and-dx` §1, `07` §3 and the openapi registry list it, but PRD US-01 AC3 and TRD §6 return 200 `coverage: no_rate_rule`.
    - **Fix:** either remove it from the registry or name the exact route and condition that emits it (e.g. none in v1, reserved). As written, a builder must guess.

23. **`request_id` format.** The openapi `Problem.request_id` pattern is `^req_<ULID>$`, but `07` §9 accepts a client `X-Request-Id` matching `^[A-Za-z0-9._-]{1,64}$` and echoes it in `request_id`. Fix by keeping the server `req_` ULID as `request_id` always, and echoing the client value separately as `client_request_id` (or loosening the pattern). State this in `07` §9 and openapi.

24. **Correction signalling: three versions.**
    - PRD §9 says "change event `correction`".
    - SEC-82 says "change-feed event with `reason: correction`".
    - `07` §5 says "`supersedes_id` and `reason: "correction"`; the old row is marked `superseded`".
    - TRD §12 says summary prefix "correction:".
    - Neither the DDL nor the openapi `Change` has `reason`.
    - **Fix:** after fix 1, define it once: the `rule_voided` change type plus a `Change.reason` enum `[normal, correction]`. Then update PRD §9, SEC-82, `07` §5, TRD §12, the DDL and openapi.

25. **Outbound HTTP for the CBIC watcher breaks the import rule.**
    - **Where:** TRD §13 has the watcher in `db/watcher.ts` fetching via `lib/http.ts` from cbic hosts. But TRD §2, SEC-32, architecture §3 and `07` §2 say **only `adapters/**` may import `lib/http.ts`**. `HSN_OUTBOUND_ALLOWLIST` is documented for adapters only, and the cbic hosts are not in it.
    - **Fix:** move the watcher to `adapters/cbicWatcher.ts` (invoked by a `jobs/` or `db/` scheduler that does not itself import `lib/http`). Add a `HSN_WATCHER_HOSTS` env var (default `cbic-gst.gov.in,taxinformation.cbic.gov.in`) to TRD §8, and update SEC-32/33.

26. **The seed loader contradicts SEC-55.** SEC-55 says bulk ingestion "produces proposals — it never writes `rate_rules` directly in production". TRD §13 says `npm run seed` writes directly when `dataset_state` is empty. Fix SEC-55 to add: "except the one-time seed into an empty database (TRD §13), which writes rows as `unverified`, `published_by='seed'`, and audit `dataset.seeded` with the file sha256".

27. **`07` §5 rate-rule field names do not match the DDL.** It uses `hsn_code`, `rate_bp`, `condition` (an object), `notification_ref`, `supersedes_id`, `reason`, "marked `superseded`", and says rules are defined at 4/6/8 digits. The DDL uses `hsn_prefix`, `igst_rate_bp`, `condition_kind/condition_text/min_/max_unit_price_paise` and `superseded_by`, and the seed example uses a 2-digit prefix (`'61'`). Fix by rewriting the `07` §5 field list with the DDL names, stating levels 2/4/5(SAC)/6/8, and deleting "marked superseded".

28. **API-key and log field names.**
    - SEC-14 lists `owner_label` and `hash`, but the DDL has `tenant`, `actor`, `label` and `key_hash`.
    - SEC-63 and TRD §14 log `key_id` ("not prefix"), but architecture §6 logs "key prefix, tenant" and "a 64-char truncated, hashed name", while SEC-62 says SHA-256 of the normalised name.
    - **Fix:** align SEC-14 to the DDL names. Make architecture §6 say `key_id`, `tenant` and `input_hash` (SHA-256 of the normalised name), per SEC-62/63.

29. **Uncertain or unsourced material is presented as fact.** This violates AG-02/AG-04.
    - **(a) URL:** every openapi example cites `source.url: https://cbic-gst.gov.in/gst-goods-services-rates.html`, a URL that appears nowhere in `research/sources.md`. Replace it with the research URL for 9/2025 (`https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications`), or with a clearly placeholder value such as `https://taxinformation.cbic.gov.in/view-pdf/<id>` labelled illustrative.
    - **(b) Citation format:** one notification appears as both `9/2025-CT(Rate), Schedule IV` and `09/2025-Central Tax (Rate)`. Pick one canonical format and document it in data-model `notification_ref`.
    - **(c) 01/2026 dates:** PRD §1 and §2.2 use the 01/2026 dates (30-04 → 01-05, corrigendum 06-05) as the binding SLA rationale, but research rates this **M, gazette not read**. Add "(per secondary sources; gazette not yet read)".
    - **(d) Unlabelled admin mock-up:** the `ui-and-dx` §2 mock-up shows "Source 01/2017-Integrated Tax(Rate)" for 3004 and "214 HSN codes under 3004 affected", neither of which is in the research, and is not labelled illustrative. Add an "Illustrative" caption, as ruling 18 and AG-04 require.

## Optional polish (not blocking)

- `03` §1: test and live keys are indistinguishable by string. Consider `hsk_test_…` / `hsk_live_…` (this needs a ruling-10 amendment) so that a test key in production fails loudly.
- PRD §4 non-goals: add exports/SEZ (zero-rated), composition-scheme dealers and reverse charge, so integrators know these are out of scope.
- Sunarone launch set (`03` §11, research §2.4): add 7114 (silver/gold articles, utensils) and 7118 (coins) to the research to-do. Jewellers sell both.
- The DDL CHECK `decided_by <> proposed_by` makes a maker unable to set `withdrawn` on their own proposal, and no withdraw endpoint exists. Either drop `withdrawn` or exempt it.
- "Two active keys per tenant" (PRD US-10): say whether a third is rejected or merely allowed.
- `/v1/admin/audit?verify=true` verifies only the returned page. Note that full-chain verification is the CLI or the restore drill, or add `verify=full`.
- SM-06 depends on a "quick start" that is only one `curl` line today. Add a 1-page client quick start (key → bootstrap feed → lookup → classify → tax) with Node and Kotlin snippets.
- 64 KiB with 500 fully populated tax lines is about 55 KB. Note the headroom, or raise the limit for `/tax/calculate` only.
- TRD §15.1 test IDs: T-C12 appears before T-C10/T-C11. Renumber.
- Architecture §4 `/readyz` omits "manifest hash verifies" (TRD §14 and `07` §9 include it). Align.
- `RateRule.verified_by` example `reviewer:priya` vs actor handle `priya`. Pick one form.
- `03` §4: the invalid-check-digit message "should be 5, got 6" sits under a scan of `…2345`, which is valid. Show the scan as `…2346` in that branch.

## Required-fix count: **29**
