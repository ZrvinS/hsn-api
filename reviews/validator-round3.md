# Validator review, round 3

Date: 2026-10-11 · Reviewer: validator.

**Scope:**
- the 15 required fixes from `validator-round2.md` (R1–R15), each checked in code, data or live behaviour;
- a fresh client-developer run that follows only `server/README.md`;
- a re-score of all six dimensions.

## Method

### Static checks, in a clean copy
- I copied `/home/claude/hsn-api/server` to the scratchpad, leaving out `node_modules`, `dist`, `*.db`, `.env` and keys.
- `npm ci` finished with 0 vulnerabilities.
- `npm run typecheck` exited 0.
- `npx vitest run`: **36 files, 875 tests passed**.
- `npm run eval` exited 0 with every gate PASS. The run prints its own provisional warning and an "INSUFFICIENT SAMPLE" banner (see dimension 3).

### Quick start, run verbatim
I pasted the README's 10 commands as written:
- `cp .env.example`, then generated the secrets with `openssl`;
- seed, `bootstrap-admins`, `create-key`, `npm run dev`;
- three `curl | jq` calls.

All three outputs match the README byte-for-byte in substance: 7113 at 3% `unverified` with `citation_note`, classify gives 7113 0.86 high, and tax gives CGST/SGST 1027.5 with `complete: true`.

**Port collision (not a product defect).** A second, unrelated agent on this host was also using `localhost:3000`. It sent bad keys there and finally `SIGTERM`ed my dev server. I restarted the same database on private ports (`HSN_PORT=3927/3928`), which is the README's documented variable, and continued from there.

### Production first-load path (`NODE_ENV=production`)
- `seed` is refused.
- `bootstrap-admins` works.
- `import-dataset propose` (amit), then a self-approve by amit, which is refused.
- `approve` (priya): integrity ok, server ready, and 3004 is ambiguous.
- I then deleted `HSN_STATE_HWM_FILE` and restarted. The server logged `dataset.hwm_missing` and `/readyz` returned 503 `not-ready`, as documented.

### Live client calls
I made about 90 calls, all on a fresh database:
- the 26 classify inputs from my round-2 adversarial set, plus new ones;
- lookups of 6- and 8-digit codes that are not in the master;
- price thresholds and history dates;
- the Sunarone and pharmacy invoices, with and without `accept_unverified`, `condition: general`, a nil `rule_id`, and a bogus `rule_id`;
- two full maker–checker `verify` flows.

All servers were stopped afterwards.

## Round-2 required fixes: re-check

