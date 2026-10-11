# Security code review: classifier and adapters, round 3

- **Auditor:** security-auditor (code, part 2 of 2)
- **Date:** 2026-10-11
- **Code:** `/home/claude/hsn-api/server` (not a git repo; reviewed as of this date). Classifier version `rules-fts-2.1`.
- **Inputs:**
  - `reviews/code-fix-classify-round2.md`, sections "Round 3" and "Round 4"
  - round-2 report `reviews/security-code-classify-round2.md`
  - `docs/06-ai-restrictions.md` (AI-40..45)
  - `docs/00c-coordinator-rulings-round2.md` (rulings 5 and 22)
- **Scope:** read in full:
  - `src/classify/coverage.ts`, `qualifiers.ts`, `ruleHint.ts`, `synonyms.ts`, `pipeline.ts` and `fusion.ts`
  - the `normalise.ts` change (`\p{M}`)
  - the per-key partition code in `src/adapters/httpClient.ts` and `budget.ts`
  - `scripts/eval-classifier.ts`, and `test/eval/eval.test.ts`, `classify-eval.jsonl` and `baseline.json`
  - `test/classify/round3.test.ts` and `round4.test.ts`
- **Mode:** review only; no repository file changed. Probe scripts are in `/home/claude/audit-scratch2/r2/` (round-2 probes, re-run) and `/home/claude/audit-scratch2/r3/` (new).

## Verdict: FAIL

Two Medium findings are open:
- **SA-K3-01:** a brand from Open Food Facts (crowd-edited) can lift a caller's name to `high`.
- **SA-K3-02:** the AI-42 eval gate reports PASS while the gate as written fails, and its regression check compares the current version with itself.

Every round-2 finding (SA-K2-01 to SA-K2-06) is fixed.

| Severity | Open | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 0 | none |
| Medium | 2 | SA-K3-01, SA-K3-02 |
| Low | 2 | SA-K3-03, SA-K3-04 |
| Info | 2 | SA-K3-05, SA-K3-06 |

## Commands run (AG-22)

