# Security code review: classifier and adapters, round 1

- **Auditor:** security-auditor (code, part 2 of 2)
- **Date:** 2026-10-10
- **Code:** `/home/claude/hsn-api/server` (not a git repo, so no commit hash; reviewed as of this date)
- **Scope:** every file in `src/classify/` and `src/adapters/`, plus `src/routes/classify.ts`, `test/classify/` and `test/adapters/`
- **Measured against:** `docs/05-security-checklist.md`, `docs/06-ai-restrictions.md` (Part A), `docs/00b-coordinator-rulings.md`, and `design/architecture.md` §5 (confidence formula)
- **Mode:** review only. No source or test file was changed. Throwaway probe scripts are in `/home/claude/audit-scratch2/`.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | none |
| High | 2 | SA-K-01, SA-K-02 |
| Medium | 5 | SA-K-03, SA-K-04, SA-K-05, SA-K-06, SA-K-07 |
| Low | 7 | SA-K-08 … SA-K-14 |
| Info | 4 | SA-K-15 … SA-K-18 |

**Overall:** the deterministic path is sound.
- The SSRF hardening held under every probe I ran: rebinding, IP literals, IPv6 and IPv4-mapped forms, redirects, gzip bombs, slow-drip bodies, DNS hangs, proxy environment variables and deeply nested JSON.
- The classifier never reads, computes or changes a rate. Rates are attached only in `routes/classify.ts` through `ctx.rates.resolve`.
- Confidence is deterministic.

**Both High findings are in the optional LLM re-ranker guard** (`rerank.ts`). As written, it does not enforce AI-01, AI-04, AI-12, AI-13 or AI-14.
- The exposure is **latent today**: `createClassifier` always injects `DisabledReranker`.
- These findings **must be fixed before any LLM provider is wired in**, and they block AI-43 enablement.
- In the current guard, an out-of-list code is tolerated, partial rankings are accepted, and free LLM text is returned to clients. A full-width `１８％ ｇｓｔ` passes the rate-text filter and is then turned into `18% gst` by NFKC.

## Commands run (AG-22)

| Command (run from `server/`) | Result |
|---|---|
| `npx vitest run test/classify test/adapters` | 9 files, 202 tests passed |
| `npx tsx /home/claude/audit-scratch2/redos.mts` | Timed the normalisation regexes on 10k-char adversarial inputs (results under SA-K-10) |
| `npx tsx /home/claude/audit-scratch2/rerank.mts` | Re-ranker guard bypasses (SA-K-01, SA-K-02) |
| `npx tsx /home/claude/audit-scratch2/http.mts` | Local TLS server and fake proxy probes of `OutboundHttpClient` |
| `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:18999 … npx tsx …/http_env.mts` with a listening fake proxy | No traffic went through the proxy (pass) |
| `npx tsx /home/claude/audit-scratch2/pipeline.mts` | Cache, trust and per-request cost probes (SA-K-03, SA-K-04, SA-K-05, SA-K-09) |
| `npx tsx /home/claude/audit-scratch2/ip.mts` | Odd IPv4 and IPv6 forms against `isBlockedAddress` |
| `npx tsx /home/claude/audit-scratch2/syn.mts` | Synonym matcher build cost compared with match cost |
| `npx tsx /home/claude/audit-scratch2/det.mts` | Determinism under repeats and token permutations |
| `grep -rnE "fetch\(\|http\.request\|https\.request\|undici\|node:https" src/` | Only `src/adapters/httpClient.ts` makes outbound calls |
| `grep -rn rate_bp src/classify/` | No matches (SEC-56 pass) |

Node version: v22.22.0.

## Per-file coverage

Every file was read in full.

