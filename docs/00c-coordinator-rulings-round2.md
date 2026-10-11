# Coordinator rulings, round 2 (binding; from validator round 1 design bugs)

1. **Corrections:** new proposal action `correct` (maker–checker). It marks the target rule `status = voided` (kept forever for audit, excluded from resolution) and inserts the replacement rule in the same transaction. Change type `rule_corrected` carrying both rule ids. This replaces every other correction mechanism in the docs.
2. **Confidence must be able to reach every band honestly.** Weights are renormalised over the signals *applicable to the request* (barcode-category only when a barcode product was found). The 0.84 cap applies unless (a) a curated exact synonym hits the candidate, or (b) a barcode category maps to the candidate's heading AND FTS/chapter agree with it. Without a synonym or category, strong FTS + chapter agreement can reach medium (up to 0.84). Tests must demonstrate one realistic input reaching each of low, medium, high through each path. architecture.md §5.4 worked examples must be recomputed.
3. **Change feed invalidation:** each change carries `affected_prefix`. Clients invalidate a cached code when the code starts with the prefix OR the prefix starts with the code (both directions).
4. **ETag and "today":** ETag hashes the resolved as-of date (IST) plus dataset version plus body. `Cache-Control: max-age` never extends past the next IST midnight.
5. **3004 and nil-rated drugs:** 3004 resolves with the general 5% rule plus an `other`-condition 0% rule ("drugs on the nil-rate list"). Result: `ambiguous: true`, `default_rule_id` = the general rule, every rule with its condition text. `/v1/tax/calculate` needs `rule_id` (or `condition: "general"`) on an ambiguous line, otherwise `needs_input`. Same mechanism as price thresholds. A name match to a specific nil-rated drug synonym may select the 0% rule.
6. **Code lengths:** HSN/SAC codes of 2, 4, 5, 6 or 8 digits are valid (5 for SAC groups such as 99972).
7. **Quantity:** decimal with up to 3 places; informational in v1 (tax is on the line `taxable_value`); used only when specific cess is computed later.
8. **Idempotency:** DDL gets an `idempotency_keys` table (key, key_id, request_hash, response, created_at, 24 h TTL) for admin writes.
9. **Re-verification:** `reverify_due_at = last_verified_at + 12 months`; overdue rules return warning `verification_overdue`; meta reports overdue count.
10. **Pending changes signal:** `watched_notifications` rows in state `detected` (not yet published) are exposed in `/v1/meta/dataset` as `pending_notifications[]` and as a `pending_change_detected` warning on any rate response whose code matches an affected prefix.
11. **Meta:** `/v1/meta/dataset` returns `content_sha256` of the canonical dataset export.
12. **Proposals:** add `source_pdf_sha256` and `schedule_serial` (both required for publish/verify; nullable on the seed path).
13. **coverage** is a required field: `ok` | `no_rate_rule` | `ambiguous`.
14. **Rate-limit headers:** counted in tokens. `RateLimit-Limit: 600`, `RateLimit-Remaining` tokens, and `RateLimit-Cost` per request.
15. **UTGST:** `supply_type` = `intra` | `intra_ut` | `inter`; `intra_ut` returns CGST + UTGST instead of CGST + SGST.
16. Contradictions and unsourced material listed by the validator are fixed exactly as the validator's review file proposes, unless they conflict with rulings above. Every illustrative figure is labelled illustrative; citations use only URLs present in research/sources.md.

## Part B: security design rulings (from security-docs-round1.md)

17. **Actors (SA-D-01):** `admin_actors` table with unique normalised handles (NFKC, lowercase, `[a-z0-9_-]{3,32}`). Admin keys bind to `actor_id`; maker ≠ checker compares `actor_id`. Creating an admin actor or admin key after bootstrap needs approval by a different existing admin (proposal action `admin_grant`). Bootstrap: `scripts/bootstrap-admins.ts` creates the first two actors in one run and records it in the audit log. Residual risk documented plainly: anyone with host/DB access can bypass maker–checker; it protects against single-actor changes through the API, not against the host owner.
18. **Tamper evidence (SA-D-02):** audit entries are HMAC-chained with a dedicated `HSN_AUDIT_KEY` (separate from the key pepper). Approval entries include the full canonical rule content and its sha256. `scripts/export-audit-head.ts` writes the chain head + dataset sha256 to a file/stdout for off-host storage (operator copies it daily); `verify-audit` script checks a DB against an exported head.
19. **DB guards (SA-D-03):** every rate rule references `proposal_id` (approved) or `seed_batch_id`; insert trigger enforces it. `verified_by`, `superseded_by`, `effective_to` may each be set once from null only; proposals in a terminal state are immutable; dataset current pointer can only move forward.
20. **Approval binding (SA-D-04):** approve/reject require `expected_sha256` of the proposal content; approval fails if a superseded rule is no longer current; `source_pdf_sha256` required; no bulk approvals; key revocation takes effect immediately (no auth cache).
21. **Admin UI (SA-D-05):** no admin web UI in v1; admin is API/CLI only. Any future UI needs server sessions, CSRF tokens, strict CSP and text-only rendering of maker content; the key never lives in the browser. ui-and-dx marks the wireframe as future.
22. **External product data (SA-D-06):** overrides ruling 2(b). Candidates supported by external (OFF/OBF) data are capped at medium (`needs_review: true`) unless a curated synonym on the product name independently hits the same code. So `high` requires a curated synonym. Product cache TTL 7 days; cached external data stored with its source and fetch time.
23. **Reference data change control (SA-D-07):** synonyms, category_map, chapter_keywords and HSN descriptions change only through proposals (action `refdata_change`) with audit; rows are deactivated, never deleted/updated in place (triggers).
24. **Unverified rates gate (SA-D-08):** `/v1/tax/calculate` refuses lines whose rule is unverified unless the request sets `accept_unverified: true` (then each such line is flagged). Lookup and classify still return unverified rules with warnings. Production launch checklist requires the launch set verified.
25. **Mediums/lows:** apply the auditor's required changes, specifically: admin routes served only on `HSN_ADMIN_HOST`/`HSN_ADMIN_PORT` (default 127.0.0.1) separate from the public listener; admin key CHECK requires a non-null actor_id regardless of JSON spelling; retroactive effective dates (before today IST) require a `retroactive_reason` and emit a `retroactive` flag in the feed; feed carries `feed_epoch` that changes on restore so clients resync; tax/calculate token cost = 1 + floor(lines/50); outbound lookups have a per-key daily cap and a global queue limit; LLM calls have a budget config; brute-force block keyed on IP+key-prefix; full SSRF deny-list including NAT64, 6to4, Teredo, 198.18/15, 240/4, and the size cap applied after decompression (or no compression accepted); source_url host check by exact parsed hostname; product names in logs as HMAC with `HSN_LOG_KEY`; checklist gets the missing items and pass/fail wording. Lows as the auditor proposes.

