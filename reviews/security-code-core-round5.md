# Security code review: core (round 5)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-11.

**Scope:** "Round 9" of `reviews/code-fix-core-round2.md`. Round 7 (the SA-C4 fixes) is re-confirmed in passing. Files read:
- `src/db/migrations.ts` v8, compared with the original `rate_rules_guard_update` in `schema.sql` and with the v5 `rate_rules_guard_bind`;
- `src/services/proposals.ts`: `sourceUrlProblem`, `isDocumentUrl`, `normaliseNotificationRef`, `verifySource`, `toRuleInput`;
- `src/services/integrity.ts` (the ruling-36 citation check);
- `src/app.ts`: Ajv `allErrors`, `ajvToFieldErrors`, the error handler;
- `src/config.ts`: `HSN_SOURCE_INDEX_PAGES`, `HSN_KNOWN_GAPS_FILE`;
- `src/services/knownGaps.ts`, `src/routes/meta.ts`, `src/repositories/sqlite/rateRules.ts` (`codesWithoutRules`), `src/routes/common.ts` (`withEtag`);
- `test/docs/traceability.test.ts`.

**Method:**
- **New exploits:**
  - `r5a.mts`: verify URL variants, v8 trigger by direct SQL, a competing verify, cross-check versus content hash, normalisation, `allErrors` bodies, and known-gaps loading.
  - `r5b.mts`: Ajv with and without `allErrors`, and the cost through the real app compared with a legitimate 500-line request.
  - `r5perf.mts`: the `codesWithoutRules` SQL at master scale.
  - `r4a` was re-run to confirm round 7.
- **Server:** none started; everything used `inject`.
- **Location:** all scripts are in the session scratchpad `audit/`. I changed no repo files.
- **Suite:** `vitest run`: 895 of 895 pass in 38 files. The seed fixture and `seed.ts` were being edited during the audit; the run at 20:35 was green.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 2 | SA-C5-01, SA-C5-02 |
| Low | 0 | none |
| Info | 4 | SA-C5-03 … SA-C5-06 |

**Verdict: FAIL** (two open Medium).

The ruling-36 citation path is sound: the v8 trigger, the verify service, the cross-check and the normalisation all hold. Both Mediums are CPU denial of service that any read key can trigger; both were introduced by the Round-9 polish items:
- SA-C5-01 comes from Ajv `allErrors` on the 256 KiB tax body.
- SA-C5-02 comes from `coverage.codes_without_rules`, which costs seconds at full-master scale and is recomputed on every request.

## Ruling 36: what held

- **v8 trigger, direct SQL (V3, V6, V7):** each of the following is refused:
  - changing `source_url` on an unverified rule;
  - changing it while marking the rule verified, without a proposal;
  - changing it on a verified rule, with or without a `last_verified_at` move;
  - reusing another rule's approved verify, with its `decided_at` and URL, on a different unverified rule.
- **v8 diff:** the trigger is otherwise identical to the original guard. The citation exemption requires all of the following:
  - the rule moves from unverified to verified;
  - an approved verify proposal targets this rule, with `decided_at = new.last_verified_at`;
  - the new values equal that proposal's payload, or are unchanged.
  The v5 `rate_rules_guard_bind` still binds `verified_by`, `last_verified_at` and `source_pdf_sha256` to the same proposal.
- **Service:**
  - **V5 (re-verify):** `url`/`notification` on an already-verified rule returns 400.
  - **V5 (competing verify):** a second pending verify with a different URL gets 409 `rule_not_active` once the first is approved, through the `target_sha256` binding.
  - **V4:** the approved citation is exactly the proposal's. `notification` `010/2025-CT(Rate)` is stored as `10/2025-CT(Rate)` and `citation_note` becomes NULL. Afterwards the cross-check and content hash are OK.
- **Host and look-alike checks (V1):** each of these is refused:
  - a `/view-pdf/` path on another host;
  - `cbic-gst.gov.in.evil.example`;
  - a trailing-dot host;
  - http;
  - port 8443;
  - userinfo;
  - a URL over 2000 characters.
- **Index-page variants (V1):** `?x=1`, `#frag`, an upper-case host and a trailing slash on the default index pages are all refused. They are `.html` paths, so the path test rejects them whatever the decoration.
- **Cross-check (V8):** a citation forged behind the trigger on a verified rule is flagged ("differ from its latest verify approval audit entry"), and the content hash also mismatches.
- **Cross-check (V9):** on a still-unverified seed rule the cross-check does not see a forged citation, but the content hash mismatches, which fails the boot check and `verify-audit`. Acceptable.
- **Normalisation:**
  - `normaliseNotificationRef` is linear: 280 leading zeros take 0.01 ms, and inputs are capped at 300 characters.
  - `0/2026` and `10/2026` are unchanged.
  - Multiple refs in one string are each unpadded.
  - The hash binding uses the normalised value, as does the v8 comparison.
