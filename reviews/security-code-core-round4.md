# Security code review: core (round 4)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-11.

**Scope:**
- **Fixes:** "Round 6" of `reviews/code-fix-core-round2.md`.
- **Changed files, read in full or in every changed part:**
  - `src/services/proposals.ts` (`loadForDecision`, disable guards);
  - `src/services/integrity.ts`, `src/repositories/sqlite/integrity.ts`;
  - `src/services/restoreGuard.ts`, `src/repositories/sqlite/audit.ts` (`hasAction`);
  - `src/db/migrations.ts` v7;
  - `src/routes/admin.ts` (watched-notification create, triage and resolve), `src/routes/tax.ts`, `src/services/tax.ts` (`warnings[]`);
  - `src/config.ts` (HWM production rules), `scripts/disable-actor.ts`, `src/db/seed.ts` (`citation_notes` in `dataset.seeded`).
- **Sweep:** every file in `src/` outside `src/classify`, plus the core scripts. See "Per-file coverage" below.

**Method:**
- **Exploits re-run:**
  - `r3a`: 60 s parser fuzz;
  - `r3b`: X1–X10;
  - `r3c`: worker isolation.
- **New exploits:**
  - `r4a.mts`: each cross-check probe in a fresh environment (X1b, X2–X4, P1–P3), the disable script, production HWM config, a missing sidecar after initialisation, tax warnings, and a full legitimate flow for regressions;
  - `r4b.mts`: `citation_note` binding on the real seed, withdraw, and acceptance of an HWM path in another directory.
- **Location:** all scripts are in the session scratchpad `audit/` and run with `npx tsx` from `server/`. I changed no repo files.
- **Suite and checks:**
  - `vitest run`: 720 of 720 pass in 32 files;
  - `tsc --noEmit`: clean;
  - `npm audit --omit=dev`: 0 vulnerabilities.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 0 | none |
| Low | 2 | SA-C4-01, SA-C4-02 |
| Info | 3 | SA-C4-03 … SA-C4-05 |

**Verdict: PASS** (no open Critical, High or Medium).

The Round-6 fixes work and add no regressions:
- SA-C3-01, 02, 03, 04, 05, 07 and 08 are fixed.
- SA-C3-06 is accepted unchanged, as intended.

The two new Lows are further state that the cross-check does not bind, in the SA-C2-02 threat model (a database writer without `HSN_AUDIT_KEY`):
- SA-C4-01: an API key's policy fields;
- SA-C4-02: watched-notification state.

## Round-3 findings: status

| Id | Sev (r3) | Status | Evidence (round 4) |
|---|---|---|---|
| SA-C3-01 | Medium | **Fixed** | **X1** (content swapped, stored hash kept): approval gets **409 `proposal_hash_mismatch`**. The cross-check and `verify-audit` report "stored content does not hash to its content_sha256" and "stored rule/payload differs". **X1b** (content swapped *and* the unkeyed `content_sha256` recomputed; the checker re-reads it and approves the new hash, which publishes 0 %): the cross-check flags the proposal while pending ("content_sha256 differs from its rate_proposal.created audit entry", "stored rule/payload differs"), and after approval also "the published rule differs". Boot, `/readyz` and `verify-audit` all fail. |
| SA-C3-02 | Low | **Fixed** | Each probe ran in a fresh environment. **X2:** an un-revoked key with its expiry cleared gives "revoked in the audit log but usable in the database (un-revoked?)". **X3:** a re-enabled actor gives "disabled in the audit log but active in the database". **X4:** a rejected proposal set back to pending gives "pending, but the audit log records rate_proposal.rejected". **P2:** a key row inserted directly gives "no api_key.created audit entry". Gaps in other columns: SA-C4-01, SA-C4-02. |
| SA-C3-03 | Low | **Fixed (residual Info SA-C4-03)** | **X5:** amit alone dismissing a manual keyed row gets **202**; the row stays `detected` and on the SLA clock. **X6:** a single admin's first triage gets **202**; prefixes stay `[]`. v7 trigger: a direct resolve, first triage or prefix removal on any keyed row is refused unless a matching `pending_action` exists. Confirmation, mismatch, and same actor with another key behave as in round 3. |
| SA-C3-04 | Low | **Fixed (residual Info SA-C4-04)** | **P7:** after `dataset.hwm_initialised`, a missing sidecar gives `/readyz` **503**, a rotated epoch and a `dataset.hwm_missing` alert, and stays 503 on the next probe. **X10:** a restored backup with the sidecar kept or deleted gives 503 and a rotated epoch in both cases. **P6 (production `HSN_STATE_HWM_FILE`):** unset is refused; `off` is refused; a path in the database's directory is refused, including the `..` and `./` forms; another directory is accepted. |
| SA-C3-05 | Low | **Fixed** | **P5:** `disableActorCli` with two active admins exits **1** with a clear message, and amit stays active. An unknown handle exits 1. The API path refuses at create and at approve (`activeCount() - 1 < 2`). **P9:** a third admin is granted, then disabled through the two-admin proposal (201, 200). |
| SA-C3-06 | Info | **Accepted** | **X8:** 405/404 behaviour unchanged. |
| SA-C3-07 | Info | **Fixed** | **P4** (real seed, 81 rules): editing a seeded `citation_note` by SQL gives "citation_note differs from the seed caveat in its dataset.seeded audit entry"; removing it gives "seed citation_note removed without a verify". It is still outside the content hash, as documented. |
| SA-C3-08 | Info | **Fixed** | **P8:** a not-in-master line has `warnings: ["code_not_in_master"]`, the invoice has the top-level `warnings: ["code_not_in_master"]`, a normal line has `[]`, and `complete: true`. **X7:** 7114 gives `no_rate_rule`; 711399 resolves to 7113; 61999999 resolves to 61; 7799 gives 404. Nothing borrows a rate from another heading. |

