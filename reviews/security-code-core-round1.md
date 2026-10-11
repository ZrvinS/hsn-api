# Security code review: core (round 1)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-10.
Scope: every file in `server/src/` except `src/classify/` and `src/adapters/`, plus `scripts/*.ts`, `src/db/schema.sql`, `package.json`, `tsconfig.json`, and the tests that claim security coverage (`test/auth.test.ts`, `test/security.test.ts`, `test/admin.test.ts`, `test/feed.test.ts`, `test/helpers.ts`).
Spec: `docs/05-security-checklist.md` (§17 per-file checklist), `docs/00b-coordinator-rulings.md`, `docs/design/data-model.md`.
Method: I read every file in scope in full. I ran exploit scripts against `buildApp` through `app.inject`, plus direct unit-level probes, with `npx tsx` from `server/`. The scripts are in the session scratchpad (`scratchpad/audit/x1.mts`, `x2.mts`). I changed no repo files. The existing security tests pass (4 files, 74 tests). `npm audit --omit=dev` reports 0 vulnerabilities.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 3 | SA-C-01, SA-C-02, SA-C-03 |
| Medium | 5 | SA-C-04 … SA-C-08 |
| Low | 8 | SA-C-09 … SA-C-16 |
| Info | 4 | SA-C-17 … SA-C-20 |

Several areas are solid: HMAC-SHA256 key hashing with `timingSafeEqual` and a dummy compare on unknown prefixes, a uniform 401 body, scope declared on every route with deny by default, `additionalProperties:false` everywhere, `onProto/ConstructorPoisoning: 'error'`, all SQL bound with no user data interpolated (only the constant `COLS` and `active` strings), a robust FTS5 builder, a read-only request connection (`readOnly` + `query_only`), append-only triggers, a hash-chained audit log, a generic 500 without SQL text, and security headers on every response. Proposals cannot be edited after creation (the repo has no update path), so there is no approve-vs-edit TOCTOU. Approval re-validates inside one `BEGIN IMMEDIATE` transaction.

The three High findings are all about availability or rate integrity rather than authentication bypass.

## Per-file coverage