- **Round 7 re-confirmed (`r4a`):**
  - **P1:** flipping `tenant`, `llm_opt_out` or `rate_limit_per_min` is flagged.
  - **P3:** a SQL dismiss of a keyed row is flagged.
  - **X1b–X4, P2, P5:** results unchanged.
  - **P9 (legitimate flow):** clean.

## Findings

### SA-C5-01: `allErrors` turns one invalid tax request into about 0.3–0.4 s of event-loop CPU for one rate-limit token (Medium; regression, SEC-22 / ruling 25)

- **Where:**
  - `src/app.ts:188`: `ajv: { customOptions: { …, allErrors: true } }`;
  - `ajvToFieldErrors` maps every Ajv error before the slice to 50;
  - `POST /v1/tax/calculate` has `bodyLimit` 256 KiB, `scope: 'read'`, and `extraCost` charged only after validation.
- **Issue:**
  - Without `allErrors`, Ajv stops at the first failure: the `maxItems: 500` breach, or the first bad item.
  - With it, Ajv validates every element of an oversized `lines` array and builds an error object for each failed keyword. The app then maps and deduplicates all of them.
  - A body of 85,000 `{}` items produces 255,000 errors.
  - The request fails validation, so it is charged the base cost of 1 token; a legitimate 500-line request is charged 11.
  - node:sqlite and validation are synchronous, so this blocks the single event loop. At the default 600 requests per minute, one read key buys about 4 s of CPU per second, which is enough to stall every listener. Several keys make it worse.
- **Proof** (`r5b`, `r5a`):
  ```
  ajv allErrors=false: 0.2 ms, errors 1
  ajv allErrors=true: 59.8 ms, errors 255001
  legit 500 lines 28KiB 200  median 6 ms   (11 tokens)
  85k empty items 249KiB 400 median 430 ms (1 token)
  85k bare numbers 234KiB 400 median 218 ms (1 token)
  E 60k empty items body 176KiB 400 289-349ms errors 50 ... 180001 problems
  ```
- **Required fix:** any one of the following.
  - Before validation (a `preValidation` hook, or a cheap structural check), reject any array longer than its `maxItems` with a single error.
  - Charge `extraCost` from the raw `lines.length`, so a 85k-item body costs about 1,700 tokens.
  - Compile the large-body routes, at least tax, without `allErrors`.

  Add a test that an 85k-item body is answered in under 20 ms, or costs at least `floor(n/50)` tokens.

### SA-C5-02: `coverage.codes_without_rules` is O(codes × rules) on every `GET /v1/meta/dataset` (Medium at full-master scale; SEC-22)

- **Where:**
  - `src/repositories/sqlite/rateRules.ts:89`: a correlated `NOT EXISTS` with `substr(…)` comparisons in both directions, which no index can serve;
  - `src/routes/meta.ts`: called inside `withEtag`'s `build()`, which runs before the `If-None-Match` comparison, so even a 304 pays for it;
  - the endpoint is `scope: 'read'`, cost 1.
- **Issue:**
  - With the shipped seed (356 codes, 81 rules) it takes 5 ms.
  - The documented exit condition of the classifier gate is "the full HSN master loaded", and `dataset_import` exists to load it. At that size, each request blocks the event loop for seconds, and any read key can call it 10 times a second.
- **Proof** (`r5perf`: the same SQL and index shape in node:sqlite, worst case of codes mostly without rules):
  ```
  codes 356 rules 81: 5 ms
  codes 5000 rules 500: 448 ms
  codes 12000 rules 1500: 2915 ms
  codes 20000 rules 3000: 9464 ms
  ```
- **Required fix:**
  - Compute the value once per `(dataset_version, today)` and cache it in memory; it changes only with those.
  - Or make the meta `build()` lazy behind the ETag, whose inputs are the version and the date.
  - Optionally rewrite the query with prefix ranges (`h.code >= r.hsn_prefix AND h.code < r.hsn_prefix || 'x'`, plus a parent walk) so an index can serve it.

### SA-C5-03: The document-URL test is a path heuristic; a configured index page can be bypassed by decoration (Info; ruling 36)

