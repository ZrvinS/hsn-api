# Validator review, round 2 (docs, code and a live run)

Date: 2026-10-11 · Reviewer: validator

**Scope:**
- every file under `docs/` (00, 00b and 00c rulings, 01–07, README, `design/`);
- `reviews/docs-fix-round2.md`, and a skim of `reviews/security-*-round2.md`;
- the live code at `/home/claude/hsn-api/server`;
- `research/sources.md`, as the GST reference.

**What I actually ran:**
- **Static checks.** `npx tsc --noEmit -p tsconfig.json` exits 0. `npx vitest run`: **25 files, 606 tests passed**.
- **Clean start from the shipped seed.** In a scratch DB I set `NODE_ENV=development`, `HSN_DB_PATH`, `HSN_KEY_PEPPER`, `HSN_AUDIT_KEY` and `HSN_LOG_KEY`, then ran:
  - `npx tsx scripts/seed.ts` (311 codes, 83 rules, all unverified);
  - `scripts/bootstrap-admins.ts --admin amit --admin priya`;
  - `scripts/create-key.ts --tenant sunarone --scopes read,classify`;
  - `npx tsx src/main.ts` on 127.0.0.1:3917 (public) and :3918 (admin).
- **Live curl session.** About 60 requests:
  - lookups, classify and tax;
  - the change feed and meta;
  - a full maker–checker `verify` (self-approve refused 403, the second actor approves, `rule_verified` appears in the feed, the ETag changes, and tax then computes without `accept_unverified`);
  - routing: an admin path on the public port returns 404, and a public key on the admin port returns 403.
- The server was stopped afterwards.

I did not judge the in-flight areas: the CBIC watcher parser (SA-C2-01) and audit verification (SA-C2-02).

## Verdict: **NOT YET**

| # | Dimension | Score |
|---|---|---|
| 1 | Fidelity and honesty | **8** |
| 2 | Consistency, docs↔docs and docs↔code (including the shipped data) | **6** |
| 3 | Completeness and testability | **7** |
| 4 | GST correctness against the research | **7** |
| 5 | Developer experience, including the live run | **6** |
| 6 | Code quality and test strength | **8** |

### What is genuinely excellent

These are the parts that would make a staff engineer proud:
- **The honesty surface is best-in-class:**
  - every response carries a `disclaimer`, `verification_status`, a `warning` and the `rate_unverified` warning;
  - `accept_unverified` gates tax (default refuse, `needs_input: ["accept_unverified"]`);
  - meta exposes `sources_checked_at: null`, `freshness_sla_business_days: 2`, `pending_notifications` and coverage counts (72 active, 0 verified);
  - placeholder history start dates are labelled as placeholders in the citation text itself.
- **Tax maths is right** on every case I recomputed:
  - 68,543.37 at 3% gives CGST 1,028.15;
  - 125,000.10 IGST at 3% gives 3,750.00;
  - `intra_ut` gives CGST + UTGST;
  - nearest-rupee round-off is 23 paise;
  - the ₹2,500 apparel threshold works: a unit price of 2500 gives 5%, 2500.01 or 2500.50 gives 18%, and quantity-derived unit prices work;
  - an ambiguous line without a price returns `needs_input: ["unit_price"]` with candidate ids;
  - a bogus `rule_id` returns 422 `rule-choice-invalid` with the valid candidates listed.
- **Maker–checker works end to end** over HTTP: actor-bound, hash-bound approval, an idempotency key, a feed event, ETag invalidation and an audit-chain head logged at boot.
- **Errors are clean RFC 9457 problems.** They carry a stable `type`/`code`, `request_id`, `errors[].pointer` and actionable `detail` (for example: "check digit should be 5, got 6 … send the product name instead"; "Try GET /v1/hsn/search … or the parent heading 6109").
- **Engineering discipline:**
  - typecheck is clean under strict flags;
  - 606 tests pass;
  - a DDL-to-doc byte-identity check;
  - openapi example validation;
  - a route and problem-code sweep;
  - and 35 coordinator rulings that are actually applied.

