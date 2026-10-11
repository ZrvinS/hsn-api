# Security code review: core (round 3)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-11.

**Scope:** "Round 4" and "Round 5" of `reviews/code-fix-core-round2.md`. Every new or changed core file, read in full:
- `src/adapters/cbicWatcher.ts`, `src/adapters/cbicParseWorker.ts`
- `src/services/integrity.ts`, `src/repositories/sqlite/integrity.ts`
- `src/services/restoreGuard.ts` and the HWM sidecar
- `src/db/migrations.ts` (v5, v6)
- `src/services/proposals.ts`, `src/services/apiKeys.ts`
- `src/routes/admin.ts`, `hsn.ts`, `tax.ts`, `health.ts`; `src/app.ts` (405 handler, boot checks), `src/main.ts`, `src/config.ts`
- `src/services/tax.ts`, `rates.ts`, `watcher.ts`, `auditExport.ts`, `src/db/seed.ts`
- `scripts/import-dataset.ts`, `disable-actor.ts`, `ack-restore.ts`, `create-key.ts`

**Method:**
- I re-ran the round-2 exploits (`r2a`–`r2e`).
- I wrote new exploits:
  - `r3a.mts`: 60 s random fuzz of the parser at 256 KiB, plus the text helpers;
  - `r3b.mts`: cross-check gaps, watcher pre-emption, restore guard, disable lock-out, R3 resolution, 405;
  - `r3c.mts`: worker isolation.
- All are in the session scratchpad `audit/` and run with `npx tsx` from `server/`.
- I changed no repo files.
- `vitest run`: 686 of 686 pass in 30 files. `npm audit --omit=dev`: 0 vulnerabilities.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 1 | SA-C3-01 |
| Low | 4 | SA-C3-02 … SA-C3-05 |
| Info | 3 | SA-C3-06 … SA-C3-08 |

**Verdict: FAIL** (one open Medium).

SA-C2-01, 02 (as specified), 04, 05, 07 and 08 are fixed. SA-C2-09 is accepted. SA-C2-03 and SA-C2-06 are fixed with residual gaps, reported below as Lows. The remaining Medium, SA-C3-01, sits in the same threat model as SA-C2-02.

### SA-C3-01: the Medium

Someone who can write the database but lacks `HSN_AUDIT_KEY` can change a pending proposal's content after the checker has reviewed it. The proposal's stored `content_sha256` is never recomputed, either at approval or by the cross-check. So the checker approves "18 %" by hash, "0 %" is published as verified, and every integrity check reports OK.

### What held

- **Parser:** linear; the worst of 14,234 fuzzed 256 KiB pages took 73 ms. The worker fails closed on a timeout.
- **Proposal and rule guards:** no forged approved proposal or direct void or end-date gets past the v5 guards.
- **Forged versions:** detected by the cross-check, `verify-audit` and boot.
- **Grants:** `not_self` and the 72-hour TTL are enforced in the service and the database.
- **Disabled actors:** a disabled proposer's proposals cannot be approved (409 and the database trigger).
- **disable_actor:** keeps at least two active admins on the API path.
- **dataset_import:**
  - file hashes are taken from the same bytes that are parsed;
  - approval is refused if any file or row count changed;
  - maker ≠ checker;
  - the API cannot approve it.
- **Restore detection:** detected when the sidecar is kept.
- **Admin listener:** a non-loopback admin listener without an allow-list is refused in production.
- **405 responses:** list only the routes of the listener that answers.
- **code_not_in_master:** cannot borrow a rate from another heading (see below).

## Per-file coverage

