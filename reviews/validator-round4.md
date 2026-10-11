# Validator review, round 4

Date: 2026-10-12 (IST) · Reviewer: validator

## What this round covers

- **N1:** ruling 36, verifying a rule that cites an index page.
- **N2:** the AG-12 sign-off entry.
- Spot-checks of the round-3 polish items.
- Re-scores for all six dimensions.

## How I tested

**Clean copy.** I copied the live tree, without `node_modules`, `dist`, databases or `.env`, then ran:
- `npm ci`: 0 vulnerabilities;
- `npm run typecheck`: exit 0;
- `npx vitest run`: **38 files, 895 tests passed**.

`diff -rq` between `/mnt/project-files/hsn-api/server` and `/home/claude/hsn-api/server` is empty.

**Live run.** I followed the README quick start, using its new `HSN_PORT` note to put the server on private ports 3947/3948. I then exercised N1 end to end and stopped the server afterwards. The steps were:
- `export-audit-head`;
- `verify-audit --head`;
- the change feed;
- meta;
- tax validation probes.

## N1: verifying a rule that cites an index page

I ran N1 on the 3004 nil-rate rule `rr_XC755…`. Before verification it cited `https://cbic-gst.gov.in/central-tax-rate.html` with the note "Source link is the CBIC notification index…".

| Step | Result |
|---|---|
| verify without `source.url` | **400 `source-url-not-document`**, detail "…cites …central-tax-rate.html, a listing/index page … Send source.url … (ruling 36)", `errors[0].pointer: /source/url` |
| verify with `url` = the index page | 400 `validation_failed`, "Must link the notification document (a /view-pdf/ or .pdf URL)" |
| verify with a look-alike host `taxinformation.cbic.gov.in.evil.com/view-pdf/…` | 400, exact host allow-list |
| verify with a `/view-pdf/1010437/…` url and `notification: "10/2025-CT(Rate)"` | 201 pending; the target shows the caveat being checked |
| checker (priya) approves | 200 approved, dataset version `2026.10.12-2` |
| `GET /v1/hsn/3004` | the nil rule shows `url …/view-pdf/1010437/…`, `pdf_sha256`, `schedule_serial "S.No. 1"`, **`citation_note: null`**, `verified`, `verified_by: priya` |
| feed | `rule_verified`, `affected_prefix: 3004`, "3004 0% rule verified against 10/2025-CT(Rate)" |
| `export-audit-head`, then `verify-audit --head` | `{"ok": true, "problems": [], "legacy": []}`, exit 0 |

**N1: Resolved.**

## N2: AG-12 sign-off

`docs/00-coordinator-decisions.md` now has the dated section "Eval gate scope decision (AG-12 sign-off), 2026-10-11". It records:
- the decision;
- the reason (356 of ~1,200 headings in the master);
- the status: provisional, Amit's sign-off pending, labels are LLM drafts;
- the exit condition.

06 refers to it.

**N2: Resolved.**

## Polish spot-checks

All six behave as asked:
- **All validation errors are reported:** 3 bad lines → "4 problems", one pointer each.
- **`needs_input` lists both choices:** an ambiguous 3004 line gives `["rule_id","condition"]`, and the note says the same.
- **Notification refs are unpadded:** `01/2026-CT(Rate)` is normalised to `1/2026-CT(Rate)` on both API input and seed, and meta sources are unpadded.
- **Known data gaps are in meta:** `known_data_gaps[]` lists `{prefix, kind, reason}` for 7104, 7117, 7114, 7118, 7110, 3004, 9027, 4014, 2202, 2403 and 9988. `kind` is one of `disputed`, `not_researched`, `not_transcribed`, `not_expressible` or `period_gap`. This is exactly the honest "not yet curated vs no rule" signal clients need.
- **`HSN_PORT` is in the README** (step 7).
- **A traceability test exists**, and it is in the 895.

## New finding from adversarial probing of ruling 36

