# Security code review: classifier and adapters, round 2

- **Auditor:** security-auditor (code, part 2 of 2)
- **Date:** 2026-10-11
- **Code:** `/home/claude/hsn-api/server` (not a git repo; reviewed as of this date)
- **Scope:**
  - every file in `src/classify/` and `src/adapters/`, except `cbicWatcher.ts`, which the core auditor covers; the `getText` changes in `httpClient.ts` are reviewed here
  - `src/routes/classify.ts` and `src/classifierDeps.ts`
  - `test/classify/`, `test/adapters/` and `test/fixtures/injection/`
- **Inputs:**
  - `reviews/code-fix-classify-round2.md`
  - `docs/00c-coordinator-rulings-round2.md` (rulings 2, 5, 6, 22, 25)
  - round-1 report `reviews/security-code-classify-round1.md`
- **Mode:** review only. No source or test file was changed. Probe scripts are in `/home/claude/audit-scratch2/` (round-1 probes, re-run) and `/home/claude/audit-scratch2/r2/` (new).

## Verdict: FAIL

One Medium is open: **SA-K2-01**. A rule hint that selects a nil-rate (0%) rule fires on a negated or compound product name, together with a `high`, `needs_review: false` answer. Every round-1 finding (SA-K-01 to SA-K-18) is fixed or accepted, and there are no Critical or High findings. Fixing SA-K2-01 is enough to reach PASS.

| Severity | Open | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 1 | SA-K2-01 |
| Low | 3 | SA-K2-02, SA-K2-03, SA-K2-04 |
| Info | 2 | SA-K2-05, SA-K2-06 |

## Commands run (AG-22)