| File | Reviewed | Findings |
|---|---|---|
| src/adapters/cbicWatcher.ts | ✓ | none (linear tokeniser, per-row caps, hidden content skipped; fuzzed) |
| src/adapters/cbicParseWorker.ts | ✓ | none (64 MB heap, 4 MB stack, 2 s from `ready`, 15 s start-up; timeout, crash or exit → `shape_changed`) |
| src/watcherDeps.ts | ✓ | none (always isolates) |
| src/services/integrity.ts | ✓ | **SA-C3-01**, SA-C3-02 |
| src/repositories/sqlite/integrity.ts | ✓ | SA-C3-02 (snapshot omits `revoked_at`, `expires_at`, `disabled_at`, `rule_json`/`payload_json`) |
| src/services/restoreGuard.ts, scripts/ack-restore.ts | ✓ | SA-C3-04 |
| src/db/migrations.ts (v5, v6) | ✓ | SA-C3-07 (rule insert guard binds only part of the rule; citation_note is not hashed) |
| src/services/proposals.ts | ✓ | **SA-C3-01** (`loadForDecision` trusts the stored hash) |
| src/services/apiKeys.ts, scripts/create-key.ts | ✓ | none (grant TTL ≤ 72 h; `issued_by`) |
| scripts/disable-actor.ts | ✓ | SA-C3-05 |
| scripts/import-dataset.ts, src/db/seed.ts | ✓ | none (see "dataset_import" below) |
| src/routes/admin.ts | ✓ | SA-C3-03 |
| src/services/watcher.ts | ✓ | SA-C3-03 (existing key, in any state, suppresses detection) |
| src/routes/hsn.ts, src/routes/tax.ts, src/services/tax.ts, src/services/rates.ts | ✓ | SA-C3-08 |
| src/app.ts (405, boot checks), src/routes/health.ts, src/main.ts | ✓ | SA-C3-06 |
| src/config.ts | ✓ | SA-C3-04 (default sidecar path is next to the DB) |

## Round-2 findings: status

| Id | Sev (r2) | Status | Evidence (round 3) |
|---|---|---|---|
| SA-C2-01 | Medium | **Fixed** | `r2e` at 256 KiB: every former pattern takes 0–62 ms (it was 9–18 s, or hours). `r3a`: 60 s random fuzz, 14,234 pages, worst 73 ms. Text helpers at 256 KiB take ≤ 3 ms. `r3c`: the isolated parse of a hostile page returns in 204 ms; a stuck worker is killed at its timeout and gives `shape_changed`; isolated output equals inline output. |
| SA-C2-02 | Medium | **Fixed as specified; new gap SA-C3-01** | `r2c` DB1–DB11: an approved-proposal insert, void, end-date, verify and pointer move are all refused. An orphan version gives `verify-audit` exit status `false`: "dataset version … no rate_proposal.approved audit entry". With triggers present, DB12 shows the forged rule is not served. |
| SA-C2-03 | Low | **Partly fixed; residual SA-C3-03** | Watcher-row dismiss or publish, and prefix removal, need two admins; the trigger refuses a direct resolve. Not covered: manual pre-emption and the first triage. |
| SA-C2-04 | Low | **Fixed** | `disable_actor` proposal and script; pending proposals are withdrawn; `DP2` gives **409 `proposer_disabled`** and the trigger refuses too. |
| SA-C2-05 | Low | **Fixed** | `G4` amit proposing a key for priya gives **400 `not_self`**, plus the database trigger. An expired or reused grant is refused (service and trigger, 72 h). |
| SA-C2-06 | Low | **Partly fixed; residual SA-C3-04** | A restored backup with the sidecar kept gives `/readyz` 503, a rotated epoch and an alert. If the sidecar is deleted: silent. |
| SA-C2-07 | Info | **Fixed** | Production refuses a non-loopback `HSN_ADMIN_HOST` without an allow-list. |
| SA-C2-08 | Info | **Fixed** | The `display:none` row from `WH1` is no longer an item; hidden rows are counted and alerted. |
| SA-C2-09 | Info | **Accepted** | As documented. |

All round-2 maker–checker, idempotency, binding, retroactive, withdraw, pepper rotation, `/metrics`, migration and unverified-gate exploits still hold (`r2a`–`r2d`, same results as round 2). Migration now goes v2 → v6 in place: 43 → 56 triggers, identical to a fresh database, and a failed step rolls back fully.

## Findings

### SA-C3-01: A pending proposal's content can be swapped after review; approval checks only the stored hash, and nothing detects the swap (Medium; ruling 18/20, SA-C2-02)