| File | Lines | Checklist areas applied | Result |
|---|---|---|---|
| `src/adapters/httpClient.ts` | 271 | SEC-07, SEC-32..37, SEC-73 | Pass, with Low/Info notes (SA-K-06 rate budget, SA-K-15 json-seq, SA-K-16 module path) |
| `src/adapters/ipGuard.ts` | 115 | SEC-34 | Pass, Info SA-K-17 |
| `src/adapters/openFoodFacts.ts` | 91 | SEC-10, SEC-37, AI-10/11 | Pass. The error path feeds SA-K-04. |
| `src/adapters/productLookup.ts` | 47 | SEC-10, AI-11 | Pass |
| `src/classify/index.ts` | 47 | SEC-33, SEC-83, AI-20 | Pass. Adapters are off unless the kill switch, the per-adapter flag, the allow-list and the user agent all permit them. |
| `src/classify/stub.ts` | 9 | SEC-73 | Pass |
| `src/classify/types.ts` | 137 | Contract review | Pass. The contract says candidates are "sorted by confidence desc"; the re-ranker breaks that (SA-K-13). |
| `src/classify/normalise.ts` | 195 | AI-11, SEC-79 | Pass. Latent quadratic regex, Low SA-K-10. |
| `src/classify/gtin.ts` | 101 | SEC-28, SEC-37 | Pass. Low SA-K-14 (value reflected in error). |
| `src/classify/synonyms.ts` | 98 | AI-45, DoS | Pass. Cost issue is SA-K-05 (called from the pipeline). |
| `src/classify/fts.ts` | 57 | SEC-40, SEC-41, SEC-77 | Pass. Errors are swallowed to "no signal", and tokens are capped at 10. |
| `src/classify/barcodeCategory.ts` | 41 | AI-10, SEC-10 | Pass. Tags must match `xx:slug`; prefixes must match `^\d{2,8}$`. |
| `src/classify/chapterKeywords.ts` | 37 | DoS | Pass. 40 tokens and 120 variants, bound through `json_each`. |
| `src/classify/fusion.ts` | 218 | AI-03, AI-05, AI-06, AI-07, AI-32, architecture §5.4, rulings 5/6/24 | Pass. The formula, gate, penalty, close cap, drop, weak handling and 5-candidate cap match the spec. |
| `src/classify/rerank.ts` | 187 | AI-01, AI-02, AI-04, AI-07, AI-10..15, AI-22, AI-31 | **Fail**: SA-K-01, SA-K-02, SA-K-13 |
| `src/classify/pipeline.ts` | 343 | AI-05, AI-50/51, SEC-38, SEC-62, SEC-86 | Findings SA-K-03, SA-K-04, SA-K-05, SA-K-07, SA-K-08, SA-K-09, SA-K-11 |
| `src/routes/classify.ts` | 136 | SEC-03, SEC-24/25/28, SEC-56, SEC-62, AI-03/08/21 | Pass, with Low SA-K-11 and SA-K-12 |
| `test/adapters/httpClient.test.ts` | 214 | Do the tests prove their claims? | Mostly yes. Gaps listed under SA-K-18. |
| `test/adapters/ipGuard.test.ts` | 19 | Same | Yes. Good table. |
| `test/adapters/openFacts.test.ts` | 54 | Same | Yes |
| `test/classify/fusion.test.ts` | 128 | Same | Yes. AI-03 asks for a property test; this is a table test (SA-K-18). |
| `test/classify/gtin.test.ts` | 76 | Same | Yes |
| `test/classify/normalise.test.ts` | 67 | Same | Yes. No timing (ReDoS) assertion. |
| `test/classify/pipeline.test.ts` | 260 | Same | Mostly. The AI-16 corpus is inline; the fixture directory is missing (SA-K-07). No pipeline-level re-ranker test. |
| `test/classify/rerank.test.ts` | 137 | Same | **Encodes the AI-01 violation as expected behaviour** (lines 29–38). See SA-K-01. |
| `test/classify/helpers.ts` | 86 | Fixture honesty (AG-01/04) | Pass. Labelled illustrative, carries no rates. |

## Findings

