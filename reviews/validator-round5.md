# Validator review, round 5 (final)

Date: 2026-10-12 (IST) · Reviewer: validator

## Scope

This round covers four things:
- **N3:** canonical citations must be enforced at every entry point, and the verify feed summary must use the new citation.
- **The optional `sources[]` counts.**
- **Regressions:** nothing from rounds 2–4 should have broken.
- **Final scores and verdict.**

## Method

**Build and test, from a clean copy of the deliverable** (`/mnt/project-files/hsn-api/server`):
- The deliverable copy is identical to the live tree: `diff -rq` is empty.
- `npm ci`: 0 vulnerabilities.
- `npm run typecheck`: exit 0.
- `npx vitest run`: **40 files, 922 tests passed**.
- `npm run eval`: every gate PASS. It still prints, unprompted, that its labels are provisional and its sample is too small.

**Live run on private ports 3957/3958, from a fresh seed.** The server was stopped afterwards. I ran:
- the bad-citation probes at every entry point;
- a padded and changed citation verify;
- the feed and meta;
- the round-4 regression sweep;
- `verify-audit`;
- timing checks.

A separate production-mode database was used for the `import-dataset` probe.

## N3: canonical citation enforced at every entry point

| Entry point | `"lol not a citation"` | `"9/2025 schedule 4"` | `"9/2025-CT(Rate), Schedule XIV"` |
|---|---|---|---|
| `verify` (`source.notification`) | 400, pointer `/source/notification` | 400 | 400 |
| `create` (`rule.source.notification`) | 400, pointer `/rule/source/notification` | 400 | 400 |
| `supersede` | 400 | 400 | 400 |
| `correct` | 400 | 400 | 400 |
| `npm run seed` (dev, tampered `data/seed` copy) | exit 2, "…is not a notification citation. Use the canonical form <n>/<yyyy>-<CT\|IT\|UTT\|Cess>(Rate)[, Schedule <I–VII>]…" | | |
| `import-dataset propose` (`NODE_ENV=production`) | exit 2, same message | | |

**Valid input still goes through.** A verify on 998892 with `notification: "  016/2025-CT(Rate)  "` was accepted and normalised to `16/2025-CT(Rate)`. After the second admin approved it:
- **Lookup:** the citation is `16/2025-CT(Rate)` with the view-pdf URL, `citation_note: null`, `verified`.
- **Feed:** the summary reads "998892 5% rule verified against **16/2025-CT(Rate)**", the new citation.
- **`sources[]`:** each entry now carries `rule_count` and `verified_count`. After this verify, 16/2025 is split into the index-URL entry (2 rules, 0 verified) and the PDF entry (1 rule, 1 verified), so a client can see how much of each notification has actually been checked.

**N3: Resolved.**

## Regression sweep (round 4 behaviour)

Every check below behaved as in round 4 or better:

- **Classify:**
  - "22K gold ring" → 7113, high.
  - "paracetamol 500mg tablet" → 3004, high, with an ambiguous rate.
  - "Samsung Galaxy tablet 10 inch", "shirt button", "chocolate biscuit" and "rolex watch gold" are all low with `needs_review`.
  - "artificial gold ring imitation" → 7117, medium.
  - "glucometer" → 9027, medium, `no_rate_rule`.
  - Bands are unchanged from round 4.
- **Lookup:**
  - 3004 is ambiguous.
  - 30049099 and 61091000 resolve via their parent, with `code_not_in_master`.
  - 6109 at 2500.01 → 18%.
  - 7103 → 0.25% with its scope condition.
  - 0000 → 404.
- **Tax:**
  - A mixed Sunarone and pharmacy invoice (7113 intra, 71039100 at 0.25%, 30049099 `intra_ut` with `condition: general`) gives `complete: true`. The paise are exact: CGST 104797, SGST 104690, UTGST 107. Round-off is −17, so the grand total is ₹85,682.00.
  - Without `accept_unverified`, the invoice gives `complete: false`, `totals: null`, excluded line ids listed, and `needs_input: ["accept_unverified"]`.
- **N1:** a verify on the 3004 nil rule without a URL → 400 `source-url-not-document`.
- **Meta:** 19 `known_data_gaps`.
- **Audit:** `export-audit-head` then `verify-audit --head` → `{"ok": true, "problems": []}`.
- **Security slowdowns (re-check):** a 500-line tax request completes in 26 ms, and `/v1/meta/dataset` in about 2 ms. Both auditors report PASS: `security-code-core-round6.md` and `security-code-classify-round4.md`.

## Final scores

| # | Dimension | R2 | R3 | R4 | **R5** | Basis |
|---|---|---|---|---|---|---|
| 1 | Fidelity and honesty | 8 | 8 | 9 | **10** | Every limit is surfaced to people and machines: the `unverified` status, the `citation_note`, the `accept_unverified` gate, `known_data_gaps`, the `sources[]` verified counts, the provisional eval banner, and "not official, not real-time". A verified rule always links the document it was checked against. |
| 2 | Consistency | 6 | 9 | 8 | **9** | The documented citation grammar is now the enforced grammar at all six entry points. DDL, openapi and route sweeps match the code. Fixture-vs-shipped differences are disclosed. |
| 3 | Completeness and testability | 7 | 9 | 9 | **9** | 922 tests, including a shipped-seed suite and a traceability test over TRD §15. The eval has gates. The production load and restore drill work as documented. |
| 4 | GST correctness against the research | 7 | 9 | 9 | **9** | Every recomputed amount is exact to the paisa. The thresholds, UTGST, 0.25%, nil-list ambiguity and history caveats are right. The gaps return `no_rate_rule` and are listed, never shown as 0%. |
| 5 | Developer experience | 6 | 9 | 9 | **9** | Zero to first call in 10 commands. Errors are actionable, report every problem and carry pointers. `needs_input` names the choices, codes outside the master are handled gracefully, and partial totals are clearly marked. |
| 6 | Code quality and test strength | 8 | 9 | 9 | **9** | Strict TypeScript and layered defences (API validation, DB triggers, HMAC audit with a cross-check, restore detection). Adversarial probes found nothing new. Both security audits PASS. |

## Verdict: **WOWED**

I would ship this with pride, as both a tax-tech product lead and a staff engineer, **as an engine**.

**Going live with real invoices still depends on human work outside this codebase.** These are data limits, not engineering defects, and the product states every one of them:
- Two people must verify the launch-set rules against the gazette PDFs (the launch gate, SM-01).
- The eval labels need human review (AI-40, the AG-12 entry).
- Synonyms need curating for Sunarone's and the health app's catalogues to raise the 3.9% high-band automation rate (SM-05).

## REQUIRED fixes

None.

## Optional polish (post-launch)

- **Change-feed `limit`.** `GET /v1/rates/changes?limit=1000` returns a 400 whose `detail` is generic ("1 field is invalid"). I did not inspect `errors[]`. Make sure the message states the maximum, for example "limit must be ≤ 500", so clients can self-correct.
- **First post-launch task.** Curate synonyms per tenant catalogue and track SM-05 from day 1. Load the full GST-portal HSN master through `import-dataset` once it can be downloaded; that also closes the provisional AG-12 gate scope.