- **Where:**
  - `src/services/proposals.ts:446-462` (`loadForDecision` compares `expected_sha256` with the *stored* `content_sha256`);
  - the approve path then publishes `p.rule` / `p.payload` as read from the row;
  - `src/services/integrity.ts:128-148` compares the `created` entry's `content_sha256` with the stored hash and the approval entry with the stored decision, but never recomputes the hash from `rule_json`/`payload_json`, and never compares the `created` entry's `rule`/`payload` with what was approved;
  - `src/repositories/sqlite/integrity.ts:232` does not load `rule_json`/`payload_json`.
- **Issue:**
  - Ruling 20 binds the approval to the content the checker reviewed, through `expected_sha256`.
  - A database writer without the audit key (the SA-C2-02 attacker) drops `rate_proposals_guard_update`, edits `rule_json` of a reviewed pending proposal (keeping `content_sha256`) and restores the trigger.
  - The checker's approval with the hash they reviewed succeeds and publishes the edited rule as **verified**.
  - The approval entry's rule snapshot matches the published rule and the content hash matches the version. So `crossCheckState`, `verify-audit` (with or without an export) and the boot check all pass.
  - The HMAC'd `rate_proposal.created` entry still holds the original rule, so the evidence exists but is never compared.
- **Proof** (`r3b.mts`):
  ```
  X1 create 201 1800 105e716edeee
  X1 approve with the reviewed sha256: 200 published igst_rate_bp = 0
  X1 cross-check OK | verify-audit: []
  ```
- **Required fix:**
  1. In `loadForDecision`, recompute `proposalContentSha256` from the row's stored content (action, target, end_date, rule, payload, rationale, retroactive_reason, target_sha256) and refuse with 409 `proposal_hash_mismatch` unless it equals both the stored hash and `expected_sha256`. Do the same in `import-dataset approve`.
  2. In `crossCheckState`:
     - recompute every proposal's content hash from its stored content;
     - require the approval snapshot's rule or payload to equal the rule or payload in the HMAC'd `rate_proposal.created` entry;
     - add `rule_json` and `payload_json` to the snapshot.
  3. Add a test that performs X1 and expects 409 at approval, and a cross-check failure when the edit happens after approval.

### SA-C3-02: The cross-check does not cover revocation, disablement or decision reversal (Low)

- **Where:** `src/services/integrity.ts:130-136, 199-217`, and the snapshot query in `src/repositories/sqlite/integrity.ts:232-237`.
- **Issue:** A database writer without the audit key can do three things undetected:
  - un-revoke a revoked key and clear its expiry (X2);
  - re-enable a disabled, for example compromised, actor (X3);
  - turn a rejected or withdrawn proposal back into `pending` so that it can be approved again (X4).

  The audit log holds `api_key.revoked`, `admin.disabled` and `rate_proposal.rejected` entries, but no check compares them with the current state. This reverses the incident-response steps (SEC-82) silently. It still needs the old key or a second admin's approval, which is why it is Low.
- **Proof:**
  ```
  X2 after un-revoke: 200 | cross-check OK
  X3 amit after re-enable via SQL: 200 | cross-check OK
  X4 resurrected rejected proposal as pending: cross-check OK
  ```
- **Required fix:** add these checks:
  - a key with an `api_key.revoked` entry must have `revoked_at` set, and its `expires_at` must equal the value in `api_key.created`;
  - an actor with `admin.disabled` must have `disabled_at` set;
  - a proposal with any decision entry must not be `pending`, and its status must match the latest decision entry.

### SA-C3-03: One admin can still silence CBIC detection, by pre-empting a notification or mis-triaging it (Low; SA-C2-03 residual)

- **Where:**
  - `src/routes/admin.ts`: manual `POST /v1/admin/watched-notifications`, then single-admin `resolve` for `source='manual'`;
  - `src/services/watcher.ts`: `repos.watched.byKey(it.key) !== null` skips the row whatever its state;
  - `triage`: adding prefixes is single-admin, and the first triage of an untriaged watcher row is only an addition.