| File | Reviewed | Findings |
|---|---|---|
| package.json | ✓ | SA-C-16 |
| tsconfig.json | ✓ | SA-C-16 (rootDir `.` ⇒ `dist/src/main.js`, but `start` runs `dist/main.js`) |
| src/config.ts | ✓ | SA-C-04, SA-C-06 (allow-list entries not validated) |
| src/context.ts | ✓ | none |
| src/main.ts | ✓ | SA-C-04 (no prod sanity checks), SA-C-13 |
| src/app.ts | ✓ | SA-C-01, SA-C-07, SA-C-09 (string expiry compare), SA-C-18, SA-C-19 |
| src/db/schema.sql | ✓ | SA-C-02 (no prefix tie), SA-C-03 (CHECK compares raw strings), SA-C-14 |
| src/db/migrate.ts | ✓ | none (extensions off, `trusted_schema=OFF`, read-only conn) |
| src/db/seed.ts | ✓ | SA-C-17 |
| src/lib/apiKey.ts | ✓ | none (fixed-position parse, 256-bit secret, constant-time compare) |
| src/lib/canonicalJson.ts | ✓ | none |
| src/lib/clock.ts | ✓ | none |
| src/lib/dates.ts | ✓ | none |
| src/lib/etag.ts | ✓ | none |
| src/lib/fts.ts | ✓ | none (fuzzed; only quoted `[\p{L}\p{N}]+` tokens, max 10) |
| src/lib/ids.ts | ✓ | none (80-bit random ULID part, unbiased `%32`) |
| src/lib/ip.ts | ✓ | SA-C-06 |
| src/lib/money.ts | ✓ | none (string-based parse, BigInt; 1e21, 0.1+0.2 and 1.005 rejected) |
| src/lib/problem.ts | ✓ | none |
| src/lib/rateLimit.ts | ✓ | SA-C-05 |
| src/lib/redact.ts | ✓ | SA-C-10 |
| src/lib/requestId.ts | ✓ | SA-C-12 |
| src/repositories/types.ts | ✓ | none |
| src/repositories/sqlite/base.ts | ✓ | none (static SQL, cached statements) |
| src/repositories/sqlite/index.ts | ✓ | none (IMMEDIATE tx, rollback) |
| src/repositories/sqlite/apiKeys.ts | ✓ | none |
| src/repositories/sqlite/audit.ts | ✓ | SA-C-11 |
| src/repositories/sqlite/dataset.ts | ✓ | SA-C-11 (hash not signed or re-checked) |
| src/repositories/sqlite/hsn.ts | ✓ | none |
| src/repositories/sqlite/products.ts | ✓ | none |
| src/repositories/sqlite/proposals.ts | ✓ | none (no update path, so proposals are immutable) |
| src/repositories/sqlite/rateRules.ts | ✓ | none |
| src/repositories/sqlite/synonyms.ts | ✓ | none |
| src/routes/common.ts | ✓ | none |
| src/routes/health.ts | ✓ | SA-C-20 |
| src/routes/hsn.ts | ✓ | SA-C-15 |
| src/routes/rates.ts | ✓ | none (limit ≤ 500, integer `since`, 410) |
| src/routes/meta.ts | ✓ | none (no secrets; LLM disclosure only) |
| src/routes/tax.ts | ✓ | SA-C-07, SA-C-15 |
| src/routes/classify.ts | ✓ | none in core part (name fingerprint only, candidate code re-checked, rate from rate table) |
| src/routes/admin.ts | ✓ | SA-C-02, SA-C-11 |
| src/services/apiKeys.ts | ✓ | SA-C-03, SA-C-06 |
| src/services/audit.ts | ✓ | SA-C-11 |
| src/services/dataset.ts | ✓ | none |
| src/services/disclaimer.ts | ✓ | none |
| src/services/proposals.ts | ✓ | SA-C-02, SA-C-03, SA-C-14 |
| src/services/rates.ts | ✓ | none |
| src/services/tax.ts | ✓ | none (BigInt maths; 500 × 1e12 paise stays below MAX_SAFE_INTEGER) |
| scripts/create-key.ts | ✓ | SA-C-03, SA-C-06, SA-C-09 |
| scripts/seed.ts | ✓ | SA-C-04 (prod refusal keyed on NODE_ENV) |
| test/helpers.ts | ✓ | SA-C-08 (unauth limit raised to 600 hides SA-C-01) |
| test/auth.test.ts | ✓ | SA-C-08 |
| test/security.test.ts | ✓ | SA-C-08 |
| test/admin.test.ts | ✓ | SA-C-08 (no prefix-mismatch or actor-variant case) |
| test/feed.test.ts | ✓ | none |

`scripts/seedgen/*.mjs` are offline data generators. I skimmed them for secrets and network or exec calls, found none, and treat them as the data worker's scope.

## Findings

### SA-C-01: Anyone sharing an IP with legitimate clients can lock them out, including holders of valid keys (High)

- **Where:** `src/app.ts:177-184` (block and unauth-budget checks run before the key is verified, for every request), `src/app.ts:160` (each failure consumes the per-IP budget), `src/config.ts:70` (`HSN_TRUST_PROXY` defaults to empty).
- **Issue:** The per-IP unauthenticated bucket (default 60/min, burst 10) and the 15-minute brute-force block are checked before the key is verified. Once an IP's budget is drained, requests carrying a valid key also get 429. The code comment at app.ts:180-181 says "legitimate clients behind one NAT are unaffected". That is false. On a typical PaaS, `HSN_TRUST_PROXY` is unset, so `request.ip` is the platform proxy and every client shares one IP. An anonymous attacker can then take the API down for all customers, including POS checkout. 10 junk requests produce an immediate 429 for everyone. 20 junk requests within 5 minutes produce a 15-minute block for everyone, renewable indefinitely.
- **Proof** (default `HSN_RATE_LIMIT_UNAUTH_PER_MIN=60`; `test/helpers.ts` raises it to 600, which hides this):
  ```
  E5 valid key after 10 bad reqs from same IP: 429 Too many unauthenticated requests from this address.
  E5b XFF spoof does not escape block (trustProxy unset): 429
  ```
  `test/auth.test.ts:256-265` already asserts that a valid key from a blocked IP gets 429, which locks the DoS in as intended behaviour.
