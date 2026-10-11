# Docs fix, round 2

Scope: every document under `docs/`: 01, 02, 03, 05, 06, 07, README, and `design/` (openapi.yaml, data-model.md, architecture.md, ui-and-dx.md). I also added a short note block to `00b`, as the coordinator asked.

Inputs, in priority order:
1. `00c-coordinator-rulings-round2.md` (rulings 1–25);
2. `00b`;
3. `reviews/validator-docs-round1.md` (29 required fixes);
4. `reviews/security-docs-round1.md` (SA-D-01…26).

The coordinator also sent two additions: the doc items in `code-fix-classify-round2.md`, and alignment with `code-fix-core-round2.md`.

I did not touch any code under `server/` or `/home/claude`; I only read it.

## Evidence

| Check | Command (from `reviews/round2-tools/`) | Result |
|---|---|---|
| The DDL runs in `node:sqlite` and its guards hold | `node --no-warnings test-ddl.cjs ../../docs/design/data-model.md` (it extracts the `sql` block). `0001_init.sql` is the same SQL. | **119 passed, 0 failed**; `PRAGMA foreign_key_check` returned 0 rows |
| openapi parses, refs resolve, examples validate | `python3 -I validate_openapi.py ../../docs/design/openapi.yaml` (JSON Schema 2020-12 via `jsonschema` with a `referencing` registry) | 265 `$ref`s, 0 unresolved; **113 examples validated, 0 failures**; 15 paths, 16 operations, 38 schemas. A deliberately broken example was caught (negative control). |
| Worked examples, architecture §5.5 | Recomputed by hand with `rules-fts-2.0`; cross-checked against the table in `code-fix-classify-round2.md` | Match; see the table below |

What the 119 DDL tests cover:
- maker ≠ checker on `actor_id`;
- admin-key CHECKs (only `["admin"]`, whatever the spelling; actor required; ≤ 90 days);
- the bootstrap and `admin_grant` triggers;
- rule INSERT provenance (approved proposal or seed batch); seed rows must be `unverified`;
- set-once columns; void-only status; terminal proposals immutable;
- dataset pointer moves forward only; append-only feed, audit and verifications;
- reference data deactivate-only;
- prefix lengths 2/4/5(99)/6/8 and prefix existence;
- `condition_code` and `rule_hint` CHECKs and immutability;
- products source enum (OFF/OBF);
- idempotency and watched notifications.

Worked examples (architecture §5.5, `rules-fts-2.0`; illustrative signals):

| Input | Top | Confidence | Band |
|---|---|---|---|
| 22K gold ring | 7113 | 0.91 (7117 0.27 low) | high |
| Paracetamol 500 mg tablet | 3004 | 0.72 (2924 0.22 low) | medium |
| Dry fruits gift box | 0813 | 0.45 (0802 0.25) | low |
| Knitted cotton T-shirt | 6109 | raw 0.903 → 0.84 (no exact synonym) | medium |
| Mobile phone stand | 8517 | 0.17, with `message`; 3926 dropped | low |
| Barcode-only biscuits | 1905 | raw 0.942 → **0.84**, external data, `review_hint` | **medium** |
| Category-only barcode | 1905 | 0.15 / 0.50 = 0.30 | low |
| Name + barcode biscuits | 1905 | 0.94 | high |

## Validator required fixes (1–29)

