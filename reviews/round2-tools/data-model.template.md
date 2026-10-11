# HSN Rate API — Data model (SQLite, `node:sqlite`)

Binding inputs: `docs/00-coordinator-decisions.md`, `00b-coordinator-rulings.md`, `00c-coordinator-rulings-round2.md` (including Part C, rulings 26–34). Companion files: `openapi.yaml`, `architecture.md`.

**Source of truth (00c ruling 34).** The DDL in §2 mirrors the code exactly. It is generated from `server/src/db/schema.sql` (the base, schema version 2) and the steps in `server/src/db/migrations.ts` (versions 3 to 8), in that order. Do not edit §2 by hand: change the code, then regenerate it with `reviews/round2-tools/gen-ddl.cjs`. `reviews/round2-tools/test-ddl.cjs` checks three things (§9):
- each block is byte-identical to the code;
- running the blocks yields the same `sqlite_master` as the code;
- the triggers and constraints behave as described below.

## 1. Conventions

| Concern | Rule |
|---|---|
| Engine | SQLite via built-in `node:sqlite` (`DatabaseSync`), WAL, `foreign_keys=ON`, `trusted_schema=OFF`. Extension loading stays disabled. |
| Connections | Read-only for request handlers; a read-write connection for the cache writes (`products`, `api_keys.last_used_at`, `idempotency_keys`) and admin writes (proposals, approvals, scripts). Admin writes run in one `BEGIN IMMEDIATE` transaction each. |
| Schema versions | `schema_migrations(version, applied_at)`. An empty database runs `schema.sql` and then every migration step. An existing database runs only the steps it lacks. All of this happens in one transaction. The app refuses a schema newer than it knows. Current version: 8 (v5: bound guards and watcher confirmation, round 4; v6: `rate_rules.citation_note`, round 5; v7: the watcher confirmation guard extended to every row with a `notification_key` and to the first triage, round 6; v8: the first verify may replace an index-page citation, ruling 36, round 9). |
| Money | Integer **paise** (`*_paise`). The API takes INR as JSON numbers (or decimal strings where the route allows) and converts them from the decimal string, never with `x*100` float maths. Outputs carry rupee numbers plus integer paise (`tax_paise`, `totals_paise`). |
| Rates | Integer **basis points** (`*_bp`; 300 = 3%), checked 0–10000 in the DDL. Allowed slabs (`HSN_ALLOWED_RATES_BP`) are checked in code. CGST = SGST (or UTGST) = `roundHalfUp(taxable_paise × igst_rate_bp, 20000)`. |
| Dates | `effective_from` / `effective_to` are `TEXT 'YYYY-MM-DD'` IST civil dates, **both inclusive**; `effective_to IS NULL` = open-ended; `effective_from ≥ 2017-07-01`. |
| Timestamps | `TEXT` RFC 3339 UTC (`2026-10-03T09:15:02Z`). |
| IDs | Prefixed ULIDs: `rr_` rule, `rp_` proposal, `key_` API key, `act_` admin actor, `sb_` seed batch, `wn_` watched notification, `req_` request. Integer ids only for append-only logs (`change_feed.seq`, `audit_log.id`, `watcher_runs.id`, `hsn_code_history.id`) and reference-data rows. |
| HSN / SAC codes | Digits only, length **2, 4, 6 or 8**, or **5** in chapter `99` (SAC groups such as `99972`, ruling 6). `level = length(code)`, `chapter = substr(code,1,2)`, and every non-chapter code has a `parent`. Rule prefixes follow the same lengths and must exist in `hsn_codes`. |
| Notification citation | `notification_ref` canonical form `<n>/<yyyy>-<CT\|IT\|UTT\|Cess>(Rate)[, Schedule <roman>]`, e.g. `9/2025-CT(Rate), Schedule IV`, with **no zero padding** in `N/YYYY` and whitespace collapsed. **Enforced everywhere (core round 10):** after normalisation the value must match `^[1-9][0-9]{0,3}/(19\|20)[0-9]{2}-(CT\|IT\|UTT\|Cess)\(Rate\)(, Schedule (I\|II\|III\|IV\|V\|VI\|VII))?$`. `normaliseNotificationRef` strips zero padding, collapses whitespace and rewrites the long series names (`Central Tax (Rate)`, `Integrated Tax (Rate)`, `Union Territory Tax (Rate)`, `(Compensation) Cess (Rate)`, `CT (Rate)`) to the short form (`09/2025-Central Tax (Rate), Schedule I` → `9/2025-CT(Rate), Schedule I`). Entry points and failures: create/supersede/correct → 400 `validation-failed` at `/rule/source/notification` (code `pattern`); verify → 400 at `/source/notification`; the seed loader → `SeedError` naming `rate_rules[i].notification_ref`; `import-dataset propose`/`approve` (same `prepareSeed`) → exit 2. Content hashes change only for data loaded after round 9. The serial number inside the schedule is `schedule_serial`. The API field `source.notification` is `notification_ref`. `source_url` must be a notification document (path contains `/view-pdf/` or ends in `.pdf`, and is not a listing/index page) on every proposal that creates a rule (ruling 36); seed rules may still cite an index page until their first verify. A document URL (core round 10, SA-C5-03) has no query or fragment, no `;`, `..`, `//`, `%2e`, `%2f` or `%5c` in its path, and a path of `/view-pdf/<id>[/…]` or a `*.pdf` file; index pages are compared on origin plus lower-cased path with repeated slashes collapsed. Seed URLs are not re-checked. |
| Canonical JSON | RFC 8785 (JCS) for every hash or MAC input: proposal `content_sha256`, `target_sha256`, idempotency `request_sha256`, audit entries, the dataset `content_hash`. |
| Immutability | Enforced by triggers. Published rule content never changes. `effective_to`, `end_dated_in_version`, `superseded_by`, `verified_by`, `source_pdf_sha256` and `schedule_serial` are each set once from NULL. `last_verified_at` only moves forward, and verification only goes `unverified → verified`. A voided rule never changes again. `citation_note` is set only by the seed and can only be cleared, by a verify (migration 6). `source_url` and `notification_ref` never change, except in the one update that takes a rule from `unverified` to `verified` under an approved verify proposal whose `decided_at` equals the new `last_verified_at`; the new values must then equal that proposal's `payload.source.url` / `.notification`, or stay unchanged where the proposal left them out (migration 8, ruling 36). Proposal content is immutable and decisions are final. `dataset_versions` (after its hash is filled), `change_feed`, `audit_log`, `seed_batches`, `hsn_code_history` and `watcher_runs` are append-only. The dataset pointer only moves forward. Reference rows are deactivated, never deleted. HSN descriptions change in place, with the old text kept in `hsn_code_history`. |
| Provenance | Every rule references an approved proposal that names it (`proposal_id` = the proposal's `resulting_rule_id`, `created_in_version` = its `resulting_version`), or the seed batch of the empty-database publish (`seed_batch_id`). Reference rows and new HSN codes reference an approved `refdata_change` (`added_by_proposal`) unless written by the seed (ruling 19). |

**Residual risk (ruling 17, SEC-53; round 4 wording).** The triggers, including the migration 5 guards that bind every rule, version-pointer, code and reference-row change to the approved proposal that makes exactly that change, stop writes through the application and through a careless SQL client. Anyone with host or DB-file access can still drop them, forge rows or replace the file. Two controls detect what they cannot prevent:
- **State-to-audit cross-check** (`services/integrity.ts`, round 4 SA-C2-02, extended in round 6 SA-C3-01/02/07). At boot, in `verify-audit` and in `import-dataset`, every dataset version, proposal, rule change, API key and admin actor must have a matching HMAC'd audit entry. Since round 6 it also recomputes every proposal's `content_sha256` from its stored content, requires the stored rule and payload to equal those in the `rate_proposal.created` entry (and, for approvals, the published rule snapshot to equal it), compares revocations, key expiry, actor disablement and each proposal's status with the latest audited decision, and checks every seed rule's `citation_note` against the `citation_notes` map in `dataset.seeded` (a cleared note needs an audited verification; seeds from before round 6 are reported as `legacy`). Since round 7 (SA-C4-01/02) it also compares each key's `tenant`, `llm_opt_out`, `rate_limit_per_min` and `daily_quota` with its `api_key.created` entry (keys from before round 7 on `tenant` only), and each watched notification with its history: a `detected` entry, `affected_prefixes` equal as a set to the last detected/triaged entry, the resolve entry (with `requested_by`/`confirmed_by` on keyed rows) for a closed row, and no resolve entry for a row still `detected`. Since round 9 (ruling 36) a rule's `source_url` / `notification_ref` must equal the citation in its latest verify approval's audit snapshot (or its seed / creation snapshot when never verified). A database writer **without** `HSN_AUDIT_KEY` is detected: `/readyz` returns 503 (`audit_integrity`) and `verify-audit` exits 3.
- **Restore detection** (`services/restoreGuard.ts`, SA-C2-06, SA-C3-04). A sidecar high-water mark, MAC'd with `HSN_AUDIT_KEY` and kept on a different volume and backup set, detects a database that is behind it, and a sidecar that went missing (§4.5).

Someone who holds **both** the database and `HSN_AUDIT_KEY` can still forge matching audit entries and a matching sidecar. That is the documented residual risk. Mitigations: keep the audit key off the DB host's backups and volumes, and anchor the chain head off-host daily (`export-audit-head`, `verify-audit --head`, §8). Versions approved before migration 5 have no audited content hash; they are checked by name only (`legacy`, warn log `audit.legacy_state`) until the next publish.

## 2. DDL

Generated from the code (ruling 34). Blocks run in order: the base, then each migration.

@@DDL@@

### 2.6 Illustrative rows (shape only)

Seed rows are written by `npm run seed` inside one transaction while the database is empty (§4.4). Rates come from `research/sources.md` and are `unverified`.

```text
synonyms        (phrase 'gold ring', hsn_code '7113', strength 'primary', created_by 'seed', active 1, added_by_proposal NULL)
chapter_keywords(keyword 'gold', chapter '71')          category_map(source 'open_food_facts', category 'en:biscuits', hsn_prefix '1905')
Price-threshold pair (apparel, chapter 61; inclusive bounds in paise):
  rr_…A1  hsn_prefix '61', 500 bp,  condition_kind 'price', max_unit_price_paise 250000
  rr_…A2  hsn_prefix '61', 1800 bp, condition_kind 'price', min_unit_price_paise 250001
General rule plus a nil-rated condition (3004, ruling 5):
  rr_…B5  hsn_prefix '3004', 500 bp, condition_kind 'none'                      ← default_rule_id
  rr_…B6  hsn_prefix '3004', 0 bp,   condition_kind 'other', condition_code 'nil_rate_list',
          condition_text 'Drugs on the nil-rate list of 10/2025-CT(Rate)'
A curated synonym for a named nil-rated drug carries rule_hint 'nil_rate_list'.
```

## 3. Rate-resolution algorithm

Implemented once in `services/rates.ts` and used by `GET /v1/hsn/{code}`, `POST /v1/classify` (per candidate) and `POST /v1/tax/calculate` (per line). It is a pure function over rows fetched by the repository; no AI or heuristics.

**Input:** `code` (2, 4, 5, 6 or 8 digits), `date` D (default today IST), optional `unit_price` P (paise).

1. **Gather.** Fetch **active** rules (`status = 'active'`; voided rules never return) in force on D (`effective_from <= D AND (effective_to IS NULL OR effective_to >= D)`) whose prefix is related to `code`:
   - **ancestor-or-self:** `code LIKE hsn_prefix || '%'`;
   - **descendant:** `hsn_prefix LIKE code || '%' AND length(hsn_prefix) > length(code)`.
2. **Longest prefix.** Among the ancestor-or-self rules, keep those with the maximum `length(hsn_prefix)`. Call this set R.
3. **Descendant check.** If descendant rules exist and any has a different `(igst_rate_bp, cess_rate_bp, cess_specific_paise)` from R (or R is empty), the result is:
   - `ambiguous = true`, `coverage = 'ambiguous'`, `default_rule_id = null`;
   - the reason "Rate differs at a more specific code …";
   - `rules = R ∪ descendants`. Stop.
4. **Price filter.** If P is given, drop `price` rules whose inclusive bounds exclude P (NULL = unbounded).
5. **Decide.**
   - |R| = 0 → `coverage = 'no_rate_rule'`, no rate. A rate is never invented.
   - |R| = 1 → that rule, `coverage = 'ok'`.
   - |R| > 1 with identical `(igst_rate_bp, cess_rate_bp, cess_specific_paise)` → the one with the latest `last_verified_at` (NULL last; tie: smallest `rule_id`), `coverage = 'ok'`.
   - Otherwise → `ambiguous`, with one of these:
     - **General plus conditions (ruling 5):** exactly one `none` rule, at least one `other` rule and no `price` rule. `default_rule_id` is the `none` rule.
     - **Price:** every rule is `price` and P is absent. Reason "pass unit_price".
     - **Other conditions only** (e.g. paneer vs cheese). A human must choose.
6. **Warnings** (open enum):
   - `rate_unverified`;
   - `verification_overdue`: verified but `reverify_due_at < now`. `reverify_due_at = last_verified_at + 12 calendar months` is computed in `services/rates.ts`; it is not a column.
   - `pending_change_detected`: a `watched_notifications` row in state `detected` with a non-empty `affected_prefixes` containing `p`, where `code.startsWith(p) || p.startsWith(code)`. Untriaged rows (empty prefixes) never warn.
   - `selected_by_hint` (classify only);
   - `no_rate_rule` and `ambiguous`.
7. **Data-integrity guard.** Two overlapping active rules is a data error. The approval path rejects it (409 `overlapping-rule`); the resolver logs `rate_rule_overlap` and returns ambiguous rather than picking one.

**Overlap rule** (checked at proposal creation and again inside the approval transaction). Two active rules with the same `hsn_prefix` and overlapping date ranges conflict when:
- both are `none`;
- one is `none` and the other `price`;
- both are `price` with overlapping price ranges;
- both are `other` with the same `condition_text`.

**Classify-only hint (ruling 5).** A curated exact synonym hit on the caller's own `name` may carry `rule_hint` (a `condition_code`). If the resolution is ambiguous and exactly one candidate rule has that `condition_code`, it is chosen with the warning `selected_by_hint`. Lookups and tax never apply hints.

**Tax lines.** An ambiguous line is computed only with `rule_id` (one of the candidates, else 422 `rule-choice-invalid`) or `condition: "general"` (→ `default_rule_id`). The line's `rule_selected_by` records how. An unverified rule is computed only with `accept_unverified: true` (ruling 24).

**Historical queries.** Rules are end-dated or voided, never edited. So `?date=2025-09-01` for `3004` returns the fixture's 12% rule and today returns the 5% general rule. To reproduce an old answer exactly, clients store `rule_id` plus `dataset_version`.

## 4. Write paths

### 4.1 Approval (`services/proposals.ts`, one `BEGIN IMMEDIATE` transaction)

1. **Idempotency.** `runIdempotent`: same `(key_id, idem_key)` and same `request_sha256` within 24 h → the stored response (`Idempotent-Replayed: true`); different hash → 409 `idempotency-conflict`.
2. **Checks.**
   - The proposal exists (else 404 `proposal-not-found`).
   - The approver's actor differs from `proposed_by_actor_id` (else 403 `maker-checker-violation`; the DDL CHECK repeats it).
   - The proposer's actor is not disabled (else 409 `proposer-disabled`; the v5 decide guard repeats it, and also requires an active checker key).
   - A `dataset_import` is refused here with 409 `proposal-stale`: only `scripts/import-dataset.ts` approves it, because only the host can re-hash the seed files.
   - `status = 'pending'` (else 409 `proposal-not-pending`).
   - `expected_sha256 = content_sha256` (else 409 `proposal-hash-mismatch`).
   - For actions with a target: `sha256(JCS(target row)) = target_sha256` (else 409 `rule-not-active`: the target changed).
   - The overlap check against published rules.
   - A change that now takes effect before today (IST) without `retroactive_reason` → 409 `proposal-stale`.
3. **Begin publish** (not for `admin_grant` or `disable_actor`). Insert `dataset_versions` with the next `YYYY.MM.DD-n`, `parent_version` = current and the placeholder `content_hash` of 64 zeros.
4. **Decide first.** Update the proposal to `approved` with `decided_by`, `decided_by_actor_id`, `decided_key_id`, `decided_at`, `resulting_rule_id` and `resulting_version`. The insert triggers then accept rows that name this proposal.
5. **Apply.**
   - `create` / `supersede` / `correct`: insert the new rule as `verified` (`verified_by` = checker handle, `last_verified_at` = now, `proposal_id`).
   - `supersede`: end-date the target to the new `effective_from − 1 day` with `superseded_by`. `end_date` uses the proposal's `end_date`. Feed `rule_end_dated`.
   - `correct` (ruling 1): void the target (`status='voided'`, `voided_at`, `voided_in_version`, `voided_by_rule`; same prefix enforced). Feed `rule_corrected` (`rule_id` = replacement, `related_rule_id` = voided rule).
   - `verify` (its `rule_verified` feed summary names the citation as it stands after the approval, core round 10): `markVerified` sets `verified_by`, `last_verified_at`, `source_pdf_sha256` and `schedule_serial` (set once; a re-verification moves only `last_verified_at` forward). On the first verify, one statement also sets `source_url` / `notification_ref` from the proposal's `source.url` / `source.notification` when given, and `citation_note = NULL` (ruling 36; migration 8 allows exactly this). Feed `rule_verified`.
   - `refdata_change`:
     - `synonym` / `category_map` / `chapter_keyword` `add` inserts with `added_by_proposal`; `deactivate` sets `active=0` and `deactivated_by_proposal` (feed `synonym_changed` / `refdata_changed`);
     - `hsn_description` `update` changes `description` / `keywords` in place with `changed_by_proposal`; the trigger copies the old text to `hsn_code_history` (feed `hsn_updated`);
     - `hsn_code` `add_code` inserts the code with `added_by_proposal`; the trigger requires the approved proposal's payload `code` to equal the new code (feed `hsn_added`).
   - `disable_actor` (round 4, stored as an `admin_grant` row with `payload.op = "disable_actor"`; refused with `last_actors` when fewer than two active admins would remain): `disableActorInTx` sets `disabled_at` (the actor's keys get 401 at once), withdraws its pending proposals (each audited `rate_proposal.withdrawn`), audits `admin.disabled` and logs `admin.actor_disabled` (warn, `alert: true`). `scripts/disable-actor.ts` does the same on the host.
   - `admin_grant`: insert `admin_actors` (`created_via='admin_grant'`, `grant_proposal_id`) when `new_actor`; audit `admin.granted`; after commit, a warn log `admin.grant_approved` with `alert: true` (no out-of-band notifier in v1, ruling 29). The key is then minted with `scripts/create-key.ts … --grant rp_…` within `HSN_ADMIN_GRANT_TTL_HOURS` (default 72; the v5 trigger caps it at 72 h after `decided_at`); `api_keys.admin_grant_id` is UNIQUE and the trigger requires the approved grant for that actor's handle. A grant for an extra key (`new_actor: false`) must be proposed by that actor itself (400 `not_self`; the v5 insert guard repeats it).
6. **Overlap re-check** of the new rule against every rule on the prefix, then feed `rule_added` (or `rule_corrected`). Every feed row carries `affected_prefix` and `retroactive`.
7. **Finish publish.** Fill `rule_count` and `content_hash` (sha256 of the canonical export) and the optional Ed25519 `signature`. The trigger allows this once, from the placeholder. Then move `dataset_state` forward (`current_version`, `last_change_seq`).
8. **Audit.** Append `rate_proposal.approved` (HMAC chain, §8) with the canonical rule row, its `rule_sha256`, the proposal `content_sha256`, the payload and (since round 4) `dataset_content_hash`, which the state-to-audit cross-check compares with the version row.
9. **COMMIT.** Any failure rolls everything back. (Step 1 also recomputes `content_sha256` from the stored proposal content and refuses with 409 `proposal_hash_mismatch` when it differs, round 6 SA-C3-01; reject does the same.) After commit the restore-detection high-water mark moves forward.

Approve and reject are one proposal per call (ruling 20). Withdraw (ruling 26) is proposer-only and pending-only, with `{reason}`. Revoking an admin key or disabling an actor withdraws that actor's pending proposals.

### 4.2 Proposal creation

The code checks:
- zod and JSON-schema validation;
- the slab list and the exact source host;
- the dates;
- `rule.source` `{notification, url, pdf_sha256, schedule_serial}` for create / supersede / correct (the `url` must be a notification document, never an index page: ruling 36), and `source {pdf_sha256, schedule_serial, url?, notification?}` for verify. `url` / `notification` are allowed only while the rule is unverified (else 400 at `/source`, `forbidden`); `url` is required when the rule cites an index page (400 `source-url-not-document`). The index-page set is the CBIC rate listing pages, the watcher pages and `HSN_SOURCE_INDEX_PAGES`;
- `admin_grant` (`not_self` for `new_actor: false`) and `disable_actor` (`last_actors`: at least two active admins must remain);
- the `refdata` rules (for `add_code`: length, not existing, chapter exists, nearest existing ancestor as `parent`, 4-digit heading for 6/8-digit codes, type matches the chapter, no duplicate pending proposal);
- the overlap pre-check;
- retroactivity (`retroactive_reason` required).

It then computes `content_sha256 = sha256(JCS(content))` and the target's `target_sha256`, inserts the proposal as `pending` (`rule_json` or `payload_json` per the action CHECKs), and audits `rate_proposal.created`. The v5 insert guard requires a new proposal to be pending and undecided, made with the proposer's own active admin key.

### 4.3 Idempotency (rulings 8 and 28)

Every admin write requires an `Idempotency-Key` UUID; a missing header is 400 `idempotency-key-required`. The writes are:
- proposal create, approve, reject and withdraw;
- watched-notification create, triage and resolve;
- product purge.

The row `idempotency_keys(key_id, idem_key, route, request_sha256, status_code, response_json, created_at)` is written in the same transaction as the write. The 24 h TTL is applied on read (`created_at` older than 24 h is ignored), and expired rows are purged (index `idempotency_keys_created`).

### 4.4 Seed (once, into an empty database)

`npm run seed` (`src/db/seed.ts`) refuses in production and when `dataset_state` exists; the `seed_batches` trigger also refuses once a dataset is published. In one transaction it writes:
1. the seed dataset version (placeholder hash);
2. `seed_batches` (`files_json` with the sha256 of each seed file);
3. `hsn_codes`;
4. `rate_rules` with `seed_batch_id`;
5. `synonyms`, `category_map` and `chapter_keywords` (`added_by_proposal` NULL);
6. the filled `content_hash`, then `dataset_state` with a random `feed_epoch`;
7. the audit entry `dataset.seeded` (actor `seed`).

Seed rules are always `unverified` (ruling 33) and may carry a `citation_note` (round 5). The loader's `allowVerified` option is for test fixtures only, and the DDL does not check this. After the seed, the insert triggers refuse every seed-path row.

**Production first load (round 5, R11): `npm run import-dataset`.** `npm run seed` stays refused in production. Instead, after `bootstrap-admins`, the load is a maker–checker proposal of kind `dataset_import` (stored as `refdata_change` with `payload = {op: "dataset_import", files: {name: sha256}, counts}`):
1. Maker: `HSN_ADMIN_KEY=<A's key> npm run import-dataset -- propose --dir data/seed --rationale "…"`. It validates the directory with the seed's checks (fail closed; every rule unverified), records each file's sha256 and the row counts, and prints `proposal_id` and `content_sha256`. Refused when a dataset exists or another import is pending.
2. Checker (a different actor): `HSN_ADMIN_KEY=<B's key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed`. Refused if B is the maker, the hash is wrong, the proposer is disabled, or any file's sha256 or row count differs. Otherwise one transaction publishes the first version through the seed path, marks the proposal approved with that version, and writes `dataset.seeded` (actor = checker, `proposal_id`) and `rate_proposal.approved`. It then runs the state-to-audit cross-check.
3. Exit codes: 0 ok; 1 refused; 2 seed validation failed; 3 imported but the cross-check reported problems. The key is read from `HSN_ADMIN_KEY` and checked as the API checks it; never pass it on the command line.

### 4.5 Admin bootstrap and restore

`scripts/bootstrap-admins.ts --admin amit:"…" --admin priya:"…"` creates the first two actors (`created_via='bootstrap'`) and one admin key each. It audits `admin.bootstrapped` and prints the keys once. The triggers refuse a third bootstrap actor and a second key for a bootstrap actor without an `admin_grant`.

**Restore (ruling 31; round 4, SA-C2-06; round 6, SA-C3-04).** The server keeps a high-water mark in `HSN_STATE_HWM_FILE`, MAC'd with `HSN_AUDIT_KEY`. In production the variable is required and its directory must not be the database's directory (put it on a different volume and backup set; a backup that restores both together defeats detection); the development default is `<HSN_DB_PATH>.hwm.json`. It records the audit head id and hash, `last_change_seq` and `feed_epoch`. It moves forward after each audited admin write and every 60 s. At boot a restore is detected when the audit head id is lower than recorded, the recorded head entry's hash differs, or the sequence is lower within the same epoch. Then:
1. the feed epoch is rotated (clients resync), `dataset.restore_detected` is audited and `dataset.restore_detected` is logged (error, `alert: true`);
2. `/readyz` returns 503 (`state_continuity`) until an operator runs `npm run ack-restore -- --by <actor> --note "<≥ 10 chars>"` (audited `dataset.restore_acknowledged`; it rewrites the sidecar) and restarts the server.

The first creation of a sidecar is audited `dataset.hwm_initialised`. A **missing** sidecar for a database whose log has that entry (or a `dataset.restore_acknowledged`) is treated as a possible restore: error log `dataset.hwm_missing` (`alert: true`), epoch rotated, `dataset.restore_detected` audited, 503 until `ack-restore`. Only a database that never had a sidecar initialises one silently. Accepted residual (SA-C4-04): a backup taken before the first boot of round-6 code, restored with the sidecar deleted, also initialises silently; so after upgrading, boot once (writing `dataset.hwm_initialised`) and export a fresh audit head off-host, and treat older backups as needing `verify-audit --head` against an export before use. A sidecar whose MAC fails gives `dataset.hwm_invalid` and 503. `HSN_STATE_HWM_FILE=off` disables detection and is refused in production. So the runbook is: restore the backup → the server detects it and fails readiness → `ack-restore` → restart. `scripts/rotate-feed-epoch.ts` stays for a manual epoch change. The quick-start drill in `reviews/docs-fix-round2.md` Round 4 ran this sequence on a live server.

**Disabling an actor.** `disable_actor` proposals (§4.1) or, on the host, `npm run disable-actor -- --handle <h> --by <who> --note "…"`. Both refuse when fewer than two active admins would remain (round 6, SA-C3-05): grant a third admin first, or revoke only the leaked key with `create-key --revoke <key_id> --by <who>`.

### 4.6 CBIC watcher (migration 3)

`npm run watch-cbic` runs from cron, or in-process with `HSN_WATCHER_ENABLED=true`. Each run is one append-only `watcher_runs` row:
- `source 'cbic'`;
- `status 'ok'|'failed'`, where `error` is set exactly when the run failed;
- `items_seen`, `items_new`, `details_json`.

New items become `watched_notifications` rows:
- `id wn_…`, `source 'cbic_watcher'`, `state 'detected'`, `affected_prefixes '[]'`;
- `notification_key`, e.g. `central_tax_rate:1/2026`; a corrigendum adds `:corrigendum:<date>`; unique when set;
- `title` and `notification_date`;
- audit `watched_notification.detected`, actor `system:cbic-watcher`.

Manual entries (`source 'manual'`) compute the same key, so a duplicate is 409 `duplicate-notification`. The update trigger allows two changes:
- `affected_prefixes` / `effective_from` while the row is `detected` (triage);
- `detected → published | dismissed` with `resolved_at` / `resolved_by`.

All other columns are frozen, and a resolved row never changes. The watcher never writes rates.

**Two admins for silencing a keyed row (migration 5, round 4 SA-C2-03; migration 7, round 6 SA-C3-03).** On every row that carries a `notification_key` (each `cbic_watcher` row and each manual row whose notification parses to a key), resolving it, setting its first prefixes (first triage) or removing prefixes is stored first in `pending_action` (`{kind, affected_prefixes?, effective_from?, by, by_actor_id, at}`; audited `watched_notification.confirmation_requested`; the API returns 202). A different admin repeating the request applies it (audited with `requested_by` and `confirmed_by`; warn log `watcher.row_silenced`). The `watched_notifications_guard_confirm` trigger (replaced in v7) refuses a direct resolve, first triage or prefix removal without a matching `pending_action`. Later additions of prefixes, and manual rows without a key, stay single-admin. The parser is linear with per-row caps, runs in a worker thread (64 MB heap, 2 s, fail closed as `shape_changed`) and skips hidden rows and elements, counting them (`PageOutcome.hidden`, warn log `watcher.hidden_rows`).

### 4.7 Key peppers (migration 4)

`api_keys.pepper_id` (default `default`, `[a-z0-9_-]{1,32}`) records which pepper of `HSN_KEY_PEPPERS` hashed the key (ruling 29). It is immutable; to change it, re-issue the key.

## 5. Size and retention

About 22k HSN plus 700 SAC rows and a few thousand rules: well under 50 MB. These are kept indefinitely (small):
- `change_feed`, `audit_log`, `hsn_code_history` and `watcher_runs`;
- proposals and voided rules.

**Products.** `products` rows expire per `expires_at` (found 7 days, not found 1 day). The table is capped at `HSN_PRODUCT_CACHE_MAX_ROWS` (default 50,000), and eviction deletes the oldest `fetched_at` first (ruling 30; index `products_fetched_at`). An admin can purge one GTIN:
- the request is `DELETE /v1/admin/products/{gtin}`;
- it returns 200 `{gtin, deleted: true}`;
- it is audited `product.purged` (entity_type `product`) with the old row's `source`, `found` and `fetched_at`.

Adapter errors are never written to `products`. They go to an in-memory error cache and surface as `product.source = lookup_failed`.

## 6. Postgres mapping (later)

| SQLite | Postgres |
|---|---|
| `TEXT` dates | `date`, `timestamptz` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint generated always as identity` |
| FTS5 `hsn_fts` + `bm25()` | `tsvector` generated column + GIN + `ts_rank_cd`; `pg_trgm` for typos |
| `json_valid` CHECK / `TEXT` JSON, `json_extract` in triggers | `jsonb`, `->>` |
| `RAISE(ABORT)` triggers | plpgsql `BEFORE` triggers with the same conditions, plus `REVOKE UPDATE, DELETE` on append-only tables |
| Partial unique indexes | Same |
| `DEFERRABLE INITIALLY DEFERRED` FKs | Same |
| `BEGIN IMMEDIATE` | `SERIALIZABLE`, or `SELECT … FOR UPDATE` on `dataset_state` |
| `GLOB` checks | `~ '^[0-9]+$'` |

## 7. Seed file format

The format is the shared `server/data/seed/FORMAT.md`. It states that seed rows are always `unverified` and that `allowVerified` is test-only (ruling 33; FORMAT.md is maintained by core).
- **Files:** `hsn_codes.json`, `rate_rules.json`, `synonyms.json`, `category_map.json`, `chapter_keywords.json`, validated row by row. Any invalid row aborts the seed.
- **`hsn_codes`:** lengths 2, 4, 5 (chapter 99 only), 6 and 8. Every non-chapter code needs an existing parent.
- **`rate_rules`:**
  - `hsn_prefix` must exist as a code;
  - `notification_ref` in canonical form: zero padding and long series names are normalised on load; anything else that does not match the §1 pattern aborts the seed (core round 10);
  - optional `condition_code` (`nil_rate_list`) on `other` rules;
  - `unverified`, with `verified_by` / `last_verified_at` NULL.
- **`synonyms`:** optional `rule_hint`.
- **File hashes:** the sha256 of every seed file goes into `seed_batches.files_json` and the `dataset.seeded` audit entry.
- **`known_gaps.json` (optional, round 9):** `{ "_comment"?, "items": [{ prefix: code | null, kind: disputed | not_researched | not_transcribed | not_expressible | period_gap, reason }] }`, at most 200 items. It is not a seed table and not part of the dataset hash: the server reads it once at boot (`services/knownGaps.ts`; path `HSN_KNOWN_GAPS_FILE`, default `data/seed/known_gaps.json`) and serves it as `known_data_gaps` in `GET /v1/meta/dataset`. The shipped default may be absent (`[]`). An explicitly set file must exist, be a regular file of at most 256 KiB and parse, or the boot is refused (errors say "not valid JSON" without quoting the contents; at most 5 schema issues of 120 characters); in production `HSN_KNOWN_GAPS_FILE` must be absolute (core round 10, SA-C5-04).

## 8. Audit chain and off-host anchor (ruling 18)

```
hash = hex(HMAC-SHA256(HSN_AUDIT_KEY, prev_hash || '\n' || JCS({id, at, actor, key_prefix, action,
                                                                  entity_type, entity_id, details})))
```

- **Columns.** `audit_log(id, at, actor, key_prefix, action, entity_type, entity_id, details_json, prev_hash, hash UNIQUE)`, append-only.
  - `actor` is the admin handle, `seed`, or `system:<job>` (e.g. `system:cbic-watcher`).
  - `key_prefix` is the key's display prefix (`hsk_` + 8 characters), or NULL for scripts and jobs.
  - The first row has `prev_hash = '0' × 64`.
  - The entry is appended inside the same transaction as the change, under `BEGIN IMMEDIATE`.
- **Secret.** `HSN_AUDIT_KEY` is separate from the key peppers and `HSN_LOG_KEY`.
- **Rule hashes.** Approval entries carry the canonical rule row and `rule_sha256 = sha256(JCS(row))`.
- **`scripts/export-audit-head.ts`** writes `{format, exported_at, audit_head_id, audit_head_hash, dataset_version, dataset_sha256, feed_epoch, mac}`, where `mac` is an HMAC with `HSN_AUDIT_KEY` over the other fields. The operator copies it off the host daily and after every publish.
- **`scripts/verify-audit.ts [--head <file>]`** recomputes the whole chain and the dataset `content_hash`, checks both against the exported head, and runs the state-to-audit cross-check (exit 3 with `state without matching audit entry: …`).
- **Boot.** The server verifies the whole chain and runs the cross-check at start-up (cost O(audit log)); a failure logs `audit.chain_broken` or `audit.state_mismatch` (error, `alert: true`) and `/readyz` returns 503 (`audit_integrity`).
- **Round 4 to 6 audit actions:** `admin.disabled`, `dataset.restore_detected`, `dataset.restore_acknowledged`, `dataset.hwm_initialised`, `watched_notification.confirmation_requested`; `dataset.seeded` carries `proposal_id` when written by `import-dataset` and (round 6) `citation_notes: {rule_id: note}`; `api_key.created` records (round 7) `llm_opt_out`, `rate_limit_per_min` and `daily_quota` besides `tenant`.
- **`GET /v1/admin/audit?verify=true`** (ruling 27) verifies only the returned span, up to 10,000 entries. It reports `chain_ok` / `chain_broken_at`, and always `head_id` / `head_hash`. The `entity_type` filter includes `product`.

## 9. Verification of this DDL

`reviews/docs-fix-round2.md` § Round 4 records the run of `node --no-warnings reviews/round2-tools/test-ddl.cjs docs/design/data-model.md <server dir>`:
- **Code mirror:** every §2 block is byte-identical to `schema.sql` and to each migration step.
- **Schema:** the resulting `sqlite_master` equals the code-built one.
- **Behaviour:** 124 checks pass (93 from round 3, updated for migrations 5 to 8, plus 31 new; round 9 added the migration 8 block and six citation checks).
- **Foreign keys:** `PRAGMA foreign_key_check` returns no rows.

The behaviour tests cover:
- the seed path, once and into an empty DB only;
- code length and SAC rules;
- rule provenance and immutability, no deletes, and the price and condition CHECKs;
- dataset versions filled once and a forward-only pointer;
- admin actors (bootstrap limit, handle charset) and admin keys (bootstrap first key, grant needed afterwards, the 90-day CHECK, exclusive admin scope);
- immutable `pepper_id` and revoke-once;
- the maker ≠ checker CHECK and final decisions;
- `add_code` bound to the approved code, FTS on the new code, and an immutable `added_by_proposal`;
- in-place description updates with history and FTS refresh;
- reference-data deactivation;
- append-only audit, feed, history and watcher runs;
- watcher key uniqueness, triage while detected, a frozen closed row and the `resolved_at` CHECK;
- the product cache source CHECK and the eviction index;
- migration 5: proposals born pending from the proposer's own active key, `not_self` grants, the 72 h grant-key window, `add_code` and description updates bound to the whole payload, deactivation bound to the row id, the dataset pointer bound to an approved publish, and the two-admin watcher guard;
- migration 6: `citation_note` set by the seed only and never edited or cleared without a verify;
- migration 7: first triage of a keyed row and resolve of a keyed manual row need a stored confirmation; later additions and unkeyed manual rows are single-admin;
- migration 8: a citation change is refused outside an approved first verify, a mismatched URL is refused even with an approved verify, and the matching URL and notification are accepted with the verification fields.