- **Required fix:**
  1. Verify the presented key first; key lookup is one indexed SELECT plus one HMAC, which is cheap. Apply the per-IP unauth budget and the block only to requests that fail authentication. A request with a valid, unrevoked key must never be refused because of other parties' failures from the same IP.
  2. Keep the pre-verification throttle only for requests with no or malformed credentials.
  3. In production, refuse to boot with an empty `HSN_TRUST_PROXY` unless `HSN_DIRECT_EXPOSURE=true` is set explicitly, and document it.
  4. Change the test to assert that a valid key from a blocked IP gets 200.

### SA-C-02: A `supersede` proposal can end-date any rule while adding a rule for an unrelated prefix (High)

- **Where:** `src/services/proposals.ts:239-248` (`validateAgainstPublished`: no check that `rule.hsn_prefix === target.hsn_prefix`), `src/services/proposals.ts:413-415` (end-dates the target), `src/routes/admin.ts:106`. The schema has no constraint either.
- **Issue:** A supersede ends the target rule the day before the new rule starts, but the new rule may be for any prefix. A maker can file a harmless-looking chapter-01 rule that "supersedes" the `9988` rule with `effective_from: 2017-07-02`. On approval, that silently removes 9988's rate coverage for all dates. The reviewer sees `supersedes_rule_id` only as an opaque `rr_…` id. Retroactive `effective_from` values are also accepted, so history can be rewritten.
- **Proof:**
  ```
  E3 create mismatched supersede 201 rp_01M4J6B5R08P14PPW8HMCHVPX6
  E3 approve 200 approved
  E3 9988 after: 200 {"hsn_queried":"998892",...,"coverage":"no_rate_rule","applicable_rule":null,...}
  E3 9988 rule row "2017-07-01"      (effective_to now equals its own start)
  ```
- **Required fix:**
  1. Reject a supersede (400) when `rule.hsn_prefix !== target.hsn_prefix`, in both `create` and `approve`. Optionally add a trigger that rejects an insert whose `superseded_by` link crosses prefixes.
  2. Include the target rule's prefix, rate and dates in the proposal DTO so the checker sees what is being ended.
  3. Require an explicit `retroactive: true` flag, and add a warning in the audit details, when `effective_from` or `end_date` is earlier than today in IST.
  4. Add tests for both.

### SA-C-03: The maker–checker identity is a free-text, unnormalised `actor`, so one human can approve their own change (High; SEC-50 is a Critical control)

- **Where:** `scripts/create-key.ts:66` (`--actor` is taken verbatim), `src/services/apiKeys.ts:24` (only checks it is non-empty), `src/services/proposals.ts:369,463` and `schema.sql:116` (exact string comparison).
- **Issue:** SEC-50 requires comparison "on owner identity". In the code, identity is whatever string was typed when the key was issued. `ravi`, `Ravi ` and `ravi​` are three different checkers. Nothing ties an actor to a registered human, and nothing stops a second admin key being issued under a near-duplicate name, for example during a "rotation".
- **Proof:**
  ```
  E2 create by ravi 201 rp_01M4J6B5R0D3ZSV4P6F89QPHRJ
  E2 approve by "Ravi " (same human) 200 approved Ravi
  E2 live 7113 rate now 0 verified          (gold jewellery at 0%, marked verified)
  ```
- **Required fix:**
  1. Validate `actor` against a strict slug, `^[a-z][a-z0-9._-]{1,63}$`, after NFKC, trim and lower-casing, in `createApiKey` itself rather than only in the CLI.
  2. Add an `admins` table (actor, display name, created_at, disabled_at), referenced by a foreign key from `api_keys.actor`. Creating an admin key for an unknown actor must fail; a new human is added through an explicit, audited step.
  3. Compare normalised actors in the service and in the CHECK constraint.
  4. Test with case and whitespace variants.

### SA-C-04: Fail-closed production checks depend on NODE_ENV, which defaults to `development` (Medium)