- **Issue:**
  - **Pre-emption:** amit creates a manual row for a notification CBIC has not yet listed (or for a range of future numbers) and dismisses it alone. The watcher later skips the real notification as "already present", with no row, no alert and no SLA clock. Two-admin dismissal (SA-C2-03) is bypassed.
  - **Mis-triage:** a fresh watcher row can be triaged by one admin to an unrelated prefix. The real codes never show `pending_change_detected`; the SLA alert still fires until the row is resolved.
- **Proof:**
  ```
  X5 amit creates manual row for a future notification 201 central_tax_rate:13/2026
  X5 amit alone dismisses it 200 dismissed
  X5 watcher run: new keys ["central_tax_rate:14/2026"] (13/2026 suppressed?) true
  X6 single-admin first triage of a watcher row to an unrelated prefix: 200 ["0406"]
  ```
- **Required fix:**
  - When the watcher finds a key whose row was manual and resolved, raise a new `detected` watcher row (or reopen it), or at least log `watcher.preempted` with `alert:true`.
  - Alternatively, require the two-admin flow to dismiss any row with a parsable `notification_key`, whatever its source.
  - Optionally require two admins for the first triage of a `cbic_watcher` row, or at least alert on it.

### SA-C3-04: Deleting the high-water-mark sidecar silently disables restore detection; by default it sits next to the database (Low; SA-C2-06 residual)

- **Where:**
  - `src/services/restoreGuard.ts:119-123`: a missing file is treated as `initialised`, `ok: true`, with no log;
  - `src/config.ts:357`: the default is `<HSN_DB_PATH>.hwm.json`.
- **Issue:**
  - A restore done together with a deleted, or never-copied, sidecar passes silently: no epoch rotation, no alert, `/readyz` 200. This is exactly the client-divergence case SA-C2-06 was about.
  - Because the default path is next to the database, a directory-level backup and restore also brings back an old, consistent sidecar.
  - The MAC and the 0600 mode are fine, and the temp-file-plus-rename write is atomic.
- **Proof:**
  ```
  X10 default sidecar path /tmp/hsn-test-…/hsn.db.hwm.json same dir as DB: true mode 600
  X10 restore (keep sidecar): readyz 503 epoch rotated true alert logged true
  X10 restore (delete sidecar): readyz 200 epoch rotated false alert logged false
  ```
- **Required fix:**
  1. Treat a missing sidecar as `initialised` only when the database is new: no audit entries, or no `dataset_state`. Otherwise fail readiness with `dataset.hwm_missing` (`alert:true`) and rotate the epoch until `ack-restore` is run.
  2. In production, require `HSN_STATE_HWM_FILE` to be set explicitly and to lie outside the database's directory.

### SA-C3-05: The host `disable-actor` script can leave fewer than two admins, and there is then no recovery path (Low)

- **Where:** `scripts/disable-actor.ts:37-38` only warns. `bootstrapAdmins` and the `admin_actors_guard_insert` trigger count disabled actors too, and a grant needs a second active admin.
- **Issue:** After the script disables the second-to-last admin, no proposal can ever be approved again: no rate fix, no new admin. Re-bootstrap is refused, and the warning text ("until a new admin is bootstrapped or granted") describes a path that does not exist.
- **Proof:**
  ```
  X9 active admins 1
  X9 re-bootstrap refused: admin actors already exist; use an admin_grant proposal to add more
  X9 grant proposal by the last admin 201 (no one else can approve it)
  ```
- **Required fix:** either refuse in the script when fewer than two active admins would remain (with an explicit `--allow-lockout` plus a documented recovery), or provide an audited host-side recovery. For example, let `bootstrap-admins --recover` add one actor when fewer than two are active, audited as `admin.recovered`.

### SA-C3-06: 405 reveals the route table to unauthenticated callers (Info)

- **Where:** `src/app.ts:455-462`.
- **Issue:** It is per listener (admin paths get 404 on the public listener) and the routes are documented anyway. The path length is capped at 512. No action needed.

### SA-C3-07: Database guards bind only part of a rule; `citation_note` is neither hashed nor cross-checked (Info)