It is still not shippable to Sunarone or the health app as-is. The live product contradicts its own docs on the health app's core case (3004). It returns 404 or a whole-invoice 422 for ordinary 8-digit invoice HSN codes. Its "high = curated exact synonym" promise is broken by single-word synonyms: a *Samsung Galaxy tablet* is classified as **medicine at 0.91 high, `needs_review: false`**. And a new developer has no README or quick start to get from zero to a first call.

## Round-1 required fixes: re-check

**27 of 29 are resolved in the docs, and I confirmed many of them live:**
- coverage required (14);
- the 422 `invalid-gtin` (17);
- the `req_` ULID plus `client_request_id` (23);
- the token rate-limit headers (`RateLimit-Policy: 600;w=60;burst=100`, 15);
- UTGST (16);
- the ETag changing on a dataset change (4);
- `affected_prefix` (3);
- `content_sha256` (10);
- freshness fields (11);
- the PDF sha256 and serial on verify (12);
- FORMAT.md exists (13).

**Two are only partly resolved:**
- **#5 (3004 / nil-rated drugs).** The docs, the code path (`condition_code`, `rule_hint`, `selected_by_hint`) and the fixture tests implement ruling 5. However, the **shipped seed has no `nil_rate_list` rule**, so live `GET /v1/hsn/3004` returns `ambiguous: false`, 5%, with no exemption signal. This is the exact failure round 1 warned about: exempt drugs are silently billed at 5%. See R1.
- **#29(b) (canonical citation).** The docs fixed the form as `9/2025-CT(Rate), Schedule IV`. Every shipped rule instead says `9/2025-Central Tax (Rate) dt 17-09-2025 (w.e.f. 22-09-2025) and corresponding IGST (Rate) notification, Schedule IV; S.No. not verified (gazette not read)`. See R6.

## REQUIRED fixes

Each fix lists the file, the location, the problem and the exact fix.

### A. Correctness and honesty (blocking)

**R1. 3004 is not ambiguous in the shipped product, so nil-rated drugs are silently billed at 5%.**
- **Where:** `server/data/seed/rate_rules.json` (only `3004 500bp` and the `3004 1200bp` history row), against 00c ruling 5, TRD T-R13/T-T08, `03-app-flow.md` §3 and §5.2, PRD P3, and the openapi `&rate3004` and tax example line 4.
- **Live result:** `GET /v1/hsn/3004` gives `coverage: ok`, 5%. Classify "insulin injection" gives 3004 high at 5%. The only nil-drug signal is a free-text `review_hint` reason on some synonyms.
- **Fix:**
  - Add the rule `{hsn_prefix: "3004", igst_rate_bp: 0, condition_kind: "other", condition_code: "nil_rate_list", condition_text: "Drugs and medicines on the nil-rate list of 10/2025-CT(Rate) (33 specified life-saving drugs; list not yet transcribed)", effective_from: "2025-09-22", unverified}`. Cite the 10/2025 research URL (`research/sources.md` line 15 / row 13).
  - Re-seed and confirm that live `GET /v1/hsn/3004` returns `ambiguous`, `default_rule_id` = the 5% rule, and that a tax line without `rule_id` or `condition: general` gets `needs_input`.
  - Add `test/seed-shipped.test.ts`, which loads `data/seed/` (not `test/fixtures/seed/`) and asserts:
    - 3004 ambiguous with a default;
    - 7113 at 3%;
    - 6109 ambiguous and resolved by price;
    - 999721 at 5%.

  This also closes the root cause: the tests only ever run on the 17-rule fixture.
- **Also:** remove the test fixture phrase "insulin injection" as the nil-rate example from `test/classify/round2.test.ts`, `round3.test.ts` and `route.test.ts`. Use a neutral placeholder such as "nil-listed drug x". Insulin is not established as nil-rated in the research, and a fixture that pins it as nil teaches the wrong law.