| # | Status | Evidence |
|---|---|---|
| R1 3004 nil rule | **Resolved** | Live `GET /v1/hsn/3004` returns `coverage: ambiguous`, `default_rule_id` = the 5% rule, and a 0% rule with `condition.code: nil_rate_list` and text "list not yet transcribed". A tax line without a choice gets `needs_input`. `condition: general` gives 5% (CGST 1.07 on ₹42.86); the nil `rule_id` gives 0. `test/seed-shipped.test.ts` runs on the real `data/seed`. |
| R2 one-word "exact" synonyms | **Resolved** | No wrong high on any adversarial input. "Samsung Galaxy tablet" is 3004 at 0.50 **low**, "shirt button" is low, "chocolate biscuit" is low, and "gold plated brass ring" / "artificial gold ring imitation" now rank **7117** first (medium). "rolex watch gold" is low. High only appears where the phrase is the whole name: "22K gold ring", "gold chain 22 carat", "t-shirt", "insulin injection" and "paracetamol 500mg tablet" (whose rate is ambiguous anyway). |
| R3 8-digit codes | **Resolved** | 30049099, 300490, 61091000, 85171300, 90273010 and 71141110 return 200 with `code_in_master: false`, `resolved_via` and the `code_not_in_master` warning. A pharmacy invoice with 30049099 computes, and nothing is rejected as a whole. `0000` (chapter 00 does not exist) still returns 404 with a helpful message. |
| R4 citation after verify | **Partly resolved** | The `citation_note` caveat moved out of `notification`, and `notification` is canonical. Verify clears the note, and the cross-check guards it. **The URL half is still open:** `verify` refuses `source.url` (400 `additionalProperties`). So 31 of 81 shipped rules, among them the 3004 nil rule, the 15/2025 job-work rules and every 1/2017 history row, can only be verified while still citing the CBIC *index page* (`cbic-gst.gov.in/central-tax-rate.html`). Verification then clears the one sentence that told the reader so ("Source link is the CBIC notification index…"). See N1. |
| R5 03-app-flow matches live | **Resolved** | §3 shows live captures. Paracetamol is documented as live high 0.87 with an ambiguous rate, and the fixture difference is stated in TRD T-C02. |
| R6 canonical citation | **Resolved** | `notification` is `9/2025-CT(Rate), Schedule IV` and similar. The free text is in `citation_note`. Polish: `01/2026` is zero-padded while `1/2017` and `9/2025` are not. |
| R7 docs index counts | **Resolved** | The counts and version strings are being synced per the coordinator note, so I ignored those two details. |
| R8 deliverable sync | **Resolved** | `diff -rq` between `/mnt/project-files/hsn-api/server` and the live tree (excluding `node_modules`, `dist`, db and `.env`) is empty. |
| R9 eval set and gates | **Resolved, with honest disclosure** | `test/eval/classify-eval.jsonl` has 495 items: 101 adversarial and a 50-item high-band probe. `npm run eval` and `eval.test.ts` gate CI. Everything is printed: the labels are LLM drafts, the high-band n is 16 with a Wilson lower bound of 0.806, and the INSUFFICIENT SAMPLE banner shows. See N2 for one process gap. |
| R10 traceability | **Resolved** | TRD §15.2 maps every one of the 103 IDs to file › test, marked covered / partial / fixture. It is a maintained table rather than an automated check; see polish. |
| R11 first production load | **Resolved** | `import-dataset propose` / `approve` is maker–checker, hash-bound and integrity-checked. I ran it end to end under `NODE_ENV=production`. |
| R12 README, quick start, `.env.example` | **Resolved** | This is the best part of the round: 10 commands to the first call, a production runbook, and a "Data status (read this first)" section with a field-meaning table. |
| R13 total on incomplete invoice | **Resolved** | With `complete: false`, `totals`, `round_off_paise` and `grand_total_paise` are null. `partial_totals` carries `included_line_ids` and `excluded_line_ids`. With `complete: true`, round-off is correct (−17 paise on ₹85,637.17). |
| R14 7103 scope | **Resolved** | `condition: other`, "not strung, mounted or set (Sch V scope wording not verified)". An invoice line on 71039100 computes 0.25% under 7103 with the condition note. |
| R15 3004 history | **Resolved** | `?date=2025-09-21` returns 12%, but now as `other` with "several 3004 items were at 5% under 1/2017 Sch I; check the specific entry" and the placeholder start date stated. The same caveat is on every history row. |

**Result: 14 of 15 resolved, R4 partly resolved.**

## Re-score

| # | Dimension | R2 | R3 | Why |
|---|---|---|---|---|
| 1 | Fidelity and honesty | 8 | **8** | Exemplary everywhere except one place where a limit is *hidden after* verification (N1). That is exactly the go-live state, since every launch-set rule must be verified first. |
| 2 | Consistency (docs↔docs, docs↔code, data) | 6 | **9** | Live outputs are pasted into 03, openapi examples come from live runs, the DDL is byte-checked, the route and problem sweep passes, and fixture-vs-shipped differences are stated. Small gap: AG-12 sign-off location (N2). |
| 3 | Completeness and testability | 7 | **9** | 875 tests, a shipped-seed suite, a traceability table, an eval with gates, and the production load and restore drill all work as written. |
| 4 | GST correctness against the research | 7 | **9** | Every recomputed amount is correct. The ₹2,500 boundary is right (2500 → 5%, 2500.01 → 18%), and so are the quantity-derived unit price, UTGST, 0.25%, nil-list ambiguity and history caveats. The gaps (7114/7118/7117, glucometer 9027, the 2202 interim) are honest `no_rate_rule`, never zero. |
| 5 | Developer experience (live run) | 6 | **9** | The quick start worked verbatim. Problems are actionable, codes outside the master are handled gracefully, and `needs_input` and `partial_totals` are clear. Polish items are below. |
| 6 | Code quality and test strength | 8 | **9** | Strict TypeScript and a large, meaningful suite: shipped-seed tests, property tests, a DDL identity check and an adversarial eval. Both security auditors now PASS in round 4. |

## Verdict: **NOT YET**: one dimension is at 8, and two small fixes remain

