# Security audit, classifier and adapters, round 4 (`rules-fts-2.2`)

- **Auditor:** security auditor, code part 2 of 2. I reviewed and probed only; no repo code was changed.
- **Inputs:**
  - the "Round 5" section of `reviews/code-fix-classify-round2.md`
  - the coordinator's SA-K3-02 ruling: the in-master top-3 gate is a provisional AG-12 scope, top-3 over all positives is reported, and the LLM-draft labels are disclosed
  - `reviews/security-code-classify-round3.md`
- **Scope:**
  - `src/classify/*`, `src/adapters/*` (except `cbicWatcher.ts` and `cbicParseWorker.ts`, which the core auditor covers)
  - `src/routes/classify.ts`
  - `scripts/eval-classifier.ts`, `test/eval/*`
  - `test/classify/*`, `test/adapters/*`
- **Probes:**
  - `/home/claude/audit-scratch2/r4/part.mts` (partitions, LRU, quantity regex)
  - `/home/claude/audit-scratch2/r4/excl.mts` (excluded eval items)
  - the round-3 probes in `r3/` and the round-2 probes in `r2/`, re-run unchanged
  - a scratch copy of the server with the 2.1 quantity rule, used to reproduce the baseline (outside the repo)

## Verdict: PASS

| Severity | Open |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 (SA-K3-03 residual, SA-K4-01) |
| Info | 4 (SA-K3-05 carried, SA-K4-02, SA-K4-03, SA-K4-04) |

**Checks:**
- `tsc --noEmit`: clean.
- `vitest run`: 32 files, 719 tests, all passed.
- `npx tsx scripts/eval-classifier.ts`: every gate PASS, exit 0.
- I reproduced the `rules-fts-2.1` baseline independently. Running a scratch copy with the old quantity rule gives exactly the metrics recorded in `baseline.json`.

## Round-3 findings: status

| ID | Sev | Status | Evidence |
|---|---|---|---|
| SA-K3-01 | Medium | **Fixed** | `pipeline.ts:343` calls `match(matchTokens)` with no ignore set. Brand tokens are no longer computed anywhere in the pipeline. Probe `r3/high.mts`: "glucometer test strips" gives 9027 low 0.51 with OFF brand null, and the same 9027 low 0.51 with OFF brand "Test Strips". "22k gold ring not real" with brand "Not Real" gives medium. The cached-brand path is also unaffected: `brand` is only echoed in `product`. |
| SA-K3-02 | Medium | **Fixed under the ruling** | See "Eval gate judged against the ruling" below. |
| SA-K3-03 | Low | **Partly fixed; residual stays Low** | The partition is now `tenant:<id>` from `request.auth.tenant`, falling back to the key id, then to `shared:no-key`. One tenant's several keys now share one third of the budget. Three *different* tenants can still drain a 15/min host: in `r3/starve.mts` the victim got 0 of 5, and 1 of 10 under a sustained attack. The fix log lists this as residual. |
| SA-K3-04 | Low | **Fixed** | `isQuantityLike` (`coverage.ts:54-61`) takes a number plus an allow-listed unit, with `k` only for real karat values. "22k gold ring 1toy", "glucometer 1fake", "22k gold ring 0not" and "22k gold ring toy" are all medium or low. Table: `1toy`, `7k`, `5kt`, `1box`, `0k`, `22.5k`, `1e5` are false; `22k`, `10gm`, `2tb`, `3x`, `5mah`, `9v`, `1l` are true. |
| SA-K3-05 | Info | **Open (accepted residual, ranking only)** | Unchanged in `qualifiers.ts`. A qualifier can only lower Chapter 71 confidence. "22k gold ring 925" is 7113 high, which is correct at 4 digits (7113 covers silver and gold), but it would matter if 8-digit answers were ever produced. |
| SA-K3-06 | Info | **Fixed** | An LRU of at most 1,000 partitions. An idle (≥ 60 s) LRU entry is evicted; otherwise a new partition is refused. Nobody's bucket is ever reset. Probe: with `maxPartitions` 2, after 61 s idle a new tenant got a slot and the count stayed at 2. See SA-K4-03 for the fail-closed side. |