**R2. "High needs an exact curated synonym" is false in practice. Generic one-word synonyms produce wrong `high`, `needs_review: false` answers.**
- **Where:**
  - `server/src/classify/synonyms.ts` and `pipeline.ts`, where a synonym counts as `synonym_exact` = 1.0 when its tokens appear anywhere in the name;
  - `data/seed/synonyms.json`, which has single-token phrases such as `tablet`→3004, `shirt`→6205 and `chocolate`→1806;
  - PRD §2.3, architecture §5.4 and 03 §3, which all promise this rule.
- **Live result:**

  | Input | Answer | Correct heading |
  |---|---|---|
  | "Samsung Galaxy tablet 10 inch" | 3004, 0.91 high | 8471 |
  | "lenovo android tablet" | 3004, 0.92 high | 8471 (8471 is offered at 0.18) |
  | "shirt button" | 6205, 0.92 high | 9606 |
  | "chocolate biscuit" | 1806, 0.94 high | 1905 |
  | "cotton t-shirt" | runner-up 6205 (woven shirts), 0.68 medium, via "shirt" | — |

  A retailer app pre-fills on high (03 §3, "Pre-fill HSN and rate"), so these errors reach invoices.
- **Fix:**
  - (a) Score a synonym as `exact` (1.0) only when its phrase covers every non-quantity, non-form token of the name: reuse `residual()` from `ruleHint.ts`. Otherwise score it `partial` (0.7), which caps the result at medium.
  - (b) Add a `min_tokens ≥ 2` rule for `exact`, or mark single generic words (`tablet`, `shirt`, `chocolate`, `ring`, `chain`, `cream`, `oil`, …) as `strength: partial` in the seed.
  - (c) Add these five inputs as regression tests asserting "not high". Add one test asserting that "Samsung Galaxy tablet" ranks 8471 above 3004, or at least does not return 3004 above low.
  - (d) Update architecture §5.4 and PRD §2.3 to define "exact" as "the curated phrase *is* the product name, after removing quantities and pack words".

**R3. Ordinary 8-digit and 6-digit invoice codes get 404, and one such line fails the whole invoice with 422.**
- **Where:**
  - `server/src/routes/hsn.ts` and `services/tax.ts`, which require the code to exist in `hsn_codes`;
  - the seed master, which has 311 codes;
  - PRD US-01 AC3 and 03 §10 ("Unknown code → 404").
- **Live result:** these codes return 404 even though a rule exists on their prefix: `30049099` (the most common pharmacy invoice code), `300490`, `61091000`, `610910`, `85171300`, `90273010` and `71141110`. A pharmacy bill with one `30049099` line is rejected entirely: 422 `unknown-hsn`.
- **Impact:** billing apps store 6- or 8-digit tariff codes (e-invoice and GSTR-1 HSN summary), so this defeats "any app that uses HSN numbers".
- **Fix:** pick one option and write it in PRD AC3, TRD §4, openapi and 03 §10.
  - **(a) Recommended:**
    - A well-formed code (pattern-valid) whose nearest known ancestor exists resolves against that ancestor's rules.
    - It returns 200 with `code_known: false`, `resolved_via: "<ancestor>"` and the warning `code_not_in_master`.
    - The code is never 404'd while a covering rule exists.
    - Tax lines do the same with a note, never a whole-invoice 422.
  - **(b)** Load the full GST-portal `HSN_SAC.xlsx` master (PRD §2.1) through a one-time seed step with a sha256 recorded.
- **Tests either way:** `GET /v1/hsn/30049099` → 3004 rule, and a mixed invoice with `30049099` gets computed lines.

