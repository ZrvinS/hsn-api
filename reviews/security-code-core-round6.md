# Security code review: core (round 6, re-check)

Auditor: security auditor (code, part 1 of 2). Date: 2026-10-11.

**Scope:** "Round 10" and "Round 10, part 2" of `reviews/code-fix-core-round2.md`. Files read in full or in every changed part:
- `src/lib/schemaGuard.ts` (new);
- `src/app.ts`: the pre-validation cost hook, the shape guard hook, and `ajvToFieldErrors` with its echo caps;
- `src/routes/tax.ts` (`extraCost` from the raw `lines`);
- `src/lib/rateLimit.ts` (`take` with a large cost);
- `src/services/proposals.ts`:
  - `sourceUrlProblem`, `documentUrlProblem`, `indexPageKey`;
  - `normaliseNotificationRef`, `NOTIFICATION_REF_RE`, `notificationRefProblem`;
- `src/repositories/sqlite/rateRules.ts` (`codesWithoutRules`, `stats` source counts);
- `src/routes/meta.ts` (coverage cache);
- `src/services/knownGaps.ts`, `src/config.ts` (`HSN_KNOWN_GAPS_FILE`);
- `test/docs/traceability.test.ts`.

**Method:**
- **Re-runs:**
  - `r5a` and `r5b`. One `r5a` URL that used CBIC's `resources//` form now fails the stricter path rule; the probe was changed to a single slash. See SA-C6-02.
  - `r4a`, for the cross-check regressions.
  - `r5perf` measured the old SQL, so it was replaced by an end-to-end scale test in `r6a`.
- **New, `r6a.mts`:**
  - attempts to bypass the shape guard;
  - edge cases of the tax pre-charge;
  - echo caps;
  - URL and citation regex timing on adversarial input;
  - known-gaps loading;
  - `/v1/meta/dataset` through the real app at about 20k codes and 1.6k rules (triggers bypassed only for the bulk insert).
- **Location:** all scripts are in the session scratchpad `audit/`. I started no server (`inject` only) and changed no repo files.
- **Suite and checks:**
  - `vitest run`: 922 of 922 pass in 40 files;
  - `tsc --noEmit`: clean;
  - `npm audit --omit=dev`: 0 vulnerabilities.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 0 | none |
| Low | 0 | none |
| Info | 2 | SA-C6-01, SA-C6-02 |

**Verdict: PASS** (no open Critical, High or Medium).

All six round-5 findings are fixed. Round 10 adds no regression or new denial-of-service vector. The two Infos are hardening notes.

## Round-5 findings: status

| Id | Sev (r5) | Status | Evidence (round 6) |
|---|---|---|---|
| SA-C5-01 | Medium | **Fixed** | **`r5b`:**<br>• 85k empty items: **429**, median **16 ms** (was 430 ms, at 1 token);<br>• 85k bare numbers: 429, 4 ms;<br>• a legitimate 500-line request: 200, 7 ms, 11 tokens.<br>**`r5a`** (high-limit key): 60k empty items give **400 in 11 ms** with one `maxItems` error (was 289–349 ms and 180,001 errors).<br>**`r6a`:**<br>• 500 lines with every field wrong: 2,000 problems in 12 ms, charged 11 tokens;<br>• 500 unknown keys spread over the lines: 4 ms (the guard counts across the whole body);<br>• an 80k array under an unknown key, an 80k-element array as the body, or a 200 KB string as `lines`: each 1 error in ≤ 14 ms;<br>• 50,000-deep nesting in a line value, or 40,000 deep in an unknown key: 1 error in ≤ 10 ms;<br>• classify with 1,500 unknown keys: 8 ms. |
| SA-C5-02 | Medium | **Fixed** | **Real app at 20,257 codes and 1,581 rules (`r6a` S):**<br>• `codesWithoutRules` takes 31 ms (the old SQL extrapolates to about 5–9 s);<br>• first `/v1/meta/dataset` 23 ms, then 4 ms;<br>• a 304 pair takes 7 ms.<br>The new set-based logic matches the old SQL predicate: rule at or above, equal, or below the code. The cache is a single entry keyed `version\|IST date`, so memory is bounded and the value is refreshed on every version or date change. |
| SA-C5-03 | Info | **Fixed** | **`r5a` V1:**<br>• refused: `?`, `#`, `;`, `%2E%2E`, `..`, `//`, `…html/view-pdf/x`, and an index page with an upper-case host or trailing slash;<br>• accepted: `x.PDF` and `/view-pdf/<id>/…`.<br>**`r5a` V2:** every decoration of a configured `listing.pdf` index page is now not a document. **`r6a` U:** `VIEW_PDF_PATH` and `PDF_PATH` are linear, taking ≤ 0.45 ms on 2,000-character adversarial paths. |
| SA-C5-04 | Info | **Fixed** | **`r6a` K:** each of these is refused with an error that quotes no content:<br>• an explicit missing file;<br>• a directory;<br>• a symlink to `/dev/zero` ("not a regular file");<br>• a 300 KiB file;<br>• non-JSON ("not valid JSON");<br>• a schema-invalid file (at most 5 issues of 120 characters).<br>The default path loads 19 items. In production, relative paths (`../../etc/x.json`, `gaps.json`) are refused and an absolute path is accepted. |
| SA-C5-05 | Info | **Fixed** | **`r5a` E:** a 200 KB key now gives a 525-byte response (was 200,485). **`r6a`:** 50 keys of about 4 KB containing `~` and `/` give 50 errors with escaped (`~0`, `~1`) and truncated (64-character) tokens, a 7,890-byte response, and errors under 12 KiB. |
| SA-C5-06 | Info | **Fixed** | With `HSN_TRD_PATH=/nonexistent` the traceability suite **fails** ("the TRD is present"). `HSN_TRD_PATH=skip` skips its 4 tests. |