### SA-K-01 (High): the re-rank guard tolerates codes outside the candidate list, and accepts partial or wrong-shape rankings

**Where:** `src/classify/rerank.ts:55-70`, `:106-118` and `:126-134`. Test: `test/classify/rerank.test.ts:29-38`.

**Issue:** AI-01 and AI-13 both say that any code not in the candidate list means the whole LLM output is discarded. AI-12 adds that any missing or duplicated code also means a full discard, and that the output must be `{ "ranking": [string, …] }`, a permutation of the codes sent.

The implementation does something different:
- It drops out-of-list codes and only discards the output when more than half of the codes are rejected (`rejected.length * 2 > ranking.length`).
- It accepts a ranking that names only some of the candidates (`applyRerank` appends the rest).
- It uses a different schema, `[{code, score, why}]`, and the system prompt (line 43) asks the model for a self-reported `score`.

A model that returns a code we never retrieved is either confused or injected. Either way, its ordering of the remaining codes cannot be trusted.

**Proof** (`rerank.mts`, case 1): the ranking `[2924, 7113, 3004]` with allowed codes `{3004, 3003, 2924}` gives `guard ok:true, rejectedCodes:["7113"]`, and the LLM ordering is applied (2924 moves from position 3 to 1). Case 2: the ranking `[2924]` alone is accepted. The existing unit test asserts the tolerant behaviour (`expect(one.ok).toBe(true)`).

**Required fix:**
- Any code not byte-equal to a sent code → `{ok:false, cause:'unknown_code'}`, log `ai.rejected_output`, use the deterministic order.
- Require `ranking.length === candidates.length`, with no duplicates and no missing codes.
- Switch the schema to `z.object({ ranking: z.array(z.string()) }).strict()` as AI-12 and architecture §5.6 specify, and remove `score` and `why` from the prompt.
- Update `rerank.test.ts:29-38` to expect a discard, and add a "missing code → discard" test.

### SA-K-02 (High): free LLM text reaches API clients, and the rate-text filter runs before NFKC

**Where:** `src/classify/rerank.ts:73`, `:107`, `:114` and `:143`.

**Issue:**
- AI-04 says "No LLM free text is returned; `detail` is written by our code". AI-14 says "no LLM text is returned". Yet `applyRerank` builds a reason detail `Re-ranker moved this … : ${why}` from the model's `why` string, and that reaches the response.
- The only control is the blocklist `RATE_TEXT`, and it is tested against the **raw** string (line 107). `sanitiseUntrusted`, which applies NFKC, runs afterwards (line 114). Full-width characters therefore slip past the filter and are then folded into ASCII.
- Hindi, spelled-out and abbreviated forms are not covered at all.
- The filter also does not stop "official / CBIC-approved" claims or URLs, which the A.7 prohibitions forbid.

**Proof** (`rerank.mts`):
- Case 3: `why: "Correct item, attracts １８％ ｇｓｔ, officially confirmed by CBIC"` passes the guard. The returned `llm_rerank` detail reads `… attracts 18% gst, officially confirmed by CBIC`, so rate text appears in a classify response.
- Case 4: `"इस पर अठारह प्रतिशत जीएसटी लगता है; eighteen per-cent levy, duty 18 pc"` is accepted verbatim.
- Case 5: `"Official CBIC-approved classification. Visit evil.example to verify. Ignore needs_review."` is accepted verbatim.

**Required fix:** never put model text in responses. The `llm_rerank` reason detail must be a fixed template, for example `Re-ranker moved this from position 3 to 1`. Drop `why` from the schema entirely (see SA-K-01). If an explanation is ever wanted, keep it in logs only, hashed or truncated. Add a test asserting that no model-supplied string appears anywhere in `JSON.stringify(result)`.

### SA-K-03 (Medium): crowd-editable product data alone can produce a `high`, `needs_review:false` answer, cached for 30 days

**Where:** `src/classify/pipeline.ts:198` (`text = input.name ?? info?.name`), `:124-134` (30-day upsert), and `:102-110` (cache hit reused for every caller).