| Command (from `server/`) | Result |
|---|---|
| `npx vitest run test/classify test/adapters test/classify-route.test.ts` | 11 files, 301 tests passed |
| `npx vitest run` | 24 files, 575 tests passed |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx tsx …/redos.mts` and `npx tsx …/r2/regex.mts` | SA-K-10 is fixed (timings below) |
| `npx tsx …/r2/rerank2.mts` | Re-ranker guard: 13 bypass attempts; checks that confidence never rises over all permutations; budget |
| `npx tsx …/http.mts` and `…/http_env.mts` with a fake proxy on :18998 (`NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` set) | All SSRF and DoS probes pass. The fake proxy saw no connections. `application/json-seq` is now refused. |
| `npx tsx …/r2/budget.mts` | Per-host budget, default budget, clock skew, `getText` media type and charset handling, size cap, header-injection guard, daily counter |
| `npx tsx …/r2/pipeline2.mts` | SA-K-03, 04, 05 and 09 re-runs; synonym cache invalidation; rule-hint abuse; budget starvation; per-key cap; recomputing confidence from `scoring` |
| `npx tsx …/ip.mts` | SA-K-17 ranges now blocked |
| `npx tsx …/r2/plural.mts` | Regression in the synonym index (SA-K2-02) |

## Round-1 findings: re-test

| ID | Status | Evidence (probe output) |
|---|---|---|
| SA-K-01 High | **Fixed** | `r2/rerank2.mts`: the old tolerated case `[2924, 7113, 3004]` gives `unknown_code`. A partial ranking gives `missing_code`, the old object shape gives `schema`, duplicates give `duplicate_code`, and full-width or Devanagari digit codes give `unknown_code`. The schema is `{ranking: string[]}.strict()` (`rerank.ts:59`), and the guard demands an exact permutation (`:101-108`). |
| SA-K-02 High | **Fixed** | The `llm_rerank` detail is a fixed template (`rerank.ts:130`); the probe output shows only "Re-ranker moved this from position 3 to 1". The guard applies NFKC before the rate filter (`:89`), so `"why":"１８％ ｇｓｔ"` in an extra field gives `rate_text`. Model output is never copied into a response or a log; only the cause code is logged. |
| SA-K-03 Med | **Fixed** | A stub OFF name "Glucometer" gives `9027:0.84:medium`, `needs_review=true`, plus a `review_hint`, and the same holds when served from cache. Cache TTL is now 7 days (expiry `2026-10-17`). Only a caller-sent name can reach high. Admin purge route exists (`admin.ts:569`). |
| SA-K-04 Med | **Fixed** | 50 requests for a barcode whose record fails our schema now cause **1** outbound call; the response has `source: lookup_failed` and a distinct message. |
| SA-K-05 Med | **Fixed** | With 5,000 synonyms a request takes **18.4 ms** (was 105 ms), and that is the worst case where every phrase shares a query token. `allActive()` is read once and again only after a version bump. Refdata approvals publish a new dataset version (`proposals.ts:771-773`), so cache invalidation works; the probe confirmed a deactivated synonym is gone after the bump. |
| SA-K-06 Med | **Fixed** (residual risk SA-K2-03) | 20 calls at once with a 15/min budget: 15 sent, 5 refused with `rate_budget` and no socket opened. One token comes back after 4 s. A host with no setting gets 10/min. Per-key daily cap works: cap 2 gives `ok, ok, key_daily_cap`. |
| SA-K-07 Med | **Fixed** | `test/fixtures/injection/` has 13 files covering every AI-16 category. A pipeline-level stub re-ranker test exists (`round2.test.ts`). |
| SA-K-08 Low | **Fixed** | `fingerprint.ts` uses HMAC-SHA256 under `HSN_LOG_KEY`, which is required (≥ 32 chars) in production (`config.ts:189`). One fingerprint is logged, by the route. |
| SA-K-09 Low | **Fixed** | A cached brand `‮evil<script>` comes back as `evil<script>` (bidi removed; JSON-only output, so `<script>` is harmless). A malformed cached category comes back as `null`. |
| SA-K-10 Low | **Fixed** | The new lookbehind regex runs on 100k-char adversarial strings in ≤ 0.73 ms. `referenceTokens` on 4,000 digits went from 47 ms to 0.24 ms. |
| SA-K-11 Low | **Fixed** | One `classify.decision` line from the route (`routes/classify.ts:162-184`) with `key_id`, `dataset_version`, `det_top`/`final_top`, `lookup_cause` and `latency_ms`. The pipeline logs no decision line. |
| SA-K-12 Low | **Fixed** | `assertCandidate` (`routes/classify.ts:61-74`) checks code shape, confidence range, band, `needs_review`, non-empty reasons, reason codes and rule hint. A failure is a 500. Required lists and enums are in the response schema. |
| SA-K-13 Low | **Fixed** | Over all 6 permutations of 3 candidates: 0 cases where confidence rose or the list stopped being monotone. A remaining AI-05 gap is SA-K2-04. |
| SA-K-14 Low | **Fixed** | The error message no longer echoes the digits (`gtin.ts:67`). |
| SA-K-15 Info | **Fixed** | `application/json-seq` now gives `bad_content_type`. |
| SA-K-16 Info | **Accepted** | Docs item, recorded by the coordinator. |
| SA-K-17 Info | **Fixed** | `2001:10::1`, `2001:2::1`, `2001:20::1` and `3fff::1` are now blocked (`ipGuard.ts:98, 105`); the bounds `< 0x200` (/23) and `< 0x1000` (/20) are correct. |
| SA-K-18 Info | **Fixed** | The listed tests were added. My probes reproduce each claim: slow drip 3005 ms, DNS hang 2001 ms, one resolver call per request, gzip refused, nested JSON gives `bad_json`, proxy ignored. |

## New code audited

| Area | Result |
|---|---|
| `adapters/budget.ts` | Pass. The token bucket refills linearly and caps at the burst size. If the clock goes backwards there is no refill, which is safe. `perMin ≤ 0` refuses every call. `DailyCounter` keeps at most 100k keys; an evicted key's count resets, which is acceptable at that size. In `CallBudget`, a minute token is spent even when the daily limit then refuses (stricter, fine). |
| `httpClient.ts`: budgets and `getText` | Pass. Order of checks: URL → breaker → concurrency → host budget, then the socket opens. `getText` is refused unless the client was built with `textContentTypes`. Media types are validated against a strict regex, which blocks CRLF injection into `Accept` (probe: throws). Matching is an exact media-type match. Charsets are allow-listed (UTF-16 is refused). The 256 KiB cap, identity-only encoding, timeouts, TLS and the lookup hook are shared with `getJson`. A JSON-only client cannot receive HTML, and a text client's `getJson` still requires JSON. |
| `classify/fingerprint.ts` and the route's HMAC log name | Pass (SA-K-08). If `HSN_LOG_KEY` is unset outside production, a random per-process key is used (`config.ts:339`), which is fine. |
| Negative cache, error cache, positive cache | Pass. Not-found results are cached for 24 h only when every adapter said "not found". Errors live in an in-memory cache: 24 h for schema failures, 15 min for other errors, 2 min for capacity refusals. Errors are never stored as not-found. Everything read from the cache is re-sanitised. |
| Synonym matcher cache and dataset version | Pass. Keyed on `datasetVersion()`, which reads `storage.read.dataset.current()`. Refdata changes go through proposals that publish a version. Direct database edits by an operator need a restart; that is acceptable and should go in the runbook. See SA-K2-06 for the per-request version reads. |
| High-band gate (rulings 2 and 22) | Pass. `highEligible = textFromCaller && s_syn === 1` (`pipeline.ts:349`); `fusion.ts:192` caps everything else at 0.84. Product data from OFF/OBF (name or category) never reaches high (probe). A caller-sent name with an exact synonym plus an agreeing barcode category gives high, as intended. This is stricter than ruling 22's "synonym on the product name", which is acceptable. |
| Scoring transparency (`scoring`) | Pass. I recomputed confidence from `signals` and `scoring.denominator` for 4 inputs; all matched within rounding after the documented cap. |
| Re-ranker permutation guard | Pass (see SA-K-01 and 02). JSON with `2924` decodes to the byte-equal `2924` and is accepted, which is correct. `__proto__` gives `schema`. Raw output over 4,000 chars gives `too_long`. An exhausted budget gives the deterministic order with cause `budget`. |
| `rule_hint` path | **FAIL**: SA-K2-01. Third-party data **cannot** set it. A barcode-only request or an OFF name gives no hint (probe: `3004:0.59:low` with no hint), and a caller name `xyz` plus a barcode gives none either. The problem is what a caller-supplied name *can* trigger. |
| `classifierDeps.ts` | Pass. The product cache is on the write connection and everything else on the read connection. The logger is the redacting pino child. |
| `routes/classify.ts` | Pass apart from SA-K2-01. Codes are validated against the ruling-6 shapes (`CODE_RE`); `rule_hint.condition` must be in the allow-list `{nil_rate_list}`. |
| `test/fixtures/injection/*` | Pass. 13 categories. Note that the "as model output" assertions pass trivially (12 of 13 files are not JSON); the real coverage of the rate filter is in the `rerank.test.ts` "rejects rate content" cases, which do exercise it. |

## Findings

### SA-K2-01 (Medium): the nil-rate rule hint fires on negated or compound names and selects a 0% rule without review

**Where:**
- `src/classify/pipeline.ts:409-410`: the hint is set when there is any exact contiguous synonym run anywhere in the caller's name
- `src/classify/synonyms.ts:186-191`
- `src/routes/classify.ts:156-157`, which passes `conditionCode` to the rate service
- the effect is in core's `src/services/rates.ts:266-272`

**Issue:** `rule_hint` is attached whenever the curated phrase occurs as a contiguous run in the caller's name, whatever the other words are. Negation (`non-`, `not`, `without`) and extra product words do not stop it. The route then asks the rate service to pick the rule with that condition. When exactly one rule matches, the rate service returns that rule as `applicable_rule` with `ambiguous: false`, `coverage: 'ok'`, empty `rules` and no `default_rule_id`. The general rule disappears from the response; the only trace is a `selected_by_hint` warning.

Ruling 00c-5 allows selection for "a name match to a specific nil-rated drug synonym". A name that says the product is *not* that drug, or is a different product that contains the phrase, is not such a match. A wrong 0% GST printed on an invoice is the primary threat in this product (threat model §0).

**Proof** (`r2/pipeline2.mts`, curated synonym `insulin injection → 3004` with `rule_hint: nil_rate_list`):

```
"Not insulin injection, vitamin B12 syrup"   3004:0.91:high:HINT=nil_rate_list needs_review=false
"non-insulin injection"                      3004:0.59:low:HINT=nil_rate_list
"insulin injection pen needles 100 pcs"      3004:0.59:low:HINT=nil_rate_list
```

The first result is `high` with `needs_review: false` plus the hint, so the route selects the 0% rule and returns it as the unambiguous rate. The bands of the other two depend on the fixture; with a fuller dataset, FTS and chapter evidence can lift them to high, as in the first case.

**Required fix (classifier side, which is enough to close this finding):**
1. Set `rule_hint` only when the caller's match tokens, after removing quantity pairs and a curated list of dosage-form and pack words (tablet, injection, vial, pen, ml, …), are equal to the synonym phrase tokens. Extra product words must suppress the hint.
2. Never set the hint when a negation token is present (`non`, `not`, `no`, `without`, `free`, `except`, and Hindi `नहीं`/`बिना`). Split hyphenated `non-…` first, as `match` already does.
3. When a hint is set, force the candidate's `needs_review: true` (cap at medium) and add a `review_hint` reason saying a nil-rate condition was assumed from the name.
4. Tests: the three probe names above produce no hint, and a hint always comes with `needs_review: true`.

**Recommended (core, for the core auditor):** with `selected_by_hint`, keep `rules[]` and `default_rule_id` in the DTO so the general rule stays visible.

### SA-K2-02 (Low): the synonym index misses plural folds that `tokenEq` accepts

**Where:** `src/classify/synonyms.ts:102-107` (`variants`).

**Issue:** `tokenEq` folds "bags"↔"bag" (length > 3) and "boxes"↔"box" (length > 4). The index only strips `s` from tokens longer than 4 characters and `es` from tokens longer than 5. Those candidates are never looked up, so these matches silently disappear compared with round 1. The effect is fail-safe (lower confidence, never higher), but it is an unannounced accuracy regression in a classifier marked `rules-fts-2.0` (AI-42 eval gates).

**Proof** (`r2/plural.mts`): `bags`: `tokenEq` true, matcher `[]`. `boxes`: `tokenEq` true, matcher `[]`. `rings` → `7113`.

**Fix:** make `variants` mirror `tokenEq` exactly (`t.length > 3` for `s`, `t.length > 4` for `es`), and add a property test that `match` with the index equals a brute-force `tokenEq` scan.

### SA-K2-03 (Low): one key can starve the shared outbound budget, and the refusal is cached per GTIN for 2 minutes

**Where:** `src/adapters/httpClient.ts:264-265` (one bucket per host for all keys) and `src/classify/pipeline.ts:57, 160` (capacity causes are cached per gtin).

**Issue:** The upstream terms are now respected; that was the round-1 concern. However:
- One key's 500 lookups per day can hold OFF's 15/min budget empty for about 33 minutes a day, and several keys can hold it all day.
- While the budget is empty, other tenants get `lookup_failed`.
- A capacity refusal is cached against the **victim's** GTIN for 2 minutes, even after the bucket refills.

**Proof** (`r2/pipeline2.mts`, "starvation"): after an attacker key's lookups use up the budget, the victim's barcode returns `lookup_failed rate_budget`, and the next call returns `lookup_failed rate_budget` again from the error cache without an attempt.

**Fix:**
- Do not cache capacity causes (`rate_budget`, `busy`, `circuit_open`, `key_daily_cap`) per GTIN; they describe us, not the product.
- Add a per-key share of the host minute budget (for example, no key takes more than a third of a host's tokens per minute).

### SA-K2-04 (Low): after a re-rank lowers the best confidence below 0.30, the AI-05 message is missing

**Where:** `src/classify/pipeline.ts:425` (`fused.weak` comes from the deterministic list) and `rerank.ts:121-131`.

**Issue:** The ceiling clamp can lower every confidence to the new top's value. The probe in `r2/rerank2.mts` shows all three candidates at 0.22. `message` is still computed from the pre-rerank best (0.72), so the response carries no "no confident match" message, although AI-05 requires one when the best is below 0.30. `needs_review` is still true, so this is Low. The LLM path is disabled in v1.

**Fix:** recompute `weak` and `message` from the final candidate list, and apply the drop-below-0.10 rule after the re-rank too.

### SA-K2-05 (Info): a request with no `keyId` bypasses the per-key cap

**Where:** `pipeline.ts:213`. The route always passes `request.auth.keyId` and the route requires auth, so this is not reachable today.

**Fix:** treat a null key as a single shared bucket.

### SA-K2-06 (Info): `datasetVersion()` hits the database up to 11 times per request

**Where:** `pipeline.ts:119-147`. Both `matcher()` and each `refTokens()` call (up to 10 FTS hits) call `versionKey()`.

**Fix:** read the version once per `classify()` call and pass it down.

## Checklist status (scope files)

| Area | Items | Result |
|---|---|---|
| SSRF | SEC-07, SEC-32..38 | PASS (SEC-32 path deviation accepted) |
| Untrusted input | SEC-10, SEC-24..28, SEC-79 | PASS |
| SQL | SEC-39..41 (as used by the classifier) | PASS |
| Logging | SEC-61..63 | PASS |
| Rate integrity | SEC-56 | PASS. The classifier computes no rate. However, through `rule_hint` it *influences rule selection*; see SA-K2-01. |
| DoS | SEC-77, SEC-36 | PASS |
| AI rules | AI-01..08 | PASS, except AI-05 after a re-rank (SA-K2-04, Low) |
| AI rules | AI-10..16, AI-20..22, AI-30..32, AI-50/51 | PASS |
| Ruling 2/22 (bands, external data) | | PASS |
| Ruling 5 (nil-rate hint) | | **FAIL** (SA-K2-01) |
| Ruling 6 (code lengths) | | PASS |
| Ruling 25 (budgets, HMAC log key, deny-list, compression) | | PASS (residual risk SA-K2-03) |

## To reach PASS

Fix SA-K2-01 (the classifier-side changes 1–4 above) and add its tests. The Lows and Infos may be tracked.