**R4. A verified rule still says "S.No. not verified (gazette not read)", and its URL can stay on an index page.**
- **Where:** the `verify` action (00c ruling 35: verify sends only `{pdf_sha256, schedule_serial}`) in `src/services/proposals.ts`, and `source.notification` / `source.url` on rules.
- **Live result:** after approval, `GET /v1/hsn/7113` gives `verification_status: verified`, `verified_by: priya`, `schedule_serial: "Sch IV S.No. 0000"`, but `source.notification` still ends "S.No. not verified (gazette not read)". The feed summary reads "rule verified against … gazette not read". 61 of the 83 rows point at `cbic-gst.gov.in/central-tax-rate.html`, an index page. A rule can therefore be "verified" against a PDF hash whose URL is never recorded.
- **Fix:**
  - `verify` must also carry `notification` (the canonical form, see R6) and `url`. Require `url` to be a document URL: for example a path matching `/view-pdf/` or ending in `.pdf`, and not one of the configured listing pages. Reject verify with 400 otherwise.
  - On approve, replace the rule's notification and url (both are set-once from the seed-placeholder state; add them to the trigger allow-list).
  - Update 00c r35 (by a ruling 36), the openapi verify example, TRD T-A10 and data-model §4.
  - Test: verify → the lookup shows the new notification and URL, and no "not verified" text.

### B. Docs↔product consistency

**R5. The 03-app-flow health-app walkthrough does not match the live product.**
- **Where:** `03-app-flow.md` line ~113 says "paracetamol 500mg tablet" → 3004 at 0.72 medium, `needs_review: true`, rate ambiguous.
- **Live result:** 0.87 high, `needs_review: false`, rate unambiguous. The high comes from the single-word synonym "tablet" (R2), and the unambiguous rate from the missing nil rule (R1).
- **Fix:** after R1 and R2, re-run the five 03 §3 walkthroughs (gold ring, paracetamol, dry fruits, T-shirt, biscuits barcode) against the shipped seed. Paste the actual confidence, band and coverage values, and label any value that depends on future curation as illustrative. Add them as an executable test (`test/flows.test.ts`) so the doc cannot drift again.

**R6. The canonical citation form is defined but not used by the data.**
- **Where:** data-model §1 `notification_ref` (canonical `9/2025-CT(Rate), Schedule IV`) against every row of `data/seed/rate_rules.json` and the `/v1/meta/dataset` `sources[]`, which are 17 long free-text variants.
- **Fix:**
  - Split the field into `notification` (canonical: `<no>/<yyyy>-CT(Rate)[, Schedule <roman>][, S.No. <n>]`) and `notification_note` (the free-text caveat, for example "gazette not read; history start date is a placeholder").
  - Validate the canonical form with a regex in the seed loader and in proposal zod.
  - Update FORMAT.md and the openapi `Source` to match.

**R7. Stale counts and descriptions in the docs index.**
- **Where:** `docs/README.md`:
  - it says data-model has "135 trigger and constraint tests", but `docs-fix-round2.md` Ruling 34 says the DDL section is now generated from code with **93 checks**;
  - it describes 00c as "rulings 1–25 (Part C adds 26–33)", but 00c has **1–35**;
  - it claims "everything is in draft" with "Status as of 2026-10-10".
- **Fix:** correct the three numbers. Add a line saying the server exists, with test count 606 and the commands to run it.

**R8. The deliverable copy of the server is stale.**
- **Where:** `/mnt/project-files/hsn-api/server` against the live `/home/claude/hsn-api/server`. They differ in 15 files: `src/classify/ruleHint.ts` and `test/classify/round3.test.ts` exist only in the live copy, and `config.ts`, `routes/admin.ts`, `services/rates.ts`, FORMAT.md and others differ.
- **Fix:** after the in-flight security patch lands, sync the live tree to `project-files` (excluding `node_modules` and `*.db`). Record the sha256 of `package-lock.json` and the test count in the final review.

### C. Completeness and testability