**Other re-runs:**
- **`r3a`:** 14,139 fuzzed 256 KiB pages, worst 109 ms; the text helpers take ≤ 3 ms.
- **`r3c`:** an isolated hostile parse takes 209 ms; a stuck worker times out and gives `shape_changed`; isolated output equals inline output.
- **Regression flow `P9`** passes, and afterwards both the cross-check and `verify-audit` report OK. Steps and results:
  - create and approve (200);
  - reject (200);
  - withdraw (200, in `r4b`);
  - admin grant (201) and approve (200);
  - `disable_actor` proposal (201) and approve (200);
  - key revoke;
  - manual keyed row, dismissed with two admins (202, then 200).

## New findings

### SA-C4-01: The cross-check does not bind an API key's policy columns (Low; SA-C2-02 model)

- **Where:**
  - `src/repositories/sqlite/integrity.ts` reads only `id, prefix, scopes, actor_id, admin_grant_id, expires_at, revoked_at` from `api_keys`;
  - the keys block in `src/services/integrity.ts` compares only those columns.
- **Issue:**
  - A database writer without the audit key can drop `api_keys_guard_update` and change a key's `llm_opt_out`, `rate_limit_per_min`, `daily_quota` and `tenant`, then restore the trigger.
  - `routes/classify.ts:140` gates LLM use on `llmOptOut`. Flipping an opted-out tenant's key to 0 therefore lets its product names reach the LLM provider whenever its client sends `allow_llm: true`.
  - Raising the rate limit or removing the quota is also undetected.
  - All of these values are in the HMAC'd `api_key.created` entry, or can be added to it.
- **Proof** (`r4a` P1):
  ```
  P1 key policy before {"llm_opt_out":0,"rate_limit_per_min":600,"daily_quota":null,"tenant":"test"} -> flipped | XC OK | VA OK
  ```
- **Required fix:**
  - Load these four columns in the snapshot and compare them with `api_key.created` (and any later audited policy change).
  - If they are not recorded at creation, add them to the created entry's details. Compare only when present, as `expires_at` already is.

### SA-C4-02: Watched-notification state is not bound by the cross-check (Low; SA-C2-02 model, SA-C2-03)

- **Where:** `crossCheckState` covers no `watched_notifications` table at all.
- **Issue:**
  - A database writer without the audit key can drop `watched_notifications_guard_confirm` and `watched_notifications_guard_update` and act on a keyed row without any confirmation flow:
    - set `state='dismissed'` (or `published`);
    - or empty its `affected_prefixes`.
  - `pending_change_detected` then disappears from the affected codes, the SLA alert stops, and the watcher keeps skipping the key.
  - The HMAC'd `watched_notification.detected`, `.triaged`, `.confirmation_requested` and `.dismissed`/`.published` entries hold the true history, but nothing compares them with the rows.
  - Rated Low, not Medium: it suppresses a warning and does not change a rate.
- **Proof** (`r4a` P3):
  ```
  P3 8517 warnings before ["no_rate_rule","pending_change_detected"]
  P3 SQL dismiss of keyed row | XC OK | 8517 warnings ["no_rate_rule"]
  ```
- **Required fix:**
  - Cross-check each watched row against its audit history:
    - a `detected` entry exists;
    - a non-`detected` state needs a matching resolve entry (for keyed rows, one with `requested_by`/`confirmed_by`);
    - the current `affected_prefixes` equal the last `detected`/`triaged` entry.
  - Also flag a row whose resolve entry exists while the row is still `detected`, in either direction.

### SA-C4-03: One admin still chooses the prefixes of a keyed manual row when creating it (Info; SA-C3-03 residual)