| Command (from `server/`) | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx vitest run` | 30 files, 686 tests passed. No `.skip`, `.only` or `it.fails` in classifier tests; the round-4 `it.fails` marker is gone because the top-3 gate now passes on the regenerated seed. |
| `npx tsx scripts/eval-classifier.ts` | Every gate prints PASS (output under SA-K3-02) |
| `npx tsx …/r2/{rerank2,budget,regex,plural,pipeline2}.mts` | Round-2 re-runs (table below) |
| `npx tsx …/r3/high.mts` | 48 crafted names plus 6 brand cases: which ones reach `high` |
| `npx tsx …/r3/glue.mts` | Digit-glued words and plating-qualifier edge cases |
| `npx tsx …/r3/redos3.mts` | New regexes and helpers on 100k-char / 100k-token inputs |
| `npx tsx …/r3/starve.mts` | Per-key outbound partition against a local TLS server (single and multi-key attacks, 10-minute sustained runs) |
| `npx tsx …/r2/evalhigh.mts` | Lists the eval items answered `high` |

## Round-2 findings: re-test

| ID | Status | Evidence |
|---|---|---|
| SA-K2-01 Med | **Fixed** | `r2/pipeline2.mts`: "non-insulin injection", "Not insulin injection, vitamin B12 syrup" and "insulin injection pen needles 100 pcs" now get **no hint** and are never high (the second case went from 0.91 high to 0.73 medium). "Insulin injection" still gets the hint, now with `needs_review` and a `review_hint`. In `pipeline.ts:369-376`, a hint removes `highEligible`. In `ruleHint.ts`, the residual tokens must equal the phrase tokens exactly. Obfuscated negation cannot help: `n​ot`, a Cyrillic `о` or a soft hyphen each produce an extra residual token, so no hint is set. |
| SA-K2-02 Low | **Fixed** | `r2/plural.mts`: `bags` → 4202, `boxes` → 4819. `variants()` now mirrors `tokenEq`. |
| SA-K2-03 Low | **Fixed** (residual risk SA-K3-03) | Capacity causes are not cached per GTIN (`pipeline.ts:58`); the probe saw the victim's barcode retried on the next request. A per-key partition was added (see below). |
| SA-K2-04 Low | **Fixed** | `pipeline.ts`: after an accepted re-rank the drop rule is re-applied, and `weak` / `message` come from the final list. |
| SA-K2-05 Info | **Fixed** | `keyId` is required by the type. A null key uses the `shared:no-key` partition, which is capped. |
| SA-K2-06 Info | **Fixed** | `versionKey()` is called once per `classify()` (`pipeline.ts:335`) and the value is passed to the matcher and the reference-token cache. |

Other round-2 probes all re-run clean:
- re-ranker guard: 13 of 13 bypass attempts rejected; confidence never rose
- budgets and `getText`
- unit regex stays linear
- SA-K-03, 04, 05 and 09

## Answers to the coordinator's questions

**1. Can a crafted name reach `high` without a whole-name curated synonym?**
Yes, two ways.
- **(a) Third-party brand (SA-K3-01, Medium).** Brand tokens from a barcode lookup are excluded from the coverage check, and Open Food Facts brands are crowd-edited.
- **(b) Digit-glued words (SA-K3-04, Low).** `isQuantityLike` treats any digits plus up to 3 letters as a quantity, so "22k gold ring 1toy" is high while "22k gold ring toy" is medium. Only the caller can craft this.

What correctly blocks `high` (`r3/high.mts`, 48 names):
- extra words: toy, box, kids, replica, fake, ™ (normalised to "tm"), Roman numerals, Devanagari नकली, strike-through combining marks
- plating, written in any form: `&plated`, `/plated`, `plated-`, `gold-plated`

The ignore-list words that pass are harmless: x, set, combo, new, premium, original, for, the, hallmarked, bis, 925, 9k, quantities and units.

Invisible input does not create a bypass:
- zero-width characters and Unicode tag characters (U+E00xx) are removed
- emoji are dropped
- `①`, `㎏`, `½` and `¹` fold under NFKC into numbers or units

None of these carries visible meaning.

**2. Can negation or qualifier handling be bypassed with Unicode tricks?**

*Negation:* the negation word list can be bypassed, but it no longer matters.
- **Probe result:** `n​ot`, `n­ot`, `n‍ot` and a Cyrillic `nоt` all slip past `NEGATION_WORDS`.
- **Why `high` is still blocked:** coverage sees the leftover token, so these names come out medium (0.75–0.78).
- **Why the rule hint is still blocked:** the hint check needs the residual tokens to equal the phrase tokens exactly, and the leftover token breaks that.

So negation handling is no longer load-bearing for safety.

*Imitation qualifier:* this is a ranking aid only.
- It is defeated by a zero-width character inside "plated", and by "plated gold" word order (SA-K3-05).
- Coverage still keeps those names at medium or below.

**3. ReDoS in the new regexes?**
None. All timings on 100k-char inputs are linear and small:

| Input or helper | Time |
|---|---|
| `^\d+(?:\.\d+)?[a-z]{0,3}$` | ≤ 0.26 ms |
| `^\d+(?:\.\d+)?$` | ≤ 0.09 ms |
| `[\p{L}\p{M}]+` (spelling pass) on 100k combining marks | 3.65 ms |
| `normaliseName` on 100k marks or Devanagari | ≤ 8.6 ms |
| `referenceTokens` | ≤ 8.6 ms |

Helpers on 100k tokens: `uncovered` 48 ms, `hasNegation` 16 ms, `imitationQualified` 35 ms, `hintAllowed` 418 ms. Real input is capped at about 100 tokens (200 characters), so these are not reachable. The matcher's worst case with curated adversarial phrases is 21 ms.

**4. Can one key starve others' outbound budget now?**
No. Three or more keys can (SA-K3-03, Low).

| Scenario (`r3/starve.mts`, 15/min host, share 1/3) | Result |
|---|---|
| One key fires 50 requests | 5 succeed; a victim then gets 5 of 5 |
| One key attacks for 10 minutes | Victim succeeds 10 of 10 times |
| Three keys at 5 each | Victim gets 0 of 5 |
| Three keys attack for 10 minutes | Victim succeeds 1 of 10 times |

A key refused by its partition spends no shared token.

**5. Does the eval gate genuinely test AI-41/42?**
No (SA-K3-02, Medium). Details below.

## Findings

### SA-K3-01 (Medium): a crowd-edited Open Food Facts brand can make a synonym "exact" and the answer `high`

**Where:**
- `src/classify/pipeline.ts:338-341`: `brandTokens` is built from `info.product.brand`, which comes from the adapter or the cached adapter data
- `src/classify/synonyms.ts:125`: `uncovered(hay, p.tokens, ignore)`
- `src/classify/coverage.ts:48-56`

**Issue:** brand tokens returned by Open Food Facts or Open Beauty Facts are subtracted from the caller's name before the whole-name check. Anyone can edit those brands. Setting a product's brand to the extra words in a merchant's product name turns a partial synonym match (medium or low) into an exact one, which gives `high` with `needs_review: false`. This is the same class of problem as SA-K-03: by ruling 22, third-party data must not lift a candidate to `high`. No review hint is added, because `externalLabel` hints are only attached when `!highEligible`.

**Proof** (`r3/high.mts`, illustrative fixture, synonym `glucometer → 9027`):

```
"glucometer test strips"  OFF brand null           → 9027:0.51:low  needs_review=true
"glucometer test strips"  OFF brand "Test Strips"  → 9027:0.92:high needs_review=false
```

Test strips are a different product from the meter. An attacker edits the OFF brand of a popular strips barcode, and every merchant who scans it while sending their own name gets a high, review-free answer for the wrong heading. Brands containing negation or imitation words are still caught ("Not Real" → medium; "Imitation Look" and "Brass Co" → 7117 medium), but any neutral word can be laundered this way.

**Required fix (either one):**
- (a) Do not use externally sourced brand tokens to establish exactness. Pass the brand ignore set only for `source: 'manual'` rows (admin-curated), or drop it.
- (b) If any brand token was needed to reach `uncovered(...) = []`, set `highEligible = false` and add the `externalText` review hint.

**Required test:** for a caller name whose exact match needs an OFF brand token, the result is never `high` and carries the external-source hint.

### SA-K3-02 (Medium): the AI-42 eval gate passes while the gate as written fails; the regression check compares the current version with itself

**Where:** `scripts/eval-classifier.ts:208-225, 249-252`; `test/eval/baseline.json`; `test/eval/eval.test.ts:42-57`.

**Issue:** each of the following lets the gate report PASS where AI-41/42 would not.

1. **Self-baseline.** `baseline.json` has `"classifier_version": "rules-fts-2.1"`, the same as `CLASSIFIER_VERSION`, and its numbers match the current run exactly. AI-42 requires "no regression … vs. the **previous** classifier.version". The check is therefore `x ≥ x − 0.01`, which always passes. Also:
   - `--write-baseline` overwrites the file with no check that the version changed;
   - `checkGates` never compares `baseline.classifier_version` with the current version.
2. **Top-3 gate rescoped without sign-off.** AI-42 requires top-3 recall (4-digit) ≥ 0.90. The script gates only on items whose label is in the seed master (`top3_4_in_master`).
   - Over all gated positives the result is **0.8466**, which fails.
   - The round-4 note itself says rescoping needs coordinator sign-off (AG-12).
   - No such sign-off is recorded in `00-coordinator-decisions.md` or 00b/00c.
3. **High-band precision measured on a near-tautological set.**
   - Only 14 items are answered `high` (precision 14/14). One error would give 0.93, a FAIL.
   - **All 14** are a curated synonym phrase plus quantity or ignorable words (`r2/evalhigh.mts`): "potato 1 kg", "sugar 1 kg", "maida 1 kg", "gold chain 22k 916 hallmarked 20 gm", "table fan 400 mm", …
   - Under the classifier's own coverage rule these are the synonym list itself. The AI-45 leakage check compares full normalised text including the quantities, so it never flags them.
   - The gate therefore mostly measures that synonyms map to their own codes, and says little about precision on real retail names.
4. **AI-41 metric missing.** Top-1 at 8 digits is hard-coded `null`.
5. **AI-40 labels.** Every label is an LLM draft (`labelled_by: "claude-classification-worker (LLM draft …)"`, `reviewed_by: null`). The same worker family wrote the synonyms. AI-40 forbids LLM labels for the gate. The fix document says so honestly, but CI still presents the gate as passed. Agents cannot fix this part; it needs human labelling.

**Proof:** `npx tsx scripts/eval-classifier.ts`:

```
PASS top-3 recall (4-digit, in-master) >= 0.90: 0.9392 over 329 items (all positives: 0.8466 over 365)
PASS no regression > 1 pt on top1_4 vs rules-fts-2.1: 0.7753 → 0.7753   (all six: identical before/after)
  high   answered 14  correct 14  precision 1