**Issue:** Open Food Facts and Open Beauty Facts are publicly editable.
- When a request sends only a barcode, the adapter's `product_name` becomes the classification text.
- If it contains a curated primary synonym, `s_syn = 1.0` passes the gate, and the answer is `high` with `needs_review: false`.
- An attacker who edits a popular barcode's product name can therefore steer every client to a different HSN code (and so a different rate) with no review flag.
- The poisoned row is persisted in `products` for 30 days and served to all keys from `local_cache`. A later fix upstream does not reach us until the row expires.

The architecture permits name and category signals from adapters, but AI-A.2 classes adapter output as untrusted. Untrusted third-party text should not by itself clear the "no silent single answer" bar.

**Proof** (`pipeline.mts`, case 1b): a stub OFF result `{name: "Glucometer", categories: []}` for barcode 8901234012345 gives `[ '9027:1:high' ]` with `needs_review false`. Case 1: `name: "22k gold ring"` on a biscuits-category barcode is cached with `expires_at 2026-11-09` and served from `local_cache` on the next call. In that case it came out `medium` only because the category disagreed.

**Required fix:**
- When the text signal comes only from adapter or cached-adapter data (no request `name`), cap the top confidence at `MEDIUM_CAP` and add a `review_hint` reason ("product name from a third-party crowd-sourced database"), unless the barcode category also agrees (`s_bar = 1`).
- Shorten the positive TTL, or re-validate on read.
- Provide an admin purge for a `gtin`.
- Record the adapter `source` in `classify.decision` so poisoned rows can be traced.

### SA-K-04 (Medium): adapter errors are never negative-cached, so an attacker-shaped upstream record defeats SEC-38

**Where:** `src/classify/pipeline.ts:112-118` and `:143-157`; `src/adapters/openFoodFacts.ts:69-70`.

**Issue:**
- An adapter `error` (schema failure, `bad_json`, `bad_content_type`, `http_status`, timeout) is correctly not cached as "not found". However, nothing is cached at all, so every request for that barcode goes back out to the third party.
- Anyone can make an OFF record fail our zod schema, for example by setting `product_name` longer than 5000 chars or more than 500 `categories_tags`.
- That turns one barcode into an unlimited, uncached outbound amplifier, bounded only by per-key rate limits.
- The user is also told "Barcode … was **not found**" (`:158-164`, `:215`) when the lookup actually failed, which is misleading.

**Proof** (`pipeline.mts`, case 2): 50 requests for a barcode whose adapter returns `{status:'error', cause:'schema'}` produce **50** outbound calls.

**Required fix:**
- Cache adapter errors in a short-lived error cache (for example 10–15 min per gtin and source), separate from the 24 h not-found TTL and never served as "not found".
- Treat `schema` failures as a deterministic result to cache.
- Return a distinct message or `product.source` value for lookup-unavailable, instead of `not_found`.

### SA-K-05 (Medium): the synonym matcher is rebuilt from the whole table on every request (CPU DoS as the curated table grows)

**Where:** `src/classify/pipeline.ts:223` (`new SynonymMatcher(this.d.synonyms.allActive())`) and `src/classify/synonyms.ts:49-63`.

**Issue:** each classify request reads every active synonym row and re-tokenises every phrase (`referenceTokens` runs the full normalise pipeline, capped at 4000 chars) before matching. This is synchronous work on the event loop. The curated table is meant to grow to hundreds or thousands of rows.

**Proof:**
- `syn.mts`: with 500 synonyms the build takes 5.4 ms and the match 1.7 ms; with 5,000 synonyms the build takes 41.6 ms and the match 12.8 ms.
- `pipeline.mts` case 4: a full classify with 5,000 synonyms costs **105 ms per request** of blocking CPU.
- At 600 tokens/min per key and cost 5 (120 classify/min per key), about 5 keys saturate one core.
- `FtsRetriever` adds a `referenceTokens` call for each of its 10 hits per request (`fts.ts:41`).