**The canonical citation form is documented but not enforced. Free text is accepted and becomes the citation of a *verified* rule.**
- **What the docs promise:** data-model §1 defines `notification_ref` as `<n>/<yyyy>-<CT|IT|UTT|Cess>(Rate)[, Schedule <roman>]`, applied to "the seed loader, create/supersede/correct proposals and verify `source`". FORMAT.md says "every API input" is canonical.
- **What the code does:** `normaliseNotificationRef` in `src/services/proposals.ts:276` only trims and strips zero-padding. Nothing checks the shape.
- **Live result:**
  - A verify on 998892 with `notification: "lol not a citation"` and a valid view-pdf URL was accepted. After the second admin approved it, the verified rule's `source.notification` is `"lol not a citation"`.
  - That string now appears in `/v1/meta/dataset` `sources[]`.
  - The feed summary still says "verified against 15/2025-CT(Rate)", the old value, which now disagrees with the rule.
  - A `create` with the same text is also accepted (pending).
- **Mitigation and impact:** maker–checker means two humans must approve it. Still, the citation is the honesty backbone of every rate, and the contract says the form is validated. Round-2 R6 asked for exactly this regex.

## Scores

| # | Dimension | R3 | R4 | Why |
|---|---|---|---|---|
| 1 | Fidelity and honesty | 8 | **9** | N1 closes the last hidden limit. A verified rule now always links the document it was checked against. `known_data_gaps` makes data limits visible to machines. |
| 2 | Consistency (docs↔docs, docs↔code, data) | 9 | **8** | One documented guarantee is not implemented: the canonical citation form (above). After a verify that changes the notification, the feed summary disagrees with the rule. |
| 3 | Completeness and testability | 9 | **9** | 895 tests, a traceability test, a shipped-seed suite and an eval with honest provisional gates. |
| 4 | GST correctness against the research | 9 | **9** | Unchanged and still correct. |
| 5 | Developer experience | 9 | **9** | All errors are reported, both choices appear in `needs_input`, known gaps are in meta, and the quick start works on any port. |
| 6 | Code quality and test strength | 9 | **9** | Ruling 36 has layered checks: the API (400 with pointer), a document-URL test, an exact host list, the DB trigger and the audit cross-check. |

## Verdict: **NOT YET**

Consistency is at 8, and the fix is one validation rule. Everything else is now at ship-with-pride level.

## REQUIRED fix

**N3. Enforce the documented canonical notification form on every API input, and make the verify feed summary use the new citation.**
- **Where:**
  - `src/services/proposals.ts`: `normaliseNotificationRef`, line ~276, and its callers at ~349 (rule source) and ~803 (verify source);
  - `src/routes/admin.ts`: the `notification` schema at lines 63 and 256 (min 3 / max 300 only);
  - the verify feed summary built during approval.
- **Fix:**
  1. After normalising, require `^[1-9][0-9]{0,3}/(19|20)[0-9]{2}-(CT|IT|UTT|Cess)\(Rate\)(, Schedule (I|II|III|IV|V|VI|VII))?(, S\.No\. [0-9A-Za-z().-]{1,20})?$`. Use the form data-model §1 documents, or widen that doc and this regex together. On failure, return 400 `validation_failed` with pointer `/rule/source/notification` or `/source/notification`.
  2. Apply the same check in the seed loader and `import-dataset`. The shipped seed already conforms.
  3. Build the `rule_verified` summary from the post-approval notification.
  4. Add tests:
     - a verify with `"lol not a citation"` returns 400;
     - a create with `"9/2025 schedule 4"` returns 400;
     - `"01/2026-CT(Rate), Schedule I"` is accepted as `1/2026-…`;
     - a verify that changes `15/2025-CT(Rate)` to `16/2025-CT(Rate)` produces a feed summary naming 16/2025.
  5. Add these as an extra case under T-A07 or T-A10 in TRD §15.

## Optional polish

- `/v1/meta/dataset` `sources[]` mixes in-force and verified citations. Consider tagging each with `rule_count` and `verified_count`, so a client can see how much of each notification has actually been checked.

## Required-fix count: **1** (N3)
