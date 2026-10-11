# Security code review: core (round 2)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-11.

**Scope:**
- Every file in `server/src/` outside `src/classify/` and `src/adapters/`.
- Also in scope: `src/adapters/cbicWatcher.ts`, the `getText` changes in `src/adapters/httpClient.ts`, `src/services/watcher.ts`, `src/watcherDeps.ts`, `src/db/migrations.ts`, `scripts/*.ts` and the test helper.

**Inputs:**
- `reviews/code-fix-core-round2.md` (rounds 2 and 3);
- `reviews/code-watcher-round2.md`;
- `docs/00c-coordinator-rulings-round2.md` (rulings 1–35);
- my round-1 report, `reviews/security-code-core-round1.md`.

**Method:**
- I read every in-scope file.
- I re-ran the round-1 exploits, rewritten for the new APIs.
- I wrote new exploits for the round-2/3 features and ran them with `npx tsx` against `buildApp` (both listeners, through `inject`), the services, the scripts' service functions and raw SQL on the write connection.
- The scripts are in the session scratchpad: `scratchpad/audit/r2a.mts` (round-1 re-run), `r2b.mts` (maker–checker, idempotency, binding, withdraw, grants), `r2c.mts` (DB guards, forgery, migrations, retroactive feed, unverified gate), `r2d.mts` (pepper rotation, metrics labels, hostile HTML) and `r2e.mts` (parser timing).
- I changed no repo files.
- Test suite: `vitest run` passes 606 of 606 tests in 25 files. `npm audit --omit=dev` reports 0 vulnerabilities.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 2 | SA-C2-01, SA-C2-02 |
| Low | 4 | SA-C2-03 … SA-C2-06 |
| Info | 3 | SA-C2-07 … SA-C2-09 |

**Round-1 findings:** all 20 (SA-C-01 … SA-C-20) are fixed. I confirmed each one by exploit or by reading the code; see the status table.

**Verdict: FAIL.** Two Medium findings are open, and PASS requires zero open Critical, High or Medium findings.

**What I could not break:** I attacked maker–checker from every angle requested and it held.
- Two keys for one human are refused (`maker_checker_violation`), in the service and by a CHECK constraint.
- NFKC and case aliases of a handle are refused.
- A grant cannot be reused (UNIQUE), cannot be moved to another handle, and cannot be approved by its proposer.
- A third bootstrap is refused.
- Idempotency keys are scoped per API key and bound to route and body.
- Replay after revocation gets 401.
- A wrong `expected_sha256` gets 409, and a changed target gets 409.
- Retroactive changes without a reason are refused, and the feed flags them.
- Withdrawal by another actor gets 403.
- Pepper rotation fails closed.
- Migrations upgrade in place with every guard intact and roll back fully on failure.

**What remains:**
- **SA-C2-01:** an untrusted-page parsing DoS in the new watcher.
- **SA-C2-02:** a tamper-evidence bypass. Someone with write access to the database file, but without `HSN_AUDIT_KEY`, can publish a forged, "verified" rate, and every shipped check, including `verify-audit` against an export, reports OK.

## Per-file coverage