## Answers to the coordinator's questions

1. **Can a client spoof `tenantId`?** No.
   - `routes/classify.ts:145` passes `request.auth?.tenant`.
   - `auth` is built in `app.ts:326-328` from the `api_keys` row, after the hash and expiry checks. `tenant` is the stored column, set by an admin when the key is created.
   - The request body schema is `additionalProperties: false` and has no tenant field. Nothing in the classify path reads a tenant from headers or the body.
   - Partition names cannot collide: tenants are prefixed `tenant:`, key ids are server-generated, and the host part of the map key comes from the allow-list and cannot contain NUL.
2. **Regressions?** None found.
   - The r2 probes still hold:
     - SA-K-03: an OFF-only name is capped at medium with a hint, including from the cache.
     - The rule hint is still blocked on negated names and names with extra words.
     - The re-ranker still never raises confidence (0 violations over all permutations).
     - Budgets, `getText` restrictions, the daily counter and the error cache all still hold.
   - The r3 ReDoS timings are unchanged.
   - The new quantity regex `/^(\d+(?:\.\d+)?)([a-z]*)$/` takes ≤ 0.5 ms on 100k–200k-character adversarial tokens.
3. **Can a crafted name reach `high` without a whole-name curated synonym?** Not found.
   - `highEligible` is still `exactOnCallerName && hint === null && !negated`.
   - Brand words and glued junk no longer count as covered.
   - The remaining high-band inputs in `r3/high.mts` are curated phrases plus genuine quantities, units, function words or grading words, which is the R2 design.
   - Unicode obfuscation (zero-width characters, soft hyphen, Cyrillic, strike-through combining marks, tag characters) still never yields `high` with an extra word. Emoji and tag characters are stripped to nothing, which is harmless.

## Eval gate judged against the ruling (SA-K3-02)

| Ruling requirement | Status |
|---|---|
| Top-3 gated on in-master items as a provisional AG-12 scope | Done: `checkGates` gates on `top3_4_in_master` (0.9418 over 378). The scope text is printed on every run and stored in `baseline.json`; the test checks both. |
| Top-3 over all positives reported | Done: 0.8578 over 415, printed in the gate detail and the summary line. |
| LLM-draft labels disclosed | Done: `PROVISIONAL_NOTICE` appears in every text and JSON output, in `baseline.json` and in the README, and is asserted in `eval.test.ts`. |
| Regression check is no longer a self-comparison | Done. The baseline is `rules-fts-2.1`, and a new gate fails on a same-version baseline unless it carries an attributed `allow_same_version`, which is tested both ways. `--write-baseline` refuses without `--approved-by`. I reproduced the 2.1 numbers independently and they match. |
| Top-1@8 (AI-41) | Implemented and reported: 0/11. This is a known capability gap, and the ruling does not make it a gate. |
| Leakage-like high band | Reported honestly: 0 high answers on items that are not coverage-equivalent to a synonym, 30 items coverage-equivalent, and a separate 50-item probe set with 2 of 50 high. The excluded item `ev0010` really does equal a synonym (checked with `r4/excl.mts`). |

**Conclusion:** the eval gate is genuine under the ruling. The remaining weaknesses are in SA-K4-01 (Low) and SA-K4-02 and SA-K4-04 (Info).

## New findings

### SA-K4-01 (Low): high-band precision gate has no minimum sample, and its 16 items are all synonym-equivalent
- The gate passes when `bands.high.answered > 0`, so 1 of 1 would pass.
- Today it is 16 of 16. A 95% Wilson lower bound for 16/16 is about 0.81, so the data cannot show precision ≥ 0.97.
- All 16 items are coverage-equivalent to a curated phrase, and only 2 of the 50 probe items reach high.
- This is disclosed as provisional, so it is Low.
- Fix: require a minimum number of high answers (for example ≥ 60), or gate on a lower confidence bound, before the gate stops being provisional. Report the bound next to the point estimate.