**Required fix:**
- Build the `SynonymMatcher` and pre-tokenised HSN reference tokens once per `dataset_version` and invalidate them on publish, as architecture §6 already does for other caches.
- Index phrases by first token, or put them in a `Map` from token to rows, so `match` is not O(rows).
- Add a micro-benchmark test with a few thousand synonyms.

### SA-K-06 (Medium): no outbound request budget against third-party limits; one key can get our IP blocked

**Where:** `src/adapters/httpClient.ts:116` (concurrency cap only), `src/classify/index.ts:29`, and `src/classify/pipeline.ts:113-142`.

**Issue:**
- `research/sources.md` records Open Food Facts at **15 product reads/min/IP**. Open Beauty Facts says "API calls must match real user scans; scraping is blocked".
- The client caps concurrency at 4 but has no rate budget. Random valid GTINs are trivial to generate (a mod-10 check digit), so each one misses the cache.
- One `classify` key at 120 requests/min can therefore drive about 120 OFF calls/min plus OBF fallbacks, 8× the published limit.
- The likely result is an upstream IP block, which is a denial of service of the barcode feature for every tenant. It also breaches the provider's terms.
- When the 4 slots are full, legitimate lookups get `busy`, which is reported to clients as "not found" (see SA-K-04).

**Required fix:**
- Add a per-host token bucket in `OutboundHttpClient`, configurable and defaulting to 15/min for OFF and something conservative for OBF.
- When the bucket is empty, return `busy` without calling out.
- Consider a lower per-key daily quota for barcode lookups that miss the cache.
- Document the limits in the runbook (SEC-82).

### SA-K-07 (Medium): AI-16 injection fixture corpus is missing, and the guard's injection tests do not exercise Unicode or Devanagari against the re-ranker

**Where:** `test/fixtures/` (only `seed/` exists); `test/classify/pipeline.test.ts:113-156`; `test/classify/rerank.test.ts`.

**Issue:**
- AI-16 requires `server/test/fixtures/injection/*.txt` with the listed categories, run in CI. The corpus is instead an inline array in `pipeline.test.ts`.
- Homoglyph and Devanagari content is only run through the deterministic path, never through `guardRerankOutput` or `maybeRerank`. That is why SA-K-02 was not caught.
- There is no pipeline-level test with an enabled stub re-ranker. None of these is tested end to end:
  - `llm_used: true` and `classifier.llm_rerank`
  - the `ai.fallback` warning log (AI-31)
  - the `classify.llm_changed_top` log with `det_top` and `final_top` (AI-51)
  - "confidence never goes up" through the full pipeline

**Required fix:**
- Create `test/fixtures/injection/*.txt` covering every AI-16 category, including full-width `％`, `ＧＳＴ` and Devanagari rate text.
- Run each fixture through the deterministic pipeline and through `guardRerankOutput` (as both model output and `why`).
- Add a `ClassifierPipeline` test with a stub `Reranker` that asserts the logs and flags above.

### SA-K-08 (Low): unsalted SHA-256 of a possibly PII-bearing name in logs allows offline guessing

**Where:** `src/classify/pipeline.ts:329` (full SHA-256 of normalised text) and `src/routes/classify.ts:443` (`nameFingerprint`, 16 hex chars).

**Issue:** SEC-62 permits a hash, but an unsalted hash of a short string is reversible by dictionary. If a name such as `ramesh 9876543210 gold ring` is logged as a plain SHA-256, the 10-digit phone number can be brute-forced. Two different hashes of the same name are also logged.

**Required fix:** use an HMAC with a server-side secret (the pepper or a separate `HSN_LOG_HASH_KEY`), and log a single fingerprint.

### SA-K-09 (Low): cached `brand` and `category` are returned without re-sanitising

**Where:** `src/classify/pipeline.ts:102-104`.