| File | Reviewed | Findings |
|---|---|---|
| package.json, tsconfig*.json, .nvmrc | ✓ | none (node 22.x, build tsconfig, `start` path fixed) |
| src/config.ts | ✓ | SA-C2-07 (non-loopback admin host allowed without allow-list) |
| src/context.ts | ✓ | none |
| src/main.ts | ✓ | SA-C2-01 (watcher can run in-process) |
| src/app.ts | ✓ | none (key verified first; separate limiters; extraCost; no key cache; actor-disabled check) |
| src/watcherDeps.ts | ✓ | none |
| src/classifierDeps.ts | ✓ | none (pino child logger) |
| src/db/schema.sql | ✓ | SA-C2-02 (no insert guard on `rate_proposals`; void and end-date not bound to a proposal) |
| src/db/migrations.ts | ✓ | SA-C2-02 (add_code and description guards bind only op and code) |
| src/db/migrate.ts | ✓ | none (one transaction; refuses newer schema) |
| src/db/seed.ts | ✓ | none (`allowVerified` is fixture-only) |
| src/lib/apiKey.ts, canonicalJson.ts, clock.ts, dates.ts, etag.ts, fts.ts, ids.ts, money.ts, problem.ts, requestId.ts | ✓ | none |
| src/lib/ip.ts | ✓ | none (strict CIDR v4/v6, /64 bucketing) |
| src/lib/rateLimit.ts | ✓ | SA-C2-09 |
| src/lib/redact.ts | ✓ | none (IPv6 expanded before /48) |
| src/lib/metrics.ts | ✓ | none (labels are route templates; series capped at 2000) |
| src/repositories/sqlite/*.ts | ✓ | SA-C2-02 (rateRules `void`/`endDate` rely on triggers that do not bind them) |
| src/routes/admin.ts | ✓ | SA-C2-03 (single-actor triage/dismiss) |
| src/routes/metrics.ts | ✓ | SA-C2-07 |
| src/routes/common.ts, health.ts, hsn.ts, meta.ts, rates.ts, tax.ts | ✓ | none |
| src/services/apiKeys.ts | ✓ | SA-C2-05 |
| src/services/audit.ts | ✓ | none (HMAC chain; span cap) |
| src/services/auditExport.ts | ✓ | SA-C2-02 (no cross-check between state and audit) |
| src/services/dataset.ts | ✓ | SA-C2-06 |
| src/services/idempotency.ts | ✓ | none |
| src/services/proposals.ts | ✓ | SA-C2-04, SA-C2-05 |
| src/services/rates.ts, tax.ts, disclaimer.ts | ✓ | none (unverified gate correct, including an explicit `rule_id`) |
| src/services/watcher.ts | ✓ | SA-C2-08 |
| src/adapters/cbicWatcher.ts | ✓ | **SA-C2-01**, SA-C2-08 |
| src/adapters/httpClient.ts (getText) | ✓ | none (explicit type allow-list, charset allow-list, 256 KiB cap, no redirects) |
| scripts/*.ts | ✓ | SA-C2-02 (verify-audit), SA-C2-04 (no disable-actor script), SA-C2-06 (rotate-feed-epoch is manual) |
| test/helpers.ts | ✓ | none (default unauth limit; auto Idempotency-Key with an opt-out) |

## Round-1 findings: status

| Id | Sev (r1) | Status | Evidence (round 2) |
|---|---|---|---|
| SA-C-01 | High | Fixed | 80 bad requests from one IP, then a valid key from the same IP gets **200**; junk from that IP gets 429. `XFF` is ignored without trust-proxy. Production needs `HSN_TRUST_PROXY` or `HSN_DIRECT_EXPOSURE`. |
| SA-C-02 | High | Fixed | A mismatched-prefix `supersede` gets **400** and a mismatched `correct` gets 400. The link trigger refuses cross-prefix `superseded_by` and `voided_by_rule`. The DTO shows `target_rule`. |
| SA-C-03 | High | Fixed | An admin key for `"Amit "` is refused (it normalises to `amit` and needs a grant). Approval of amit's proposal by amit's second key gets **403 maker_checker_violation**. A `Ａｍｉｔ` grant gets 400 duplicate. |
| SA-C-04 | Medium | Fixed | `loadConfig` without NODE_ENV is refused. `development` without a pepper or audit key is refused. |
| SA-C-05 | Medium | Fixed | Separate key and unauth limiters. LRU eviction one bucket at a time. IPv6 is bucketed per /64. The tracker is bounded and swept. |
| SA-C-06 | Medium | Fixed | `read`+`admin` is refused. `"10.0.0.1/"` is refused at boot. IPv6 CIDR works. A non-listed IP gets 403 on admin routes and `/metrics`. |
| SA-C-07 | Medium | Fixed | A 500-line tax request is charged `RateLimit-Cost: 11`. |
| SA-C-08 | Medium | Fixed | Route snapshot, 401 sweep, child-process boot and allow-list tests exist; the suite runs at the default unauth limit (606 tests pass). |
| SA-C-09 | Low | Fixed | Strict RFC 3339 UTC expiry; epoch compare; unparseable counts as expired. |
| SA-C-10 | Low | Fixed | `2001::5:6 → 2001:0:0::/48`, `::ffff:1.2.3.4 → 1.2.3.0/24`. |
| SA-C-11 | Low | Fixed as specified | `head_id`/`head_hash`, a 10k span cap, chunked `verifyAll`, boot hash check, Ed25519 option, export/verify scripts. A new gap is reported as SA-C2-02. |
| SA-C-12 | Low | Fixed | `X-Request-Id: req_FIXED` gives a server `req_<ULID>`; the client value is logged as `client_request_id`. |
| SA-C-13 | Low | Fixed | The classifier gets a pino child logger. |
| SA-C-14 | Low | Fixed | Prefixes are 2/4/5(99)/6/8 digits and must exist (service and trigger). |
| SA-C-15 | Low | Fixed (recorded) | `q` is 2–100. The 256 KiB tax limit is recorded in SEC-24. |
| SA-C-16 | Low | Fixed | `engines 22.x`, `.nvmrc`, `tsconfig.build.json`, `start` uses `dist/main.js`. |
| SA-C-17 | Info | Fixed | The seed CLI never sets `allowVerified`. |
| SA-C-18 | Info | Fixed | `Vary: Origin` on every response when CORS is configured. |
| SA-C-19 | Info | Fixed | No key cache; a revoked key gets 401 immediately. |
| SA-C-20 | Info | Fixed | `/readyz` runs no DDL; probes have their own budget. |

## Maker–checker and new-feature exploit results (all held)

```
I2 same key+body replay 201 replayed=true (same proposal)
I3 same key, different body 409 idempotency_conflict
I4 same idem key from amit2 (other key, same actor) 409 (duplicate pending content, not a replay)
I5/I6 priya reusing amit's idem key: independent scope (per key_id) → 200, replay 200 replayed
I7 same idem key on another route 409 idempotency_conflict
I8 re-approve with a new idem key 409 proposal_not_pending
I9 no Idempotency-Key 400 idempotency_key_required;  I11 no auth 401 (hook runs after auth)
S2 approve with wrong expected_sha256 409 proposal_hash_mismatch
S5 approve a competing proposal after its target changed 409 rule_not_active
R1/R2/R4 retroactive supersede / end_date / correct without reason 400
RF3 feed: rule_end_dated and rule_added carry retroactive=true when approved with a reason
W1 withdraw by another actor 403 not_proposer; W2 by the same actor's other key 200; W3 approve withdrawn 409
G3 amit2 approving amit's grant 403; G7 grant reuse → UNIQUE; G8 grant for another handle refused
G9 third bootstrap refused; DB10 raw INSERT of an actor without a grant refused by trigger
G11 revoked key 401 at once; G13 replaying an approve after the approver's key was revoked 401
D1 a disabled actor's keys 401
UG1 unverified rule without accept_unverified: tax null, needs_input [accept_unverified]; UG3 same via explicit rule_id: refused
PR1-PR5 pepper rotation: old key works while its pepper is listed, 401 once removed, mislabelled pepper_id 401
PR6/PR7 duplicate ids, duplicate secrets, bad ids, short secrets, pepper == audit key: all refused
MX1/MX2 /metrics labels are route templates ("unmatched" for 404s); no raw paths
MG1/MG2 base v2 → v4 in place: 43 → 46 triggers, none missing, triggers identical to a fresh DB
MG3/MG4 a failing v4 step rolls back v3 as well: schema stays at 2 with the v2 guards
WH2/WH3 javascript:, entity-encoded and tab-split schemes, host suffix and userinfo tricks: all rejected
```

## Findings

### SA-C2-01: The CBIC watcher's HTML parser has super-linear regexes; one hostile listing page blocks the event loop for hours (Medium)

- **Where:**
  - `src/adapters/cbicWatcher.ts:194` (`ANCHOR_RE`, cubic);
  - `:224-226` (comment/script strip, quadratic on unclosed `<!--` or `<script>`);
  - `:231` (`ROW_RE`, quadratic on `<tr` without `>`);
  - `:236` (cell regex, quadratic on `<td`);
  - `:94` (`htmlText` tag strip, quadratic on `<b` without `>`).
  - The parser runs on the main thread: `src/main.ts:55-56` when `HSN_WATCHER_ENABLED=true`, otherwise `scripts/watch-cbic.ts`.
- **Issue:** The design says the page is untrusted and parsed over a bounded input. The input is bounded (256 KiB), but the regexes backtrack.
  - `ANCHOR_RE` (`<a\b[^>]*?\bhref\s*=\s*(…|([^\s>"']+))[^>]*>([\s\S]*?)<\/a\s*>`) runs on any notification row that has a valid reference and date. A row holding `<a href=` repeated without a closing `</a>` costs O(n³).
  - Several other patterns cost O(n²) on unclosed constructs.
  - With the in-process watcher, both listeners stop answering: the event loop blocks, so the public API and admin go down. With the cron script, the job hangs and the only signal is the 36-hour freshness alert.
  - Precondition: content control of an allow-listed CBIC host (compromise, defacement, or injected listing text). The fetch path is otherwise hardened (exact hosts, no redirects, TLS).
- **Proof** (`r2e.mts`, `parseCbicListing` alone):
  ```
  <a href= bare      2KiB=52ms 4KiB=372ms 8KiB=2263ms 12KiB=7684ms 16KiB=18207ms   (×8 per doubling; 256 KiB ≈ 20 h)
  <td no close       64KiB=1178ms 256KiB=18563ms
  tags (<b …)        64KiB=896ms  256KiB=14276ms
  <!-- unclosed      64KiB=641ms  256KiB=10474ms
  <tr no >           64KiB=575ms  256KiB=9251ms
  ```
- **Required fix:**
  1. Replace the regex scanning with a linear scanner. Use `indexOf`-based tag tokenising: find `<`, find the next `>`, and if there is none, stop.
  2. Strip comments and `script`/`style` blocks by searching for the terminator once and dropping the rest when it is absent.
  3. Match anchors as `<a\b[^>]*>` only, then read `href` from that tag string with an anchored regex, and find `</a` with `indexOf`.
  4. Cap the row length (for example 16 KiB) and the tags per row.
  5. Optionally run `parseCbicListing` in a `worker_threads` worker with a hard timeout (e.g. 2 s) that fails closed (`shape_changed`).
  6. Add tests feeding 256 KiB adversarial pages (the five patterns above) and asserting each parse finishes in under 250 ms.

### SA-C2-02: A database writer without `HSN_AUDIT_KEY` can publish a forged "verified" rate that every shipped integrity check reports as OK (Medium; ruling 18/19, SEC-53)

- **Where:**
  - `src/db/schema.sql:238-285`: `rate_proposals` has no INSERT guard, so a row can be inserted already `approved`.
  - `src/db/schema.sql:333-345`: the rule insert guard only checks that such a row exists.
  - `src/db/schema.sql:347-369`: `status → voided`, `effective_to`, `end_dated_in_version` and `verified_by` can be set once without any approved proposal targeting the rule.
  - `src/db/schema.sql:35-38, 49-52`: a new `dataset_versions` row can be inserted with any hash, and the pointer moved forward.
  - `src/services/auditExport.ts:48-77` and `src/app.ts:120`: they check the HMAC chain, the exported head and the dataset hash against the data, but never that the published state has matching audit entries.
  - `src/db/migrations.ts:55-73`: the add_code guard binds only `op` and `code`, not parent, type or description; the description guard accepts any approved `refdata_change` id, not one for that code.
- **Issue:**
  - Ruling 17 accepts that the host owner can bypass maker–checker.
  - Ruling 18 makes the HMAC chain plus `verify-audit` the *tamper evidence* against exactly this attacker: one who can write the database but lacks `HSN_AUDIT_KEY`, as with a stolen or replaced DB file, a tampered backup that gets restored, or a volume shared with another workload.
  - The attacker never has to touch the chain. They insert a fake approved proposal (maker amit, checker priya), insert a rule that names it, insert a new dataset version with a recomputed plain sha256, and move `dataset_state` forward.
  - The boot hash check, `/readyz`, `verify-audit`, and `verify-audit --head <export taken before the forgery>` all pass. The API serves the forged rule as `verified`.
  - Voiding or end-dating a rule needs no fake proposal at all.
  - If `HSN_DATASET_SIGNING_KEY` is configured, the forged version has no signature, but nothing on the server checks signatures.
- **Proof** (`r2c.mts`):
  ```
  DB3 void a rule with no proposal: ACCEPTED
  DB4 end-date a rule with no proposal: ACCEPTED
  DB11 forged approved proposal + rule + version: ver ACCEPTED | prop ACCEPTED | rule ACCEPTED | hash ACCEPTED | state ACCEPTED
  DB12 live 6109 after forgery: 200 ["rr_forged1",0,"verified"]
  DB13 verify-audit (no export): true []
  DB14 verify-audit vs export before forgery: true []
  ```
  For contrast, the guards that do hold: DB1 (rule without proposal), DB2 (rate edit), DB5 (audit delete), DB6 (proposal edit), DB7/DB8 (key scope or pepper change), DB9 (state backwards) and DB10 (actor without grant) are all refused.
- **Required fix:** The core of the fix is detection, because a DB writer can also drop triggers.
  1. Make `verify-audit` (and the boot check) cross-check state against the HMAC'd log:
     - every `dataset_versions` row after the seed has a `proposal.approved` (or `dataset.seeded`/`restored`) audit entry naming that version and its `content_hash`. Add the content hash to the approval audit details.
     - every approved proposal has an approval entry whose `rule_sha256` equals the live rule row.
     - every voided or end-dated rule has the approval entry of the proposal that did it.
     - every `api_keys` and `admin_actors` row has its creation entry.
     - Report any orphan as a problem; at boot, fail readiness the same way as a hash mismatch.
  2. Add a `rate_proposals` BEFORE INSERT trigger: `status='pending'` and all `decided_*` NULL.
  3. Bind the rule update guard. `status → voided` needs `voided_by_rule` to be a rule whose `proposal_id` is an approved `correct` with `supersedes_rule_id = old.rule_id`. Setting `effective_to`/`end_dated_in_version` needs an approved `end_date`/`supersede` proposal targeting this rule with `resulting_version = new.end_dated_in_version`. Setting `verified_by` needs an approved `verify` proposal for it.
  4. Bind the add_code guard to `$.parent`, `$.type` and `$.description`, and the description guard to `$.code = new.code`.
  5. Optionally have `verify-audit` check the Ed25519 signature of every version when a public key is configured.
  6. Add tests that perform the forgery and expect `verify-audit` to fail.

### SA-C2-03: One admin can silence a detected CBIC rate notification (Low)

- **Where:** `src/routes/admin.ts:451-490` (triage) and `:538-568` (resolve).
- **Issue:**
  - Triage and resolve are single-actor actions.
  - One admin, or one stolen admin key, can dismiss a watcher-detected notification, or re-triage its `affected_prefixes` to unrelated codes. That removes the `pending_change_detected` warning from the real codes and stops the 2-business-day SLA alert.
  - Rates themselves still need two actors, and these actions are audited, so this hides rather than changes data.
- **Required fix:** pick one of the following.
  - Require a second actor to dismiss a `cbic_watcher` row: a two-step confirm, or a `refdata_change`-style proposal.
  - Or allow `published` only when an approved proposal references the notification.
  - At least, log dismissals of watcher rows at warn level with `alert: true`.

### SA-C2-04: A disabled actor's pending proposals stay approvable, and there is no way to disable an actor (Low)

- **Where:**
  - `src/services/proposals.ts:642-653`: `loadForDecision` does not check whether the proposer is disabled.
  - `src/repositories/sqlite/actors.ts:20`: `disable()` exists, but no route or script calls it.
  - `docs/05-security-checklist.md` SEC-82: the runbook says "disable the actor (this withdraws their pending proposals)".
- **Proof:** `DP2 approve proposal of disabled actor 200 approved`.
- **Issue:** The documented incident response for a compromised admin cannot be carried out. A compromised admin's queued proposals stay one click from publication.
- **Required fix:**
  1. Add `scripts/disable-actor.ts` (audited). It sets `disabled_at` and withdraws that actor's pending proposals in the same transaction.
  2. `loadForDecision` refuses proposals whose proposer is disabled.
  3. Add tests for both.

### SA-C2-05: An admin grant for an existing actor can be proposed by someone else and used later by whoever runs the CLI (Low)

- **Where:** `src/services/proposals.ts:555-567`, `src/services/apiKeys.ts:108-131`, `scripts/create-key.ts`.
- **Issue:**
  - `amit` can propose "one more key for priya" (`new_actor: false`), and priya can approve it. The checker is a different actor, so the approval is valid (`G4`/`G5`).
  - Whoever then runs `create-key --grant` receives priya's key. If amit has CLI access, he now holds keys for two actors and can approve his own changes.
  - Grants never expire, so an approved, unused grant is a standing key-minting token.
  - Precondition: CLI access to the host. Ruling 17 accepts host-level bypass, which is why this is Low.
- **Required fix:**
  1. For `new_actor: false`, require the proposer to be the grant's handle: an actor requests their own extra key, and a different actor approves it.
  2. Expire unused grants (for example after 7 days, checked in `createApiKey` and in the trigger).
  3. Print `issued_by` in the `admin.key_issued` warn line.

### SA-C2-06: `feed_epoch` changes only if the operator remembers a manual step after a restore (Low; ruling 25)

- **Where:** `src/services/dataset.ts:52` (the epoch is set only on the first publish) and `scripts/rotate-feed-epoch.ts`.
- **Issue:**
  - After a restore, clients whose `since` lies between the restored and the old `last_change_seq` get 410 only until new changes push the sequence past their cursor.
  - After that they silently skip the changes they missed, and they keep the rows that were rolled back.
  - Unless someone runs `rotate-feed-epoch`, nothing signals the restore. `verify-audit --head` flags it, but only if it is run.
- **Required fix:** Detect a restore automatically at boot. For example, keep the last served `(feed_epoch, last_change_seq, audit_head_id)` in a small sidecar file outside the database, or compare against the last exported head. On regression, rotate the epoch and log `alert: true`.

### SA-C2-07: `/metrics` is open to anyone who can reach the admin listener (Info)

- **Where:** `src/routes/metrics.ts:15-18`, `src/config.ts:81`.
- **Issue:**
  - The admin listener binds 127.0.0.1 by default, and the allow-list applies when it is set.
  - But `HSN_ADMIN_HOST=0.0.0.0` with no `HSN_ADMIN_IP_ALLOWLIST` is accepted in production, which exposes `/metrics` (counts, dataset version, watcher timestamps) to anyone who can reach that port.
  - The admin routes on that listener still need an admin key.
- **Suggested fix:** in production, refuse a non-loopback `HSN_ADMIN_HOST` without an allow-list, or at least log a warning.

### SA-C2-08: The watcher keeps hidden rows and markup-looking titles; a hostile page can pre-claim notification keys (Info)

- **Proof** (`WH1`):
  - a row with `style="display:none"` becomes `central_tax_rate:99/2026`;
  - a title is stored as `"… <script>alert(1)</script>"` (decoded text, never executed).
- **Issue:**
  - This is harmless while there is no UI (ruling 21 requires text-only rendering in any future UI).
  - A hostile page can insert future keys (for example `99/2026`) so that the real notification is skipped as "already present" when it appears.
- **Suggested fix:** let a later run update a still-`detected` row's title and URL when the key matches, or flag it, and mention this in the runbook.

### SA-C2-09: LRU bounds let a client with many IPv6 /64s evict its own throttle state (Info)

- **Where:** `src/lib/rateLimit.ts:57-61` and `:136-141`.
- **Issue:** About 100k fresh /64s evict the attacker's own unauth bucket or block. This does not matter for 256-bit keys; recorded only so that nobody relies on the block as a hard control.

## Checklist status (core scope, round 2)

| Status | Items |
|---|---|
| PASS | SEC-01, 02, 03, 05, 08, 09, 11–31 (24 with the recorded deviation), 39–42, 50, 51, 52, 57, 59, 61, 62, 63, 66, 67, 69, 70, 71, 73–76, 78, 83 |
| FAIL | SEC-53 / ruling 18 (SA-C2-02: tamper evidence bypassable without the audit key), SEC-79 (SA-C2-01: super-linear regexes on untrusted input), SEC-82 (SA-C2-04: the "disable the actor" runbook step has no implementation) |
| N/A (other auditor) | SEC-07, 10, 32–38, 56, 60 (classifier and outbound adapters other than the watcher's `getText`) |
| N/A (ops or docs) | SEC-58, 64, 68, 72, 80, 81, 84–90 |

## Final verdict

**FAIL.** Open: 0 Critical, 0 High, 2 Medium (SA-C2-01, SA-C2-02), 4 Low, 3 Info.

Fixing SA-C2-01 (linear parser and tests) and SA-C2-02 (state-to-audit cross-check in `verify-audit` and at boot, a `rate_proposals` insert guard and bound update guards) would turn this into a PASS. Maker–checker, idempotency, approval binding, retroactive handling, withdraw, pepper rotation, the unverified gate, the listener split and the migrations all held under attack.
