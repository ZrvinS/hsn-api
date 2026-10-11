# 02 — Technical Requirements (HSN Rate API)

Status: draft, synced to code rounds 4–6 · Date: 2026-10-11 · Requirements source: `01-PRD.md`
Precedence: `00-coordinator-decisions.md`, `00b-coordinator-rulings.md` and `00c-coordinator-rulings-round2.md` > `05-security-checklist.md` / `06-ai-restrictions.md` > this document > `07-best-practices.md` > `design/*`. Cross-document conflicts were settled by `00b-coordinator-rulings.md` and `00c-coordinator-rulings-round2.md` (see §20).
Detailed designs referenced (not repeated): `design/openapi.yaml` (contract), `design/data-model.md` (DDL, resolution algorithm), `design/architecture.md` (components, sequences, confidence formula), `design/ui-and-dx.md` (errors, client UX; the admin UI is future work, ruling 21).

---

## 1. Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 (installed: v22.22.0; `engines: >=22.13`) | `node:sqlite` is built in and needs no native build |
| Language | TypeScript **5.9.3**, strict, ESM | Flags: `07` §1 (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| HTTP | **Fastify 5.12.5** | JSON-schema (Ajv) validation of params, query, body and response; `onProtoPoisoning: 'error'` |
| Domain validation | **zod 3.25.76** | Config, seed and ingestion rows, admin proposal bodies, LLM output |
| Storage | `node:sqlite` `DatabaseSync`, WAL, **FTS5** (`unicode61 remove_diacritics 2`, bm25) | Repository interfaces stay storage-agnostic (Postgres later) |
| Tests | **vitest 5.0.3** | `fastify.inject()` for HTTP; temp DB per test file |
| Dev runner | tsx 4.23.15 | `npm run dev` / `npm run seed` |
| Runtime deps | `fastify`, `zod` only, pinned exactly | New runtime deps need auditor sign-off (SEC-65, AG-13). Logging uses Fastify's bundled pino. ULID, ETag, rate limiter and security headers are hand-written (no plugins). |

Scripts (`server/package.json`, ruling 31): `dev`, `build`, `start` (`dist/main.js`), `typecheck`, `test`, `seed`, `create-key`, `bootstrap-admins`, `export-audit-head`, `verify-audit`, `rotate-feed-epoch`, `disable-actor`, `ack-restore`, `watch-cbic`, `eval` (`scripts/eval-classifier.ts`), `import-dataset`; each operator script is `scripts/<name>.ts`, run with `npm run <name> -- …` or `npx tsx scripts/<name>.ts …`. There is no `keys.ts` and no `restore.ts`. **Entrypoint is `src/main.ts`; the app factory is `src/app.ts`** (ruling 2). Zero-to-first-call instructions, production notes and the data-status statement are in `server/README.md`; every environment variable is in `server/.env.example`.

## 2. Module boundaries

The layout is `design/architecture.md` §3 (ruling 1): `routes/ services/ repositories/ classify/ adapters/ lib/ db/ jobs/` plus `scripts/`.

```
src/
  main.ts            entrypoint: loadConfig → openDb → migrate → buildApp → listen
  app.ts             buildApp({config, repos, clock, llm}) — used by tests
  config.ts          zod env schema, frozen, secrets wrapped (toJSON → "[redacted]")
  routes/            health, hsn, classify, tax, rates, meta, admin; schemas/
  services/          rateResolver, taxCalculator, proposalService, auditService, changeFeedService, datasetService
  repositories/      types.ts (interfaces) + sqlite/ (only place importing node:sqlite) + sqlite/migrations/*.sql
  classify/          normalise, gtin, synonyms, fts, chapterKeywords, barcodeCategory, fusion, rerank, pipeline
  adapters/          productLookup (port), openFoodFacts, openBeautyFacts, llm, cbicWatcher, httpClient (the only outbound client)
  lib/               problem (type registry), auth, rateLimit, etag, money, dates, ids, log
  db/                openDb (pragmas; read-only, cache-writer and admin-writer connections), migrate, seed loader
  jobs/              scheduler: in-process watcher runs (HSN_WATCHER_ENABLED), idempotency purge, products eviction (imports adapters, never the http client)
scripts/             seed, create-key, bootstrap-admins, export-audit-head, verify-audit, rotate-feed-epoch, disable-actor,
                     ack-restore, watch-cbic, eval-classifier, import-dataset (admin-writer connection)
```

Enforced by `test/arch/imports.test.ts`, which scans source imports:
- `routes/**` must not import `repositories/**` or `node:sqlite`.
- Only `repositories/sqlite/**` and `db/**` import `node:sqlite`.
- Only `adapters/httpClient.ts` calls `fetch`, `http.request` or `undici`, and only `adapters/**` import it (SEC-32; the module is `src/adapters/httpClient.ts`, an accepted deviation from the earlier `lib/http.ts`). `jobs/**` may import adapters but not the client (validator fix 25).
- Admin routes are registered only on the admin listener; a test asserts the public app has no `/v1/admin/*` route (ruling 25).
- `classify/**` must not import `services/proposalService*`, `services/taxCalculator*`, or any repository write method (SEC-56, AI-02).
- `lib/money`, `lib/dates`, `lib/ids` and `classify/fusion` import nothing with I/O, and have no `Date.now()` and no `process.env`.

## 3. Data model summary

Full DDL is in `design/data-model.md` §2. Under 00c ruling 34 it mirrors the code exactly: `server/src/db/schema.sql` (base, version 2) plus the `src/db/migrations.ts` steps (v3 watcher and `add_code`; v4 `pepper_id` and the product-cache index; v5 bound guards: proposals born pending from the proposer's own active key, every rule, version-pointer, code and reference-row change bound to the approved proposal that makes it, the 72 h grant-key window and watcher `pending_action`; v6 `rate_rules.citation_note`; v7 two-admin confirmation for keyed watched rows and their first triage). `reviews/round2-tools/test-ddl.cjs` checks this byte-for-byte and runs 117 trigger and constraint checks (data-model §9). Tables: `schema_migrations`, `dataset_versions`, `dataset_state`, `seed_batches`, `hsn_codes` (+ `hsn_fts` external-content FTS5, `hsn_code_history`), `admin_actors`, `api_keys`, `idempotency_keys`, `rate_proposals`, `rate_rules`, `change_feed`, `audit_log` (HMAC chain), `watched_notifications`, `watcher_runs`, `products` (barcode cache), `category_map`, `synonyms`, `chapter_keywords`.

Conventions: money in integer paise; rates in integer basis points from the `HSN_ALLOWED_RATES_BP` slab list (CGST = SGST/UTGST = IGST/2, computed with divisor 20000 so odd slabs such as 25 bp need no fractional bp); effective dates are inclusive IST civil dates (`effective_to NULL` = open-ended); prefixed ULIDs; codes of length 2, 4, 6, 8, or 5 in chapter 99 (ruling 6); canonical `notification_ref` such as `9/2025-CT(Rate), Schedule IV` with the serial in `schedule_serial` (validator fix 29b).

### 3.1 Integrity model (details in `design/data-model.md`)

- **Provenance (ruling 19).** Every `rate_rules` row references an approved proposal that names it (`proposal_id` = `resulting_rule_id`, `created_in_version` = `resulting_version`) or the seed batch of the empty-database publish (`seed_batch_id`). Reference rows and post-seed HSN codes reference an approved `refdata_change` (`added_by_proposal`).
- **Set-once fields.** `effective_to`, `end_dated_in_version`, `superseded_by`, `verified_by`, `schedule_serial` and `source_pdf_sha256` change only from NULL, once; `last_verified_at` only moves forward; a voided rule never changes. Proposal content is immutable and decisions are final. `dataset_versions.content_hash` is filled once (from a placeholder) and `dataset_state` only moves forward.
- **Verification.** `verification_status` moves only `unverified → verified`. Approval of `verify` sets `verified_by` (checker handle), `last_verified_at`, `schedule_serial`, `source_pdf_sha256` and emits `rule_verified`. Re-verification moves only `last_verified_at` forward (ruling 9). **Ruling 36 (core round 9):** the first verify of an unverified rule may carry `source.url` (a notification document: `/view-pdf/` or `.pdf`, not an index page) and `source.notification`; `url` is required when the rule cites an index page (400 `source-url-not-document`). Approval sets the citation, the verification fields and `citation_note = NULL` in one statement; migration 8 lets the trigger accept exactly this citation change, and the cross-check compares each rule's citation with its latest verify approval's audit snapshot. On a verified rule `url`/`notification` → 400. `reverify_due_at = last_verified_at + 12 months` is computed in `services/rates.ts` (not a column). There is no separate verifications table: the history is the audit log and the `rule_verified` feed rows.
- **Corrections (ruling 1).** `correct` voids the target (`status='voided'`, `voided_at`, `voided_in_version`, `voided_by_rule`, same prefix enforced) and inserts the replacement in one transaction; feed `rule_corrected` (`rule_id` = replacement, `related_rule_id` = voided).
- **Approval binding.** `rate_proposals.content_sha256` (sent back as `expected_sha256`) and `target_sha256` (the target row's hash at proposal time; a changed target → 409 `rule-not-active`). Rule content is in `rule_json`; other action data in `payload_json`.
- **Admin identity (ruling 17).** `admin_actors(id, handle, display_name, created_via ∈ bootstrap|admin_grant, grant_proposal_id, disabled_at)`; `api_keys.scopes` in one canonical JSON spelling (`["read"]`, `["classify"]`, `["read","classify"]`, `["admin"]`), `actor_id` exactly for admin keys, `admin_grant_id` UNIQUE, admin expiry ≤ 90 days, `pepper_id` (migration 4).
- **HSN descriptions (ruling 34).** Updated in place with `changed_by_proposal`; a trigger copies the old text to `hsn_code_history`.
- **Idempotency (rulings 8, 28).** `idempotency_keys(key_id, idem_key, route, request_sha256, status_code, response_json, created_at)`, primary key `(key_id, idem_key)`, 24 h TTL on read plus purge.
- **Feed lineage (ruling 25).** `dataset_state.feed_epoch` (random; rotated automatically when a restore is detected, or by hand with `rotate-feed-epoch`).
- **Citation notes (round 5).** `rate_rules.citation_note` (≤ 1000 chars) is the caveat served with an unverified seed rule ("Transcribed from secondary sources; schedule S.No. and gazette text not yet checked …"). Only the seed sets it; only a `verify` approval clears it (v6 triggers); it is outside the dataset content hash, and `dataset.seeded` records every note so the cross-check catches edits (round 6).
- **Proposal kinds stored in existing actions (round 4–5).** `disable_actor` is an `admin_grant` row with `payload.op = "disable_actor"`; `dataset_import` is a `refdata_change` row with `payload = {op: "dataset_import", files, counts}`. DTOs show the logical `action`.
- **Detection (rounds 4–6).** A state-to-audit cross-check (`services/integrity.ts`) runs at boot, in `verify-audit` and in `import-dataset`: every version, proposal (content hash recomputed from stored content, created vs approved content, decision), rule change, verification, citation note, key (creation, revocation, expiry, and since round 7 the policy fields `tenant`, `llm_opt_out`, `rate_limit_per_min`, `daily_quota` recorded in `api_key.created`), actor (disablement) and watched notification (a `detected` entry, prefixes equal as a set to the last detected/triaged entry, the resolve entry with `requested_by`/`confirmed_by` on keyed rows, no resolve entry on a row still `detected`) must match an HMAC'd audit entry. Restore detection (`services/restoreGuard.ts`) compares the DB with a MAC'd high-water-mark sidecar (`HSN_STATE_HWM_FILE`). See §16 and data-model §4.5.
- **Watcher (ruling 10, migrations 3, 5, 7).** `watched_notifications(id wn_…, notification_ref, source_url, affected_prefixes, effective_from, detected_at, state ∈ detected|published|dismissed, expedite, note, created_by, resolved_at, resolved_by, source, notification_key UNIQUE, title, notification_date, pending_action)` and the append-only `watcher_runs`. On a row with a `notification_key`, resolve, first triage and prefix removal need two admins (§13).

## 4. Rate-resolution algorithm

Implemented once as a pure function, `services/rateResolver.ts`, as specified in `design/data-model.md` §3. Summary:

1. Gather rules in force on date D (`effective_from ≤ D ≤ coalesce(effective_to, ∞)`) whose prefix is an ancestor of `code` (or the code itself), or a descendant of it.
2. Keep the **longest** ancestor-or-self prefix set R.
3. If descendant rules have a different `(igst_rate_bp, cess_rate_bp, cess_specific_paise)` → `ambiguous`, with reason "query the more specific code".
4. If `unit_price` P is given, drop `price` rules whose inclusive `[min, max]` excludes P.
5. |R| = 0 → `coverage: no_rate_rule`, no rate. |R| = 1 → applicable, `coverage: ok`. Several rules with identical rate tuples → applicable (latest `last_verified_at`, then smallest `rule_id`). Otherwise → `ambiguous: true`, `coverage: ambiguous`, all of R with condition text and a reason. When R is one `none` rule plus `other` rules (e.g. 3004 general 5% plus the nil-rate drug list of 10/2025-CT(Rate)), `default_rule_id` = the `none` rule (ruling 5); otherwise `default_rule_id = null`.
6. Overlap (a data error): both `none`; `none` with `price`; overlapping `price` ranges; or two `other` rules with the same text. Logged as `rate_rule_overlap` and returned ambiguous; approval rejects these (409). A `none` rule may coexist with `other` rules.
7. Only `status = 'active'` rules are considered; voided rules never resolve.
8. **Codes outside the master (round 5, validator R3).** A code that is not in `hsn_codes` but has a known ancestor (6, then 5 for SAC 99xxx, then 4, then 2 digits) is resolved under that nearest known parent: lookup 200 with `code_in_master: false`, `resolved_via: "<parent>"`, warning `code_not_in_master` and a description naming the parent; tax lines are computed the same way. Only a code whose **chapter** does not exist gets 404 `hsn-not-found` (lookup) or 422 `unknown-hsn` (tax). Codes in the master carry `code_in_master: true`, `resolved_via: null`.

Additions in this TRD:
- **Warnings** (`RateResolution.warnings`, required, open enum): `rate_unverified` (the applicable rule, or any listed rule when ambiguous, is unverified; the `disclaimer` adds "This rate has not yet been checked against the notification PDF by a reviewer."), `verification_overdue` (verified but past `reverify_due_at`, ruling 9), `pending_change_detected` (a `watched_notifications` row in state `detected` lists a prefix `p` with `code.startsWith(p) || p.startsWith(code)`, ruling 10), `selected_by_hint` (an exact curated synonym's `rule_hint` selected one rule of an ambiguous set, ruling 5), `code_not_in_master` (step 8), `no_rate_rule` and `ambiguous` (mirroring `coverage`).
- **`citation_note`** is on every rule DTO (`rate.rules[]`, `applicable_rule`, tax `candidate_rules[]`); null once verified.
- **Required fields:** `coverage` (`ok | ambiguous | no_rate_rule`), `warnings`, `matched_at_level` and `default_rule_id` are always present (ruling 13, validator fix 14).
- **Default date** = today in Asia/Kolkata from the injected clock. Valid range: 2017-07-01 to today + 366 days (SEC-29).
- **`matched_at_level`** (from `07` §5) = `length(hsn_prefix)` of the matched rules (2, 4, 5, 6 or 8); null for `no_rate_rule`.
- The resolver never consults the classifier. The classifier calls the resolver read-only.

## 5. Classification pipeline and confidence

Specified in `design/architecture.md` §2.2, §2.3 and §5. Constraints come from `06-ai-restrictions.md` Part A.

```
barcode → GTIN check digit (422 on fail, no outbound) → normalise GTIN-14
        → products cache (found 7 d / not-found 24 h; cap HSN_PRODUCT_CACHE_MAX_ROWS, oldest fetched_at evicted first)
        → enabled adapters (OFF, OBF; allow-listed, 3 s total timeout, no redirects, no compression),
          only within the key's daily cap (HSN_OUTBOUND_PER_KEY_DAILY), the per-host minute budget
          (OFF 15/min) and the global queue (HSN_OUTBOUND_QUEUE_MAX), else product.source = lookup_failed;
          adapter errors are cached in memory (15 min transient, 24 h schema, 2 min budget), never as not_found
        → {name, brand, category, source, fetched_at}   (external, publicly editable data)
name    → normalise (NFKC, lowercase, strip control/zero-width, karat → "22k", split units, ≤200 chars)
          text = request name if sent, else the external product name (then the external-data cap applies)
        → candidates = synonyms ∪ FTS5 top-10 (levels 4 and 8) ∪ category_map prefix
        → signals per candidate: s_syn (0.50), s_fts (0.20), s_chap (0.15), s_bar (0.15)
        → fusion → caps → band → [optional LLM re-rank, reorder only, confidence only down] → top ≤ 5 → RateResolver per candidate
```

Confidence formula (`classifier.version` **`rules-fts-2.3`**; the formula is unchanged since `rules-fts-2.0`, architecture.md §5.4 is authoritative and reproduced because tests depend on it; rulings 2 and 22). What changed is when a synonym counts as exact (see the exactness policy below):
```
A        = {fts, chap} ∪ {syn if any curated synonym matched the text} ∪ {bar if the barcode category is in category_map}
raw_c    = Σ_{i∈A} w_i·s_i(c) / Σ_{i∈A} w_i            (denominator 0.35, 0.50, 0.85 or 1.00)
penalty  = max(0, 0.10 − (raw_top − raw_second)) / 2    (top candidate only)
conf_c   = clamp(raw_c − penalty_c, 0, 1)
syn cap  : s_syn(c) < 1.0 → conf_c ≤ 0.84                 (no reason code; visible as conf < raw)
ext cap  : text came from external product data → ≤ 0.84  reason review_hint naming the source
close    : conf_top − conf_second < 0.10 → conf_top ≤ 0.84, reason close_runner_up
band     : high ≥ 0.85 · medium ≥ 0.60 · low < 0.60
needs_review = band ≠ high (candidate); top band ≠ high or no candidates (response)
```
**Exactness policy (`rules-fts-2.1`, validator R2; tightened in `rules-fts-2.2`, SA-K3-01/04).** A primary, contiguous, uncontested synonym scores `s_syn = 1.0` only when it **is** the product name: after removing its tokens nothing may remain except quantities (a number, optionally followed by an allow-listed unit: g, gm, gms, kg, mg, mcg, ml, l, ltr, cm, mm, m, in, pcs, pc, x, iu, w, kw, v, mah, gb, tb, or a real karat value), pack words, dosage forms and function words (`classify/coverage.ts`). A phrase inside a longer name scores 0.7 (at most medium), a one-word phrase inside a longer name 0.3 ("tablet" in "Samsung Galaxy tablet" → 3004 low). Single generic words (tablet, capsule, syrup, shirt, chocolate, ring, chain, oil, …) are never exact. Brand words from a barcode lookup never count towards exactness (2.2). **Accessory / packaging qualifier (`rules-fts-2.3`, `classify/accessory.ts`):** an accessory word (stand, holder, cover, case, charger, cable, mount, guard, …, "screen guard", "tempered glass", "back cover"; not "sleeve") that follows a candidate's own evidence or is linked to it by "for" caps that candidate at 0.45 (low) with a review hint, unless the word is the candidate's own evidence ("phone charger" keeps 8504); packaging words (box, hamper, packaging, container, basket) keep the contents' candidates with a review hint. It only lowers scores and never adds a candidate. The imitation-jewellery qualifier (`classify/qualifiers.ts`: plated, imitation, artificial, alloy, brass, oxidised, "german silver", "american diamond", "one gram") moves 7113 evidence to 7117 (capped at 0.7) and lowers other Chapter 71 evidence ×0.4; gold-plated silver stays silver jewellery. The qualifier never touches rates.

Consequences (stated in PRD §2.3): `high` requires that a curated phrase is the whole name the client sent; FTS plus chapter agreement without a synonym reaches at most medium (0.84); a barcode-only request is at most medium; a weak FTS hit alone stays low.

- **Weak matches (AI-05):** drop candidates with conf < 0.10. If the best remaining is < 0.30, still return the rest, all band `low`, `needs_review: true`, with a response `message`. `candidates: []` only when nothing reaches 0.10.
- **Rule hint (ruling 5):** an exact curated synonym on the caller's name may carry `rule_hint` (a rule `condition_code`, e.g. `nil_rate_list`). The classifier passes it to `RateService.resolve(code, date, price, { conditionCode })`; if the resolution is ambiguous and exactly one rule has that code, it is selected (`coverage: ok`, warning `selected_by_hint`) and the candidate carries `rule_hint: {condition, synonym}`. Never from external data, partial, contested or related synonyms; the band is unchanged.
- **Order:** `candidates` order is the ranking; after a re-rank confidences are clamped to be non-increasing. The response's `scoring` gives the applicable set and denominator.

The response carries `classifier.version`, `dataset_version`, `llm_used`, the raw `signals` (a signal outside A is `null`) and `reasons[]` (`{code, detail, weight}`, ruling 4) for each candidate, so anyone can recompute the score by hand. `product` carries `source` and `fetched_at` (SA-D-06; there is no separate last-modified field, 00c ruling 35).

**LLM re-ranker (Later, off by default).** Used only if configured (`HSN_LLM_ENABLED`), the request sends `allow_llm: true` (default false), the key's `llm_opt_out` is not set (ruling 8), the LLM call budgets (`HSN_LLM_CALLS_PER_MIN`, `HSN_LLM_CALLS_PER_DAY`) are not spent, and the deterministic top is not already `high`. Input: normalised text and candidate codes with their official descriptions, sent as JSON data fields; the external product category is **not** sent (SA-D-26). Output: zod-validated `{ "ranking": [code, …] }`, an exact permutation of the codes sent; any unknown, missing or duplicated code discards the whole output (SA-K-01). No model text reaches responses or logs; the `llm_rerank` reason is a fixed template. Any unknown code, extra field, timeout (5 s) or parse failure → deterministic order, `llm_used: false`, `ai.fallback` logged. The re-ranker never sees or returns rates and can only lower confidence (ruling 7, architecture.md §5.6). `/v1/meta/dataset` discloses `llm: {configured, provider}`. Enabling it requires the AI-20 config set and passing the AI-43 gates.

## 6. Tax calculation rules

Per `07` §6 (the binding contract) and OpenAPI `calculateTax`:

| Rule | Specification |
|---|---|
| Input money | JSON number in INR with ≤ 2 decimals (OpenAPI `multipleOf 0.01`, checked on the decimal string), parsed **from its string form** to integer paise, with no `x*100` float maths. `taxable_value` max ₹10,000,000,000 (1e12 paise) per line; `unit_price` > 0 and ≤ ₹1,000,000,000 (SEC-28); ≤ 500 lines; tax body ≤ 256 KiB (coordinator decision: 500 full lines are about 55 KB; other routes 64 KiB, classify 16 KiB). |
| Output money | Every amount twice (ruling 32): rupee numbers in `tax` / `totals` and integer paise in `tax_paise` / `totals_paise` (same keys: `cgst`, `sgst`, `utgst`, `igst`, `cess`, `total_tax`; totals add `taxable_value`). |
| Rate | `igst_rate_bp` from the resolved rule; never from input. |
| Supply type | `intra`: `cgst = roundHalfUp(taxable_paise × rate_bp, 20000)`; `sgst` the same, independently. `intra_ut` (intra-UT supply in a UT without legislature, e.g. Chandigarh, Ladakh): `cgst` as above and `utgst` instead of `sgst`, same rate (ruling 15). `inter`: IGST. Every line result carries `sgst` and `utgst` (one of them 0). |
| IGST | `igst = roundHalfUp(taxable_paise × rate_bp, 10000)` |
| Cess | Ad-valorem: `roundHalfUp(taxable_paise × cess_rate_bp, 10000)`. Specific cess: returned as data on the rule, **not computed in v1**; the line gets note `specific_cess_not_computed` (ruling 14). It is zero for all goods from 01-02-2026 in any case. |
| Rounding | Per line, per component, half-up to the paisa. Totals are sums of rounded lines, with no re-rounding. CGST+SGST may differ from IGST by 1 paisa; this is expected. Implemented with `BigInt`. |
| Unit price and quantity | `unit_price` (if given) resolves price-threshold rules. `quantity` is a number or a decimal string (≤ 12 characters), > 0, ≤ 9,999,999, with ≤ 3 places (rulings 7 and 32). It never changes the tax base: tax is always on `taxable_value`. When `unit_price` is absent and `quantity` is given, the unit price used for price-threshold rule selection is derived as roundHalfUp(taxable_paise × 1000 / qty_milli) (validator fix 7; implemented as `deriveUnitPricePaise`). It is held as `qty_milli` for the specific-cess computation planned later. |
| Line id | `line_id` optional on input; default is the zero-based index as a string. Output always has it. |
| Rule echo | Each computed line returns `rule_id`, `rule_selected_by` (`resolver`, `rule_id` or `condition_general`), `igst_rate_bp`, `igst_rate_percent`, `source`, `verification_status` and `warning` (text, set for unverified rules); clients persist `rule_id`, `igst_rate_bp` and `dataset_version` on the invoice. |
| Ambiguous line | The line is computed if it names the rule: `rule_id` (must be one of the candidate rules, else 422 `rule-choice-invalid`) or `condition: "general"` (uses `default_rule_id`; 422 `rule-choice-invalid` when null). Otherwise `ambiguous: true`, `tax: null`, `candidate_rules[]`, `default_rule_id`, `needs_input[]` (among `unit_price`, `rule_id`, `hsn`) and a matching `notes[]` entry with explanation; response `complete: false`; totals exclude the line (ruling 5). |
| Code outside the master | Computed under the nearest known parent (§4 step 8); the line carries `code_in_master: false`, `resolved_via`, `warnings: ["code_not_in_master"]` and a `code_not_in_master: …` note; the response's top-level `warnings` then contains `code_not_in_master` (round 6, SA-C3-08). `complete` stays true for such a line. |
| Unknown HSN on a line | Only a code whose chapter does not exist: 422 `unknown-hsn` with pointer `/lines/{i}/hsn`. |
| Partial totals (round 5, validator R13) | When any line has `tax: null` (`needs_input`, refused unverified, no rule), `complete: false`, `totals` and `totals_paise` are **null**, and `partial_totals = {complete: false, included_line_ids, excluded_line_ids, totals, totals_paise}` sums only the computed lines. A complete invoice has `totals` and `partial_totals: null`. |
| HSN with no rule | Line `ambiguous: false`, `tax: null`, note `no_rate_rule`, `complete: false`. Never a zero rate by default. |
| Unverified rule | Computed **only** when the request sets `accept_unverified: true`; the line then has `unverified_accepted: true`, the `warning` text and note `rate_unverified_accepted`, and the acceptance is logged per key (`tax.unverified_accepted`). Otherwise `tax: null`, `needs_input: [accept_unverified]`, `warning` and note `rate_unverified_refused`, excluded from totals, `complete: false` (ruling 24, SA-D-08). Lookups and classify still return unverified rules with the warning. |
| Optional rupee round-off | `invoice_rounding: "none" \| "nearest_rupee"` (default `none`) adds top-level `round_off_paise` and `grand_total_paise` (taxable value plus tax, half-up to the rupee); both are null when `complete` is false. |
| Composite supply | Not decided by the API. Jewellery making charges billed with a sale are part of the 3% supply (one Chapter 71 line); SAC 9988 job work at 5% only for work on customer-owned metal (ruling 12; PRD Q1 open for the CA). |

## 7. API contract

`design/openapi.yaml` (OpenAPI 3.1) is the contract. Public listener: `GET /v1/hsn/{code}`, `GET /v1/hsn/search`, `POST /v1/classify`, `POST /v1/tax/calculate`, `GET /v1/rates/changes`, `GET /v1/meta/dataset`, `GET /healthz`, `GET /readyz`. Admin listener only (`HSN_ADMIN_HOST:HSN_ADMIN_PORT`): `POST|GET /v1/admin/rate-proposals`, `GET /v1/admin/rate-proposals/{id}`, `POST /v1/admin/rate-proposals/{id}/approve|reject|withdraw`, `GET|POST /v1/admin/watched-notifications`, `POST /v1/admin/watched-notifications/{id}/triage|resolve`, `GET /v1/admin/watcher/status`, `DELETE /v1/admin/products/{gtin}`, `GET /v1/admin/audit`, plus `GET /metrics` (not in the OpenAPI file).

Rules:
- `additionalProperties: false` on every request schema. Response schemas are declared so that no internal field is ever serialised (SEC-03).
- Errors are RFC 9457 `application/problem+json` with kebab-case `type` URI, `title`, `status`, `detail`, `instance` (= request path), `request_id` (always the server `req_` ULID) and `client_request_id` (the client's valid `X-Request-Id`, validator fix 23), using the type registry in `design/ui-and-dx.md` §1 (ruling 3). `detail` may echo validated-format values (digit codes, GTINs, ids), never free text (validator fix 20).
- Additive-only changes within `/v1` (`07` §4).
- Applied to `openapi.yaml` (v1.1.0; parses, every `$ref` resolves, 182 examples validate under JSON Schema 2020-12, see `reviews/docs-fix-round2.md`; the hsn, classify and tax examples are live outputs of the quick-start server, 2026-10-11): required `coverage` (`ok | ambiguous | no_rate_rule`), `warnings` (`rate_unverified | verification_overdue | pending_change_detected | selected_by_hint | no_rate_rule | ambiguous`), `matched_at_level`, `default_rule_id` on `RateResolution`; `Source.schedule_serial` and `pdf_sha256`; `RateRule.reverify_due_at`; code pattern `^(\d{2}|\d{4}|\d{6}|\d{8}|99\d{3})$`; tax `accept_unverified`, `supply_type: intra_ut`, line `rule_id` / `condition: general`, `quantity` multipleOf 0.001, `igst_rate_bp` and `utgst` on results; feed `affected_prefix`, `rule_corrected`, `related_rule_id`, `retroactive`, `affects_from`, `feed_epoch`; meta `content_sha256`, `signature`, `feed_epoch`, `sources_checked_at`, `freshness_sla_business_days`, `pending_notifications`, `coverage.rate_rules_verification_overdue`; proposal actions `correct`, `refdata_change`, `admin_grant`, `content_sha256`, `GET …/{id}`, `withdraw`, `expected_sha256` on approve/reject; audit `verify=true|false` with `head_id`, `head_hash`, `chain_broken_at`, `verify_note` (ruling 27); round 3: tax `tax_paise`, `totals_paise`, `rule_selected_by`, `warning`, `quantity` > 0 ≤ 9,999,999 ≤ 3 decimals as number or string (ruling 32); `RefdataChange` `{table, op}` incl. `add_code` and feed `hsn_added`; watched-notification and watcher-status routes; meta `untriaged_notifications`; problems `idempotency-key-required`, `duplicate-notification`; `RateLimit-Cost` and `RateLimit-Policy`; body limits 64 KiB (classify 16 KiB, tax 256 KiB); tax line `needs_input[]`, `unverified_accepted`, `default_rule_id`; problem `code` member; `q` 2–100; rounds 4–6: proposal actions `disable_actor` (`disable: {handle}`) and `dataset_import` (script-only approve; API approve → 409 `proposal-stale`), problems `proposer-disabled` (409) and `method-not-allowed` (405 with `Allow`, now raised for a known path with the wrong method), validation codes `not_self` and `last_actors`, watched-notification `pending_action` and 202 responses, HSN `code_in_master` / `resolved_via` and warning `code_not_in_master`, tax `partial_totals`, nullable `totals` / `totals_paise` / `round_off_paise` / `grand_total_paise`, line and top-level `warnings`, rule `citation_note` (also on the proposal `target_rule` summary, core round 8), `verified_by` = checker handle, classify `message` nullable, 409 `proposal-hash-mismatch` also when the stored content no longer hashes to `content_sha256` (approve and reject).
- `server/openapi.json` is generated from the route schemas and checked into the repo. CI fails if it drifts (SEC-09).

## 8. Configuration (environment variables)

Validated with zod at boot. Any invalid value, or a required value missing in production, makes the process exit non-zero (fail closed). Names use the `HSN_` prefix everywhere (ruling 9).

| Variable | Type / default | Required | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development \| test \| production` | yes | Unknown value → refuse to start |
| `HSN_PORT` | int, `3000` | no | Public listen port |
| `HSN_HOST` | `0.0.0.0` | no | Public bind address |
| `HSN_ADMIN_HOST` | `127.0.0.1` | no | Admin listener bind address; `/v1/admin/*` is served only here (ruling 25). In production a non-loopback value (not `127.0.0.0/8`, `::1` or `localhost`) requires `HSN_ADMIN_IP_ALLOWLIST` (SA-C2-07) |
| `HSN_ADMIN_PORT` | int, `3001` | no | Admin listener port |
| `HSN_DB_PATH` | path | yes | SQLite file (the seed loader must use this name too) |
| `HSN_KEY_PEPPER` | ≥ 32 bytes, secret | prod: yes, unless `HSN_KEY_PEPPERS` is set | Single pepper for API-key hashes (SEC-12, ruling 10); keys hashed with it have `pepper_id` `default`. Not together with `HSN_KEY_PEPPERS` |
| `HSN_KEY_PEPPERS` | `id:secret,id:secret`, newest first; ids `[a-z0-9_-]{1,32}`, each secret ≥ 32 bytes | for rotation | Ruling 29: new keys are hashed with the first pepper; a key verifies with the pepper named by its stored `pepper_id`, so old keys keep working during rotation. Put the old single pepper in the list as `default:<secret>` |
| `HSN_AUDIT_KEY` | ≥ 32 bytes, secret | prod: yes | HMAC key of the audit chain; separate from the pepper (ruling 18) |
| `HSN_LOG_KEY` | ≥ 32 bytes, secret | prod: yes | HMAC key for `input_hash` of classify names in logs; rotated at the log-retention interval (SA-D-18) |
| `HSN_TRUST_PROXY` | CIDR list, empty | no | Fastify `trustProxy`; never `true` (SEC-23). Boot fails in production behind a known platform proxy when unset (SA-D-15) |
| `HSN_LOG_LEVEL` | `info` | no | pino level |
| `HSN_RATE_LIMIT_PER_MIN` | `600` | no | Default per-key bucket (tokens/min); per-key override `api_keys.rate_limit_per_min`. Costs are fixed in code: classify 5, tax 1 + floor(lines/50), others 1 (there is no `HSN_CLASSIFY_TOKEN_COST`) |
| `HSN_AUTH_FAIL_BLOCK_THRESHOLD` | `20` | no | Failed authentications per (client IP — full IPv4, IPv6 /64 — and key prefix) in 5 min before a 15-min block (SA-D-15) |
| `HSN_DIRECT_EXPOSURE` | `false` | no | Set `true` only when clients connect directly (no platform proxy); otherwise production boot requires `HSN_TRUST_PROXY` |
| `HSN_RATE_LIMIT_UNAUTH_PER_MIN` | `60` | no | Per-IP limit on **failed** authentications only; never applied to requests with a valid key |
| `HSN_DAILY_QUOTA_DEFAULT` | `50000` | no | Classify and search per key per IST day (SEC-22) |
| `HSN_ADAPTERS_ENABLED` | `false` | no | Kill switch for all outbound adapters (SEC-83) |
| `HSN_OFF_ENABLED` | `false` | no | Open Food Facts adapter |
| `HSN_OFF_USER_AGENT` | string | if OFF on | Required by the OFF API |
| `HSN_OUTBOUND_ALLOWLIST` | comma-separated hostnames | if any adapter on | Product adapters only, e.g. `world.openfoodfacts.org` |
| `HSN_OUTBOUND_PER_KEY_DAILY` | `500` | no | Barcode cache misses that may call out, per key per IST day (`api_keys.outbound_daily_cap` overrides); beyond → `lookup_failed` (SA-D-14) |
| `HSN_OUTBOUND_QUEUE_MAX` | `4` | no | Global concurrency cap on outbound lookups; full → `lookup_failed` |
| `HSN_OFF_RATE_PER_MIN` | `15` | no | Per-host minute budget for Open Food Facts (its published limit is 15 product reads/min/IP) |
| `HSN_OBF_ENABLED`, `HSN_OBF_RATE_PER_MIN` | `false`, `10` | no | Open Beauty Facts adapter and its minute budget |
| `HSN_PRODUCT_CACHE_MAX_ROWS` | `50000` (100–10,000,000) | no | `products` row cap; the oldest `fetched_at` rows are evicted first (ruling 30) |
| `HSN_WATCHER_ENABLED` | `false` | no | Run the CBIC watcher in-process every `HSN_WATCHER_INTERVAL_MIN` (first run 30 s after boot). Use this **or** the cron line of §13, not both |
| `HSN_WATCHER_INTERVAL_MIN` | `360` (15–1440) | no | In-process watcher interval |
| `HSN_WATCHER_HOSTS` | `cbic-gst.gov.in,www.cbic-gst.gov.in,taxinformation.cbic.gov.in,www.cbic.gov.in` | no | Exact-host allow-list of the watcher's own outbound client (DNS names only, no IP literals; validator fix 25, ruling 30). Each page URL's host must be in this list **and** in `HSN_SOURCE_HOSTS` |
| `HSN_WATCHER_CT_RATE_URL` | `https://cbic-gst.gov.in/central-tax-rate.html` | no | Central Tax (Rate) notifications page; empty disables it. Validated at boot: https, default port, no credentials, a path |
| `HSN_WATCHER_IT_RATE_URL` | `https://cbic-gst.gov.in/integrated-tax-rate.html` | no | Integrated Tax (Rate) notifications page; empty disables it |
| `HSN_WATCHER_USER_AGENT` | `hsn-api-watcher/0.1 (rate notification watcher)` | no | User-Agent of watcher requests |
| `HSN_WATCHER_NOT_BEFORE` | `2025-09-17` | no | Notifications dated before this are counted in `items_seen` but not queued (the seed already transcribes 9/2025-CT(Rate)) |
| `HSN_LLM_ENABLED` | `false` | no | Re-ranker (AI-20). Earlier documents (00b) call it `HSN_LLM_RERANK_ENABLED`; the code and this table use `HSN_LLM_ENABLED` |
| `HSN_LLM_PROVIDER`, `HSN_LLM_MODEL`, `HSN_LLM_API_KEY` | strings (key secret) | if LLM on | Boot fails if any is missing |
| `HSN_LLM_DATA_DISCLOSURE_ACK` | `true` | if LLM on | Operator acknowledgement (AI-20) |
| `HSN_LLM_CALLS_PER_MIN` | `30` | if LLM on | LLM call budget per minute (SA-D-14) |
| `HSN_LLM_CALLS_PER_DAY` | `5000` | if LLM on | LLM call budget per day; spent → deterministic order, cause `budget` |
| `HSN_ADMIN_WRITES_ENABLED` | `true` | no | Kill switch for proposals and approvals (SEC-83) |
| `HSN_ADMIN_IP_ALLOWLIST` | CIDR list | no | Optional extra check on the admin listener (SEC-18); a request from outside it → 403 `forbidden-ip` |
| `HSN_CORS_ORIGINS` | empty (CORS off) | no | SEC-71 |
| `HSN_ALLOWED_RATES_BP` | `0,10,25,100,150,300,500,600,1200,1800,2800,4000` | no | Slab allow-list for proposals and seed; historical slabs kept so old effective-dated rules load (SEC-55, ruling 15) |
| `HSN_SOURCE_HOSTS` | `cbic-gst.gov.in,www.cbic-gst.gov.in,taxinformation.cbic.gov.in,cbic.gov.in,www.cbic.gov.in,egazette.gov.in,www.egazette.gov.in,gstcouncil.gov.in,www.gstcouncil.gov.in` | no | Allowed https `source.url` hosts for proposals (SEC-51, ruling 25) |
| `HSN_SOURCE_INDEX_PAGES` | (empty; built in: `central-tax-rate.html`, `integrated-tax-rate.html`, `gst-goods-services-rates.html` and the watcher pages) | no | Extra listing/index pages (CSV of absolute URLs) that never count as a notification document (ruling 36, core round 9) |
| `HSN_KNOWN_GAPS_FILE` | `<server>/data/seed/known_gaps.json` | no | Curated known-gaps list served as `known_data_gaps` by `GET /v1/meta/dataset`; read once at boot; missing → `[]`, malformed → boot fails (core round 9) |
| `HSN_TRD_PATH` | `/mnt/project-files/hsn-api/docs/02-TRD.md` | no (tests only) | TRD read by `test/docs/traceability.test.ts` (T-X02); a missing file **fails** the suite (core round 10, SA-C5-06); `skip` skips the check |
| `HSN_DATASET_SIGNING_KEY` | Ed25519 private key, base64 PKCS#8 DER, secret | no | Optional signature over `content_sha256` (`/v1/meta/dataset.signature`; null when unset). Not mandatory in v1; the off-host audit head is the required anchor (ruling 18) |
| `HSN_FEED_RETENTION_DAYS` | empty (= keep forever) | no | When set, older cursors get 410 |
| `HSN_ADMIN_GRANT_TTL_HOURS` | `72` (1–72) | no | An approved `admin_grant` must be redeemed with `create-key --grant` within this window; the DB caps it at 72 h (SA-C2-05) |
| `HSN_STATE_HWM_FILE` | dev: `<HSN_DB_PATH>.hwm.json` | **prod: yes** | Restore-detection sidecar, MAC'd with `HSN_AUDIT_KEY`. In production it must be set and its directory must not be the DB's directory; keep it on a different volume and backup set. `off` disables detection and is refused in production (SA-C2-06, SA-C3-04) |
| `HSN_ADMIN_KEY` | secret | scripts only | The operator's own admin key, read by `npm run import-dataset` from the environment (never on the command line) |

Dropped (rulings 29 and 30): `HSN_ADMIN_NOTIFY_HOSTS` (no out-of-band notifier in v1), `HSN_METRICS_HOST` and `HSN_METRICS_PORT` (Prometheus `GET /metrics` is served on the admin listener, `HSN_ADMIN_HOST:HSN_ADMIN_PORT`). (Core removed the unused `HSN_METRICS_PORT` parse, 00c ruling 34.)

## 9. Authentication and scopes

- Header: `Authorization: Bearer <key>`. Keys in query strings are rejected. Format (ruling 10): `hsk_<8-char prefix>_<43-char base64url secret>`, the secret being 32 random bytes from `crypto.randomBytes`. Parse by fixed positions (base64url may contain `_`).
- Storage: prefix (unique, public) plus `HMAC-SHA256(secret, pepper[pepper_id])`. Lookup by prefix on **every request (no auth cache)**, then `timingSafeEqual`; expired or revoked keys → 401. Revocation and expiry take effect immediately (ruling 20). Unknown prefix and wrong secret give the same 401 body.
- Scopes are non-hierarchical and stored as one canonical string: `read`, `classify`, `read,classify` or `admin`. `read` covers lookup, search, tax, the feed and meta; `classify` covers `POST /v1/classify`; `admin` covers `/v1/admin/*` on the admin listener. `admin` never combines with another scope. Unknown values fail the CHECK and the parser refuses to authenticate such a row (SA-D-10). Each route declares `config.scope`; an `onRequest` hook enforces it, and a route without a declared scope is denied.
- **Admin identity (ruling 17, SA-D-01).** Admin keys bind to an `admin_actors.actor_id`; handles are NFKC-normalised, lowercase, `[a-z0-9_-]{3,32}`, unique. Maker–checker compares `actor_id`, never a string chosen at key creation. Admin keys expire within 90 days (CLI and DDL CHECK).
- **Bootstrap.** `scripts/bootstrap-admins.ts` creates the first two actors and one admin key each in one run, only when `admin_actors` is empty, and records `admin.bootstrapped`.
- **After bootstrap, two-person issuance.** A new admin actor, or a new admin key for an actor, needs an approved `admin_grant` proposal approved by a *different* existing admin actor. A grant for an extra key (`new_actor: false`) must be proposed by that actor itself (400 `not_self`, SA-C2-05), and an approved grant expires if not redeemed within `HSN_ADMIN_GRANT_TTL_HOURS` (≤ 72 h). The operator then runs `npx tsx scripts/create-key.ts --tenant internal --scopes admin --actor <handle> --grant <rp_id>`; the DDL accepts an admin key only with an unused approved grant. v1 has no out-of-band notifier (ruling 29, deferred to Later): the approval writes the audit entry and a warn-level log line `admin.grant_approved` with `alert: true`, and `api_key.created` records the key, the actor and the grant.
- Client keys: `npx tsx scripts/create-key.ts --tenant sunarone --scopes read,classify --label prod [--expires <RFC 3339>]` (or `npm run create-key -- …`). It prints the key once and writes audit `api_key.created` with the `pepper_id` (never the key itself). Revocation: `npx tsx scripts/create-key.ts --revoke <key_id> --by <actor>`, effective on the next request. Revoking an admin key or disabling an actor withdraws that actor's pending proposals (audited). **Disabling an actor (round 4, SA-C2-04):** two admins through a `disable_actor` proposal, or on the host `npm run disable-actor -- --handle <h> --by <who> --note "<incident>"`; keys get 401 at once, pending proposals are withdrawn, `admin.disabled` is audited and `admin.actor_disabled` logged (warn, `alert: true`). Both paths refuse when fewer than two active admins would remain (400 `last_actors`, message since round 7: "grant a third admin first (admin_grant), then disable. To cut off a leaked key now, revoke that key (create-key --revoke)"; SA-C3-05, SA-C4-05). A pending proposal of a disabled proposer cannot be approved (409 `proposer-disabled`).
- **Residual risk (stated plainly; SEC-53, ruling 18).** Anyone with host or DB-file access can still drop triggers, edit rows, mint keys or replace the file. Maker–checker protects against single-actor changes through the API, not against the host owner. What changed in rounds 4–6 is **detection**: a writer who lacks `HSN_AUDIT_KEY` is caught by the state-to-audit cross-check (boot → `/readyz` 503, `verify-audit` exit 3), and a restored or replaced database, or a deleted sidecar, is caught by the high-water mark. Someone who holds **both** the database and `HSN_AUDIT_KEY` can still forge matching HMAC'd entries and a matching sidecar; that is the remaining residual risk. Mitigations: keep the audit key off the DB host's backups and volumes, anchor the head off-host daily (`export-audit-head`, `verify-audit --head`), and watch the warn-level alert lines (an out-of-band notifier is on the Later roadmap, ruling 29). Versions approved before v5 are checked by name only (`legacy`) until the next publish.

## 10. Rate limiting

- **Algorithm (ruling 11, ruling 14):** one token bucket per key, in memory (`lib/rateLimit.ts` interface; Redis later). Limit = `api_keys.rate_limit_per_min` tokens per minute (default 600); refill = limit/60 tokens per second (10/s by default); burst capacity = ⌈limit/6⌉ tokens (100 by default), as implemented. Costs: `POST /v1/classify` 5; `POST /v1/tax/calculate` 1 + floor(lines/50) (ruling 25), charged after validation; everything else 1. The clock is injected for tests.
- **Headers** on every authenticated response (ruling 14, validator fix 15): `RateLimit-Limit` = tokens per minute (600); `RateLimit-Policy` = `600;w=60;burst=100`; `RateLimit-Remaining` = tokens left after this request (floored); `RateLimit-Reset` = seconds until the bucket is full; `RateLimit-Cost` = tokens charged. On 429 also `Retry-After` (seconds until enough tokens for this request).
- **Failed-auth limiter (SA-D-15):** only failed authentications count. ≥ `HSN_AUTH_FAIL_BLOCK_THRESHOLD` (20) 401s from one client IP (full IPv4 address; IPv6 bucketed per /64) for one key prefix (or with no parsable prefix) in 5 min → that (IP, prefix) pair is blocked for 15 min, logging `auth.bruteforce_suspected`. A request with a valid key is never blocked by this rule. Client IP comes from `HSN_TRUST_PROXY` only.
- Daily quota: classify plus search requests, plus tax lines, per key per IST day (`api_keys.daily_quota`, default `HSN_DAILY_QUOTA_DEFAULT` 50,000) → 429 `quota-exceeded`.
- Outbound budget: per-key daily cap on barcode cache misses that call out (`HSN_OUTBOUND_PER_KEY_DAILY` / `outbound_daily_cap`), per-host minute budgets (OFF 15/min), global concurrency cap; beyond any → `product.source: lookup_failed`, no outbound call. Budgets are in-memory per process, which matches the single-instance deployment; a multi-instance move needs a shared store.

## 11. Caching and ETags

One table, copied verbatim into `openapi.yaml` (info) and `07` §7 (validator fixes 4 and 19):

| Route | ETag | Cache-Control |
|---|---|---|
| `GET /v1/hsn/{code}`, `GET /v1/hsn/search` | yes | `private, max-age=<min(3600, seconds to next IST midnight)>, must-revalidate` |
| `GET /v1/rates/changes`, `GET /v1/meta/dataset` | yes | `private, no-cache` |
| `POST /v1/classify`, `POST /v1/tax/calculate`, all `/v1/admin/*`, `/healthz`, `/readyz` | no | `no-store` |

- ETag (weak): `W/"ds-{dataset_version}-{sha256(dataset_version, as_of_ist, body)[:16]}"`. `as_of_ist` is the resolved date (the request's `date`, else today IST), so the tag changes at IST midnight when a pre-loaded rule takes effect even if the dataset did not change (ruling 4). Clients send `If-None-Match` → 304.
- Server-side: an LRU (max 10,000 entries) of resolved rule sets keyed by `(dataset_version, code, as_of)`; the `unit_price` filter is applied after the cache so varying prices cannot evict other tenants' entries (SA-D-14). Cleared on publish. There is no key-lookup cache.

## 12. Change feed

- `change_feed` is an append-only table. `seq` is assigned in the publish transaction. Types: `rule_added`, `rule_end_dated`, `rule_verified`, `rule_corrected`, `hsn_added`, `hsn_updated`, `refdata_changed`. Each row has `affected_prefix`, `rule_id`, `related_rule_id` (corrections only), `effective_from`/`to`, `retroactive`, `affects_from`, `summary`.
- `GET /v1/rates/changes?since=<seq>&limit≤500` returns `seq > since` in ascending order, with `next_since`, `has_more`, `feed_epoch` and `current_dataset_version`. `since=0` yields the full history as changes (the bootstrap path).
- Future-dated rules appear when approved, so clients preload them and switch on `effective_from`.
- **Corrections (ruling 1, validator fix 24):** one mechanism only: a `correct` proposal voids the target and inserts the replacement; the feed emits one `rule_corrected` row (`rule_id` = replacement, `related_rule_id` = voided). There is no `reason` field and no "correction:" summary convention.
- **Retroactive changes (ruling 25, SA-D-11):** a change whose effect starts before today (IST) needs `retroactive_reason` on the proposal (400 at create; 409 `proposal-stale` if it became retroactive while pending). Its feed rows carry `retroactive: true` and `affects_from`.
- **Lineage (ruling 25, SA-D-12):** `feed_epoch` is random at seed and rotated automatically when the server detects a restore (§16); `scripts/rotate-feed-epoch.ts` remains for a manual rotation (ruling 31). `since > last_change_seq`, or `since` older than the retained window (`HSN_FEED_RETENTION_DAYS`), → 410 `feed-window-expired`.
- Client contract: poll every 15 min with `If-None-Match`, and at startup (ruling 28). If `feed_epoch` changed, drop the cache and resync from `since=0`. For each change, invalidate cached code `c` when `c.startsWith(affected_prefix) || affected_prefix.startsWith(c)` (ruling 3). Persist `next_since` only after the cache writes commit. Never accept a `dataset_version` older than the stored one within one epoch. Show a stale banner if the last successful poll is more than 24 h old.

## 13. Ingestion and maker–checker workflow

```
CBIC watcher (npm run watch-cbic from cron, or in-process with HSN_WATCHER_ENABLED=true; never both)
  → fetch central-tax-rate.html and integrated-tax-rate.html with the watcher's own client
     (exact hosts HSN_WATCHER_HOSTS ∩ HSN_SOURCE_HOSTS, text/html or application/xhtml+xml only, ≤ 256 KiB, 3 s, no redirects; no PDF parsing)
  → fail-closed parse in a worker thread (64 MB heap, 2 s; linear tokenizer, per-row caps, hidden rows/elements
     skipped and counted, warn log watcher.hidden_rows) (not_html | shape_changed | no_items | wrong_series |
     too_many_malformed > 20% | shrunk < half of last good run)
  → record watcher_runs (ok | failed, items_seen, items_new, error)
  → each item dated ≥ HSN_WATCHER_NOT_BEFORE with a new notification_key (e.g. central_tax_rate:1/2026)
     → watched_notifications row: source cbic_watcher, state detected, affected_prefixes [] ; audit watched_notification.detected
       (actor system:cbic-watcher); warn log watcher.new_notifications {"alert": true}. Never changes a rate.
Daily triage (admin listener): GET /v1/admin/watcher/status → GET /v1/admin/watched-notifications → open source_url
  → POST …/watched-notifications/{id}/triage {affected_prefixes, effective_from?}   (only while detected; audited)
     (on a row with a notification_key — every watcher row, and keyed manual rows — the FIRST triage and any
      removal of prefixes need two admins: the first request returns 202 with pending_action, a different
      admin repeating it gets 200; same actor → 403 maker-checker-violation; v7 trigger. Later additions: one admin)
     (triaged rows surface as /v1/meta/dataset.pending_notifications and the pending_change_detected warning;
      untriaged rows only as meta untriaged_notifications)
  → rate proposals below → POST …/watched-notifications/{id}/resolve {state: published | dismissed}
     (keyed rows: 202 then a second admin's 200, warn log watcher.row_silenced; unkeyed manual rows: one step)
  Manual entry: POST /v1/admin/watched-notifications (same notification_key; duplicate → 409 duplicate-notification)
Maker: downloads the PDF, records its sha256 and the schedule serial →
  POST /v1/admin/rate-proposals (Idempotency-Key, required: missing → 400 idempotency-key-required) per changed entry
  zod: slab in HSN_ALLOWED_RATES_BP (no bypass), source URL parsed with new URL(): https, no userinfo, default port,
       hostname exactly in HSN_SOURCE_HOSTS, path to the notification document; schedule_serial; pdf_sha256 (64 hex);
       hsn_prefix of length 2/4/5(ch. 99)/6/8 that exists; effective_from ≥ 2017-07-01; retroactive → retroactive_reason
  overlap pre-check vs published + pending; content_sha256 = sha256(JCS(content)); audit rate_proposal.created
Checker (different actor_id): GET …/{id} (content_sha256, target_rule, rule / payload) → opens the PDF, checks its sha256
  → POST …/approve {expected_sha256, verified_against_source: true}
  one BEGIN IMMEDIATE txn (data-model §4.1): re-read key + actor → status, maker≠checker, sha256, staleness, retroactivity,
  target_sha256 → dataset_versions (placeholder hash) → proposal approved (rule id pre-allocated) → apply action
  → change_feed → fill content_hash + dataset_state → audit (HMAC, full rule rows + rule_sha256) → COMMIT → log line
Post-publish: /v1/meta/dataset shows the new version; spot-check 5 codes; golden fixtures updated in the same cycle;
  DATASET_CHANGELOG.md entry; watched notification → resolve published (measures NFR-07); export-audit-head → off-host copy
```
**Running the watcher from cron** (exit codes: 0 ok; 1 config error; 2 run failed; 3 ok but freshness alert):
```
# m  h    dom mon dow  command
17 */6 * * *  cd /srv/hsn-api/server && set -a && . /etc/hsn-api/env && set +a && npm run --silent watch-cbic >> /var/log/hsn-api/watch-cbic.log 2>&1
```
Freshness alert (00b ruling 27): no successful run for 36 h (or never), or a detected row open for more than 2 business days (Mon–Fri IST; Indian public holidays are not modelled). Known gaps: the parser has not yet been run against the live CBIC pages; long pages may exceed the 256 KiB / 3 s limits and fail closed; there is no egress proxy; the UTGST (Rate) and Compensation Cess (Rate) listings are not watched (check them by hand).

```
- Rules approved through maker–checker are `verified` by construction. Seed rows load as `unverified` and are promoted with `verify` proposals; verified rules are re-verified with `verify` within 12 months (ruling 9).
- One proposal per approve/reject call; there is no bulk approval (ruling 20). Approve twice: a replay with the same `Idempotency-Key` and body returns the stored 200; any other approve or reject of a non-pending proposal returns 409 `proposal-not-pending` (validator fix 21).
- **Idempotency (rulings 8 and 28):** every admin write (proposal create, approve, reject, withdraw; watched-notification create, triage, resolve; product purge) requires `Idempotency-Key`, a UUID (missing → 400 `idempotency-key-required`); a replay carries `Idempotent-Replayed: true`. Keys are stored in `idempotency_keys` per `(key_id, idempotency_key)` with `request_hash` and the response for 24 h (data-model §4.3).
- **Reference data (ruling 23):** `synonyms`, `category_map`, `chapter_keywords` and `hsn_codes` change only through `refdata_change` proposals in the `{table, op, …}` shapes of openapi `RefdataChange`: `add` / `deactivate` for synonym, category_map and chapter_keyword; `update` for `hsn_description`; `add_code` for a new `hsn_code` (validated: length, not existing, chapter exists, nearest existing ancestor as parent, 4-digit heading for 6/8-digit codes, type matches the chapter, no duplicate pending proposal). Codes are never deactivated (`deactivate` on hsn_code / hsn_description → 400). Feed `refdata_changed` / `hsn_added` / `hsn_updated`.
- **Seed (`npm run seed`)** is the development path that bypasses proposals: refused when `NODE_ENV=production` and when `dataset_state` exists; writes every rule `unverified`, records `seed_batches` with the sha256 of each seed file and audit `dataset.seeded`; after it, the triggers refuse every seed-path insert. Seed rows are always `unverified` (ruling 33); the loader's `allowVerified` option is for test fixtures only. Seed format: the shared `server/data/seed/FORMAT.md`, constrained by data-model §7 (validator fix 13).
- **First production load (round 5, validator R11): `npm run import-dataset`.** Production data goes through maker–checker as a `dataset_import` proposal:
  1. Create the empty DB (boot once or run any script) and `npm run bootstrap-admins` (ruling 17).
  2. Maker: `HSN_ADMIN_KEY=<A's key> npm run import-dataset -- propose --dir data/seed --rationale "Initial load, data/seed @ <commit>"`. Validates the directory with the seed's checks (every rule unverified), records each file's sha256 and the row counts, prints `proposal_id` and `content_sha256`; refused if a dataset exists or another import is pending.
  3. Checker (a different actor) reviews `GET /v1/admin/rate-proposals/{id}` against the same commit, then `HSN_ADMIN_KEY=<B's key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed`. Refused if B is the maker, the hash is wrong, the proposer is disabled, or any file hash or count changed. One transaction publishes the first version (rules `unverified`), approves the proposal and writes `dataset.seeded` + `rate_proposal.approved`; the cross-check then runs (exit 3 on a problem).
  4. Start the server; `/readyz` 200. Exit codes: 0 ok, 1 refused, 2 seed validation failed, 3 imported but the cross-check reported problems. The API can list or reject a `dataset_import` but not approve it (409 `proposal-stale`).
- **Production launch gate (ruling 24):** every rule in the chapters a live tenant uses is `verified` before go-live, recorded as an explicit go/no-go in `reviews/`.

## 14. Observability

- Logs (pino JSON): one line per request (`request_id`, `client_request_id` if sent, `key_id`, `tenant`, route pattern, status, `latency_ms`, `dataset_version`). Domain events: `classify.decision` (`input_hash` = HMAC-SHA256(`HSN_LOG_KEY`, normalised name) only), `rate.resolved_ambiguous`, `rate_rule_overlap`, `tax.unverified_accepted`, `outbound.call`, `outbound.throttled`, `ai.fallback`, `admin.proposal_*`, `auth.failed`, `auth.bruteforce_suspected`, `admin.grant_approved` (warn, `alert: true`), `watcher.failed`, `watcher.freshness_alert`, `watcher.new_notifications` (each with `"alert": true`), `audit.chain_broken`. Rounds 4–6, error with `alert: true`: `audit.state_mismatch`, `audit.chain_broken`, `dataset.restore_detected`, `dataset.hwm_invalid`, `dataset.hwm_missing`; warn with `alert: true`: `watcher.hidden_rows`, `watcher.row_silenced`, `admin.actor_disabled`; warn: `audit.legacy_state`. New audit actions: `admin.disabled`, `dataset.restore_detected`, `dataset.restore_acknowledged`, `dataset.hwm_initialised`, `watched_notification.confirmation_requested`. Redacted: `authorization`, `cookie`, `*.key`, `*.secret`. Neither the raw name, a truncation of it, nor its plain SHA-256 is ever logged (SA-D-18).
- Metrics (ruling 30): minimal Prometheus text at `GET /metrics` on the **admin listener only** (`HSN_ADMIN_HOST:HSN_ADMIN_PORT`, loopback by default; no key, `HSN_ADMIN_IP_ALLOWLIST` applies; counts and timestamps only, no keys, names or codes): `hsn_http_requests_total`, `hsn_http_request_duration_seconds`, `hsn_classify_top_band_total`, `hsn_watcher_last_success_timestamp_seconds`, `hsn_rate_rules_active`, `hsn_rate_rules_unverified`, `hsn_dataset_info{version}`, `hsn_product_cache_rows`, `hsn_product_cache_max_rows`. Further series (outbound, LLM budget, overdue verifications, publish lag) are Later.
- Alerts: 5xx > 1% for 5 min; p95 `/hsn` > 500 ms or `/classify` > 1.5 s; freshness (ruling 27): the watcher's last successful run is older than 36 h, or a watched notification is unreviewed past the 2-business-day SLA (NFR-07) — never on dataset age (dataset age is informational only); the watcher signals these through its exit code 3, the `watcher.freshness_alert` log line and `GET /v1/admin/watcher/status`; audit chain or `rule_sha256` verification failure from `scripts/verify-audit.ts` (page immediately); `hsn_rate_rules_unverified` rising after launch; any rule past `reverify_due_at` (meta `coverage.rate_rules_verification_overdue` > 0).
- `/healthz`: process alive. `/readyz` checks: `db`, `migrations` (at head, v8), `fts5`, `dataset` (pointer present), `dataset_integrity` (content hash re-verified at boot), `audit_integrity` (whole HMAC chain plus the state-to-audit cross-check, run once at boot, O(audit log)) and `state_continuity` (no unacknowledged restore and a valid sidecar). Public body is only `{status}`; 503 detail is generic (SA-D-25).

## 15. Test strategy

Layers follow `07` §10: unit, property, golden, HTTP integration, security, architecture, eval. Rules: injected clock, fixture datasets, no network (outbound mocked). Coverage ≥ 90% lines in `lib/` pure helpers, `classify/` and `services/`. CI runs `typecheck`, `test`, eval (v1), `npm audit`, and a secret scan.

### 15.1 Concrete test cases (minimum set)

Unless a case cites a notification, the rate values below are **fixture values**. Golden fixtures cite their source per AG-01/AG-04, and while seed data is unverified, those fixtures are labelled `unverified`.

**Domain / unit**
- T-U01 GTIN: `4006381333931` valid; `8901234012346` invalid → 422 `invalid-gtin` (expected and actual check digits in the error, the submitted digits not echoed); GTIN-8 `96385074` valid; non-digit → schema 400.
- T-U02 Normaliser: `"22 Carat Gold RING"` → `22k gold ring`; `"Paracetamol 500mg"` → `[paracetamol, 500, mg]`; zero-width and RTL-override characters stripped; 10 KB input truncated to 200 characters.
- T-U03 Money: `"1234.50"` → 123450 paise; `0.1+0.2`-style inputs never go through floats; `1e12` paise accepted, `1e12+1` rejected; a round-trip property holds.
- T-U04 roundHalfUp: (5, 10) → 1; (4, 10) → 0; (15, 10) → 2; BigInt path above 2^53.
- T-U05 Bands: 0.85 → high; 0.8499 → medium; 0.60 → medium; 0.5999 → low.
- T-U06 Fusion reproduces every row of architecture.md §5.5 (fixture values; the formula is unchanged in `rules-fts-2.3`, the exactness policy is covered by T-C14): 22K gold ring → 7113 0.91 high, 7117 0.27 low; paracetamol → 3004 0.72 medium, 2924 0.22 low; dry fruits gift box → 0813 0.45 low; knitted cotton T-shirt → 6109 raw 0.903 capped 0.84 medium; mobile phone stand → 8517 0.17 low with `message`, 3926 dropped; barcode-only biscuits → 1905 raw 0.942 capped 0.84 medium (`review_hint`); category-only barcode → 0.30 low; name + barcode biscuits → 0.94 high. Also asserts `scoring.denominator` (0.85, 0.35, 1.00, 0.50). **On the shipped seed** (`trd-round8.test.ts`, observed values, `rules-fts-2.3`): "dry fruits gift box" → no confident match (all low, `message`), chapter 08 kept with a packaging hint, 0813 not proposed (not in the master); "knitted cotton T-shirt" → 6109 medium; "mobile phone stand" → 8517 capped at low (≤ 0.45) with an accessory hint, 3926 not proposed; category-only barcode (en:biscuits) → 1905 0.30 low.
- T-U07 Confidence band matrix (replaces the old gate test; ruling 2): one realistic input reaches each of low, medium and high through the synonym path; low and medium through FTS + chapter (high impossible: any input without an exact synonym → ≤ 0.84, grid property test over s_fts, s_chap ∈ [0,1]); low and medium through barcode-only (high impossible, ruling 22); high only via name + barcode with an exact synonym on the name. Denominators 0.35/0.50/0.85/1.00 pinned.
- T-U08 Close alternative: top 0.88, second 0.80 → top capped at 0.84, reason `close_runner_up`.
- T-U09 FTS query builder: input `gold OR "ring" NEAR(*)` → only quoted tokens, no operators (SEC-40).
- T-U10 IST date: clock at 2026-10-09T19:00Z → today = 2026-10-10.

**Rate resolver (golden, `test/golden/*.json`)**
- T-R01 Single rule: 7113 on 2026-10-10 → 300 bp, applicable, `matched_at_level` 4.
- T-R02 Historical: 3004 on 2025-09-21 → the 1200 bp fixture rule (a **fixture simplification**: under 1/2017 some 3004 items were at 5%; this is not a statement of law); on 2025-09-22 → ambiguous: general 500 bp rule plus the 0 bp `other` rule (nil-rate list of 10/2025-CT(Rate)), `coverage: ambiguous`, `default_rule_id` = the general rule (ruling 5).
- T-R03 Price threshold: 6109 with no price → ambiguous, 2 rules; 2500.00 → 500 bp; 2500.01 → 1800 bp.
- T-R04 Descendant differs: query 7102 with rules at 7102 (rough, 25 bp) and a more specific prefix (cut and polished, 150 bp) → ambiguous with reason "query the more specific code" (research rows 5–6).
- T-R05 No rule: an HSN that exists with no rule → `coverage: no_rate_rule`, no rate.
- T-R06 Identical duplicate rules → not ambiguous; the latest `last_verified_at` wins.
- T-R07 Non-price condition (0406 paneer nil vs cheese 5%, research row 23) → ambiguous, "a human must choose".
- T-R08 Future-dated rule: query before `effective_from` → old rule; on or after → new rule.
- T-R09 Unverified rule → `verification_status: unverified` and `warnings: ["rate_unverified"]`.
- T-R10 Date bounds: `2017-06-30` → 400; today+367 → 400; `2024-02-30` → 400.
- T-R11 5-digit SAC (ruling 6): rule at `99972`; query `999721` → that rule, `matched_at_level` 5; query `71131` → 400.
- T-R12 Voided rule never resolves; its replacement does (ruling 1).
- T-R13 Warnings: verified rule past `reverify_due_at` → `verification_overdue`; a `detected` watched notification with prefix `3004` → `pending_change_detected` on 300410 and on 30 (both directions); synonym `rule_hint: nil_rate_list` on an exact caller-name hit → 0 bp rule selected with `selected_by_hint`; the same phrase from OFF data → no selection.

**Tax**
- T-T01 Intra, 7113, ₹68,500.00 at 300 bp → CGST 1027.50, SGST 1027.50, total 2055.00.
- T-T02 Inter, same → IGST 2055.00.
- T-T03 Odd split, 25 bp on ₹1,000.01 → CGST = SGST = roundHalfUp(100001×25, 20000) = 125 paise each.
- T-T04 Ambiguous line excluded from totals; `complete: false`.
- T-T05 Quantity (ruling 7, validator fix 7): 6109, ₹3,600, quantity 2, no unit_price → derived unit price ₹1,800 → 500 bp, tax still on ₹3,600; 6109 with neither unit_price nor quantity → ambiguous (`needs_input: [unit_price]`); quantity 8.250 and "8.250" accepted, 8.2505, 0 and 10000000 → 400; omitted `line_id` → "0", "1", …; result carries `igst_rate_bp`.
- T-T08 Ambiguous selection (ruling 5): 3004 line without `rule_id`/`condition` → `tax: null`, `needs_input: ["rule_id", "condition"]` (both accepted inputs, core round 9; `["rule_id"]` when there is no default rule); with `condition: "general"` → 500 bp; with `rule_id` of the nil rule → 0; with a `rule_id` from another code → 422 `rule-choice-invalid`; both `rule_id` and `condition` → 400.
- T-T09 Unverified gate (ruling 24): unverified rule without `accept_unverified` → `tax: null`, `needs_input: accept_unverified`, excluded from totals; with `accept_unverified: true` → computed with `unverified_accepted: true`, note `rate_unverified_accepted` and log `tax.unverified_accepted`.
- T-T10 UTGST (ruling 15): `supply_type: intra_ut`, 500 bp on ₹1,000 → CGST 25.00, UTGST 25.00, SGST 0.
- T-T11 Token cost: 49 lines → `RateLimit-Cost: 1`; 50 → 2; 500 → 11. Charged before validation (core round 10): the 85k-item body costs 1701 tokens and, on a default 600-token key, gets 429 without being validated.
- T-T06 Validation errors list every problem (Ajv `allErrors`, core round 9): three lines missing `supply_type` → three `errors[]` entries and `detail` "Request validation failed: 3 problems. See errors[]."; more than 50 problems → 50 entries and the total in `detail`. 501 lines → 400; 257 KiB tax body → 413; 65 KiB body on another route → 413; unknown HSN → 422 with pointer `/lines/n/hsn`. **Core round 10 (SA-C5-01):** a structural guard runs before Ajv: 85k empty items or 85k bare numbers → one `maxItems` error within 10 ms beyond body parsing; more than 50 unknown keys → 50 errors and the total in `detail`; 501 lines → `maxItems`, while 500 valid lines are still served.
- T-T07 Properties (≥ 1,000 runs): cgst == sgst; |cgst+sgst−igst| ≤ 1; monotonic; zero rate → zero; total = Σ lines.

**Classify (HTTP)**
- T-C01 "22K gold ring" → top 7113, high, `needs_review: false`, reasons include `synonym_exact`.
- T-C02 Fixture with a contested "paracetamol" synonym: "paracetamol 500mg tablet" → 3004 medium plus 2924 low, `review_hint` present. (On the shipped seed the synonym is uncontested and the name is the phrase plus quantity and form words, so the live answer is 3004 **high** 0.87 with three review hints and an ambiguous rate; see 03-app-flow §3.)
- T-C03 "asdfgh" → `candidates: []`, `needs_review: true`, `message` present. Fixture whose best candidate scores 0.25 → candidates returned, all band `low`, `message` present; a 0.08 candidate is dropped.
- T-C04 Bad GTIN → 422 and the adapter mock is **not** called.
- T-C05 GTIN cache miss with OFF disabled → `product.source: not_found`, empty candidates; second call → no new lookup (negative cache). Adapter error → `lookup_failed` (not cached as not_found); 50 requests in the error window → 1 outbound call.
- T-C06 GTIN-only with OFF mock returning `en:biscuits` and "Glucose Biscuits 250 g" → 1905 **medium** 0.84, `review_hint` naming Open Food Facts, `needs_review: true` (SEC-46); the same with `name: "Glucose biscuits"` → high 0.94. Served from cache → still capped.
- T-C13 Per-key daily outbound cap and per-host minute budget exhausted → `lookup_failed`, no network call; `DELETE /v1/admin/products/{gtin}` purges the row, audits `product.purged`, next request refetches.
- T-C07 Name and barcode conflict → reason `barcode_conflict`; top is not high.
- T-C08 Determinism: two identical calls → byte-identical bodies except `request_id`.
- T-C09 `max_candidates: 6` → 400.
- T-C12 LLM stub enabled: request without `allow_llm` → `llm_used: false`; `allow_llm: true` with a key that has `llm_opt_out` → `llm_used: false`; accepted re-rank never raises any confidence.
- T-C10 Injection corpus (AI-16) with the LLM stub enabled → codes only from the retrieved set, no rate change.
- T-C11 LLM stub returns an unknown code, malformed JSON, or times out → deterministic result, `ai.fallback` logged, 200.

**Feed, meta, caching**
- T-F01 Approve a proposal → two feed rows (`rule_end_dated`, `rule_added`) with consecutive seq; `next_since` advances.
- T-F02 `limit=501` → 400; `has_more` paging covers all rows exactly once.
- T-F03 `If-None-Match` with the current ETag → 304; after publish → 200 with a new ETag.
- T-F04 `/v1/meta/dataset` counts of verified, unverified and overdue rules match the DB; `content_sha256` equals a recomputation over the JCS export; `pending_notifications` lists `detected` rows only. Since core round 9 meta also returns `known_data_gaps` (the curated `data/seed/known_gaps.json` items; missing file → `[]`, malformed file → boot fails) and `coverage.codes_without_rules`. Since core round 10 each `sources[]` entry has `rule_count` and `verified_count`, and `codes_without_rules` is computed in O(codes + rules) (equal to the previous SQL on random data; 20k codes / 3k rules in under 50 ms) and cached per dataset version and IST day.
- T-F05 Clock crosses IST midnight onto a pre-loaded rule's `effective_from` with the same dataset → new ETag and the new rule; `max-age` never exceeds the seconds to the next IST midnight (ruling 4).
- T-F06 Client invalidation vector (ruling 3): rule added at `71131910` → a cached `7113` is invalidated (`affected_prefix.startsWith(c)`); rule added at `71` → cached `71131910` invalidated (`c.startsWith(affected_prefix)`); cached `7117` untouched by a `7113` change.
- T-F07 Lineage: after `scripts/rotate-feed-epoch.ts`, `feed_epoch` differs; `since` > `last_change_seq` → 410 `feed-window-expired`.
- T-F08 `correct` → one `rule_corrected` row with both ids; a back-dated change → `retroactive: true`, `affects_from`.

**Admin / integrity**
- T-A01 Self-approval (same `actor_id`, different key) → 403 `maker-checker-violation`. Handles `amit`, `Amit`, `amit `, Cyrillic `аmit` → rejected or normalised to one actor.
- T-A02 Overlapping proposal → 409 `overlapping-rule`.
- T-A03 Approval failure mid-transaction (injected) → no rule, no feed row, no version bump.
- T-A04 Same `Idempotency-Key` with the same body → replayed response (approve replay → 200 with the stored body); different body → 409 `idempotency-conflict`; same key under another API key → independent. A second approve with a new key on an approved proposal → 409 `proposal-not-pending`.
- T-A05 `UPDATE rate_rules SET igst_rate_bp=…` → trigger abort; `DELETE` → abort; `verification_status` verified → unverified → abort.
- T-A06 Audit chain: tampering with a row via a raw file edit → `verify=true` returns `chain_ok: false` with `chain_broken_at`; a full rewrite with recomputed hashes but without `HSN_AUDIT_KEY` fails HMAC; a rewrite with the key is caught by `scripts/verify-audit.ts --head` against the exported head; a rate edit with triggers dropped is caught through `rule_sha256` (SA-D-02).
- T-A07 Proposal with `source.url` that is a listing/index page (ruling 36: create/supersede/correct must cite a document) or on a non-allowed host (a trailing-dot host is refused, "Host must not end with a dot", core round 8), or `https://cbic-gst.gov.in.evil.example/`, `https://cbic-gst.gov.in@evil.example/`, a trailing dot, an IDN look-alike, a non-default port; a slab not in the allowed list; a missing `pdf_sha256` or `schedule_serial`; a 3-digit or non-existent prefix → 400. **Core round 10:** a free-text `rule.source.notification` on create/supersede/correct → 400 `validation-failed` at `/rule/source/notification` (code `pattern`); a document URL with a query or fragment, `;`, `..`, `//`, `%2e`, `%2f` or `%5c`, or a path other than `/view-pdf/<id>[/…]` or `*.pdf` → 400; a configured `.pdf` index page is matched regardless of case, slashes, query or fragment.
- T-A08 `verify` proposal changes only the verification fields and emits `rule_verified`.
- T-A09 `correct` a rule on its own first effective day: target `status = voided`, replacement in force from the same day, history query returns the replacement, audit shows both rows with `rule_sha256` (ruling 1).
- T-A10 Re-verify a verified rule: only `last_verified_at` moves forward, `reverify_due_at` follows, `rule_verified` emitted; an earlier timestamp → abort (ruling 9). **Ruling 36 (core round 9, on the shipped 3004 nil rule, which cites `central-tax-rate.html`):** verify without `source.url` → 400 `source-url-not-document` (`/source/url`, `required`); an index-page or non-document URL → 400; a direct SQL citation change is refused by the migration 8 trigger; `url` + `notification` approved by the second admin → GET /v1/hsn/3004 shows the rule verified with the new citation and `citation_note: null`, and the cross-check is ok; a later verify with `url` → 400 (plain re-verify still works); a citation changed behind the trigger is flagged by the cross-check. The index-page set includes `HSN_SOURCE_INDEX_PAGES`; `/view-pdf/` and `.pdf` URLs are documents. **Core round 10:** a free-text verify `source.notification` → 400 at `/source/notification`; a verify with a decorated URL → 400; a verify that changes the citation puts the new citation in the `rule_verified` feed summary. **Accepted citation forms (SA-C6-02):** cite `https://taxinformation.cbic.gov.in/view-pdf/<id>[/…]` or a single-slash `.pdf` link; CBIC's own double-slash links (`https://cbic-gst.gov.in/resources//htdocs-cbec/gst/….pdf`) are refused by the `//` rule (fail-safe, not canonicalised), so a reviewer uses the view-pdf form or a single-slash URL the server actually serves.
- T-A11 Approval binding (ruling 20): wrong `expected_sha256` → 409 `proposal-hash-mismatch`; supersede whose target was end-dated or otherwise changed meanwhile → 409 `rule-not-active` (00c ruling 35; also at create when the target is not active, already superseded or already end-dated); proposal that became retroactive without `retroactive_reason` → 409 `proposal-stale`; back-dated create without `retroactive_reason` → 400.
- T-A12 Admin identity (ruling 17): bootstrap twice → refused; admin key without an approved `admin_grant` → refused; grant proposed and approved by the same actor → 403; grant reused → refused; admin key with expiry > 90 days → refused; `read,admin` → refused.
- T-A13 Revocation is immediate: revoke the checker's key, then approve → 401; disabling the maker withdraws their pending proposals (audited `system`).
- T-A14 DB triggers (data-model §9: the §2 DDL mirrors the code and 124 trigger checks pass): in CI as `test/db/ddl.test.ts` (core round 8), which runs the checks against the code schema; the comparison of data-model.md with the code stays in `reviews/round2-tools/test-ddl.cjs`.
- T-A15 Reference data (ruling 23): direct UPDATE/DELETE of `synonyms` aborts; a `refdata_change` produces audit, feed `refdata_changed` and a new dataset version; self-approval → 403.

**Security (one per SEC "Test" item; highlights)**
- T-S01 No key, unknown prefix, wrong secret → identical 401 bodies.
- T-S02 `read` key on `/v1/classify` → 403; on `/v1/admin/*` → 403.
- T-S03 Revoked key → 401 on the very next request (no cache).
- T-S04 Rate limit: fresh key, one classify → `RateLimit-Limit: 600`, `RateLimit-Remaining: 595`, `RateLimit-Cost: 5`; drain the bucket → 429 with `Retry-After` and all four RateLimit-* headers; `RateLimit-Reset` = seconds to full.
- T-S05 `__proto__` in the body → 400.
- T-S06 Outbound to a non-allow-listed host, a redirect to 127.0.0.1, or a slow or oversized response → rejected or treated as not found.
- T-S07 Log capture: the Authorization header, the raw classify name and its plain SHA-256 are absent; `input_hash` equals HMAC-SHA256(`HSN_LOG_KEY`, normalised name); `key_id` present (SA-D-18).
- T-S08 Forced DB error → 500 body containing no SQL or `SQLITE`.
- T-S09 Boot with `HSN_LLM_ENABLED=true` and the disclosure ack missing → exit non-zero.
- T-S10 Public listener has no `/v1/admin/*` route (404); admin listener binds `HSN_ADMIN_HOST`; `/metrics` exists only on the admin listener; `/readyz` failure body is `{status}`-level generic (SA-D-09, SA-D-25).
- T-S11 Failed-auth block: 20 bad keys from one IP for one prefix → that pair blocked; a valid key from the same IP still succeeds (SA-D-15).
- T-S12 Connections (SA-D-13): writing `rate_rules`, `rate_proposals`, `audit_log` or `synonyms` through the read-only or cache-writer connection fails.
- T-S13 SSRF table (SEC-34): NAT64, 6to4, Teredo/`2001::/23`, `3fff::/20`, 198.18/15, 240/4, `::`, mapped v4 → refused; compressed response refused; proxy env vars ignored.

**Architecture**
- T-X01 The import-rule scan from §2.
- T-W01 Watcher (ruling 10, `test/watcher.test.ts`): a new item becomes one `detected` row with `source cbic_watcher` and empty prefixes; a second run adds nothing (same `notification_key`); each fail-closed reason records a `failed` run and no rows; items before `HSN_WATCHER_NOT_BEFORE` are counted, not queued; a non-HTML content type is refused by `getText`.
- T-W02 Triage only while `detected` (else 404); resolve closes the row and a second resolve is 404; a manual entry for a watched notification → 409 `duplicate-notification`; untriaged rows appear in meta `untriaged_notifications`, not in `pending_notifications`.
- T-W03 Freshness: no ok run in 36 h → `watcher_stale`, exit code 3; a detected row older than 2 business days is listed in `overdue_notifications`.
- T-A16 `add_code` (`test/add-code.test.ts`): an approved proposal inserts the code with `added_by_proposal` and emits `hsn_added`; an existing code, a missing heading or chapter, or a wrong type → 400; `deactivate` on `hsn_code` → 400.
- T-A17 Missing `Idempotency-Key` on any admin write → 400 `idempotency-key-required`; withdraw by a non-proposer → 403 `not-proposer`.

**Rounds 4–6 (added in docs round 4)**
- T-R14 Codes outside the master (R3): 7199 → 200 via 71 with `code_in_master: false`, `resolved_via`, `code_not_in_master`; 30049099, 61091000 (with price) and 85171300 resolve under their parents; a code whose chapter does not exist → 404.
- T-T12 Partial totals (R13): an invoice with a `needs_input` line → `complete: false`, `totals` null, `partial_totals` with included/excluded ids; complete invoice → `partial_totals: null`. Not-in-master lines are computed with line and top-level `warnings: ["code_not_in_master"]` (SA-C3-08).
- T-A18 `disable_actor`: two admins disable an actor → keys 401, pending proposals withdrawn, audited, alert; fewer than two active admins left → 400 `last_actors` (API and script); a disabled proposer's proposal → 409 `proposer-disabled` (and the trigger).
- T-A19 Grants: an extra key for another actor → 400 `not_self` (service and DB); an approved grant not redeemed within 72 h → refused (service and DB).
- T-A20 State-to-audit cross-check: a legitimate history passes; key policy changes (`llm_opt_out`, rate limit, quota, tenant) and SQL-dismissed or emptied keyed watched rows are reported (round 7); the forged approved proposal + verified rule + version (DB11) is reported at boot (`/readyz` 503), by `verify-audit`; raw key inserts, dropped-trigger rule edits, a proposal edited after approval, an un-revoked key, a re-enabled actor and a rejected proposal set back to pending are reported; a pending proposal whose stored content was swapped → approve 409 `proposal-hash-mismatch`.
- T-A21 Restore detection: a `VACUUM INTO` backup restored behind the mark → epoch rotated, alert, audit, 503 → `ack-restore` → 200; an edited sidecar → 503; a deleted sidecar → 503 until `ack-restore`; production refuses `HSN_STATE_HWM_FILE=off`, unset, or in the DB's directory.
- T-A22 Two-admin watched rows: dismiss/publish of a keyed row → 202, same admin again → 403, a second admin → 200; first triage and prefix removal are two-step; later additions and unkeyed manual rows are single-step; the DB refuses direct changes.
- T-A23 `citation_note`: loaded from the seed and served in rule DTOs; direct edit refused; cleared only by a verify approval; editing or removing a note without a verify is a cross-check problem.
- T-A24 `import-dataset`: refused for a non-admin key, a short rationale, a duplicate pending import, API approve (409), maker = checker, a wrong hash or a changed file; a second admin's approve publishes unverified rules, the cross-check passes and `/readyz` is 200.
- T-S14 Known path with the wrong method → 405 `method-not-allowed` with `Allow`; unknown path → 404.
- T-S15 Production config: a non-loopback `HSN_ADMIN_HOST` without `HSN_ADMIN_IP_ALLOWLIST` is refused.
- T-W04 Watcher parser hardening: 256 KiB adversarial pages parse in well under 1 s; per-row caps; the parse runs in a worker and a stuck parser fails closed as `shape_changed`; hidden rows and elements never become items and are counted.
- T-C14 Exactness policy (`rules-fts-2.1`/`2.2`): the validator's inputs ("Samsung Galaxy tablet 10 inch", "lenovo android tablet", "shirt button", "chocolate biscuit", "cotton t-shirt") never give high; "22K gold ring 10 gm" stays high; bare generic words are not high; "gold plated brass bangles" → 7117 on top; quantity tokens need an allow-listed unit ("22k gold ring 1toy" not high); an OFF brand never makes a synonym exact; accessory names ("mobile phone stand", "tv wall mount") are capped low while "phone charger" keeps 8504, and packaging names keep their contents (`rules-fts-2.3`).
- T-E01 Eval gates (06 AI-40..42, AI-45): ≥ 300 gated items, ≥ 60 adversarial; no eval input equals an active synonym (and every `excluded` item really does); high-band precision ≥ 0.97, reported with its Wilson 95% lower bound and an INSUFFICIENT SAMPLE flag below 50 high answers (not a failure); baseline content hash verifies and the baseline is a strictly older version; top-3 @4 ≥ 0.90 on in-master items (provisional AG-12 scope, recorded in `00-coordinator-decisions.md` "Eval gate scope decision (AG-12 sign-off), 2026-10-11"); no regression > 1 pt against the previous version's baseline; the provisional / LLM-draft notice in every output.

**Round 9 (added in docs round 4)**
- T-A25 Notification references (core round 9): `normaliseNotificationRef` strips zero padding from `N/YYYY` and collapses whitespace (`01/2026-CT(Rate), Schedule I` → `1/2026-CT(Rate), Schedule I`); the seed loader stores no zero-padded reference. **Core round 10:** the canonical pattern (data-model §1) is enforced after normalisation, which also rewrites long series names (`09/2025-Central Tax (Rate), Schedule I` → `9/2025-CT(Rate), Schedule I`); `"01/2026-CT(Rate), Schedule I"` is accepted and stored unpadded; the shipped seed conforms; a free-text `notification_ref` is refused by the seed loader, and `import-dataset propose` refuses such a seed.
- T-X02 Docs traceability: `test/docs/traceability.test.ts` reads this TRD (`HSN_TRD_PATH`; a missing file fails the suite since core round 10, and only `HSN_TRD_PATH=skip` skips it) and fails if a specified ID has no §15.2 row, a cited file or test name does not exist, or a covered/partial row cites no test.
- T-S16 Echo caps (SEC-75, core round 10 SA-C5-05): a 200 KB property name comes back RFC 6901 escaped and at most 64 characters; 50 long keys still give a problem body under 16 KiB (`errors[]` ≤ 12 KiB, pointers ≤ 256 characters).
- T-S17 Known-gaps file (SEC-92, SA-C5-04): `HSN_KNOWN_GAPS_FILE` must be absolute in production; an explicit path that is missing, not a regular file, over 256 KiB or not JSON throws without echoing the contents, and refuses the boot.

### 15.2 Traceability: TRD test IDs → suite (R10)

Built in docs round 4 by grepping `server/test/**` (40 files, 922 tests, all passing on 2026-10-11, after core round 10 and classify round 7). Paths are relative to `server/test/`; names are the `it(...)` titles, shortened with "…". **covered** = the test asserts what the ID specifies; **partial** = the main behaviour is asserted but a listed sub-case is not; **not covered** = no test in the suite.

| ID | Test file › test | Status |
|---|---|---|
| T-U01 | `classify/gtin.test.ts` › "rejects a wrong check digit and reports expected vs actual", "rejects malformed %j", "computes check digits" (4006381333931, 96385074); `classify-route.test.ts` › "invalid GTIN → 422 invalid-gtin" | covered |
| T-U02 | `classify/normalise.test.ts` › "splits units and drops quantity tokens…", "strips control, zero-width and bidi characters…", "caps length at 200 characters (10 KB input)" | covered |
| T-U03 | `tax.test.ts` › "money parsing never uses float maths", "501 lines → 400; above max taxable → 400" | covered |
| T-U04 | `trd-round8.test.ts` › "T-U04: roundHalfUp boundaries and the BigInt path above 2^53"; `tax.test.ts` › "half-up rounding boundary…" | covered |
| T-U05 | `classify/fusion.test.ts` › "random scores: band boundaries and needs_review always agree" | covered |
| T-U06 | `classify/fusion.test.ts` › "reproduces the worked example…", "reproduces the paracetamol example…", "renormalises over 1.00 … (biscuits example)"; `trd-round8.test.ts` › "T-U06: \"dry fruits gift box\" → no confident match…", "T-U06: \"knitted cotton T-shirt\" → 6109 top, medium…", "T-U06: \"mobile phone stand\" → 8517 capped at low (≤ 0.45)…", "T-U06: category-only barcode … → 1905 at 0.30, low" | covered (shipped-seed rows assert observed values; see T-U06) |
| T-U07 | `classify/round2.test.ts` › "synonym path — high/medium/low", "FTS + chapter path — medium/low/never high", "barcode path — high only with a curated synonym…/medium/low"; `classify/fusion.test.ts` › "nothing but an eligible exact synonym ever produces high (grid)" | covered |
| T-U08 | `classify/fusion.test.ts` › "applies the margin penalty and caps the top at medium…", "penalty = (0.10 − gap)/2…" | covered |
| T-U09 | `security.test.ts` › "query builder emits only quoted letter/digit tokens" | covered |
| T-U10 | `watcher.test.ts` › "business days are Mon–Fri in IST…" (a UTC evening that is the next IST day); `rulings-round2.test.ts` › "ruling 4: secondsUntilNextIstMidnight"; `trd-round8.test.ts` › "T-U10: today in IST at 2026-10-09T19:00Z is 2026-10-10 (and 18:29Z is still the 9th)" | covered |
| T-R01 | `rates.test.ts` › "single rule: 7113 → 300 bp, matched_at_level 4…"; `seed-shipped.test.ts` › "7113 is 3%" | covered |
| T-R02 | `rates.test.ts` › "date boundaries are inclusive: 3004 on 2025-09-21 → 1200, on 2025-09-22 → 500"; `rulings-round2.test.ts` › "ruling 5: lookup is ambiguous with default_rule_id…" | covered |
| T-R03 | `rates.test.ts` › "price thresholds: no unit_price → ambiguous…", "price thresholds inclusive…"; `seed-shipped.test.ts` › "6109 is resolved by unit_price at the ₹2,500 boundary…" | covered |
| T-R04 | `rates.test.ts` › "descendant differs: 7102 is ambiguous and names the more specific code" | covered |
| T-R05 | `rates.test.ts` › "HSN with no rule → coverage no_rate_rule and no invented rate" | covered |
| T-R06 | `rates.test.ts` › "identical rate tuples → not ambiguous; latest last_verified_at wins (2924)" | covered |
| T-R07 | `rates.test.ts` › "non-price conditions → ambiguous, a human must choose (0406)" | covered |
| T-R08 | `rates.test.ts` › "future-dated rule switches on effective_from…" | covered |
| T-R09 | `rates.test.ts` › "unverified rule carries verification_status, warning and rate_unverified" | covered |
| T-R10 | `rates.test.ts` › "invalid date %s → 400" | covered |
| T-R11 | `rulings-round2.test.ts` › "ruling 6: 99972 is a valid code, 999721 resolves through the 99972 rule…"; `seed-shipped.test.ts` › "999721 (hairdressing) is 5% via its SAC group 99972" | covered |
| T-R12 | `rulings-round2.test.ts` › "ruling 1: correct → target voided (kept), replacement live…" | covered |
| T-R13 | `rulings-round2.test.ts` › "ruling 9: reverify_due_at…", "ruling 10: a detected notification … warns on related codes…", "ruling 5: a nil_rate_list hint … selects the 0% rule"; `classify/round2.test.ts` › "no hint from third-party product names" | covered |
| T-R14 | `rates.test.ts` › "unknown code whose chapter does not exist → 404…"; `seed-shipped.test.ts` › "30049099 → under 3004…", "61091000 with unit_price → under 6109…", "85171300 → under 8517 at 18%", "a code whose chapter does not exist is still 404" | covered |
| T-T01 | `tax.test.ts` › "matches the openapi example: 7113 intra, 6109 by quantity, 6109 ambiguous" | covered |
| T-T02 | `trd-round8.test.ts` › "T-T02: inter-state 7113 on ₹68,500 → IGST 2055.00, no CGST/SGST" | covered |
| T-T03 | `tax.test.ts` › "25 bp line (0.25%): CGST = SGST = round_half_up(taxable × 25 / 20000)" | covered |
| T-T04 | `tax.test.ts` › "matches the openapi example…" (ambiguous line excluded); `seed-shipped.test.ts` › "tax/calculate: … totals are partial…" | covered |
| T-T05 | `rulings-round2.test.ts` › "ruling 7: up to 3 decimals as qty_milli…", "ruling 7 (validator 7): line_id defaults to the zero-based index…" | covered |
| T-T06 | `tax.test.ts` › "501 lines → 400…", "unknown HSN → 422 unknown-hsn with pointer"; `security.test.ts` › "oversized body → 413 (64 KiB global, 256 KiB tax, 16 KiB classify)"; `core-round9.test.ts` › "three lines missing supply_type → three errors", "problems are capped, the total is in detail"; `security-core-round5.test.ts` › "85k empty items: one maxItems error…", "85k bare numbers: same", "a flood of unknown keys is refused with 50 errors and the total in detail", "501 lines → maxItems; 500 valid lines are still served…" | covered |
| T-T07 | `tax.test.ts` › "property: cgst == sgst, \|cgst+sgst−igst\| ≤ 1, monotonic, integers (2000 runs)" | covered |
| T-T08 | `rulings-round2.test.ts` › "ruling 5: tax needs rule_id or condition…"; `core-round9.test.ts` › "3004 lists both accepted inputs (rule_id or condition: \"general\")" | covered |
| T-T09 | `rulings-round2.test.ts` › "ruling 24: an unverified line is refused…"; `tax.test.ts` › "unverified rule (ruling 24): accepted explicitly…" | covered |
| T-T10 | `rulings-round2.test.ts` › "ruling 15: intra_ut returns CGST + UTGST, no SGST" | covered |
| T-T11 | `trd-round8.test.ts` › "T-T11: token cost 1 + floor(lines / 50): 49 → 1, 50 → 2, 500 → 11"; `security-core-round2.test.ts` › "SA-C-07: …"; `security-core-round5.test.ts` › "with the default 600-token limit the 85k body is rate-limited (1701 tokens) without validation" | covered |
| T-T12 | `seed-shipped.test.ts` › "tax/calculate: lines with codes outside the master are computed…"; `tax.test.ts` › "no rule → tax null, complete false, never a zero rate", "nearest_rupee rounding adds round_off_paise and grand_total_paise"; `core-round6.test.ts` › "complete:true is kept, but line.warnings and top-level warnings carry code_not_in_master" | covered |
| T-C01 | `classify/round4.test.ts` › "a phrase that IS the name (quantities aside) is still high…" (22K gold ring 10 gm); `classify/round2.test.ts` › "synonym path — high…" | covered |
| T-C02 | `classify/round2.test.ts` › "synonym path — medium: \"paracetamol 500mg tablet\" (contested synonym)"; `classify/fusion.test.ts` › "reproduces the paracetamol example…" | covered (fixture) |
| T-C03 | `classify/pipeline.test.ts` › "nonsense → empty or weak, always needs_review, with a message"; `classify/fusion.test.ts` › "drops candidates below 0.10 and flags a weak best (< 0.30)…" | covered |
| T-C04 | `classify/pipeline.test.ts` › "invalid check digit → ClassifyInputError and no adapter call" | covered |
| T-C05 | `classify/pipeline.test.ts` › "not found → … negative-cached (one outbound call)", "SA-K-04: adapter errors are not cached as not-found…", "SA-K-04: transient errors are cached for 15 minutes" | covered |
| T-C06 | `classify/pipeline.test.ts` › "found product (barcode only) → 1905 capped at medium…"; `classify/round2.test.ts` › "barcode path — medium…", "served from cache later, still capped" | covered |
| T-C07 | `classify/pipeline.test.ts` › "name + barcode disagreeing → barcode_conflict reason" | covered |
| T-C08 | `classify/pipeline.test.ts` › "is deterministic (AI-32)"; `classify/fusion.test.ts` › "returns at most 5 candidates and is deterministic (AI-32)" | covered |
| T-C09 | `classify-route.test.ts` › "validation: needs name or barcode; max_candidates ≤ 5; unknown fields rejected" | covered |
| T-C10 | `classify/round2.test.ts` › "has the AI-16 categories", "%s → deterministic path: master codes only…", "%s → as model output it is discarded by the guard" | covered |
| T-C11 | `classify/rerank.test.ts` › "falls back on timeout and on provider error (AI-31)", "accepts exactly a permutation of the sent codes"; `classify/round2.test.ts` › "timeout / provider error → ai.fallback (AI-31)" | covered |
| T-C12 | `classify/rerank.test.ts` › "disabled by default…", "per-request opt-out is honoured", "reorders only; never raises confidence…" | covered |
| T-C13 | `classify/pipeline.test.ts` › "ruling 25: per-key daily cap on cache-miss lookups"; `adapters/httpClient.test.ts` › "SA-K-06: per-host request budget refuses calls without contacting the host"; `security-core-round2.test.ts` › "SA-K-03: DELETE /v1/admin/products/:gtin…" | covered |
| T-C14 | `classify/round4.test.ts` (validator inputs, generic words, `uncovered()`, `imitationQualified`); `classify/round5.test.ts` › "auditor probe…", "a cached product brand is ignored too"; `classify/round7.test.ts` (accessory and packaging qualifier) | covered |
| T-F01 | `admin.test.ts` › "a different actor approves: rule + end-date + feed + version bump + audit in one transaction" | covered |
| T-F02 | `feed.test.ts` › "since=0 pages through the whole feed exactly once", "limit > 500 → 400…" | covered |
| T-F03 | `feed.test.ts` › "ETag/304 and Cache-Control: private, no-cache"; `rates.test.ts` › "ETag + If-None-Match → 304" | covered |
| T-F04 | `feed.test.ts` › "reports version, hash, coverage incl. verified/unverified…"; `rulings-round2.test.ts` › "ruling 11: meta content_sha256 = recomputed canonical export hash…", "ruling 10: a detected notification shows in meta…"; `core-round9.test.ts` › "meta lists the curated gaps and counts codes without rules", "loader: missing file → [], malformed file throws, default file parses"; `core-round10.test.ts` › "meta sources[] carry rule_count and verified_count"; `security-core-round5.test.ts` › "matches the previous SQL on random data", "20k codes / 3k rules computes in under 50 ms", "meta computes it once per dataset version and day…" | covered |
| T-F05 | `rulings-round2.test.ts` › "ruling 4: same dataset, clock crosses IST midnight → new ETag…" | covered |
| T-F06 | `rulings-round2.test.ts` › "ruling 3: prefixRelated matches both directions", "ruling 3: … a rule added at 71131910 invalidates a cached 7113" | covered |
| T-F07 | `rulings-round2.test.ts` › "ruling 25: feed_epoch is reported and changes on restore (rotate)"; `feed.test.ts` › "… since ahead → 410" | covered |
| T-F08 | `rulings-round2.test.ts` › "ruling 1: correct → …", "ruling 25: retroactive effective dates need retroactive_reason and set the feed retroactive flag" | covered |
| T-A01 | `admin.test.ts` › "same actor cannot approve, even with a different key → 403…"; `security-core-round2.test.ts` › "SA-C-03: actor spelling variants all normalise to the same actor…" | covered |
| T-A02 | `admin.test.ts` › "overlapping rule → 409 overlapping-rule" | covered |
| T-A03 | `admin.test.ts` › "a conflict discovered at approval time rolls back everything…" | covered |
| T-A04 | `admin.test.ts` › "idempotency: same key + same body → replay; different body → 409", "re-approving with the same Idempotency-Key replays (200)…"; `rulings-round2.test.ts` › "ruling 8: stored per key…" | covered |
| T-A05 | `admin.test.ts` › "rate fields cannot be updated; rules cannot be deleted", "verified → unverified is blocked" | covered |
| T-A06 | `admin.test.ts` › "tampering with a row … is detected at that id"; `rulings-round2.test.ts` › "ruling 18: chain verifies only with HSN_AUDIT_KEY…", "ruling 18: export-audit-head + verify-audit detect truncation…" | covered |
| T-A07 | `admin.test.ts` › "non-allowed slab (1700 bp) → 400", "source url on a non-allow-listed host or http → 400", "missing citation → 400"; `rulings-round2.test.ts` › "ruling 12: … need source.pdf_sha256 and schedule_serial"; `security-core-round2.test.ts` › "SA-C-14: only 2/4/6/8 digits (5 for 99xxx) and the prefix must exist"; `trd-round8.test.ts` › "T-A07: %s → 400" (`.evil.example`, `@evil.example`, trailing dot, Cyrillic IDN, punycode, port 8443, non-allowed host, http), "T-A07: the canonical URL … is accepted"; `core-round9.test.ts` › "create proposals must cite a document, not an index page"; `core-round10.test.ts` › "create / supersede / correct refuse free text with /rule/source/notification"; `security-core-round5.test.ts` › "refuses decorated or non-canonical paths", "a configured .pdf index page is matched regardless of case, slashes, query or fragment", "proposal citations may not carry a query string or fragment (none is stored)" | covered (the trailing-dot case found a bug, fixed in core round 8) |
| T-A08 | `admin.test.ts` › "verify action: only verification fields change and rule_verified is emitted" | covered |
| T-A09 | `rulings-round2.test.ts` › "ruling 1: correct → target voided (kept), replacement live…" | covered |
| T-A10 | `rulings-round2.test.ts` › "ruling 9 / 19: verify on a verified rule only moves last_verified_at forward…"; `core-round9.test.ts` › "index pages and non-document URLs are not documents; /view-pdf/ and .pdf are", "HSN_SOURCE_INDEX_PAGES adds pages to the set", "the seed rule cites the CBIC index page", "verify without source.url → 400 source-url-not-document", "verify with an index page or a non-document url → 400", "a direct SQL citation change is refused by the trigger", "verify with url + notification: approval replaces both atomically, clears citation_note", "a later verify may not change url/notification (400), plain re-verify still works", "a citation changed behind the trigger after the verify is flagged by the cross-check"; `core-round10.test.ts` › "verify refuses free text with /source/notification", "a verify that changes the citation puts the new one in the rule_verified feed summary"; `security-core-round5.test.ts` › "a verify with a decorated URL is refused through the API" | covered |
| T-A11 | `rulings-round2.test.ts` › "ruling 20: approval fails if the superseded rule changed after the proposal (target_sha256)", "ruling 25: retroactive effective dates need retroactive_reason…"; `core-round6.test.ts` › "X1: rule_json edited (hash kept) → … 409 proposal_hash_mismatch…" | covered |
| T-A12 | `rulings-round2.test.ts` › "ruling 17: bootstrap only once…", "ruling 25: admin keys expire within 90 days"; `security-core-round2.test.ts` › "SA-C-06: admin cannot be combined with another scope" | covered |
| T-A13 | `security-core-round2.test.ts` › "SA-C-19: a revoked key fails on the very next request…"; `core-round4.test.ts` › "disable_actor proposal (two admins): … pending proposals withdrawn…" | covered |
| T-A14 | `db/ddl.test.ts` › "T-A14: ${name}" (the docs tool's trigger and constraint checks, ported, against schema.sql + MIGRATIONS), "T-A14: schema.sql + MIGRATIONS equals what migrate() builds…" | covered (the byte comparison of data-model.md §2 with the code stays in `reviews/round2-tools/test-ddl.cjs`) |
| T-A15 | `rulings-round2.test.ts` › "ruling 23: synonyms/category_map/chapter_keywords change only via approved refdata_change…" | covered |
| T-A16 | `add-code.test.ts` (all five tests) | covered |
| T-A17 | `core-round3.test.ts` › "ruling 28: each admin write without the header → 400 idempotency-key-required…", "ruling 26: another actor gets 403 not-proposer…" | covered |
| T-A18 | `core-round4.test.ts` › "disable_actor proposal (two admins)…", "a disabled proposer…", "scripts/disable-actor.ts disables…"; `core-round6.test.ts` › "with two active admins the script refuses and nothing changes"; `core-round7.test.ts` › "disable_actor with two active admins → 400 last_actors without the disable-actor.ts hint" | covered |
| T-A19 | `core-round4.test.ts` › "an extra key for an existing actor can only be requested by that actor (service and DB)", "an approved grant expires 72 h after approval if not redeemed…" | covered |
| T-A20 | `core-round7.test.ts` › "P1: flipping llm_opt_out, raising the rate limit…", "P3: a SQL dismiss or emptied prefixes of a keyed row is detected…", "legitimate triage and two-admin dismiss keep the cross-check clean…"; `core-round4.test.ts` › "a legitimate history cross-checks clean…", "DB guards: …", "the auditor…" (DB11), "a raw api_keys insert and a dropped-trigger rule edit are reported"; `core-round6.test.ts` › "X1…", "an approved proposal edited afterwards…", "X2 un-revoked key and X3 re-enabled actor…", "X4: a rejected proposal set back to pending is detected" | covered |
| T-A21 | `core-round4.test.ts` › "a restored backup (database behind the high-water mark) rotates the feed epoch…", "an edited sidecar (MAC fails) fails readiness…", "production refuses HSN_STATE_HWM_FILE=off"; `core-round6.test.ts` › "sidecar deleted for a database that had one…", "production requires HSN_STATE_HWM_FILE outside the database directory" | covered |
| T-A22 | `core-round4.test.ts` › "first triage needs a second admin (SA-C3-03)…", "dismiss: first admin → 202…", "SA-C3-03 (X5): a manual row with a CBIC notification key…", "manual watch entries without a notification key keep single-admin resolve" | covered |
| T-A23 | `core-round5.test.ts` › "is loaded from the seed and served in rule DTOs", "cannot be edited directly, only cleared by a verify approval"; `core-round6.test.ts` › "the seed audit entry records the notes…" | covered |
| T-A24 | `core-round5.test.ts` › "propose → refused for the same actor and for changed files → approved by a second admin…" (plus the refusal cases in the same file) | covered |
| T-S01 | `auth.test.ts` › "missing, malformed, unknown prefix and wrong secret all give the same 401 body" | covered |
| T-S02 | `auth.test.ts` › "read key cannot classify…", "%s %s: not on the public listener (404); on the admin listener read/classify keys → 403…" | covered |
| T-S03 | `auth.test.ts` › "revoked key → 401 (cache TTL 0)" | covered |
| T-S04 | `rulings-round2.test.ts` › "ruling 14: Limit 600, Remaining tokens, Cost per request, Policy"; `auth.test.ts` › "per-key token bucket → 429 with Retry-After…" | covered |
| T-S05 | `security.test.ts` › "__proto__ / constructor keys → 400" | covered |
| T-S06 | `adapters/httpClient.test.ts` › "refuses a non-allow-listed host…", "does not follow redirects…", "aborts oversized bodies…", "times out a slow server" | covered |
| T-S07 | `security.test.ts` › "logs never contain the API key or Authorization header"; `classify/route.test.ts` › "writes exactly one classify.decision line with HMAC name…"; `classify/round2.test.ts` › "HMAC differs by key and is not the bare SHA-256" | covered |
| T-S08 | `security.test.ts` › "a forced DB error returns a generic 500 without SQL or SQLITE" | covered |
| T-S09 | `security.test.ts` › "missing DB path, bad values, production without pepper, LLM without key → ConfigError"; `trd-round8.test.ts` › "T-S09: config refuses HSN_LLM_ENABLED=true without HSN_LLM_DATA_DISCLOSURE_ACK", "T-S09: booting the server that way exits non-zero before listening" | covered |
| T-S10 | `auth.test.ts` › "%s %s: not on the public listener (404)…"; `core-round3.test.ts` › "ruling 30: never on the public listener"; `security-core-round2.test.ts` › "SA-C-20: /readyz runs no DDL per probe and says only ready/not ready" | covered |
| T-S11 | `auth.test.ts` › "SA-C-01: repeated auth failures from one IP are throttled, but a valid key…"; `security-core-round2.test.ts` › "SA-C-01: …" (three tests) | covered |
| T-S12 | `admin.test.ts` › "the request-handling connection is read-only"; `trd-round8.test.ts` › "T-S12: the read-only connection cannot write %s", "T-S12: the cache-writer connection cannot write %s", "T-S12: the cache writer can write products, api_keys.last_used_at and idempotency_keys, and nothing else on api_keys", "T-S12: every connection has foreign_keys=1, trusted_schema=0 and no extension loading" | covered (the cache-writer connection was added in core round 8) |
| T-S13 | `adapters/ipGuard.test.ts`; `adapters/httpClient.test.ts` › "SA-K-18: compressed responses are refused…", "SA-K-18: HTTPS_PROXY in the environment is ignored…" | covered |
| T-S14 | `core-round4.test.ts` › "known path, wrong method → 405 problem with Allow; unknown path → 404" | covered |
| T-S15 | `core-round4.test.ts` › "0.0.0.0 without HSN_ADMIN_IP_ALLOWLIST is refused; loopback or an allow-list is accepted" | covered |
| T-X01 | `architecture.test.ts` (five tests) | covered |
| T-W01 | `watcher.test.ts` › "first run queues every notification dated on/after HSN_WATCHER_NOT_BEFORE…", "duplicate run is idempotent…", page-shape tests, "content-type allow-list per adapter…" | covered |
| T-W02 | `watcher.test.ts` › "admin triage sets affected prefixes…", "a manual entry and the watcher share one identity…" | covered |
| T-W03 | `watcher.test.ts` › "watcher: never succeeded → alert; 35 h → fresh; 37 h → stale", "a detected notification unreviewed past 2 business days raises the alert…" | covered |
| T-W04 | `core-round4.test.ts` › "256 KiB adversarial page (${name}) parses in well under 1 s", "row text, cells and anchors are capped", "isolated parse: …", "watcherDeps … always isolates…", "display:none / hidden rows…", "a watcher run logs watcher.hidden_rows…" | covered |
| T-A25 | `core-round9.test.ts` › "normaliseNotificationRef strips zero padding from N/YYYY and collapses spaces", "the seed loader stores no zero-padded notification numbers"; `core-round10.test.ts` › "accepts the canonical form after normalisation, refuses free text", "… is accepted and stored as …", "the shipped seed conforms", "a free-text notification_ref is refused by the loader; a padded one is normalised", "import-dataset propose refuses a seed with a free-text citation" | covered |
| T-X02 | `docs/traceability.test.ts` › "the table parses and lists every test ID the TRD specifies", "every cited test file exists and contains every cited test name", "every row that claims coverage cites at least one test" | covered |
| T-S16 | `security-core-round5.test.ts` › "a 200 KB key comes back as at most 64 characters, escaped", "50 long keys still fit the 16 KiB body cap" | covered |
| T-S17 | `security-core-round5.test.ts` › "must be absolute in production", "explicit path: missing, not a file, too large, or not JSON → throws without echoing contents", "a bad explicit file refuses the boot" | covered |
| T-E01 | `eval/eval.test.ts` (all tests) | covered (gates provisional: LLM-draft labels; high band n = 16, lower bound 0.806, flagged insufficient) |

**All IDs are covered** (re-checked after core round 10 and classify round 7; since round 9 `test/docs/traceability.test.ts` (T-X02) enforces this table, so a drifted test name fails the suite; since core round 10 a missing TRD fails it too, unless `HSN_TRD_PATH=skip`). T-U06 asserts the **observed** shipped-seed values where they differ from the §5.5 design examples: "dry fruits gift box" is a no-confident-match (0813 is not in the master, chapter 08 kept with a packaging hint), and "mobile phone stand" is 8517 capped low by the `rules-fts-2.3` accessory qualifier.

## 16. Deployment

- Container `node:22-slim@sha256:<digest>` (pinned, scanned in CI), non-root uid 10001, read-only root filesystem, `/data` volume holding `hsn.db` and its WAL. One process, two listeners (public `HSN_HOST:HSN_PORT`; admin `HSN_ADMIN_HOST:HSN_ADMIN_PORT`, default `127.0.0.1:3001`, reached over SSH or VPN) with `GET /metrics` on the admin listener.
- TLS terminates at the platform edge (TLS ≥ 1.2). HTTP is refused for `/v1/*`.
- Boot: config → open DB (WAL, `foreign_keys=ON`, `trusted_schema=OFF`) → migrations in a transaction (refuse to start if the schema is newer than the code) → listen. Three connections (SA-D-13): read-only for request handlers; a cache writer limited to `products`, `api_keys.last_used_at` and `idempotency_keys` (`openCacheDb`, core round 8; node:sqlite has no authorizer, so per-connection TEMP triggers refuse every other write); an admin writer for `ProposalService` and `scripts/` (SEC-42, SEC-91).
- Server timeouts: `requestTimeout` 10 s, `connectionTimeout` 10 s, `keepAliveTimeout` 5 s, `bodyLimit` 64 KiB (classify 16 KiB, tax 256 KiB), `maxParamLength` 100.
- Backups: nightly `VACUUM INTO`, encrypted upload to object storage in an Indian region, 30 daily plus 12 monthly kept; the backup encryption key is held outside the host and rotated yearly. `scripts/export-audit-head.ts` output copied off the host daily and after each publish. `HSN_STATE_HWM_FILE` and `HSN_AUDIT_KEY` stay out of the DB's backup set (a different volume). **Restore (ruling 31; rounds 4 and 6):** stop the service, replace the DB file from the backup, start it. The server detects that the DB is behind the high-water mark (or that the sidecar is missing): it rotates `feed_epoch`, audits `dataset.restore_detected`, logs an alert and fails `/readyz` (`state_continuity`). After confirming the restore was intended, run `npm run ack-restore -- --by <actor> --note "<incident note, ≥ 10 chars>"` (audited `dataset.restore_acknowledged`) and restart; then `verify-audit --head` against the last exported head. `rotate-feed-epoch` remains for a manual rotation. **Upgrade step (SA-C4-04, accepted residual):** a backup taken before the first boot of round-6 code, restored with the sidecar deleted, initialises silently (its log has neither `dataset.hwm_initialised` nor `dataset.restore_acknowledged`); so after upgrading, boot once (writes `dataset.hwm_initialised`), then export a fresh audit head off-host, and treat older backups as needing `verify-audit --head` against an export before use. The drill ran live in docs round 4 (`reviews/docs-fix-round2.md`). Quarterly restore drill with `scripts/verify-audit.ts --head`.
- Environments: `test` keys and DB for client integration; `live` for production. `npm run seed` is refused in production; production data arrives through `import-dataset` (§13), proposals or a restore. Supply chain: CI actions pinned to commit SHAs, no production secrets in test jobs, `npm sbom` per release, SQLite pragma/FTS behaviour re-tested on each Node update (SA-D-24).
- Path to Postgres: `repositories/postgres/*` implementing the same interfaces (`design/data-model.md` §6), Redis rate limiting, N stateless instances. No route or service changes.

## 17. Performance budgets

| Path | Budget (server-side p95) | Main costs | Notes |
|---|---|---|---|
| Auth + rate limit + validation | ≤ 2 ms | Prefix lookup (indexed, no cache), one HMAC-SHA256, bucket math | |
| `GET /v1/hsn/{code}`, LRU hit | ≤ 5 ms | Serialisation | Most traffic |
| `GET /v1/hsn/{code}`, miss | ≤ 30 ms | 2 indexed queries (code plus ancestors, rules in force) | `rate_rules_prefix_dates` index |
| `GET /v1/hsn/search` | ≤ 50 ms | FTS5 bm25 over about 23k rows, limit ≤ 50 | Token cap 10 |
| `POST /v1/classify` (no outbound) | ≤ 300 ms | Synonym lookup, FTS top-10, fusion, ≤ 5 resolver calls | |
| `POST /v1/classify` (OFF miss) | ≤ 1.5 s | 3 s hard timeout → `lookup_failed` | Concurrency cap 4 outbound |
| `POST /v1/tax/calculate`, 50 lines | ≤ 150 ms | ≤ 50 resolver calls (LRU) | 500-line worst case ≤ 1 s |
| `GET /v1/rates/changes`, 500 rows | ≤ 80 ms | One range scan on the PK | |
| Approval transaction | ≤ 200 ms | `BEGIN IMMEDIATE`, about 8 statements | Rare |
| Memory | ≤ 256 MiB RSS | LRU 10k entries, DB page cache | |
| DB size | < 50 MB | About 23k HSN/SAC rows, a few thousand rules | |

## 18. Security summary

The checklist `05-security-checklist.md` is authoritative. Items that most affect implementation: hashed and peppered keys; non-hierarchical scopes with default deny; per-key buckets plus a failed-auth limiter that never blocks a valid key; `additionalProperties: false` everywhere; FTS query builder; prepared statements only; SSRF-controlled outbound (allow-list, DNS/IP checks, no redirects, 3 s, size cap); append-only rules, feed and audit enforced by triggers; maker–checker by `actor_id` with two-person admin issuance; approval bound to `content_sha256`; HMAC audit chain with an off-host head; admin plane on a separate loopback listener; unverified-rate gate on tax; external-data confidence cap; reference-data change control; secrets redacted; no PII; CERT-In and DPDP runbook entries (legal readings to be confirmed with counsel).

## 19. Traceability (PRD → TRD)

FR-01/02/03 → §4, §7 · FR-05/06/07 → §5 · FR-08 → §6 · FR-09 → §12 · FR-10 → §3.1, §7 · FR-11/12 → §3.1, §13 · FR-13 → §9, §10 · FR-14 → §13 · FR-15 → §3.1, §13 · NFR-01–04, 11 → §17 · NFR-05, 15 → §16 · NFR-07 → §13, §14 · NFR-08 → §3.1 (re-verification), §14 · NFR-09, 10, 14 → §15.

## 20. Inconsistencies (resolved)

Resolved per `00b-coordinator-rulings.md` (rulings 1–28, the former items I-01…I-28 of this section) and `00c-coordinator-rulings-round2.md` (rulings 1–25, from the validator and security reviews of round 1). The rulings have been applied to `01-PRD.md`, this document, `03-app-flow.md`, `05-security-checklist.md`, `06-ai-restrictions.md`, `07-best-practices.md` and `design/` (`openapi.yaml`, `data-model.md`, `architecture.md`, `ui-and-dx.md`); the change map is `reviews/docs-fix-round2.md`. Where any text still conflicts with a ruling, the ruling wins.

Open after the rulings:
- PRD Q1 (making charges vs job work, 00b ruling 12) awaits Sunarone's CA.
- The seed format is the shared `server/data/seed/FORMAT.md`; data-model §7 lists the DDL constraints that win where it differs (no verified seed rows; every rule prefix must exist as a code of length 2/4/5/6/8).
- Round 3 (00c Part C, rulings 26–33) is applied; remaining code ↔ docs differences are listed in `reviews/docs-fix-round2.md` § Round 3.
- Code rounds 4–10 (core: schema v5–v8, ruling 36 verify citations, canonical citations enforced at every entry point, the structural body guard and pre-validation token cost, document-URL rules, error echo caps, meta `sources[]` counts, `allErrors` validation, `needs_input` with `condition`, unpadded notification references, meta `known_data_gaps` / `codes_without_rules`, the traceability test, the cache-writer connection, trailing-dot refusal, restore detection, cross-check, disable_actor, import-dataset, codes outside the master, partial totals, citation notes; classify: `rules-fts-2.1`/`2.2`/`2.3`, eval set) are applied by docs round 4; every test ID is covered (§15.2), and the remaining code-side gaps in `reviews/docs-fix-round2.md` § Round 4.
- The Ed25519 dataset signature stays optional in v1 (`signature: null`); the required anchor is the off-host audit head (00c ruling 18).