- **Where:** `src/db/migrations.ts`: `rate_rules_guard_insert` binds prefix, rate, cess rate, dates, notification and URL, but not the condition fields or the specific cess. V6 adds `citation_note`.
- **Issue:**
  - The cross-check covers the condition fields, so this is defence in depth only.
  - A database writer can edit or remove a seed rule's `citation_note` caveat without detection, because it is outside the content hash and the cross-check.
- **Suggestion:** add `citation_note` to the cross-check, comparing it with the `dataset.seeded` snapshot or the verify approval.

### SA-C3-08: code_not_in_master resolution cannot borrow another heading's rate, but such lines count as complete (Info)

- **Where:** `src/routes/hsn.ts:107-125`, `src/services/tax.ts:186-253`.
- **Answer to the coordinator's question: no.**
  - Rates are resolved with `rates.resolve(code, …)` on the submitted code itself. Only rules whose prefix is a string prefix of that code, or descendants, apply.
  - `resolved_via` affects only the description and the ancestors.
  - `7114` (not in the master) gets `no_rate_rule`, not 7113's rate. `711399` gets the 7113 rule, and `61999999` the chapter-61 rule, each with `code_not_in_master`. `7799` gets 404.
- **Note:** a not-in-master tax line is computed and the invoice stays `complete: true`; only a note flags it. A POS that ignores notes will bill a mistyped code at its chapter or heading rate.
- **Suggestion:** consider `needs_input: ['hsn']` or a `code_not_in_master` flag at invoice level.

## Other checks (no finding)

- **dataset_import:**
  - `prepareSeed` hashes the exact bytes it parses (no TOCTOU), covering all five files, with absent optional files recorded as `null`.
  - Approval compares `files` and `counts` with the proposal inside the write transaction, after `loadForDecision` (maker ≠ checker, pending, proposer active, quoted hash).
  - The import works only on an empty database (checked before the transaction and by the `seed_batches` trigger).
  - The API refuses to approve it (409), the API body schema cannot create it, and the script authenticates `HSN_ADMIN_KEY` the way the API does.
  - SA-C3-01's recompute applies here too.
- **disable_actor:**
  - At creation and again at approval, at least two active admins must remain.
  - A disable payload cannot be redeemed as a key grant: the `admin_actors` and `api_keys` triggers require `$.op IS NULL`, and the target is disabled anyway.
- **Grants:** `not_self` holds in the service and the trigger; the TTL is `min(config, 72 h)` in the service with a 72 h ceiling in the trigger; reuse is blocked by UNIQUE.
- **Two-admin dismiss for watcher rows:**
  - the same actor with another key gets 403;
  - a different request replaces the pending one;
  - the confirmer must repeat exactly the requested change;
  - the trigger enforces it against direct writes.
- **Restore guard:**
  - the MAC uses `HSN_AUDIT_KEY` over canonical JSON;
  - the file is mode 0600 and written atomically;
  - the check runs once per process in `buildApp`, before the listeners serve;
  - the sidecar never moves backwards at runtime and is updated after audited writes and every 60 s;
  - an invalid MAC gives 503.
- **Partial totals:** an incomplete invoice gets `totals` = null and `partial_totals` listing the included and excluded lines.

## Checklist status (core scope, round 3)

| Status | Items |
|---|---|
| PASS | SEC-01, 02, 03, 05, 08, 09, 11–31, 39–42, 50, 51, 52, 57, 59, 61, 62, 63, 66, 67, 69, 70, 71, 73–76, 78, **79** (parser fixed), **82** (disable path exists), 83 |
| FAIL | SEC-53 / ruling 18 + 20 (SA-C3-01: a reviewed proposal can be swapped undetected by a database writer without the audit key) |
| N/A | as in round 2 (classifier, adapters other than the watcher; ops and docs items) |

## Final verdict

**FAIL.** Open: 0 Critical, 0 High, 1 Medium (SA-C3-01), 4 Low, 3 Info.

SA-C3-01 needs two changes: recompute the proposal content hash at approval and in the cross-check, and compare the created entry's content with the approval snapshot. With that fix the verdict becomes PASS. The Lows should still be scheduled, especially SA-C3-03 and SA-C3-04, because they leave residual gaps in SA-C2-03 and SA-C2-06.