This is very close. The service is now one I would show a tax-tech lead with pride: honest about its data, correct in its arithmetic, careful where the law is ambiguous, and a developer is productive in five minutes. It falls short of WOWED on one honesty leak at the moment it matters most (verification for go-live) and on one recorded-process gap.

## REQUIRED fixes

**N1. `verify` cannot record the document URL, and it clears the caveat that the URL is only an index page.**
- **Where:**
  - `src/routes/admin.ts`: the verify body schema allows `source {pdf_sha256, schedule_serial}` only, and `source.url` is rejected as an unknown field;
  - `src/services/proposals.ts`: the verify approval clears `citation_note`;
  - 00c ruling 35;
  - the openapi `RateProposalCreate` verify example;
  - TRD T-A10;
  - data-model §4.
- **Live evidence:**
  - Verifying `rr_XC755…` (3004 nil, url `https://cbic-gst.gov.in/central-tax-rate.html`) is accepted with only the hash and serial.
  - A body that adds `source.url` gets 400.
  - After approval, a verified rule shows `citation_note: null` and an index-page URL.
  - 31 of 81 shipped rules have that URL.
- **Fix:**
  1. Let `verify` accept `source.url` (the document URL, run through the same exact-host and path checks as `rule.source.url`) and optionally `source.notification` (canonical regex).
  2. Make `url` **required** when the target's current URL is not a document. The test: it equals a configured listing page (`HSN_WATCHER_CT_RATE_URL`, `HSN_WATCHER_IT_RATE_URL`), or its path does not contain `/view-pdf/` and does not end in `.pdf`. Refuse such a verify with 400 `source-url-not-document`.
  3. On approve, replace `url` (and `notification` if given) together with setting the hash and serial. Allow this once, from the seed state, in the rule trigger, and include it in the audit entry and the verify-audit cross-check.
  4. Record the decision as ruling 36 in 00c. Update the openapi verify example (add `url`), TRD T-A10 (add two cases: an index URL without `url` gives 400; with `url`, the lookup shows the new URL and a null note) and data-model §4.

**N2. The provisional narrowing of the AG-12 gate is not recorded where AG-12 requires.**
- **Where:**
  - `06-ai-restrictions.md` AG-12: "never lower the eval gates … without coordinator sign-off recorded in `00-coordinator-decisions.md`";
  - AI-42, `test/eval/README.md` and `scripts/eval-classifier.ts` all describe top-3 gated on in-master items only as "coordinator-approved provisional scope".
  - `00-coordinator-decisions.md` (and 00b/00c) contain no such entry: grep finds nothing.
- **Fix:** add a dated entry to `00-coordinator-decisions.md`. It should state:
  - the narrowed scope (top-3 on in-master headings; all-positives reported, not gated);
  - why (the master is a curated subset);
  - the exit condition (the full HSN master is loaded, or a human-reviewed eval exists);
  - that Amit's sign-off is pending.

  Point AI-42 at that entry.

## Optional polish (not blocking)

- **Validation errors.** A `validation_failed` response still reports only the first issue (3 lines missing `supply_type` give one error). Return all zod issues, capped at about 50.
- **`needs_input` choices.** On a non-price ambiguous line (3004), `needs_input` lists only `rule_id`, although `condition: "general"` also resolves it. List `["rule_id","condition"]`, so a client can render both choices without parsing the note.
- **Automation rate.** High recall is 3.9% (16/410) in the eval, so most names come back medium and need review. That is the honest consequence of a conservative classifier and is disclosed (README, SM-05). The value to the user's "automatically detected" ask now depends on synonym curation for Sunarone's and the health app's catalogues. Make that the first post-launch task, with SM-05 tracked from day 1. "biscuits" alone gives medium and "cotton t-shirt" gives low; these are cheap curation wins.
- **Citation padding.** Normalise the canonical notification number padding (`1/2026` vs `01/2026`), or document that the gazette's own form is kept.
- **Traceability.** Automate TRD §15.2: a test that fails when an ID is missing from both the table and the suite.
- **Known gaps in meta.** Expose the known data gaps in `/v1/meta/dataset` (`known_gaps: [{prefix, reason}]`: 7114, 7117, 7118, 9027 glucometers, the 2202 interim, the nil-drug list), so a client can tell "not yet curated" from "no rule exists".
- **Port in the quick start.** The README hard-codes `localhost:3000`. Mention `HSN_PORT` / `HSN_ADMIN_PORT` in step 7 for machines where 3000 is taken.

## Required-fix count: **2** (N1, N2)