- **Where:** `isDocumentUrl`. It matches the index set by exact `href`, then accepts any path that contains `/view-pdf/` or ends in `.pdf`, case-insensitively. The stored `url` is the string as submitted.
- **Issue:**
  - **Accepted although not documents (V1):**
    - `https://cbic-gst.gov.in/central-tax-rate.html;.pdf`
    - `…/central-tax-rate.html/view-pdf/x`
    - `…/%2E%2E/view-pdf/1`
    - `…/a/../view-pdf/1` (normalised by URL)
    - `…/x.pdf?redirect=https://evil.example`, stored and served with the query string.
  - **Configured index pages that look like documents (V2):** for `HSN_SOURCE_INDEX_PAGES=…/pdf/listing.pdf`, the variants `?a=1`, `#x`, `LISTING.PDF` and `//listing.pdf` all count as documents.
  - The defaults are `.html`, so they are not affected. Maker–checker review and the `pdf_sha256` binding remain the real control.
- **Suggestion:**
  - Compare index pages on origin plus lower-cased path, with query and fragment ignored and repeated slashes collapsed.
  - Refuse query strings and fragments in citation URLs, or store `origin + pathname` only.
  - Refuse a path containing `;`, `%2e` or `%2f`.

### SA-C5-04: Known-gaps file handling fails open on a missing explicit path (Info)

- **Where:** `src/services/knownGaps.ts`, `config.ts:163`.
- **Issue:**
  - A missing file returns `[]` even when `HSN_KNOWN_GAPS_FILE` was set explicitly, so a typo silently serves "no known gaps".
  - The path is not validated: relative paths resolve against the process's working directory, and `../../etc/x.json` is accepted in production.
  - There is no size cap; `/dev/zero` would hang the boot.
  - A non-JSON file's parse error quotes its first characters (`"SECRET_TOK"...`). This reaches only the boot error output, never clients.
  - The variable is operator-set, so this is not attacker-reachable.
  - Malformed content fails the boot correctly, and the strict zod schema caps the file at 200 items with 500-character reasons.
- **Suggestion:** treat an explicitly set but missing file as a boot error, require an absolute path in production, cap the size (for example 256 KiB), and report "not valid JSON" without the parser's excerpt.

### SA-C5-05: Validation errors reflect submitted property names unbounded (Info; SEC-75)

- **Where:** `ajvToFieldErrors` appends `params.additionalProperty` to the pointer verbatim, without RFC 6901 escaping (`~`, `/`) and without a length cap.
- **Issue:**
  - A 200 KB key comes back as a 200 KB `problem+json` response (V-E "long reflected key": 200,485 bytes).
  - With `allErrors`, up to 50 keys can be reflected.
  - The content type is `application/problem+json` and values are never echoed, so there is no injection risk, only reflection and amplification.
- **Suggestion:** escape the pointer and truncate any property name over 100 characters.

### SA-C5-06: The traceability test passes silently when the TRD is absent, and its default path differs from the fix doc (Info)

- **Where:** `test/docs/traceability.test.ts:13`. The default is `/mnt/project-files/hsn-api/docs/02-TRD.md`; the fix doc says `docs/02-TRD.md`.
- **Issue:**
  - When the file is missing the test only warns and passes, so a CI run without the docs never enforces the table.
  - The test is read-only: the cited `file` is joined under `test/` and must end in `.test.ts`. It is not shipped code, and I found no security issue in it.
- **Suggestion:** fail when `CI=true` and the TRD is missing, and correct the doc or the default path.

## Checklist status (core scope, round 5)

| Status | Items |
|---|---|
| PASS | Ruling 36 (verify citation replacement, v8, cross-check); ruling 18/20 bindings; SEC-51 citation URL host rules (T-A07); SEC-75 (no values reflected); round-7 fixes SA-C4-01/02/05 |
| FAIL | SEC-22 / ruling 25 (cost and rate limiting): SA-C5-01 (`allErrors` amplification on tax) and SA-C5-02 (`codes_without_rules` per-request cost) |
| N/A | classifier; ops and docs items |

## Final verdict

**FAIL.** Open: 0 Critical, 0 High, 2 Medium (SA-C5-01, SA-C5-02), 0 Low, 4 Info (SA-C5-03 … SA-C5-06).

Both Mediums are small, local fixes:
- **SA-C5-01:** bound or charge oversized arrays before validation, or drop `allErrors` for the tax route.
- **SA-C5-02:** cache `codes_without_rules` per dataset version and day, or build the meta body lazily behind the ETag.

With both fixed and regression-tested, the core verdict becomes PASS. The ruling-36 path needs no change for security.