**Issue:** only `name` is re-run through `sanitiseUntrusted` on a cache hit. `brand` and `category` are echoed exactly as stored. Today only `cleanText` and `cleanTags` output is written, but a `source: 'manual'` row or a future import path would bypass that.

**Proof** (`pipeline.mts`, case 3): a cached brand containing `‮` (right-to-left override) and a category containing `​` (zero-width space) are returned verbatim in `product`.

**Required fix:** apply `cleanText(brand, 100)` and the `cleanTags` pattern to `category` on read, or validate them at the `ProductRepo.upsert` boundary.

### SA-K-10 (Low): `unitRewrite` regex is quadratic; only the length caps keep it safe (SEC-79)

**Where:** `src/classify/normalise.ts:124`, `/(\d+(?:\.\d+)?)\s*([a-z]+)\b/g`.

**Issue:** on a run of digits with no unit, each start position consumes the rest of the run and then backtracks, so cost is O(n²). Untrusted input is capped at 200 code points first (`normalise.ts:142`), and curated reference text at 4000, so there is no exploit today. The pattern becomes dangerous if a cap is raised or the regex is reused.

**Proof** (`redos.mts`):
- Raw regex, no cap: 1,000 digits take 4.8 ms, 10,000 take 240 ms, and 50,000 take 4.1 s.
- Through `normaliseName` with a 10k-char input: at most 0.6 ms for every adversarial shape tried (digits, `1.`, `1a`, karat-like runs, hyphens, zero-width, bidi, combining marks, emoji, Devanagari).
- Through `referenceTokens` with 4000 digits: 47–62 ms (curated input only).
- NFKC expansion: `ﷺ`×10k takes 11.7 ms; `sanitiseUntrusted` on 100k chars takes 268 ms. The route schema caps `name` at 200 and the adapter zod schema caps fields at 5000, so this is fine.

**Required fix:** make the pattern linear, for example `/(?<![\d.])(\d+(?:\.\d+)?)\s*([a-z]+)\b/g` (sticky start), or tokenise first and then join number and unit tokens. Record the SEC-79 review in this file (done above), and add a timing test that runs 10k-char adversarial strings in under 50 ms.

### SA-K-11 (Low): the AI-50 decision log is split across two events with the same name and lacks `dataset_version`

**Where:** `src/classify/pipeline.ts:315-341` and `src/routes/classify.ts:459-462`.

**Issue:**
- Two different `classify.decision` events are written per request with different shapes.
- Neither event has `dataset_version` or `key_id`. `key_id` appears only on the generic request log line in `app.ts:253`, joinable by `request_id`.
- The pipeline's `latency_ms` excludes rate attachment.

**Required fix:** emit one `classify.decision` from the route, carrying the pipeline's fields plus `key_id`, `dataset_version`, and the adapter `source`.

### SA-K-12 (Low): the route trusts `result.product` and `reasons` shapes, and the response schema has no `required` or `additionalProperties` constraints on nested objects

**Where:** `src/routes/classify.ts:367-382` and `:405-433`.

**Issue:** the Fastify serializer drops unknown top-level keys, but nested `reasons[]` items and `signals` are loosely typed. A candidate with empty `reasons` would serialise without error, while AI-04 says that "a candidate with empty `reasons` fails response validation". Today `fusion.ts:186` always adds `no_signal`, so this is defence in depth.

**Required fix:**
- Add `required` lists to the candidate schema, plus `reasons: {minItems: 1}`, `confidence: {minimum: 0, maximum: 1}` and `confidence_band: {enum: [...]}`.
- Set `reasons.items.code` to an enum.
- Add a route test showing that an empty `reasons` list fails.

### SA-K-13 (Low): after an accepted re-rank, candidates are not sorted by confidence; `message`/`weak` are computed before the re-rank

**Where:** `src/classify/rerank.ts:126-147` and `src/classify/pipeline.ts:261-311`; the contract in `types.ts:13`.