- **Where:** `src/config.ts:64` (`.default('development')`), `src/config.ts:109` (pepper is required only when `production`), `scripts/seed.ts:27-29`, `src/main.ts` (no other guard).
- **Issue:** A deployment that forgets `NODE_ENV=production` boots with an empty HMAC pepper. The seed script's production refusal is also skipped, and the seed can write rules marked `verified` (SA-C-17). An empty pepper is not directly exploitable because secrets are 256-bit, but this breaks the fail-closed requirement in SEC-08 and SEC-57.
- **Proof:** `E8 NODE_ENV omitted -> development pepper length 0`
- **Required fix:** Make `NODE_ENV` required, with no default, in `main.ts` and the scripts, or have `main.ts` refuse to start unless it is `production` or an explicit `HSN_ALLOW_DEV=true` is set. Require `HSN_KEY_PEPPER` of at least 32 characters whenever `NODE_ENV !== 'test'`. Add a boot-failure test that runs `main.ts` as a child process.

### SA-C-05: Rate-limiter state can be wiped or grown by an attacker (Medium)

- **Where:** `src/lib/rateLimit.ts:66-71` (`evict` clears all buckets if nothing is full), `:117` (`fails.clear()` above 100k entries), `:96` (`blockedUntil` is unbounded).
- **Issue:** Every failed authentication from a new IP creates an `unauth:<ip>` bucket. A freshly used bucket is never full, so when the map reaches 100k entries `evict` deletes nothing and then calls `clear()`. That resets every per-key bucket. With one IPv6 /64, an attacker can reset all customers' rate limits, and the brute-force counters, on demand. `blockedUntil` entries are only removed when the same IP comes back.
- **Proof** (`maxEntries` scaled down to 1000):
  ```
  E10 victim drained, allowed? false
  E10 after 1000 fresh attacker IPs (maxEntries=1000), victim allowed? true remaining 98
  ```
- **Required fix:**
  1. Keep separate limiter instances for `unauth:` and `key:` buckets, so unauthenticated traffic can never evict key buckets.
  2. Use LRU eviction of the oldest `updatedMs` instead of `clear()`.
  3. Key unauthenticated and brute-force state for IPv6 by /64.
  4. Bound and periodically sweep `blockedUntil`.

### SA-C-06: Admin key hygiene and the admin IP allow-list (Medium)

- **Where:** `src/services/apiKeys.ts:23-30`, `scripts/create-key.ts:53-57`, `src/lib/ip.ts:20-27`, `src/config.ts:84`.
- **Issues:**
  1. SEC-18 requires admin keys to be distinct keys, not a client key with an admin scope added. `createApiKey` and the CLI accept `--scopes read,admin`. Proof: `E4 mixed key read 200 admin 200`.
  2. `HSN_ADMIN_IP_ALLOWLIST` entries are not validated at boot, and the matcher has a footgun. `"10.0.0.1/"` parses `Number('')` as 0, so the prefix length is 0 and the entry allows every IPv4 address (`E9 … allows 203.0.113.5? true`). IPv6 CIDRs are silently ignored; this fails closed but is surprising.
  3. No test covers SEC-18.
- **Required fix:** Reject `admin` combined with any other scope. Validate each allow-list entry at boot with zod: strict IPv4 or IPv6, or a CIDR with an explicit integer prefix length, `^\d{1,3}$`. Support IPv6 CIDRs or reject them. Add a test that an allow-list with a non-matching IP gets 403.

### SA-C-07: `/v1/tax/calculate` cost is not proportional to work (Medium; SEC-04, SEC-77)

- **Where:** `src/routes/tax.ts:29` (`config: { scope: 'read' }`, cost 1, no quota), `src/app.ts:206`.
- **Issue:** A request with 500 lines costs one token but runs up to 500 `rulesInForce` queries plus a `getMany`. Measured at about 24 times a lookup. With the default 600/min and burst 100, one key can pin a core for seconds per burst. Several keys multiply this.
- **Proof:** `E6 tax 500 lines: 21.9 ms/request … ; E6 baseline GET hsn: 0.9 ms/request`
- **Required fix:** Charge `cost = 1 + ceil(lines/10)`, applied after body parse in a `preHandler` that takes the extra tokens. Alternatively, count lines against the daily quota. Memoise `resolve(code, date, price)` per request.

### SA-C-08: The security tests do not prove what they claim (Medium; the checklist says a missing test is a FAIL)