- **Where:** `POST /v1/admin/watched-notifications` (`src/routes/admin.ts`). `affected_prefixes` is required at creation and taken from a single admin. The watcher then skips that key (`services/watcher.ts:144`).
- **Issue:**
  - amit can create `13/2026-Central Tax (Rate)` before CBIC lists it, pointing it at decoy prefixes. The real codes never show `pending_change_detected`.
  - Resolving the row, or removing the decoys, now needs two admins.
  - The row stays `detected`, so the SLA alert fires after the SLA period. The impact is therefore a delay, not silence.
  - Related: `watched.pending()` is capped at `LIMIT 200` ordered oldest first. A flood of manual rows could hide newer rows from the overdue list, but the flood rows themselves alert.
- **Suggestion:** for a manual row that has a `notification_key`, treat the creation prefixes as a pending triage needing confirmation, or alert when the watcher skips a key whose row is manual (`watcher.preempted`).

### SA-C4-04: A pre-initialisation backup restored with the sidecar removed still initialises silently (Info; SA-C3-04 residual)

- **Where:** `restoreGuard.ts`, missing-sidecar branch. It alerts only if the audit log already has `dataset.hwm_initialised` or `dataset.restore_acknowledged`.
- **Issue:** a backup taken before the first boot of the Round-6 code (or before first boot at all) has neither entry. Restoring it while deleting the sidecar gives `initialised`, not `hwm_missing`. This needs a backup from before this release, and production now forces the sidecar onto another path.
- **Suggestion:** document it in the restore runbook, i.e. take a fresh off-host audit-head export after upgrading. Alternatively, treat "no sidecar, and the audit log has entries older than N minutes" as `hwm_missing`.

### SA-C4-05: The API's lock-out message points to a path that now refuses too (Info)

- **Where:** `src/services/proposals.ts:646`. The message reads "…grant a new admin first (or use scripts/disable-actor.ts on the host)". Since SA-C3-05, the script applies the same two-admin floor.
- **Fix:** drop the script hint. The script's own message, "grant a third admin first … or revoke the key", is the correct guidance.

## Regression review of the Round-6 changes

- **`loadForDecision`:**
  - The recompute runs before the `expected_sha256` comparison and after the maker ≠ checker, pending and proposer-active checks.
  - Approve, reject and `import-dataset` all use it. A tampered proposal can therefore be neither approved nor rejected; its proposer can still withdraw it.
  - The hash formula is unchanged, so existing pending proposals still verify (720 tests, P9).
- **Cross-check:**
  - It recomputes every proposal hash and compares the stored rule and payload with the `created` entry, and the approval snapshot with both.
  - No false positives in the legitimate flow (P9), on the real seed (P4 baseline OK), or in the suite.
- **v7 trigger:**
  - It replaces the v5 trigger in place. Adding prefixes to an already-triaged row is still single-admin, which is conservative.
  - Reopening is not offered. The watcher's own inserts are unaffected.
  - The confirm path writes the pending prefixes, not the confirmer's body, after a set-equality check.
- **`hasAction`:** a plain query. Deleting or editing the `hwm_initialised` entry to get around it breaks the HMAC chain, which boot verifies.
- **Production config:**
  - `HSN_STATE_HWM_FILE` is required.
  - It may not be `off` or in the database's directory; the path is resolved before comparing.
  - Outside production the default is still `<DB>.hwm.json` (accepted in round 3 for development).
- **disable-actor script:**
  - The guard runs inside the same transaction as the disable, so it has no race with a concurrent disable.
  - It catches `AppError` and `KeyInputError` and exits 1, and always closes storage.
- **Seed:** `citation_notes` is taken from the same `ruleRows` that are inserted, inside the seed transaction.
- **Tax:** `warnings[]` is in the response schema at line and invoice level. No new information leaks: the parent was already shown in `resolved_via`.

## Per-file coverage (src/ outside src/classify, and core scripts)

"Last reviewed" is the most recent round in which I read the file in full or read every changed part. Files whose mtime is later than the round-3 report were re-read this round.