**Issue:** the re-ranker can place a 0.22 candidate above a 0.72 one (`rerank.mts`, case 1). The architecture allows reordering, but `types.ts` promises "sorted by confidence desc", and clients may take `candidates[0]` as the best answer. Its band is `low`, so `needs_review` is still true. No integrity break was found.

**Required fix:** document in the OpenAPI spec that order is the ranking, not confidence order, when `llm_used` is true. Alternatively, cap a moved-up candidate so it cannot sit above a higher-confidence one unless every confidence is reduced to at most the new top's value.

### SA-K-14 (Low): the invalid-GTIN problem reflects the submitted value

**Where:** `src/classify/gtin.ts:66` and `src/classify/pipeline.ts:187`.

**Issue:** the error detail is `Check digit of "8901234012346" should be 5, got 6.`, which conflicts with SEC-75 ("not the rejected value"). The value is schema-limited to 8–14 digits, so the impact is nil. Also note that SEC-28 says 400 while the architecture and implementation use 422; the docs need reconciling.

**Required fix:** drop the echoed digits from `detail` (keep `expected` and `actual`), and align SEC-28 with architecture §2.2.

### SA-K-15 (Info): the content-type check accepts `application/json-seq` and similar types

**Where:** `src/adapters/httpClient.ts:221`.

**Issue:** `\b` after `json` matches before `-`, so `application/json-seq` is accepted (probe returned `ok:true`). The body still has to parse as JSON and pass zod, so the impact is nil.

**Fix (optional):** use `/^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/`.

### SA-K-16 (Info): the outbound module path differs from SEC-32

**Issue:** SEC-32 and architecture §3 name `src/lib/http.ts`. The implementation is `src/adapters/httpClient.ts`. The grep confirms it is the only user of `node:https`. The SEC-32 verification command in the checklist will report a false positive.

**Fix:** update the checklist and architecture paths, or move the file.

### SA-K-17 (Info): some non-routable IPv6 ranges are allowed

**Where:** `src/adapters/ipGuard.ts:105`.

**Issue:** `2001:10::/28` (ORCHID), `2001:2::/48` (benchmarking), `2001:20::/28` (ORCHIDv2) and `3fff::/20` (documentation, RFC 9637) return "not blocked". They are not internally routable in practice. All the important forms are blocked:
- IPv4-mapped and SIIT, both expanded and compressed
- NAT64 `/96` and `/48`
- 6to4 and Teredo
- `fd00:ec2::254` (AWS metadata)
- `100.100.100.200` (Alibaba Cloud metadata)
- shorthand IPv4 such as `0177.0.0.1`, `127.1`, `2130706433` and `0x7f.0.0.1` (rejected as non-IP)

**Fix (optional):** block `2001::/23` (the IETF protocol assignments block) and `3fff::/20`.

### SA-K-18 (Info): test gaps (claims that hold, but are not proven by a test)

**Issue:** the following behaviours were all confirmed by my probes, but no test covers them:
- gzip `content-encoding` rejection
- slow-drip body killed at the 3 s total (the existing test uses a 300 ms override)
- DNS resolver hang killed at the 2 s connect timeout
- proxy env (`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`) ignored
- deeply nested JSON returns `bad_json`, not a crash
- rebinding: the resolver is called exactly once per request and the connection goes to the checked address

AI-03 asks for a *property* test over random scores; `fusion.test.ts` has a table test.

**Fix:** add these as regression tests.

## Verified as passing (evidence)