```

**Required fix:**
- (1) Keep the baseline from the previous released version (for example `rules-fts-2.0`) and fail when `baseline.classifier_version === CLASSIFIER_VERSION`. Allow `--write-baseline` only for a newly bumped version and record who approved it.
- (2) Gate top-3 on all positives as AI-42 states, or record a coordinator ruling that rescopes it. Until then, report the gate as FAIL.
- (3) Extend the AI-45 check to flag items whose `uncovered(tokens, phrase)` is empty for some synonym. Report high-band precision only on items that are not leakage, and require a minimum high-band count (or a confidence interval) before calling the gate passed.
- (4) Compute top-1@8 or mark the AI-41 metric missing as a gate FAIL.
- (5) Leave the gate marked "not a ship gate" until human labels and review are in place (AI-40).

### SA-K3-03 (Low): three keys can still starve the shared outbound budget; partitions are per key, not per owner

**Where:** `src/adapters/httpClient.ts:187-196, 219-221`. The pipeline uses the key id as the partition.

**Issue:** each key gets one third of a host's per-minute budget, so three keys together take all of it. That can be one owner holding several keys (SEC-15 rotation allows two at once, and admins can issue more) or a few tenants acting together.

**Proof** (`r3/starve.mts`): a 3-key burst leaves the victim 0 of 5; a sustained 10-minute 3-key attack lets the victim through 1 time in 10. A single key cannot starve others (victim 10 of 10).

**Fix:**
- Partition by key owner (actor or tenant), not by key id.
- Reserve a slice of each minute (for example 20%) for partitions that have not used outbound in the last minute, or use round-robin fair queuing.

### SA-K3-04 (Low): `isQuantityLike` hides digit-glued words from the whole-name check

**Where:** `src/classify/coverage.ts:42` (`/^\d+(?:\.\d+)?[a-z]{0,3}$/`).

**Issue:** any word of up to 3 letters prefixed by a digit is treated as a quantity.

**Proof** (`r3/glue.mts`): "22k gold ring 1toy" is high (0.94), while "22k gold ring toy" is medium (0.76). Only the caller can craft this; third-party data cannot.

**Fix:** allow only known unit suffixes, `^\d+(?:\.\d+)?(?:k|kt|g|gm|kg|mg|mcg|ml|l|cm|mm|in|pcs|pc|x)?$`, with the list taken from `UNIT_ALIASES`, karat forms and `COVER_IGNORE`.

### SA-K3-05 (Info): imitation-qualifier edge cases

**Where:** `src/classify/qualifiers.ts:92-101`.

**Issue:** any "plated|plating" followed by a precious metal turns the rule off for the whole name, so "silver plated gold ring" (0.79) and "plated gold ring brass" (0.76) both stay 7113. A zero-width character inside "plated" also defeats the rule. Coverage keeps all of these at medium or below, and the rule only ever lowers confidence, so there is no safety impact.

**Optional fix:** treat the substrate exception as "the *last* metal word is precious and no base-metal word (brass, alloy, copper) is present".

### SA-K3-06 (Info): partition buckets are cleared all at once at 10,000 entries

**Where:** `httpClient.ts:191`. When the map is cleared, every key's share resets. Reaching it needs 10k distinct partitions per process, which is not realistic with admin-issued keys.

**Optional fix:** evict least-recently-used entries.

## New code: verified as passing

**`coverage.ts`, `synonyms.ts`:**
- A synonym is exact only when the phrase covers the whole name, apart from ignorable words.
- Single generic words are never exact.
- A one-word phrase inside a longer name scores 0.3.
- 16 adversarial names from the validator are never high (tests, plus my 48-name probe).
- The only holes are SA-K3-01 and SA-K3-04.

**`ruleHint.ts`:** the hint requires all of the following:
- an exact match on the caller's own name
- no negation word
- residual tokens equal to the phrase tokens
- a hint always means `needs_review: true` and a `review_hint` (invariant tested)

Third-party data still cannot set a hint (barcode-only and name `xyz` + barcode probes: no hint).

**`qualifiers.ts`:** only lowers confidence for Chapter 71 headings, never raises it (`highEligible: false` on every adjusted input); no rate is involved.

**`pipeline.ts`:**
- the high gate is `exactOnCallerName && hint === null && !negated`
- capacity causes are not cached
- `keyId` is required, with a shared no-key partition
- one version read per request

**`fusion.ts`:** unchanged formula apart from `highEligible`. `scoring` still allows confidence to be recomputed by hand (round-2 recompute probe still passes).

**`normalise.ts`:** keeping `\p{M}` causes no ReDoS (timed) and keeps Devanagari negation words whole.

**`httpClient.ts` / `budget.ts` partitions:**
- the partition is checked before the shared bucket, so a refused key spends no shared token
- partitions are created lazily
- a key gets at least 1 token per minute
- `getJson` without a partition behaves as before (only the CBIC watcher's `getText` uses that path)

## To reach PASS

1. **SA-K3-01:** stop crowd-edited brand tokens from establishing exactness, and add the test.
2. **SA-K3-02:**
   - restore a real previous-version baseline and add the same-version guard;
   - gate top-3 on all positives, or obtain a recorded coordinator ruling;
   - extend the leakage check to coverage-equivalent items;
   - handle top-1@8;
   - keep the human-label requirement (AI-40) as an explicit release blocker.

The Lows and Infos may be tracked.