- **Where and what:**
  - `test/auth.test.ts:222-229` (SEC-05): "a route registered without config.scope fails boot" builds a new Fastify with its own hook. It never exercises `buildApp`'s hook, so it is tautological.
  - SEC-02 and SEC-09: no enumeration of the real route table (`printRoutes()` or an `onRoute` capture) asserting that every non-health route is authenticated, and no route snapshot.
  - SEC-01: the admin matrix omits `GET /v1/admin/rate-proposals/:id`.
  - SEC-23: no test that `X-Forwarded-For` is ignored when `HSN_TRUST_PROXY` is unset, or honoured only from a trusted CIDR.
  - SEC-18: no test of the admin IP allow-list (see SA-C-06).
  - SEC-21: block expiry after 15 minutes with the fake clock is not tested.
  - `test/helpers.ts:59` sets the unauth limit to 600/min, so no test runs with the default 60 (this masked SA-C-01).
  - SEC-50: no actor-variant test (SA-C-03). SEC-51 and SEC-52: no prefix-mismatch supersede test (SA-C-02).
  - SEC-08 and SEC-57: config tests call `loadConfig` only. Nothing proves that `main.ts` exits non-zero.
- **Required fix:** Add the tests above against `buildApp` and the real `main.ts`, as a child process for the boot tests.

### SA-C-09: Key expiry is a free-form string compared lexicographically (Low)

- **Where:** `scripts/create-key.ts:71` (`--expires` not validated), `src/app.ts:193` (`row.expires_at <= nowIso`).
- **Issue:** `--expires tomorrow` on a non-admin key never expires, because `"tomorrow" > "2026-…"`. A value with milliseconds, such as `…00.000Z`, sorts before `…00Z`. Admin keys are capped, but a bad value is silently replaced.
- **Required fix:** Validate RFC 3339 UTC in `createApiKey`, normalise with `rfc3339(new Date(x))`, and reject past dates. Compare as epoch milliseconds.

### SA-C-10: `truncateIp` mishandles IPv6 and leaks host bits (Low; SEC-63)

- **Where:** `src/lib/redact.ts:30-33`.
- **Proof:** `2001::5:6 -> 2001::5::/48`, `fe80::1234:5678 -> fe80::1234::/48`, `::1 -> ::1::/48`. The low-order groups leak, and the output is not a /48.
- **Required fix:** Expand the address to 8 groups first (`net.SocketAddress` or a manual `::` expansion), then keep 3 groups.

### SA-C-11: Audit chain and dataset integrity gaps (Low; SEC-53, SEC-54)

- **Where:** `src/services/audit.ts:76-86`, `src/routes/admin.ts:256-275`, `src/repositories/sqlite/dataset.ts:66-82`.
- **Issues:**
  1. Verification cannot detect truncation of the newest rows: with triggers dropped, delete the last N entries and the chain still verifies. Nothing compares against an external anchor. Head hashes are logged, but the route does not use them.
  2. With an `entity_type` filter, `verifyFromRepo` loads the full id span between the first and last match, which is unbounded (admin-only memory DoS).
  3. `content_hash` is stored by the same writer that could tamper with rules. It is not re-verified at boot or by `/readyz`, and there is no optional Ed25519 signature.
- **Required fix:**
  1. Return `head_id` and `head_hash` from `/admin/audit`, and document comparing them with logged and backed-up heads.
  2. Cap the span (for example 10,000 ids) or verify filtered pages by walking in chunks.
  3. Recompute `computeContentHash()` at boot and compare it with `dataset_versions.content_hash`; log an error and fail readiness on mismatch.
  4. Implement `HSN_DATASET_SIGNING_KEY` when it is configured.

### SA-C-12: A client-supplied `X-Request-Id` is adopted as the server request id (Low)

- **Where:** `src/lib/requestId.ts:7`.
- **Issue:** The charset is safe, so there is no log injection. But clients can reuse another tenant's request id, or a fixed one, to confuse log correlation and incident review (SEC-63, SEC-82).
- **Required fix:** Always generate `req_<ULID>` and log the client value separately as `client_request_id`.

### SA-C-13: The classifier logger in `main.ts` bypasses pino redaction (Low; SEC-61, SEC-62)

- **Where:** `src/main.ts:40-44`.
- **Issue:** The `consoleLog` passed to the classifier writes `JSON.stringify(o)` straight to stdout, with no `REDACT_PATHS`, no `scrubKeys` and no request id. Any classifier log that carries a name or upstream payload goes out raw.
- **Required fix:** Pass `app.log.child({ component: 'classifier' })`, which is pino with redaction. Build the app logger first, or create a pino instance with the same redact config.