| File | Last reviewed | Findings / note |
|---|---|---|
| src/app.ts | r3 | none (boot cross-check, 405) |
| src/main.ts | r3 | none |
| src/config.ts | **r4** | none (HWM production rules verified) |
| src/context.ts | **r4** | none (types; `restore` adds `hwm_missing`) |
| src/classifierDeps.ts | r2 | none |
| src/watcherDeps.ts | r3 | none |
| src/adapters/cbicWatcher.ts | r3 (fuzzed r4) | none |
| src/adapters/cbicParseWorker.ts | r3 (re-run r4) | none |
| src/adapters/httpClient.ts | **r4** (SSRF core: `checkUrl`, lookup hook, limits) | none (https only, no userinfo, fixed port, host allow-list, every resolved address checked, connect to the checked address, no redirects, 256 KiB cap) |
| src/adapters/ipGuard.ts | **r4** | none (v4 and v6 special ranges, mapped/NAT64/6to4/Teredo blocked, only 2000::/3 allowed) |
| src/adapters/budget.ts | **r4** | none |
| src/adapters/productLookup.ts | **r4** | none (sanitised, tag regex, source URL built from validated digits) |
| src/adapters/openFoodFacts.ts | **r4** (URL building) | none (`encodeURIComponent` on validated digits, fixed host) |
| src/db/migrate.ts | r2 (re-checked r3) | none |
| src/db/migrations.ts | **r4** (v7) | none |
| src/db/schema.sql | r2 | none |
| src/db/seed.ts | **r4** (`citation_notes`) | none |
| src/lib/apiKey.ts, ip.ts, metrics.ts, rateLimit.ts, redact.ts | r2 | none |
| src/lib/canonicalJson.ts, clock.ts, dates.ts, etag.ts, fts.ts, ids.ts, money.ts, requestId.ts | r1 | none |
| src/lib/problem.ts | **r4** (new codes) | none (`proposal_hash_mismatch` 409, `proposer_disabled` 409) |
| src/repositories/types.ts | **r4** (diff areas) | none |
| src/repositories/sqlite/index.ts | **r4** | none |
| src/repositories/sqlite/integrity.ts | **r4** | **SA-C4-01** (key policy columns not loaded) |
| src/repositories/sqlite/audit.ts | **r4** | none (`hasAction`) |
| src/repositories/sqlite/actors.ts | **r4** | none |
| src/repositories/sqlite/watched.ts | **r4** | SA-C4-03 (`pending()` LIMIT 200 note) |
| src/repositories/sqlite/idempotency.ts | **r4** | none (scoped by key id; expired rows replaced) |
| src/repositories/sqlite/apiKeys.ts, base.ts, dataset.ts, hsn.ts, products.ts, proposals.ts, synonyms.ts | r1 | none |
| src/repositories/sqlite/rateRules.ts | r3 (parent resolution) | none |
| src/routes/admin.ts | **r4** (watched routes, disable path) | SA-C4-03 |
| src/routes/tax.ts | **r4** | none |
| src/routes/classify.ts | **r4** (scope, cost, quota, LLM gate) | SA-C4-01 (impact) |
| src/routes/hsn.ts, health.ts | r3 | none |
| src/routes/common.ts, metrics.ts | r2 | none |
| src/routes/meta.ts, rates.ts | r1 | none |
| src/services/proposals.ts | **r4** | SA-C4-05 |
| src/services/integrity.ts | **r4** | SA-C4-01, SA-C4-02 |
| src/services/restoreGuard.ts | **r4** | SA-C4-04 |
| src/services/tax.ts | **r4** | none |
| src/services/watcher.ts | **r4** (key skip, SLA) | SA-C4-03 |
| src/services/apiKeys.ts, rates.ts | r3 | none |
| src/services/audit.ts, auditExport.ts, dataset.ts, idempotency.ts | r2 | none (`verifyAgainstHead` runs `crossCheckState`) |
| src/services/disclaimer.ts | r1 | none |
| scripts/disable-actor.ts | **r4** | none |
| scripts/_common.ts, bootstrap-admins.ts, verify-audit.ts, export-audit-head.ts | **r4** | none (bootstrap refused once any actor exists; head written with mode 0600) |
| scripts/ack-restore.ts, import-dataset.ts, create-key.ts | r3 | none |
| scripts/rotate-feed-epoch.ts, watch-cbic.ts | r2 | none |
| scripts/seed.ts, scripts/seedgen/ | r1 | none (refused in production) |
| scripts/eval-classifier.ts | n/a | classifier scope (part 2) |

No file in `src/` outside `src/classify` has gone unreviewed.

## Checklist status (core scope, round 4)

| Status | Items |
|---|---|
| PASS | SEC-01, 02, 03, 05, 08, 09, 11–31, 39–42, 50, 51, 52, **53** (ruling 18 + 20: SA-C3-01 fixed), 57, 59, 61, 62, 63, 66, 67, 69, 70, 71, 73–76, 78, 79, 82, 83 |
| PASS with Low residuals | ruling 18 state-to-audit coverage: SA-C4-01 (key policy columns) and SA-C4-02 (watched rows) |
| FAIL | none |
| N/A | as in round 3 (classifier; ops and docs items) |

## Final verdict

**PASS.** Open: 0 Critical, 0 High, 0 Medium, 2 Low (SA-C4-01, SA-C4-02), 3 Info (SA-C4-03 … SA-C4-05).

All round-3 findings are fixed or accepted, and the Round-6 changes add no regressions. The two Lows both extend the existing cross-check to state it does not yet bind, and are worth scheduling before production. Prioritise SA-C4-01 because of the LLM opt-out.