**R9. The classifier eval set and gates that the docs make mandatory do not exist.**
- **Where:** 06 AI-40/41/42 require `server/test/eval/classify-eval.jsonl` (≥ 300 human-labelled items), `npm run eval`, and a high-band precision of at least 0.97 as a ship gate. SM-04 also depends on it. There is no `test/eval/`, no `eval` script, and no AI-45 leakage check.
- **Why it matters:** R2 is exactly what this gate exists to catch.
- **Fix:**
  - Add the eval file. Start with ≥ 100 items and say so in AI-40 as an interim target with a dated plan to reach 300. Include ≥ 20 adversarial negatives ("tablet" electronics, "ring light", "gold-plated brass", "imitation gold ring", "shirt button", "chocolate biscuit").
  - Add `scripts/eval.ts` and `npm run eval`, printing top-1@4, top-3@4, high-band precision and coverage.
  - Fail `npm test` (or CI) when high-band precision is below 0.97.
  - Record the first run in `reviews/ai-eval-2026-10-xx.md`.

**R10. No traceability between the TRD tests and the suite.**
- **Where:** none of the 89 test IDs in TRD §15 (T-R01…T-X01) appears anywhere in `server/test/`. Some tests exist under other names (T-T01's 102,750 paise, T-F05 in `rulings-round2.test.ts`, T-R11), but nothing shows which TRD tests are implemented or missing.
- **Fix:**
  - Prefix each `it()` with its ID (for example `it('T-T01 intra 7113 …')`).
  - Add a check (`test/traceability.test.ts`) that parses `docs/02-TRD.md` §15 and fails when an ID is neither referenced in `test/` nor listed in an explicit `deferred` array with a reason.

**R11. No path documented for first production data.**
- **Where:** TRD §16 line 435 says "`npm run seed` is refused in production; production data arrives through proposals or a restore". Proposals need a published dataset first, so on a fresh production DB neither path is possible as written.
- **Fix:** document the go-live procedure in TRD §16 and 07 §12:
  - seed in a `staging` environment (`NODE_ENV=development`) with the **production** `HSN_AUDIT_KEY`;
  - verify the launch set there through maker–checker;
  - `scripts/export-audit-head.ts`;
  - copy the DB file to production as a restore;
  - `rotate-feed-epoch`;
  - `verify-audit --head`.

  State which secrets must be identical across the two environments (`HSN_AUDIT_KEY`, the peppers). Add a script test, or at least a dry-run checklist in `reviews/`.

### D. Developer experience

**R12. There is no server README, quick start or `.env.example`. SM-06 ("≤ 1 day using the quick start") cites a document that does not exist.**
- **Where:** `server/` has no README. The docs never list the minimum env set. I had to read `src/config.ts` to learn that `NODE_ENV` is required with no default, that `HSN_KEY_PEPPER` and `HSN_AUDIT_KEY` must be ≥ 32 characters and different, and that `HSN_LOG_KEY` is needed in production.
- **Fix:** add `server/README.md` with:
  1. prerequisites (Node 22, `.nvmrc`);
  2. `cp .env.example .env` with every variable, its default and whether it is required, generated from `EnvSchema`;
  3. the exact sequence I used: seed → bootstrap-admins → create-key → `npm run dev`;
  4. four copy-paste curls: lookup 7113, 6109 with `unit_price`, classify by name, and a tax call **with `accept_unverified: true` explained**;
  5. client snippets in Node `fetch` and Kotlin/OkHttp covering the `If-None-Match` and change-feed loop;
  6. a "what the honesty fields mean" table (`verification_status`, `coverage`, `needs_input`, `needs_review`).

  Link the README from `docs/README.md` and from PRD SM-06.

**R13. An invoice total is offered on an incomplete invoice.**
- **Where:** `POST /v1/tax/calculate` with `invoice_rounding: nearest_rupee`.
- **Live result:** with `complete: false` (one `no_rate_rule` line of ₹7,000), the response still returns `grand_total_paise: 20145000` and `round_off_paise: 23`, both computed without that line. A client that prints `grand_total` under-bills the customer.
- **Fix:**
  - When `complete` is false, return `grand_total_paise: null` and `round_off_paise: null`, plus the top-level note `totals_exclude_unresolved_lines` listing the excluded `line_id`s.
  - Update the openapi `TaxCalculateResponse` and TRD §6.
  - Add test T-T12.

### E. GST data fidelity

**R14. The 7103 rule dropped the "not set" scope that the research gives.**
- **Where:** `data/seed/rate_rules.json` 7103 at 25 bp has `condition_kind: null`. Research row 7 says "Precious/semi-precious stones (not diamonds), **not set**". A coloured stone that is strung, mounted or set falls under 7113/7116 at a different rate.
- **Fix:** set `condition_kind: "other"` and `condition_text: "Precious (other than diamonds) and semi-precious stones, not strung, mounted or set (Sch V scope wording not verified)"`.

**R15. The 3004 rate before 22-09-2025 is presented as a flat 12% without the fixture caveat that round 1 required.**
- **Where:** `rate_rules.json` 3004 at 1200 bp, 2025-09-01→2025-09-21, `condition_kind: null`.
- **Live result:** `GET /v1/hsn/3004?date=2025-09-21` gives 12%, `coverage: ok`, and a tax line at 12%. Under 1/2017 many 3004 items (List-1 drugs, some formulations) were at 5%. Round-1 fix 5 asked for this to be labelled a simplification.
- **Fix:** make this row `condition_kind: "other"` with `condition_text: "Rate for medicaments generally before 22-09-2025; several 3004 items were at 5% under 1/2017 Sch I; check the specific entry"`. Better, add the 5% `other` sibling row so the history is ambiguous rather than wrong. Apply the same treatment to the 9018 and 330610 history rows if their research rows say "most" or "many".

## Optional polish

- A `validation_failed` response reports only the first issue: 8 lines each missing `supply_type` give one error. Return every zod issue (capped at about 50).
- Make `supply_type` default to `intra` when a key is configured with a home state, or explain in the 400 detail which values are allowed.
- Sunarone coverage: 7114 (silver articles), 7118 (coins) and 7117 return `no_rate_rule`, and research says gold coins are commonly 3%. Add them to the research to-do with a gazette-reading owner. Show them in a "known gaps" list in `/v1/meta/dataset` (`known_gaps: [{prefix, reason}]`), so clients can tell "not yet curated" from "no GST".
- Health app: glucometers are 5% in research, but `9027` has no rule, so classify returns 9027 medium with `no_rate_rule`. When R3(a) lands, consider a curated 9027 80 glucometer rule once the tariff line is confirmed.
- `/v1/meta/dataset` returns both `content_sha256` and `sha256` with the same value. Keep one and deprecate the other in openapi.
- 99972 is in the test fixture master but not in the shipped master, so live `GET /v1/hsn/99972` returns 404 while the TRD T-R11 example uses it. Add `99972` to `hsn_codes.json`.
- Classify of "gold coin 10g" gives 7108 (0.72 medium) above 7118 (0.53). Coins are 7118; adjust the synonym strength.
- `cache-control` on lookups was `max-age=3600` at 10:41 IST, which is correct. Also expose `Age`/`Date`, so clients can verify the IST-midnight cap.

## Required-fix count: **15**

Top 5:
- **R1**: the shipped seed lacks the 3004 nil-rate rule, so drugs are silently billed at 5%. Add a shipped-seed test.
- **R2**: single-word "exact" synonyms produce wrong high answers (a tablet computer becomes medicine at 0.91).
- **R3**: real 8-digit invoice codes return 404, and one such line fails the whole invoice with 422.
- **R12**: there is no server README, quick start or `.env.example`.
- **R9**: the classifier eval set and the high-precision gate are missing.