### SA-K4-02 (Info): the regression baseline is a hand-made record, and the version guard is a string comparison
- `baseline.json` (2.1) was written by hand, not by `--write-baseline` on a 2.1 build. I reproduced it, so it is accurate today.
- The guard only checks `classifier_version !== CLASSIFIER_VERSION`. Any edit to the file that names an older version passes.
- Its 2.1 → 2.2 comparison is identical by construction, because the only difference cannot be seen in a name-only eval.
- Suggestion: record the seed hash and eval-file hash in the baseline and check them, or keep it in code review only.

### SA-K4-03 (Info): when the partition table is full, a new tenant is refused outbound lookups
- With 1,000 partitions each touched within the last 60 s, a new tenant gets `rate_budget` with no request made. Refused calls also refresh `lastUsed`, so hammering tenants keep their slots.
- Probe: `maxPartitions` 3, three tenants touching every 59 s, victim 0 of 10.
- This fails closed and needs about 1,000 distinct authenticated tenants, so it is Info.
- Possible fix: do not refresh `lastUsed` on refused calls, or keep a small reserve.

### SA-K4-04 (Info): the `excluded` field is enforced by prefix only
- `eval.test.ts` checks that each `excluded` reason starts with `leakage: `. It does not check that the item really equals a synonym.
- Any failing item could be dropped this way.
- Today the only exclusion, `ev0010`, is genuine.
- Fix: assert `leakage(excludedItems) == excludedIds` in the test.

## Final sweep: last-reviewed round per file

| File | Last change | Last reviewed |
|---|---|---|
| `src/adapters/budget.ts` | before r3 | r3 (re-probed r4) |
| `src/adapters/httpClient.ts` | r5 fix (partitions, LRU) | **r4, in full** |
| `src/adapters/ipGuard.ts` | before r2 | r2 (r1 probes re-run r2) |
| `src/adapters/openFoodFacts.ts` | before r3 | r4 (partition plumbing re-checked) |
| `src/adapters/productLookup.ts` | before r3 | r4 (interface re-checked) |
| `src/adapters/cbicWatcher.ts`, `cbicParseWorker.ts` | — | out of scope (core auditor) |
| `src/classify/barcodeCategory.ts` | before r2 | r2 |
| `src/classify/chapterKeywords.ts` | before r2 | r2 |
| `src/classify/coverage.ts` | r5 fix | **r4, in full** |
| `src/classify/fingerprint.ts` | before r2 | r2 |
| `src/classify/fts.ts` | before r2 | r3 |
| `src/classify/fusion.ts` | r5 (version bump, comments) | **r4, in full** |
| `src/classify/gtin.ts` | before r2 | r2 |
| `src/classify/index.ts` | before r2 | r2 |
| `src/classify/normalise.ts` | before r3 | r3 |
| `src/classify/pipeline.ts` | r5 fix | **r4, in full** |
| `src/classify/qualifiers.ts` | r5 (timestamp; logic same as r3) | **r4, in full** |
| `src/classify/rerank.ts` | before r2 | r2 (probe re-run r4) |
| `src/classify/ruleHint.ts` | before r3 | r3 (probe re-run r4) |
| `src/classify/stub.ts` | before r2 | r2 |
| `src/classify/synonyms.ts` | before r3 | r3 (the `ignore` parameter now has no callers) |
| `src/classify/types.ts` | r5 (additive `tenantId`) | **r4** |
| `src/routes/classify.ts` | r5 (`tenantId` passing) | **r4** (tenant sourcing traced into `app.ts`) |
| `scripts/eval-classifier.ts`, `test/eval/*` | r5 | **r4, in full** |