**SSRF and outbound (SEC-32..37):**
- **Allow-list** (`httpClient.ts:128-144`): https only, no credentials, port 443, exact hostnames. A refused URL makes no DNS call and opens no socket (tested).
- **DNS and rebinding** (`:171-187`): our own `lookup` checks every address and connects to the first checked one. The probe confirmed one resolver call per request and a connection to the checked IP.
- **IP literals:** checked directly (`:141-142`).
- **Redirects:** any 3xx is a failure (`:218`).
- **TLS:** `rejectUnauthorized: true` with SNI. An untrusted certificate gives `network` (tested).
- **Proxy env:** `agent: false`, so `HTTPS_PROXY` and `NODE_USE_ENV_PROXY` are ignored (probed with a fake proxy that saw no connections).
- **Timeouts:**
  - total 3 s, hard-capped by `Math.min`; drip body probe: 3005 ms
  - connect 2 s; DNS hang probe: 2003 ms
- **Response limits:**
  - identity encoding only; gzip probe returned `bad_content_type`
  - 256 KiB cap enforced on the declared length and while streaming, chunked included (tested)
- **Concurrency and breaker:** at most 4 requests in flight; the breaker opens after 5 consecutive failures for 60 s.
- **Request headers:** only `user-agent`, `accept` and `accept-encoding` are sent.
- **Barcode URL (SEC-37):** the URL is built from a fixed origin and the validated digits (`openFoodFacts.ts:54-57`). `sourceRef` is built by us, never taken from the response.

**SEC-38:** found results are cached for 30 days and not-found for 24 h, and the negative cache is written only when every adapter answered "not found" (tested).

**SEC-10:** adapter JSON is validated by zod with length caps. Malformed or oversized responses become `error`, never a 500 (tested).

**SEC-39/40/41:** FTS goes through `buildFtsQueryFromTokens` (token re-validation, quoting, bound parameter) with at most 10 tokens. Repository errors are swallowed in `fts.ts:32-37`, so they never become a 500 or a fabricated match.

**SEC-56, AI-02 and A.7:** no `rate_bp` in `classify/`. `architecture.test.ts:23` guards the imports. Rates are attached only in `routes/classify.ts:454-457` via `ctx.rates.resolve`. The route re-checks `^\d{2,8}$` on every code and recomputes `needs_review`.

**AI-03/05/06/07 and rulings 5/6/24:**
- Bands are 0.85 and 0.60.
- The gate caps candidates without a primary synonym or a barcode-category hit at 0.84.
- Margin penalty is ≤ 0.05.
- The close cap applies to every candidate within 0.10 of the top.
- Candidates below 0.10 are dropped; a best score below 0.30 sets `message` and all bands `low`.
- At most 5 candidates are returned.
- Worked examples reproduce: 0.91, 0.72 and 0.94.
- The LLM can only lower confidence (`applyRerank` uses `min`).

**AI-10/11/22:** untrusted text is sanitised as follows:
- NFKC
- removal of Cc, Cf, Co, Cs and Cn code points
- whitespace collapse
- a code-point cap

The payload contains only `product_text`, `product_category` and code plus description; no price, barcode, key or ids (tested).

**AI-20/21 and SEC-83:**
- Adapters are off by default (tested).
- The re-ranker is always `DisabledReranker` in v1.
- `allowLlm` requires the request flag, `!llmOptOut` (missing auth means opted out) and `config.llm.enabled`.

**AI-31:** a 5 s timeout via `Promise.race` with abort. Any error falls back to the deterministic order and logs `ai.fallback` (unit-tested).

**AI-32:** repeated identical input gives byte-identical output (probed). Token-order permutations differ only in the order of quoted words inside `detail`; codes, scores and bands are identical.

**SEC-62:** no raw name in logs (tested with a name containing a phone number). The hash caveat is SA-K-08.

## Required before the next round

1. **SA-K-01 and SA-K-02:** fix the guard (strict permutation of strings, no model text in responses, any unknown code means full discard) and fix the tests that encode the old behaviour. These block any LLM enablement and AI-43.
2. **SA-K-03, SA-K-04, SA-K-05, SA-K-06:** mitigate before `HSN_OFF_ENABLED` or `HSN_OBF_ENABLED` is turned on in production (SA-K-05 regardless).
3. **SA-K-07:** add the injection corpus fixture directory and the pipeline-level re-ranker tests.