## Part C: code ↔ docs reconciliation (from docs-fix-round2.md "Unresolved")

26. **Withdraw:** implement `POST /v1/admin/rate-proposals/{id}/withdraw` (proposer only, pending only; else `not-proposer` / conflict). Code changes.
27. **Audit verify param:** docs adopt the code's `verify=true|false`.
28. **Idempotency-Key:** required on all admin writes (code changes; 400 `idempotency-key-required` when missing).
29. **Pepper rotation:** implement `pepper_id` on keys with `HSN_KEY_PEPPERS` (id:secret list, newest first) so old keys verify during rotation. Out-of-band admin notifier is deferred to "Later" in the roadmap; v1 records audit + a warn-level log line; docs say so and drop `HSN_ADMIN_NOTIFY_HOSTS`.
30. **Env vars:** implement `HSN_PRODUCT_CACHE_MAX_ROWS` (oldest-first eviction) and a minimal Prometheus `/metrics` on the admin listener only (`HSN_METRICS_HOST` dropped; metrics share the admin host/port). `HSN_WATCHER_HOSTS` belongs to the watcher.
31. **Script names:** docs adopt the code's names.
32. **Tax response extras:** openapi adopts the code's fields (`tax_paise`, `rule_selected_by`, `warning`) and the code's quantity bounds.
33. **Seed:** seed rows are always unverified; the fixture-only `allowVerified` flag stays test-only; FORMAT.md says so.
34. **Remaining code ↔ docs differences (round 3):** the docs adopt the code's behaviour for:
    - watched-notification keys (`wn_` id, `notification_date`);
    - HSN description updates (in place, old text kept in `hsn_code_history`);
    - audit columns (`actor`, `key_prefix`);
    - the product purge response (200 `{gtin, deleted}`);
    - the proposal response fields (`proposed_by`, `decided_by`, `payload`);
    - the tax line `source` (`{notification, url}`).

    `design/data-model.md` §2 must mirror `server/src/db/schema.sql` plus `src/db/migrations.ts` exactly.

    Core adds `product` to the audit `entity_type` filter, drops `HSN_METRICS_PORT`, and fixes the FORMAT.md wording (seed rows are always unverified; `allowVerified` is test-only). The docs record these three as done.

35. **Docs adopt the code for the last three differences, then a final route/problem sweep.**
    - Proposal request bodies take the code's shape (`src/routes/admin.ts`): `rule.source` is `{notification, url, pdf_sha256, schedule_serial}` (all required; notification 3–300, url 8–2000); `verify` sends top-level `source {pdf_sha256, schedule_serial}` and nothing else of its own; `end_date` carries `end_date` only; `admin_grant` sends `grant {handle, display_name?, new_actor}` (`new_actor: true` creates the actor, `false` authorises a key for an existing one); `retroactive_reason` is 1–2000 characters; a field the action does not use is refused (400). There is no `evidence` field.
    - A supersede, end_date, verify or correct whose target is not active, already superseded, already end-dated, missing, or changed since the proposal (`target_sha256`) → 409 `rule-not-active` (at create and at approve). `proposal-stale` stays for "now retroactive without a reason", a changed reference row, and a granted actor created meanwhile.
    - The classify `product` is `{gtin, gtin_valid, name, brand, category, source, fetched_at, hints?}`: no `source_last_modified` and no `data_source`.
    - `RateResolution` documents nullable `rule_selected_by` (e.g. `rule_hint:nil_rate_list`) and `verification_status`; `Condition` documents nullable `code`.
    - `reviews/round2-tools/sweep.py` checks every route registered in `src/routes/*.ts` and `src/app.ts` against `openapi.yaml` both ways (`GET /metrics` and the CORS `OPTIONS /*` are intentional exclusions), and every problem code used in code against `src/lib/problem.ts` and the three docs registries. Docs-side: 0 gaps. Code-side: `method-not-allowed` (405) is registered but never raised (an unknown method gets 404 `not-found`); the docs registries say so.