**Ruling 36 and earlier fixes still hold** (`r5a` V3–V9, `r4a`):
- the v8 trigger refuses every direct citation change and the reuse of another rule's approval;
- verify with a document URL is approved, and `010/2025-…` is stored as `10/2025-CT(Rate)`;
- a competing verify gets 409; a re-verify with a URL gets 400;
- a citation forged behind the trigger is flagged by the cross-check, or by the content hash for unverified seed rules;
- the round-4/round-7 cross-check probes (X1b–X4, P1–P3, P5) all still flag, and the legitimate flow P9 stays clean.

## Review of the Round 10 changes

- **Tax pre-charge (`app.ts` preValidation, `tax.ts`):**
  - `extraCost` counts `lines.length` only when `lines` is a real array. A string, `{"length":1e308}` or `{"length":1e400}` costs 0 extra and gets 400.
  - A refused `take` does not deduct tokens, so a huge cost cannot drive a bucket negative; the key works normally afterwards ("legit after abuse": 200).
  - The cost hook is registered before the shape guard, so an oversized invalid body is charged first.
  - Bucket capacity is `max(cost, burst)`: after a long idle a key can make one request of up to `1 + floor(lines/50)` tokens. That request is still bounded by the 256 KiB body and costs about 15 ms. This is intended.
- **Shape guard (`schemaGuard.ts`):**
  - It costs one pass over the keys of schema-described objects, plus array elements only within `maxItems`.
  - It recurses only as deep as the schema, so a deeply nested body cannot exhaust the stack.
  - Unknown keys are counted across the whole body, not per object.
  - Values held under unknown keys are not walked. Ajv does not walk them either, because `additionalProperties: false` stops at the key.
  - See SA-C6-01 for what it does not walk.
- **Echo caps:**
  - `pointerToken` escapes after truncation; slicing at 64 UTF-16 units can split a surrogate pair, and `JSON.stringify` emits that as a `\udXXX` escape, which is harmless.
  - `capPointer` caps Ajv's already-escaped `instancePath` per token and in total.
  - `fitErrors` bounds `errors[]` at 12 KiB, and `detail` keeps the true total.
- **Citations:**
  - `NOTIFICATION_REF_RE` is anchored and linear.
  - The `SERIES_LONG` rewrites are linear. Normalisation runs on input capped at 300 characters (API) or file-bounded (seed).
  - `S.No.`, schedules beyond VII, 5-digit numbers and free text are refused.
  - The verify feed summary uses the post-approval citation.
- **`sources[]` `rule_count` / `verified_count`:** a GROUP BY over in-force rules, which stays in the 4 ms meta request at scale.
- **Known gaps:** loaded once at boot. The `existsSync`/`statSync`/`readFileSync` sequence is a TOCTOU window only for the operator's own file.

## New findings

### SA-C6-01: The shape guard does not walk schema combinators (Info; hardening for SA-C5-01)

- **Where:** `preValidateShape` only follows `properties`, `additionalProperties: false`, `items` and `maxItems`. It ignores `anyOf`, `oneOf`, `allOf`, `$ref`, `patternProperties`, and `additionalProperties` given as a schema.
- **Issue:**
  - No current body route places an array or a closed object under one of those, so today nothing is unguarded. Classify's `anyOf` only lists `required` alternatives, and admin bodies are authenticated and capped at 64 KiB.
  - A future route that puts an array under `anyOf` would silently reintroduce the `allErrors` amplification under Ajv. In `r6a` G, a 50,000-element array under an `anyOf` branch with `maxItems: 5` passed the guard with no errors.
- **Suggestion:** either make the guard walk the branches (taking the smallest `maxItems` of any branch), or add a test that enumerates every route's body schema and fails if a combinator contains `type: 'array'` or `additionalProperties: false`.

### SA-C6-02: The strict document path refuses CBIC's own `resources//htdocs-cbec/…pdf` links (Info; functional)

- **Where:** `documentUrlProblem` refuses any path containing `//`.
- **Issue:**
  - Many genuine notification PDFs on `cbic-gst.gov.in` are published under `https://cbic-gst.gov.in/resources//htdocs-cbec/gst/….pdf`, with a double slash.
  - A reviewer must rewrite the URL to a single slash, which the CBIC server may or may not serve the same way, or use the `taxinformation.cbic.gov.in/view-pdf/<id>` form, which passes.
  - This is not a security weakness; the refusal is fail-safe.
- **Suggestion:** document the accepted forms in the verify API docs. Optionally canonicalise exactly one `resources//htdocs-cbec/` segment for the `cbic-gst.gov.in` host instead of refusing it.

## Checklist status (core scope, round 6)

| Status | Items |
|---|---|
| PASS | SEC-22 / ruling 25 (pre-validation charging; Ajv work bounded; meta cost bounded and cached); SEC-75 (no values reflected; names escaped and capped; size-capped `errors[]`); SEC-51 / T-A07 / ruling 36 (citation host and document-path rules, canonical notification form, v8, cross-check); ruling 18/20 bindings; round-7 fixes |
| FAIL | none |
| N/A | classifier; ops and docs items |

## Final verdict

**PASS.** Open: 0 Critical, 0 High, 0 Medium, 0 Low, 2 Info (SA-C6-01, SA-C6-02).

SA-C5-01 to SA-C5-06 are fixed and confirmed by exploit re-runs and new probes. Round 10 introduces no regression and no new denial-of-service vector.