### SA-C-14: Rule prefixes may have odd length or no matching HSN (Low)

- **Where:** `src/services/proposals.ts:129`, `src/routes/admin.ts:17`, `schema.sql:124`.
- **Issue:** `^\d{2,8}$` accepts 3, 5 and 7-digit prefixes. For example `711` applies to 7111 through 7119, across headings, and is easy to approve unnoticed. There is no check that the prefix, or at least its chapter, exists in `hsn_codes`.
- **Required fix:** Require a length in {2, 4, 6, 8} and that the prefix exists in `hsn_codes`, in zod or JSON schema, the service and a schema CHECK.

### SA-C-15: Limits deviate from the checklist (Low)

- `src/routes/hsn.ts:23`: `q` is 2–200 characters; SEC-27 says 1–100.
- `src/routes/tax.ts:30`: `bodyLimit` is 256 KiB; SEC-24 says 64 KiB globally.
- **Required fix:** Align the code with the checklist, or record the deviation in 00b rulings and the security checklist.

### SA-C-16: Runtime pinning and build output (Low; SEC-69)

- `package.json:6-8`: `engines.node` is `>=22.13`, not pinned to 22.x, and there is no `.nvmrc`. `node:sqlite` is still experimental on 22.
- `package.json:11` with `tsconfig.json` (`rootDir: "."`, includes `test`): `tsc` emits `dist/src/main.js` and also compiles tests into `dist`. `npm start` (`node dist/main.js`) would fail.
- **Required fix:** Pin `"node": "22.x"` and add `.nvmrc`. Use a separate `tsconfig.build.json` (rootDir `src`, excluding test) or fix the start path.

### SA-C-17: Seed files can mark rules `verified` with any `verified_by` (Info)

- `src/db/seed.ts:352-354,503`. This writes directly, without maker–checker, in non-production and into an empty DB only. Given SA-C-04, also require that seeds be `unverified`, or log loudly and record the verifier list in the `dataset.seeded` audit entry.

### SA-C-18: `Vary: Origin` is only sent for allowed origins (Info)

- `src/app.ts:140-142`. When `HSN_CORS_ORIGINS` is set, send `Vary: Origin` on every response so shared caches cannot mix CORS and non-CORS variants.

### SA-C-19: Key cache (Info)

- `src/app.ts:147-157`. Unknown prefixes are cached negatively, and the cache is cleared when it exceeds 10k entries, so random-prefix floods cause cache churn. Revocation still honours the TTL of 60 seconds or less. Acceptable; consider an LRU and skipping negative caching.

### SA-C-20: `/readyz` runs DDL on the write connection, unauthenticated (Info)

- `src/routes/health.ts:19` creates and drops a temp FTS table on `writeDb` per probe. Use a one-time boot check or the read connection (temp schema), and rate-limit public probes.

## Checklist status (core scope)

| Status | Items |
|---|---|
| PASS | SEC-01 (code), 03, 11, 12, 13, 14, 15, 16, 17, 19 (key bucket), 20, 22, 24 (with deviation), 25, 26, 28, 29, 30, 31, 39, 40, 41, 42, 52, 59, 61, 62, 66, 67, 70, 71, 73, 74, 75, 76, 78, 83 (admin-writes switch tested) |
| FAIL | SEC-02 test (SA-C-08), 05 test (SA-C-08), 08 / 57 (SA-C-04), 09 (no route snapshot), 18 (SA-C-06), 21 (SA-C-01 side effect, SA-C-05), 23 test (SA-C-08), 50 (SA-C-03), 51 / 52 semantics (SA-C-02), 53 (partial, SA-C-11), 63 (SA-C-10, SA-C-12), 69 (SA-C-16) |
| N/A (other auditor) | SEC-07, 10, 32–38, 56, 60 (classify and adapters) |
| N/A (ops or docs) | SEC-58 CI scan (no CI config in repo; grep found no key literals), 64, 68, 72, 80–82, 84–90 |
| Review only | SEC-79: every regex on user input is anchored and linear. The config hostname regex has nested quantifiers but runs only on env input of at most 4000 characters, so it is acceptable. |