| # | Fix | What changed (file § ) |
|---|---|---|
| 1 | Corrections from a rule's first day | 00c r1 applied. `correct` action voids the target (`status='voided'`) and inserts the replacement in one transaction; feed `rule_corrected` with `rule_id` + `related_rule_id` (field renamed from my draft `replaced_rule_id` to match the code). Changed: data-model §2 DDL (status, voided_*), §4 write path; openapi `ProposalAction`, `Change`; TRD §3, §12, T-A09, T-F08, T-R12; 03 §8; 05 SEC-52, SEC-82; 07 §5 |
| 2 | Medium unreachable, dead gate | 00c r2 + r22. Weights renormalised over applicable signals (denominators 0.35/0.50/0.85/1.00); `high` only with an exact curated synonym on the caller's name; external data and no-exact-synonym capped at 0.84; `scoring` field. Changed: architecture §5.4/§5.5 (recomputed); TRD §5, T-U06, T-U07; openapi classify description, `scoring`, examples; 06 AI-03/04/07; PRD §2.3 |
| 3 | Feed invalidation misses specific codes | `affected_prefix` on every change; clients invalidate when `c.startsWith(p) \|\| p.startsWith(c)`. openapi `Change`; TRD §12, T-F06; 03 §8; 07 §13 |
| 4 | ETag/LRU ignore "today" | ETag `W/"ds-{v}-{sha256(v, as_of_ist, body)[:16]}"`; `max-age` = min(3600, seconds to next IST midnight). TRD §11 (single table), T-F05; openapi info and headers; architecture §2.1; 07 §7 |
| 5 | 3004 / nil-rated drugs | 00c r5: general 5% rule `…B5` plus `other` 0% rule `…B6` (`condition_code nil_rate_list`, placeholder URL labelled illustrative) → `coverage: ambiguous`, `default_rule_id` = B5. Tax lines pick with `rule_id` / `condition: general`, else `needs_input`; a wrong choice → 422 `rule-choice-invalid`. Synonym `rule_hint` (exact caller-name hit only) selects the nil rule with warning `selected_by_hint`. Changed: data-model §2 (`condition_code`, `synonyms.rule_hint`), §3; openapi examples (`&rate3004`); TRD §4, §6, T-R13, T-T08; 03 §3, §5.2; PRD US-03; ui-and-dx §3.2; 06 AI-09 |
| 6 | 5-digit SAC rejected | Code pattern `^(\d{2}\|\d{4}\|\d{6}\|\d{8}\|99\d{3})$`, DDL CHECK on prefix length, T-R11; 05 SEC-26; 07 §5 |
| 7 | Quantity divide unspecified | Quantity is ≤ 3 decimals (`qty_milli`) and never changes the tax base. Per the implemented code, when `unit_price` is absent it derives the unit price for threshold selection only: `roundHalfUp(taxable_paise × 1000, qty_milli)`. `line_id` defaults to the index; `igst_rate_bp` on lines. Changed: openapi info, tax op, `TaxLineInput.quantity`; TRD §6, T-T05; PRD US-06 AC6; 03 §7.1; 05 SEC-30; 07 §6; ui-and-dx §3.4 |
| 8 | Idempotency has no storage | `idempotency_keys` table (data-model §2, §4.3); TRD §13; 07 §8 |
| 9 | Re-verification mechanism | `reverify_due_at` = `last_verified_at` + 12 months; warning `verification_overdue`; meta overdue count; `rule_verifications` log. data-model, openapi, TRD §3.1, T-A10, T-R13; 07 §12 step 7 |
| 10 | meta lacks sha256 | `content_sha256` (JCS export) and optional `signature`. openapi meta; TRD T-F04; 05 SEC-54 |
| 11 | Source freshness | meta `sources_checked_at`, `freshness_sla_business_days`, `pending_notifications[]` (00c r10); warning `pending_change_detected`. openapi; TRD §3.1, §13; PRD §2.2; ui-and-dx §3.6 |
| 12 | PDF sha256 / serial | `schedule_serial`, `source_pdf_sha256` on proposals and rules (required except unverified seed rows). DDL; openapi `Source`, `RateRuleInput`; TRD §3.1; 05 SEC-51 |
| 13 | Seed format missing | Every reference now points to the shared `server/data/seed/FORMAT.md`; data-model §7 lists the DDL constraints that win where it differs. TRD §13, §20; README; 07 §11 |
| 14 | `coverage` optional | Required, `ok \| ambiguous \| no_rate_rule`; examples fixed. openapi; TRD §4 |
| 15 | Rate-limit header semantics | Counted in tokens: `RateLimit-Limit` 600 (per minute), `-Remaining`, `-Reset`, `-Cost`, `-Policy` (`600;w=60;burst=100`). openapi headers on every authenticated response; TRD §10; architecture §6; 05 SEC-19/20; ui-and-dx §1 |
| 16 | UTGST | `supply_type: intra_ut` → CGST + UTGST; every amounts object has `sgst` and `utgst`. openapi; TRD §6, T-T10; 07 §6; PRD non-goals updated |
| 17 | GTIN status | 422 `invalid-gtin` everywhere, including the purge route; digits not echoed. 05 SEC-28, SEC-75; openapi |
| 18 | Body and field limits | `q` 2–100 (openapi, SEC-27); `unit_price` > 0 and ≤ 1e9 on classify and tax lines; **body limits per coordinator decision: 64 KiB global, classify 16 KiB, tax 256 KiB** (differs from the fix's single 64 KiB; recorded in 00b notes, SEC-24, openapi `PayloadTooLarge`, TRD §6/§16, PRD US-06 AC4) |
| 19 | ETag and Cache-Control | One route table in TRD §11, copied into openapi info and 07 §7 |
| 20 | Echoing input | Echo only values that passed a strict format check (codes, ids); never free text, never a GTIN that failed its check digit. 05 SEC-75; ui-and-dx §1 rule 2; openapi `Problem.detail`; 07 §3 |
| 21 | Approve twice | Replay with the same `Idempotency-Key` → stored 200; otherwise 409 `proposal-not-pending`. 07 §8; TRD §13, T-A04; openapi approve |
| 22 | `no-rate-for-date` | Removed from every registry (openapi, ui-and-dx §1, 07 §3) |
| 23 | `request_id` format | `request_id` is always the server's `req_` ULID; the client value goes in `client_request_id`. openapi `Problem`, `X-Request-Id`; 07 §9; ui-and-dx §1 |
| 24 | Correction signalling | One mechanism (fix 1): `rule_corrected` + `related_rule_id`; no `reason` field. PRD §9, SEC-82, 07 §5, TRD §12 |
| 25 | Watcher import rule | Watcher is `adapters/cbicWatcher.ts`, scheduled from `jobs/`; `HSN_WATCHER_HOSTS` added. TRD §2, §8, §13; architecture §3; 05 SEC-32/33; 07 §2. The outbound client is `src/adapters/httpClient.ts` (coordinator, SEC-32) |
| 26 | Seed vs SEC-55 | SEC-55 carries the exact exception text from the fix, plus: refused in production and into a non-empty DB; seed rows must be `unverified` (DDL) |
| 27 | 07 §5 field names | Rewritten with DDL names (`hsn_prefix`, `igst_rate_bp`, `condition_kind none\|price\|other`, `condition_text`, `condition_code`, inclusive `min_`/`max_unit_price_paise`, `superseded_by`, `status`); levels 2/4/5(SAC)/6/8; "marked superseded" deleted |
| 28 | Key and log field names | SEC-14 uses DDL names (`key_id`, `key_hash`, `tenant`, `label`, `actor_id`, `pepper_id`, `outbound_daily_cap`); logs use `key_id`, `tenant` and `input_hash` = HMAC(`HSN_LOG_KEY`) (SA-D-18 supersedes the SHA-256 wording). 05 SEC-62/63; architecture §6; TRD §14 |
| 29 | Unsourced material | (a) Example URLs use the research URL for 9/2025 or a labelled placeholder `https://taxinformation.cbic.gov.in/view-pdf/<id>`. (b) Canonical `notification_ref` form `9/2025-CT(Rate), Schedule IV` (data-model §1; examples, ui-and-dx). (c) PRD §1/§2.2 01/2026 dates marked "per secondary sources; gazette not yet read". (d) ui-and-dx §2 mock-up captioned illustrative; unsourced "01/2017-IT(Rate)" and "214 codes" replaced by placeholders |

## Security findings (SA-D-01…26)

| Id | What changed |
|---|---|
| SA-D-01 | `admin_actors` table, normalised unique handles, `actor_id` on keys and proposals, DDL CHECK on `actor_id`, `admin_grant`, `scripts/bootstrap-admins.ts` (exactly two actors), notice on key creation. data-model §2/§5; TRD §9, T-A12; 03 §1; PRD US-08; **05 SEC-43, SEC-50, §0 residual risk** |
| SA-D-02 | HMAC chain (`HSN_AUDIT_KEY`), full rule rows + `rule_sha256` in approval entries, `export-audit-head.ts` / `verify-audit.ts`, API `verify=none\|page` with `chain_scope`. Per 00c r18 the Ed25519 signature stays optional; the off-host head is the required anchor. 05 SEC-53, SEC-54, SEC-97; TRD §3, §14, T-A06; openapi audit |
| SA-D-03 | Insert/update triggers for rules, proposals, dataset pointer and versions (tested). data-model §2; 05 SEC-52; TRD T-A14 |
| SA-D-04 | `content_sha256` on GET proposal; `expected_sha256` on approve/reject (409 `proposal-hash-mismatch`); staleness 409 `proposal-stale`; mandatory `source_pdf_sha256` + serial; no bulk approve; no auth cache; withdraw (maker-only). 05 SEC-44, SEC-16; 07 §8, §12; openapi; ui-and-dx §2 |
| SA-D-05 | No admin web UI in v1 (00c r21). ui-and-dx §2 marked future/illustrative with the required controls; 05 SEC-45, SEC-70 note; PRD non-goals |
| SA-D-06 | External-data cap at medium with `review_hint`; 7-day TTL; `source`, `fetched_at`, `source_last_modified`; `DELETE /v1/admin/products/{gtin}` (audited `product.purged`). 05 SEC-46, SEC-38; 06 AI-17; architecture §5.4; openapi; TRD T-C06, T-C13 |
| SA-D-07 | `refdata_change` proposals, deactivate-only triggers, `refdata_changed` feed type. 05 SEC-47; 06 AI-45; data-model; TRD T-A15 |
| SA-D-08 | Tax gate `accept_unverified` (`needs_input: [accept_unverified]`, `unverified_accepted`); launch gate. 05 SEC-48; PRD Q5 resolved, SM-01; TRD T-T09; openapi |
| SA-D-09 | Admin listener `127.0.0.1:3001` (openapi path-level `servers`); admin expiry ≤ 90 d (DDL); no cache; notifier. 05 SEC-18, SEC-96; TRD §8, §16 |
| SA-D-10 | Admin scope exclusive, actor required whatever the JSON spelling, unknown scopes rejected. DDL CHECKs; 05 SEC-14; openapi securitySchemes wording |
| SA-D-11 | `retroactive_reason`; feed `retroactive`, `affects_from`. 05 SEC-93; TRD §12, T-A11, T-F08 |
| SA-D-12 | `feed_epoch` on feed and meta; `since > last_change_seq` → 410; audited restore. 05 SEC-49, SEC-78, SEC-81; 07 §13; TRD T-F07 |
| SA-D-13 | Three connections; single-process limitation stated. 05 §0, SEC-42, SEC-91; TRD §16; 07 §2 |
| SA-D-14 | Tax cost 1 + floor(lines/50) (00c r25 overrides the review's ⌈lines/25⌉); LRU keyed without price; per-key daily outbound cap, per-host minute budgets, queue cap → `lookup_failed` (not the review's `lookup_throttled`); LLM budgets; products LRU cap. 05 SEC-36, SEC-92; TRD §8, §10 |
| SA-D-15 | Failed-auth-only limiter keyed on full IPv4 (IPv6 /64, as implemented) + key prefix; a valid key is never blocked; production boot needs `HSN_TRUST_PROXY` or `HSN_DIRECT_EXPOSURE`. 05 SEC-21, SEC-23; TRD §10, T-S11 |
| SA-D-16 | Allow-only-global-unicast with the full deny table; compressed responses refused; proxy env ignored; TLS checks never disabled; per-caller allow-lists; watcher moved to adapters. 05 SEC-32–36; architecture §1/§3; TRD T-S13 |
| SA-D-17 | Exact parsed-hostname check, path required, PDF sha256. 05 SEC-51 with bypass test strings |
| SA-D-18 | `input_hash` = HMAC with `HSN_LOG_KEY`; never truncated text. 05 SEC-62; 06 AI-50; architecture §6; TRD T-S07 |
| SA-D-19 | Log retention max(180 d, 1 y) in India; NTP; CERT-In PoC; DPDP 72 h report; `actor_id` pseudonymity; every legal reading marked "confirm with counsel". 05 SEC-64, SEC-84, SEC-88, SEC-89, SEC-95 |
| SA-D-20 | SEC-43…49 and SEC-91…101 added, no numbering gaps. Verifications are pass/fail: SEC-39 is a lint rule plus T-X01; SEC-56 is T-X01; SEC-50 is on `actor_id`. SEC-55 bypass removed. SEC-14/42/60/63/76 are now tests. Backup key management is SEC-94 |
| SA-D-21 | `q` ≤ 100; `unit_price` ≤ 1e9; one ETag length (16); echo rule; SEC-65 "no plugins"; idempotency per key; `/readyz` generic. (`00` HMAC wording not edited: `00` is the coordinator's file; flagged below) |
| SA-D-22 | Prefix lengths 2/4/5(99)/6/8 and existence (DDL + zod). 05 SEC-26 |
| SA-D-23 | Zero-token FTS → empty result (SEC-27/40); RFC 8785 JCS (SEC-101); `pepper_id` rotation (SEC-12) |
| SA-D-24 | Image digest and scan (SEC-98), pinned action SHAs, no secrets in CI tests, SBOM (SEC-99), SQLite re-test on Node updates (SEC-69); TRD §16 |
| SA-D-25 | Metrics on `HSN_METRICS_HOST` loopback (SEC-100); `/readyz` returns `{status}` only (SEC-73) |
| SA-D-26 | One fixed LLM payload: `product_text`, a separate `product_category` field (≤ 100 chars) and the candidates, matching `classify/rerank.ts`. 06 AI-22, AI-16; architecture §5.6 |

## Coordinator additions

From `code-fix-classify-round2.md`:
- openapi `product.source` gains `lookup_failed`; candidates get `rule_hint` and the response gets a required `scoring`. The descriptions state that candidate order is the ranking and that confidences are non-increasing after a re-rank. Architecture §5.4/§5.5 use the new formula and examples (barcode-only biscuits 0.84 medium).
- SEC-28: 422 `invalid-gtin` everywhere. SEC-32: `src/adapters/httpClient.ts`.
- `DELETE /v1/admin/products/{gtin}`: 204, plus 404 when nothing is cached (as implemented); audited.
- Runbook note on outbound limits (OFF 15/min, per-key daily cap, kill switch) is in SEC-82.

From `code-fix-core-round2.md` (where the code follows 00c), the docs now match the code on:
- feed `related_rule_id`;
- problem types `proposal-hash-mismatch` and `rule-choice-invalid`, plus `forbidden-ip`, `proposal-not-found`, `method-not-allowed`, `rule-not-active`, `dataset-not-loaded`, `classifier-unavailable` and `admin-writes-disabled` in the registry; the `code` member in problems;
- burst capacity 100 with `RateLimit-Limit` 600 and `RateLimit-Policy`. This **reverses my own earlier change to a 600-token burst**;
- tax line `needs_input[]`, `unverified_accepted` and `default_rule_id`;
- quantity-derived unit price for threshold selection;
- IPv6 /64 bucketing for the failed-auth limiter;
- body limits;
- reason codes: the caps have no reason codes of their own (the code emits only its 12 codes and 500s on any other). `external_product_data`, `capped_no_exact_synonym` and the `margin_penalty` reason were removed from the docs; `signals.margin_penalty` stays.

## Interpretations and open items

Docs vs code. The docs keep the design, and the code workers need to act:
1. **Withdraw endpoint** and `not-proposer`: in the contract (SA-D-04 item 6), but `routes/admin.ts` has no withdraw route.
2. **Audit verify parameter:** the docs say `verify=none|page` with `chain_scope` (SA-D-02 item 4). The code uses `verify=true|false` with `head_id`, `head_hash` and `verify_note`.
3. **`Idempotency-Key`:** required in the contract, optional (UUID) in the code.
4. **Pepper rotation (`pepper_id`)**, **out-of-band notifier**, **CBIC watcher** and `sources_checked_at` are not implemented (core report "Not done"). The docs keep them as requirements: SEC-12, SEC-96, TRD §13.
5. **Env vars in the docs but not the code:** `HSN_PRODUCT_CACHE_MAX_ROWS`, `HSN_WATCHER_HOSTS`, `HSN_METRICS_HOST`, `HSN_ADMIN_NOTIFY_HOSTS`. The code has `scripts/rotate-feed-epoch.ts` and `scripts/create-key.ts`; the docs name `scripts/restore.ts` and `scripts/keys.ts`.
6. **Tax response shape:** the code also returns `tax_paise`, `rule_selected_by` and `warning`, and its quantity bound (≤ 9,999,999) differs from openapi (≤ 1,000,000). This needs a contract/code reconciliation pass.
7. **Seed:** the DDL refuses verified seed rows. `FORMAT.md` documents a `verified` option, and the code allows it only through a fixture-only `allowVerified` flag. data-model §7 says the DDL wins.

Interpretations I made:
- **00c r22** is read as "the curated synonym must hit on the caller's request name". The code does the same.
- **`HSN_LLM_ENABLED`:** the code name is used everywhere. The 00b notes block records that `HSN_LLM_RERANK_ENABLED` was its earlier name.
- **`in_review`** proposal state was dropped; the lifecycle is `pending → approved | rejected | withdrawn`.
- **Outbound and LLM budgets** are per process, which matches the single-instance v1. TRD §10 says so.
- **Money `multipleOf: 0.01`** was removed from the min/max price schema fields. Float `multipleOf` rejects 2500.01 in some validators, so the server checks 2 decimals on the decimal string and openapi says so in its info section.
- **T-C test numbering** was kept, with new cases appended (T-C12, T-C13), to avoid breaking references.

Not edited:
- `00-coordinator-decisions.md` (still says SHA-256 for keys; SA-D-21) and the body of `00c`. Both are coordinator files. 00b got only the notes block it asked for.

## Tools

`reviews/round2-tools/`:
- `0001_init.sql`: the DDL;
- `test-ddl.cjs`: the DDL tests (135 after round 3); run `node --no-warnings test-ddl.cjs <file.sql|data-model.md>`;
- `validate_openapi.py`: run `python3 -I validate_openapi.py <openapi.yaml>`; needs PyYAML, jsonschema and referencing.

## Round 3

Scope: the 00c Part C rulings 26–33, plus the doc updates listed in `reviews/code-watcher-round2.md` (CBIC watcher and `add_code`). The code was read in `/home/claude/hsn-api/server` but not edited. The shared `server/data/seed/FORMAT.md` was not edited either; the coordinator re-syncs it.

### Evidence

- **DDL** (`design/data-model.md` §2, the same text as `round2-tools/0001_init.sql`):
  - `node --no-warnings test-ddl.cjs docs/design/data-model.md` → **135 passed, 0 failed**;
  - `PRAGMA foreign_key_check` → 0 rows;
  - 119 tests were run in round 2; the 16 new ones cover `add_code`, the `hsn_description` replacement, and watcher triage, keys and runs.
- **OpenAPI** (`python3 -I validate_openapi.py docs/design/openapi.yaml`):
  - 319 refs, 0 unresolved;
  - **141 examples validated, 0 failures**;
  - 19 paths, 21 operations, 43 schemas.
  - Round 2 had 265 refs and 113 examples.
- **Tools:** `round2-tools/0001_init.sql`, `test-ddl.cjs` and `validate_openapi.py` were updated to these versions.

### Rulings 26–33

| Ruling | Change | Where |
|---|---|---|
| 26 Withdraw | `POST …/{id}/withdraw` with body `{reason}` (5–1000 characters), proposer-only (403 `not-proposer`), pending-only (409), audited. Added a 400 response and the `Idempotent-Replayed` header. | openapi; TRD T-A17; 03 §10 |
| 27 Audit verify | `verify=true\|false` (default false) replaces `none\|page`; `chain_scope` is removed. `AuditPage` now has `head_id`, `head_hash`, `chain_ok`, `chain_broken_at` and `verify_note` (spans over 10,000 entries are not verified and point to `scripts/verify-audit.ts`). `AuditEntry` uses the code's fields: `actor`, `key_prefix` (`hsk_` + 8). The `entity_type` filter uses the code's enum. | openapi; data-model §8; PRD US-08 AC5 and FR-12; TRD T-A06; 05 SEC-53; ui-and-dx §2 |
| 28 Idempotency-Key | Required on every admin write: proposal create, approve, reject, withdraw; watched-notification create, triage, resolve; product purge. A missing key is 400 `idempotency-key-required` (new `AdminBadRequest` response). A replay returns `Idempotent-Replayed: true`. | openapi; data-model §4.3; TRD §13; 07 §3 and §8; 05 checklist item 9; ui-and-dx registry; 03 §10 |
| 29 Peppers and notifier | `HSN_KEY_PEPPERS` (`id:secret`, newest first; a key verifies with its `pepper_id`; the old single pepper becomes `default:<secret>`; not together with `HSN_KEY_PEPPER`). The out-of-band notifier moves to the PRD "Later" roadmap. v1 writes the audit entry plus log lines; an approved grant logs `admin.grant_approved` at warn level with `alert: true`. Removed `HSN_ADMIN_NOTIFY_HOSTS`, `adapters/notifier.ts` and every "notified out of band" claim. | TRD §8, §9, §14; 05 SEC-12, §0, SEC-43, SEC-96; 03 §1, §8; PRD risks and roadmap; architecture §1, §2.4, §3; 07 §9 and §12; openapi `AdminGrant`; DDL comment on `admin_actors.contact` |
| 30 Product cache and metrics | `HSN_PRODUCT_CACHE_MAX_ROWS` evicts the oldest `fetched_at` first (default **50,000**, as in the code; the docs said 100,000 with LRU). The DDL drops `products.last_hit_at` and adds index `products_fetched`. `/metrics` is served only on the admin listener; `HSN_METRICS_HOST` and `HSN_METRICS_PORT` are dropped. The metric list now matches the code's `hsn_*` series. `HSN_WATCHER_HOSTS` is documented as the watcher's own list. | TRD §8, §14, §16, T-S10; 05 SEC-38, SEC-100; 07 §9; architecture §1, §4; data-model §5 |
| 31 Script names | npm scripts: `dev`, `build`, `start`, `typecheck`, `test`, `seed`, `create-key`, `bootstrap-admins`, `export-audit-head`, `verify-audit`, `rotate-feed-epoch`, `watch-cbic`. Key commands use `create-key.ts --tenant … --scopes … [--actor … --grant rp_…]` and `--revoke key_… --by …`. A restore is: replace the DB file, then `rotate-feed-epoch.ts --by … --note "…"`. There is no `keys.ts` and no `restore.ts`. | TRD §1, §2, §9, §12, §16, T-F07; 05 SEC-17, SEC-81; 07 §2, §12; 03 §1, §9; architecture §3, §4; data-model §4.1, §4.5; DDL comment on `feed_epoch` |
| 32 Tax response | The line now has: `line_id`, `hsn`, `supply_type`, `taxable_value`, `ambiguous`, `rule_id`, `rule_selected_by`, `default_rule_id`, `unverified_accepted`, `igst_rate_bp`, `igst_rate_percent`, `tax` (rupees), `tax_paise` (integers, same keys), `effective_from` / `to`, `source`, `last_verified_at`, `verification_status`, `warning`, `candidate_rules`, `needs_input`, `notes`. The response now has `totals` and `totals_paise` (each with `taxable_value`), `invoice_rounding`, `round_off_paise` and `grand_total_paise`. The echoed `accept_unverified` and `quantity` were dropped, and the examples were rewritten to match the code's notes. `quantity` is a number or a string of at most 12 characters, > 0, ≤ 9,999,999, with at most 3 decimals. | openapi; TRD §6, T-T05; 07 §6; 03 §7.3 |
| 33 Seed | Seed rows are always `unverified`; `allowVerified` is for test fixtures only. FORMAT.md is left to the coordinator. | data-model §7; TRD §13 |

### Watcher and add_code (code-watcher-round2.md)

- **New routes:**
  - `GET` and `POST /v1/admin/watched-notifications`;
  - `POST …/{id}/triage` and `POST …/{id}/resolve`;
  - `GET /v1/admin/watcher/status`.
- **New schemas:** `WatchedNotification`, `WatchedNotificationCreate`, `WatcherRun`, `WatcherStatus`.
- **New problem:** 409 `duplicate-notification`, added in the openapi registry, ui-and-dx §1, 07 §3 and 03 §10.
- **Meta:** added `untriaged_notifications`. `sources_checked_at` is now defined as the `finished_at` of the last ok run. `pending_notifications` lists triaged rows only.
- **DDL:**
  - `watched_notifications` gains `source`, `notification_key` (unique partial index) and `title`;
  - state `no_change` becomes `dismissed`;
  - identity columns are frozen and triage is allowed only while `detected`;
  - new append-only `watcher_runs` table.
  - data-model §4.6 describes the flow and the code's schema-v3 migration (`src/db/migrations.ts`: new columns, `watcher_runs`, `hsn_codes.added_by_proposal`).
- **Env (TRD §8):** `HSN_WATCHER_ENABLED`, `_INTERVAL_MIN`, `_HOSTS` (the code's four defaults), `_CT_RATE_URL`, `_IT_RATE_URL`, `_USER_AGENT`, `_NOT_BEFORE` (2025-09-17).
- **Operation:**
  - TRD §13 gives the cron line, exit codes 0/1/2/3, the fail-closed reasons and the daily triage loop;
  - 05 SEC-82 has the runbook;
  - 07 §12 has the data-update process;
  - 03 §8 has the sequence.
- **Outbound:** `getText()` with each client's own `textContentTypes` allow-list (the watcher: `text/html` and `application/xhtml+xml`; OFF and OBF: none) and the charset rule. Watcher URLs are checked at boot. The watcher timeout is 3 s (was 10 s). See 05 SEC-32/33 and architecture §1 and §3.
- **add_code:**
  - `RefdataChange` is redefined to the code's `{table, op, …}` shapes;
  - `add_code` example and validation rules added; feed `hsn_added`;
  - the DDL `hsn_codes` insert guard requires an approved `add_code` (or an `hsn_description` update) naming that code;
  - documented in TRD §13 and 07 §12.
  - The stale `condition_hint` and `deactivate_row_id` were removed.
- **Known gaps stated:**
  - not yet run against the live CBIC pages;
  - the 256 KiB / 3 s limits;
  - no egress proxy;
  - the UTGST (Rate) and Compensation Cess (Rate) listings are not watched;
  - Indian public holidays are not modelled.
  - These are in TRD §13, 05 SEC-82, PRD risks and roadmap, 07 §12 and openapi `getWatcherStatus`.
- **Tests added to TRD §15:** T-W01–W03, T-A16 (`add_code`), T-A17 (idempotency and withdraw).

### Remaining code ↔ docs differences (for the coordinator)

1. **`watched_notifications` keys and dates:** the design DDL keys on `notification_no` and has `published_on`; the code uses a `wn_` id and `notification_date`. OpenAPI follows the code; the DDL keeps the design.
2. **HSN description updates:** the design DDL replaces the `hsn_codes` row (deactivate + insert); the code updates in place with `changed_by_proposal` and `hsn_code_history`.
3. **Audit columns:** the design DDL has `actor_kind`, `actor_id` and `key_id`; the code and API hash `actor` and `key_prefix`. data-model §8 notes this.
4. **Product purge:** the code returns 200 `{gtin, deleted}`; openapi still says 204. No ruling covers this.
5. **Proposal response:** the code returns `proposed_by` / `decided_by` (handles) and `payload`; openapi has `proposed_by_actor_id` / `decided_by_actor_id` with typed `rule` / `evidence` / `refdata` / `grant`. No ruling covers this.
6. **Tax line `source`:** the code returns `{notification, url}`; openapi `Source` also requires `schedule_serial` and `pdf_sha256` (null in examples).
7. **Audit `entity_type` filter:** the code's enum has no `product`, although purge writes `entity_type: product`.
8. **`HSN_METRICS_PORT`:** the code still parses it but does not use it. The docs say it is dropped.
9. **`GET /v1/admin/watched-notifications`:** returns open (`detected`) rows only. The docs say so.
10. **FORMAT.md:** must state that seed rows are always unverified (ruling 33). It was not edited here.

### Ruling 34 (applied after the first Round 3 pass)

Ruling 34 is recorded as item 34 at the end of `00c-coordinator-rulings-round2.md`. The docs now follow the code for remaining differences 1–6 and 9.

**`design/data-model.md` §2 is generated from the code.**
- It is `server/src/db/schema.sql` (base, version 2) followed by the `src/db/migrations.ts` steps (v3 watcher and `add_code`; v4 `pepper_id` and the products index), using `round2-tools/gen-ddl.cjs`.
- `round2-tools/test-ddl.cjs` replaces the old 135-test design suite. Run `node --no-warnings test-ddl.cjs docs/design/data-model.md /home/claude/hsn-api/server`. It checks that:
  - every block is byte-identical to the code;
  - `sqlite_master` matches the code-built schema;
  - **93 checks pass, 0 fail**, and `foreign_key_check` returns 0 rows.
- A one-character edit to the doc makes the identity checks fail, as intended.
- The old design DDL is kept for reference only as `round2-tools/0001_init.design-r3.sql`.

**data-model prose (§1, §3–§9) rewritten to the code:**
- `content_hash` with a placeholder filled once;
- `rule_json` / `payload_json` / `target_sha256` (a changed target gives 409 `rule-not-active`);
- `idem_key` / `request_sha256` with the TTL checked on read;
- `admin_actors.created_via`;
- `hsn_code_history` (in-place description updates);
- `audit_log.actor` / `key_prefix`;
- `watched_notifications` with the `wn_` id and `notification_date`;
- the export-audit-head fields.

There is no `rule_verifications` table and no generated `reverify_due_at` column: `reverify_due_at` is computed in `services/rates.ts`. TRD §3 / §3.1, 05 SEC-38 / SEC-52, architecture §2.4 and the readiness check, 03 §8 and 07 §8 were updated to match.

**openapi:**
- `DELETE /v1/admin/products/{gtin}` → 200 `{gtin, deleted}`.
- `RateProposal` uses the code's shape (`target_rule` summary, `rule`, `payload`, `proposed_by` / `decided_by`; no `*_actor_id`, `impacted_codes`, `evidence` / `refdata` / `grant`).
- The tax line `source` is `{notification, url}`.
- The audit `entity_type` filter includes `product`.
- Validator: 314 refs, 0 unresolved; **142 examples, 0 failures**.

**Recorded as done by core (items 7, 8, 10):**
- `product` in the audit filter;
- `HSN_METRICS_PORT` removed;
- FORMAT.md wording (seed rows always unverified, `allowVerified` test-only).

**Still open (no ruling covers these):**
1. **Proposal request bodies differ.** The code takes:
   - a top-level `source {pdf_sha256, schedule_serial}`;
   - `grant {handle, display_name, new_actor}`;
   - `rule.source {notification, url}`.

   openapi `RateProposalCreate` still has `evidence`, `AdminGrant` (`kind`, `actor_id`, `contact`, `expires_in_days`) and `SourceInput`.
2. **Target-changed status.** The code returns 409 `rule-not-active` for a supersede/verify/correct target that changed. openapi (approve) and TRD T-A11 say `proposal-stale`.
3. **`source_last_modified`.** It appears in the openapi classify `Product` and in TRD §5, but the code has no such column or field.

### Ruling 35 and final sweep

All three open differences above are closed by adopting the code (00c ruling 35):

- **Proposal bodies.** openapi `RateProposalCreate` now has top-level `source {pdf_sha256, schedule_serial}` (verify only) and `grant` = `AdminGrant {handle, display_name?, new_actor}`. `RateRuleInput.source` is `{notification, url, pdf_sha256, schedule_serial}`, and `cess` / `condition` are inline with the code's required sets. `retroactive_reason` is 1–2000. `evidence` and `SourceInput` are removed. The verify and adminGrant examples are updated. Prose is updated in 03-app-flow (admin_grant sequence).
- **409 `rule-not-active`.** Updated in: openapi createRateProposal (description and 409), approveRateProposal (description and 409 list), TRD T-A11, PRD US-A AC2, 03-app-flow (approve alt and the §8 table, now split into separate rule-not-active and proposal-stale rows), SEC-44, the architecture §2.4 sequence, and ui-and-dx §2.
- **`source_last_modified` / `data_source` removed.** Updated in: openapi `Product` (now gtin, gtin_valid, name, brand, category, source, fetched_at, optional hints) and two classify examples, TRD §5 flow and text, PRD AC2, 03-app-flow, and AI-17.
- **Also from the code.** `RateResolution.rule_selected_by` and `verification_status` (nullable), and `Condition.code` (nullable).

Checks run:
- `python3 -I round2-tools/validate_openapi.py docs/design/openapi.yaml` → 309 refs, 0 unresolved; 142 examples, 0 failures; 19 paths, 21 operations, 42 schemas.
- `python3 -I round2-tools/sweep.py /home/claude/hsn-api/server docs/design/openapi.yaml docs`:
  - 23 code routes vs 21 openapi operations; the 2 extra routes are intentional exclusions (`GET /metrics` admin listener, `OPTIONS /*` CORS preflight).
  - Problem codes: 31 in problem.ts = 31 in each of the openapi `Problem`, ui-and-dx §1 and 07 §3 registries, statuses equal. Every code thrown in src is registered, and every openapi example `type` exists in code.
  - Result: 0 docs-side gaps. One code-side gap: `method_not_allowed` (405) is registered but nothing raises it (Fastify sends an unknown method or path to the 404 `not-found` handler). The registries note this.

## Round 4 (docs sync to code rounds 4–7; validator-round2 R5, R7, R10, R12)

Inputs: `code-fix-core-round2.md` Rounds 4–7 and `code-fix-classify-round2.md` Rounds 4–6. The code was frozen for this pass at 33 test files and 727 tests, all passing. The schema is v7 and the classifier is `rules-fts-2.2`. The coordinator's brief named `rules-fts-2.1`; the docs follow the code (2.2), and say what 2.1 and 2.2 each changed.

### Sync (item 1)

**02-TRD**

| Section | Change |
|---|---|
| §1 | Script list, plus pointers to `server/README.md` and `.env.example`. |
| §3 | Migrations v5–v7; 117 DDL checks. |
| §3.1 | `citation_note`; `disable_actor` / `dataset_import` storage; the cross-check list (key policy and watched rows, round 7); restore detection. |
| §4 | Step 8: codes outside the master; warning `code_not_in_master`. |
| §5 | Exactness policy for 2.1 and 2.2. |
| §6 | Not-in-master lines; partial totals; round-off null when incomplete. |
| §7 | 150 examples; round 4–6 contract list. |
| §8 | `HSN_ADMIN_GRANT_TTL_HOURS`, `HSN_STATE_HWM_FILE` (required in production, outside the DB directory) and `HSN_ADMIN_KEY` added. Admin-host production rule added. The non-existent `HSN_CLASSIFY_TOKEN_COST` removed. Signing-key format corrected to base64 PKCS#8 DER. Source-host default corrected. |
| §9 | Grants: `not_self` and TTL. `disable_actor` / `last_actors` with the round-7 text. Residual-risk wording. |
| §12 | Automatic epoch rotation. |
| §13 | Two-admin rules for keyed rows and first triage; worker-isolated parser; `import-dataset` runbook. |
| §14 | New log events, audit actions and `/readyz` checks. |
| §15 | New test IDs T-R14, T-T12, T-A18–A24, T-S14–S15, T-W04, T-C14, T-E01. |
| §15.2 | Traceability table. |
| §16 | Restore runbook with `ack-restore` and the SA-C4-04 upgrade step. |

**Other documents**

| Document | Change |
|---|---|
| `design/openapi.yaml` | Built by `round2-tools/r4_oa.py` then `r6_oa.py`. Added: new actions, `proposer-disabled`, 405, `pending_action` with 202 (keyed rows and first triage), `code_in_master` / `resolved_via`, `partial_totals`, nullable totals, line and top-level tax `warnings`, `citation_note`, `verified_by` as a handle, nullable classify `message`, the stored-content `proposal-hash-mismatch`, `rules-fts-2.2`, and the `/readyz` checks. The hsn, classify and tax examples are replaced with live outputs. Valid: 314 refs, 150 examples, 0 failures. |
| `design/data-model.md` | Regenerated from code with `gen-ddl.cjs` (v7), with the prose for rounds 4–7 added. `test-ddl.cjs` updated for v7: 117 passed, 0 failed, FK 0. |
| `01-PRD` | AC3 (R3), AC2 (R13), NFR-10 status, SM-06. |
| `05` | Residual risk: cross-check and high-water mark, the "both DB and audit key" wording, SA-C4-03/04 accepted. SEC-53 (cross-check), SEC-79 (fixed), SEC-81 (restore runbook), SEC-82 (disable-actor, restore alert), SEC-18 (admin host), SEC-92 (SA-C2-09 accepted). |
| `06` | AI-07 (2.2), AI-40 status (495 items, LLM-draft labels, requirement not met), AI-42 (provisional in-master scope, strictly-older signed baseline, live numbers with the Wilson bound and the insufficient-sample flag), AI-45 (`excluded`). |
| `07` | Script list, classifier version, first production load, restore, upgrade step. |
| `architecture` | `coverage.ts` / `qualifiers.ts`, watcher isolation, migrations, scripts, integrity / restoreGuard, readiness, backups, exactness policy. |
| `ui-and-dx` | Quick start and display rules. |

The 405 row and the `proposer-disabled` row were done earlier in this round.

**Sweep** (`round2-tools/sweep.py`): 23 code routes against 21 operations. The two exclusions are intentional: `GET /metrics` and `OPTIONS /*`. 32 problem slugs appear in code, the openapi registry, ui-and-dx and 07. **0 gaps.**

### R5: live walkthroughs (item 2)

**Setup.** A fresh copy of `server/` (no `node_modules`, `dist`, db or `.env`) ran the README quick start verbatim. With the server up, two scripts captured responses:
- `live2.sh`: 33 public calls, covering every 03-app-flow walkthrough plus the errors;
- `admin.sh`: 20 admin calls.

**What 03-app-flow now shows.** Every example is the trimmed live response:
- 7113 with its `citation_note`, and the 304;
- 7199 → 200 via 71; 0012 → 404;
- meta and feed;
- classify: gold ring 7113 0.86 high; paracetamol 3004 **0.87 high** with an ambiguous rate (the old illustrative 0.72 medium was wrong for the shipped seed); dry fruits all low with a message; t-shirt 6109 medium; "Samsung Galaxy tablet" 3004 low;
- barcode: invalid GTIN 422; not_found with the GS1 hint; glucometer 9027 0.82 medium, which has no rate rule, while 9018 is at 5%;
- rates: 6109 ambiguous and its price boundaries; 3004 ambiguous with `default_rule_id`; 7102 descendant rules;
- tax: 7113 ring (102,750 paise each); the same line without `accept_unverified`; 998892 job work; the pharmacy invoice (IGST 6 / 57.5 / 22.5, total 86); partial totals; 61091000 not in the master with `warnings`;
- the §10 error rows.

**Admin walkthrough (§8).**
- 201 watched notification; 201 supersede.
- 403 self-approve; 409 bad hash; 200 approve (version `-2`).
- Feed 438/439.
- Resolve: **202** from amit, then 200 from priya (a keyed manual row, round 6).
- Verify of 3004: `verified_by` priya, `citation_note` null.
- 7113 on 2026-11-01 resolves to the new rule.
- `disable_actor`: 400 `last_actors` with the round-7 text.
- Grant: 201; `not_self` 400; 400 for a missing `Idempotency-Key`.
- Audit `chain_ok`; `verify-audit` exit 0.

**Restore drill.**
- `VACUUM INTO`, one more write, restore → `/readyz` 503 with `dataset.restore_detected` ("audit log head 14 < recorded 15") and a rotated epoch. `ack-restore`, restart → 200.
- Sidecar deleted → `dataset.hwm_missing`, 503. `ack-restore`, restart → 200.

**After the run.** The server was stopped (no `src/main.ts` process left). Captures are in the docs worker's scratchpad (`live4/`); the openapi examples were rebuilt from them.

### R7: docs/README.md (item 3)
- Rulings 1–35.
- 117 DDL checks, generated from v7 code.
- openapi counts.
- Server status: 33 files, 727 tests.
- Link to `server/README.md` and `.env.example`.
- Live-output note for 03.
- Status date 2026-10-11, with the unverified-data statement.

### R10: traceability (item 4)
02-TRD §15.2 maps every TRD test ID (T-U01 … T-E01) to `file › test name`. The mapping was made by grepping `server/test/**`.

**Not covered:**
- **T-A14.** `test/db/ddl.test.ts` does not exist; the 117 DDL checks run only through `round2-tools/test-ddl.cjs`.

**Partial:**

| ID | What is missing |
|---|---|
| T-U04 | No BigInt test above 2^53. |
| T-U06 | The dry fruits, T-shirt, mobile stand and category-only fusion rows are not asserted. |
| T-U10 | No direct "today in IST at 19:00Z" assertion. |
| T-T02 | IGST is not tested on the 7113 ₹68,500 case. |
| T-T11 | The 49 → 1 and 50 → 2 token-cost boundaries are not tested. |
| T-A07 | The look-alike source URLs (`.evil.example`, `@evil.example`, trailing dot, IDN, non-default port) are not each asserted. |
| T-S09 | A missing `HSN_LLM_DATA_DISCLOSURE_ACK` is not tested. |
| T-S12 | The cache-writer connection's write refusals are not tested. |

### R12: server README and .env.example (item 5)

**`server/README.md`:**
- prerequisites, then the 10-command quick start with what each command does;
- API overview and configuration, including the production-required table;
- production notes:
  - `import-dataset` runbook;
  - watcher cron line and exit codes;
  - `export-audit-head` / `verify-audit` and the cross-check coverage;
  - backups and restore with `ack-restore`, the missing sidecar and the upgrade step;
  - incident response;
  - residual risk;
- data status: all 70 rules unverified with a `citation_note`, `accept_unverified`, codes outside the master, the 3004 nil list, the classifier at 2.2, eval labels as LLM drafts (n = 16, lower bound 0.806, in-master scope), adapters off, the watcher untested live, and an honesty-fields table.

**`.env.example`:** every `EnvSchema` variable plus `HSN_ADMIN_KEY`, with safe placeholders, defaults, comments and secret generation. `HSN_STATE_HWM_FILE` is marked required in production, on a separate volume.

**Retest.** The quick-start block was extracted from the README and run verbatim in a clean copy on the frozen code. Results:
- `npm ci` OK; seed loaded 356 codes and 81 rules (70 active);
- 7113: 3%, unverified, with the `citation_note`;
- classify: 7113 0.86 high;
- tax: CGST and SGST 1027.5 each, complete.

`npm test` in the same copy: 33 files, 727 passed. `npm run eval`: all gates PASS, plus the INSUFFICIENT SAMPLE banner (n = 16, lower bound 0.8064).

### Code-side gaps (not fixed by docs)
- ~~The proposal `target_rule` DTO has no `citation_note`.~~ Fixed in core round 8.
- ~~No `test/db/ddl.test.ts` in CI (T-A14). The partial IDs above also need tests.~~ Fixed in core round 8 (`test/db/ddl.test.ts`, `test/trd-round8.test.ts`).
- Eval: labels are not human-reviewed (AI-40 not met). The high band has n = 16 against a minimum of 50. Top-3 passes only on the provisional in-master scope (0.942; all positives 0.858). Top-1 @8 is 0/11.
- `reviews/code-fix-classify-round2.md` Round 4 still says `labelled.jsonl`. This is historical; the file is now `classify-eval.jsonl`, and every doc under `docs/` uses the new name.
- Classify returns 3004 **high** for "Paracetamol 500 mg tablet" while its rate is ambiguous. This is consistent with the policy (the band is about the code, not the rate), but clients must still run the §5.2 question. 03 says so.

## Round 4 addendum: core round 8 and classify round 7

Folded in:
- **SEC-91 cache writer.** `openCacheDb` installs TEMP triggers so the connection can write only `products`, `idempotency_keys` and `api_keys.last_used_at`. Docs: 05 SEC-91, TRD §16.
- **Trailing-dot hosts.** Source URLs whose host ends in a dot are refused. Docs: TRD T-A07; openapi already said "no trailing dot".
- **`target_rule.citation_note`.** Added to the TRD §7 contract and to the openapi `RateProposal.target_rule` schema (`round2-tools/r8_oa.py`, run after `r4_oa.py` and `r6_oa.py`).
- **`rules-fts-2.3`.** The accessory/packaging qualifier (`classify/accessory.ts`) is documented in TRD §5, architecture §3 and §5.3, 06 AI-07, 07, 03, the openapi classify text and the server README. AI-42 now records the run against the signed `rules-fts-2.2` baseline; the metrics are unchanged.
- **Counts.** 36 test files and 875 tests, in docs/README and TRD.
- **TRD §15.2.** Every ID is covered. Checked by grepping the test names in `trd-round8.test.ts`, `db/ddl.test.ts` and `classify/round7.test.ts`.

Verified:
- **Quick start.** Ran verbatim in a fresh copy of the synced server tree and gave the same results as above.
  - An earlier run failed with 401 and then 429. The cause was another agent's server holding port 3000; the README was not at fault.
- **Live capture.** Re-captured; versus round 7 the only changes are the classifier version and the new `citation_note` on proposals.
- **Tests and eval.** `npm test`: 36 files, 875 passed. `npm run eval`: every gate PASS, with the INSUFFICIENT SAMPLE banner.
- **openapi.** 150 examples valid.
- **Sweep.** 0 gaps.

Process note: `server/README.md` was edited only in `/home/claude/hsn-api/server/`. The copy under `/mnt/project-files/hsn-api/server/` still says 2.2 until the next sync.

## Round 4 addendum 2: core round 9 and N2

Folded in:
- **Ruling 36.**
  - The verify `source` takes `url` / `notification`.
  - New problem type `source-url-not-document`.
  - Proposals that create rules must cite a document.
  - New env var `HSN_SOURCE_INDEX_PAGES`.
  - Migration v8 trigger and the citation cross-check.
  - Updated in: openapi (schema, the proposal text, a live `AdminBadRequest` example); TRD §3 verification, T-A07, T-A10 and the env table; 05 SEC-51; 07; ui-and-dx; data-model §1, §4.1, §4.2 and §9; 03 (§5.2 note, walkthrough steps 9a and 9b, step 2 now cites a view-pdf URL).
  - SEC-51 also had a stale trailing-dot sentence from before round 8 ("stripped"). It now says refused.
- **`errors[]` from `allErrors`.** At most 50 entries, with the new `detail` text. Updated in: openapi (`Problem.errors`, and the `BadRequest` example, now a live three-error capture); TRD T-T06; 07.
- **`needs_input` adds `condition`.** Updated in: the openapi enum and text, plus a live `ambiguousNoChoice` tax example (request and response); TRD T-T08; 07; 03; server README.
- **Unpadded `N/YYYY` notification references.** Updated in: openapi `Source.notification`; data-model §1 and §7; 07; new TRD ID T-A25.
- **Meta `known_data_gaps` and `coverage.codes_without_rules`; `HSN_KNOWN_GAPS_FILE`.**
  - Updated in: openapi (`DatasetMeta`, with the example replaced by trimmed live output); TRD T-F04 and the env table; data-model §7; 03; server README and `.env.example`.
  - While doing this I found that openapi `DatasetMeta` had drifted from the code. It listed `llm {configured, provider}` and full `Source` items, while the code returns `sha256`, `signature_alg`, `classifier {llm_configured, llm_provider, external_lookups}` and `{notification, url}` items. It now matches the code.
- **Traceability test.**
  - New TRD ID T-X02, and `HSN_TRD_PATH` added to the TRD env table. The test's actual default is the absolute `/mnt/project-files/hsn-api/docs/02-TRD.md`, not `docs/02-TRD.md`.
  - The §15.2 table cites the new tests. Counts are now 38 files and 895 tests.
- **N2.** 06 AI-42, TRD T-E01 and `server/test/eval/README.md` point to "Eval gate scope decision (AG-12 sign-off), 2026-10-11" in `00-coordinator-decisions.md`, as does the server README's data status. `docs/README.md` now lists ruling 36 and the two dated entries in 00.

Tools: `round2-tools/r9_oa.py` runs after r4, r6 and r8. `test-ddl.cjs` has six migration-8 checks, giving 124 checks in total; the new "accepted" check fails against the v7 schema, as expected.

Verified, on a fresh copy of the live server tree (`/home/claude/hsn-api/server`, round 9):
- **Quick start.** Ran verbatim except for `HSN_PORT=3200 HSN_ADMIN_PORT=3201`, the override that README step 7 documents, because another agent held port 3000.
- **Live re-capture.** `admin.sh` now cites a view-pdf URL in step 2. It also captures the ruling-36 path (400, then propose, approve, and GET), and `live2.sh` captures `needs_input` and the multi-error 400.
- **Tests.** `npx vitest run`: 38 files, 895 passed.
- **Traceability.** `HSN_TRD_PATH=docs/02-TRD.md`: 3 of 3 pass. A deliberately broken test name fails, as it should.
- **openapi.** 161 examples, 0 failures.
- **Sweep.** 0 gaps, after adding `source-url-not-document` to ui-and-dx §1 and 07 §3.
- **DDL.** 124 passed, FK 0.

Not done:
- The `/mnt/project-files/hsn-api/server` copy is still round 8. The server README, `.env.example` and eval README edits are in `/home/claude/hsn-api/server` only.
- `data/seed/known_gaps.json` currently has 19 items, not the 12 the code review mentions; the docs give no count.


## Round 4 addendum 3: core round 10 (N3 and SA-C5-01…06)

Folded in:
- **Canonical citation enforced at every entry point**, including the long-name normalisation.
  - openapi: `Source`, `RateRuleInput.source` and verify `notification`, plus a live `notificationPattern` example.
  - data-model §1 and §7; 05 SEC-51; 07; TRD T-A07, T-A10 and T-A25.
- **`rule_verified` summary uses the post-approval citation.** Updated in: the openapi `ChangeFeedItem.summary`, data-model §4.1 and TRD T-A10.
- **Meta `sources[].rule_count` and `verified_count`.** Updated in: openapi, where the live meta example was re-captured; TRD T-F04; and 03.
- **Structural guard and pre-validation token cost.**
  - openapi: tax description, `Problem.errors`, and the `BadRequest` examples (now three live ones: three errors, `maxItems`, 60 unknown keys).
  - 05 SEC-19 and SEC-24; ui-and-dx; 07; TRD T-T06 and T-T11.
- **Document-URL rules.** Updated in: the openapi URL descriptions, 05 SEC-51, 07, data-model §1, `.env.example` and TRD T-A07.
- **`HSN_KNOWN_GAPS_FILE` production rules.** Updated in: 05 SEC-92, data-model §7, the README config table, `.env.example`, and the new TRD ID T-S17.
- **Error echo caps.** Updated in: openapi `Problem.errors`, 05 SEC-75, 07, and the new TRD ID T-S16.
- **`HSN_TRD_PATH=skip`** (a missing TRD now fails the suite). Updated in: the TRD env table and T-X02, the README "Tests" line, and `.env.example` (a new tests-only section).
- **Counts:** 40 files and 922 tests, in TRD §15.2 and `docs/README.md`.

Tools: `round2-tools/r10_oa.py` runs after r9. The capture scripts add the `maxItems` 400, the unknown-keys 400, a free-text notification 400 and a feed read after the verifies.

Verified on a fresh copy of the live tree (round 10):
- **Quick start:** passed, with only the ports overridden as README step 7 documents.
- **Tests:** 40 files, 922 passed.
- **Traceability:** 4 of 4 pass against `docs/02-TRD.md`.
- **openapi:** 182 examples, 0 failures.
- **Sweep:** 0 gaps.
- **DDL:** 124 passed, FK 0. The DDL is unchanged in round 10; the data model was regenerated for its prose.

SA-C6 add-on:
- **SA-C6-02 (accepted citation forms).** Reviewers must cite `taxinformation.cbic.gov.in/view-pdf/<id>` or a single-slash `.pdf` link, because CBIC's double-slash `resources//htdocs-cbec/…pdf` links are refused. Documented in TRD T-A10, 05 SEC-51 and the 03 walkthrough (step 9b).
- **SA-C6-01 (shape guard limitation).** `schemaGuard` does not walk combinators. Recorded in 05 SEC-24 as a known limitation, with a rule for future routes: no array or closed object under `anyOf`/`oneOf`/`allOf`/`$ref` without extending the guard.
