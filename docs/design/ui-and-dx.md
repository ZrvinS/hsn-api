# HSN Rate API — UI and developer experience

Binding inputs: `docs/00-coordinator-decisions.md`, `00b-coordinator-rulings.md`, `00c-coordinator-rulings-round2.md`. Contract: `openapi.yaml`. Scoring: `architecture.md` §5. All figures, ids and screens below are **illustrative** unless they cite a notification.

## 1. Error message style

All errors are RFC 9457 `application/problem+json`. Members:
- a kebab-case `type` URI, `title`, `status`, `detail`, `instance` (= the request path, no query string);
- the extension members `request_id` (always the server's `req_` ULID), `client_request_id` (the client's `X-Request-Id`, when sent and valid), `code` (the server's snake_case machine code, a convenience only) and, for validation, `errors[]`.

Clients switch on `type`, never on `title`, `detail` or `code`.

```json
{
  "type": "https://hsn-api.example/problems/validation-failed",
  "title": "Request validation failed",
  "status": 400,
  "detail": "1 field is invalid. See errors[].",
  "instance": "/v1/hsn/71-13",
  "request_id": "req_01J9ZQ4V6W0F3K2H8M5N1P7R9X",
  "code": "validation_failed",
  "errors": [
    { "pointer": "/code", "code": "pattern", "message": "Must be 2, 4, 6 or 8 digits (or 5 digits starting 99 for a SAC group), e.g. \"7113\"" }
  ]
}
```

**Rules for writing `detail` and `errors[].message`**

1. **Say what is wrong, then what to do.** Example: `Barcode check digit is wrong. Re-scan the barcode or send the product name instead.`
2. **Echo a value only when it passed a strict format check** (validator fix 20, SEC-75). Allowed: a digit-only HSN code that matched the pattern (`No HSN/SAC "7199" in dataset …`) or an id. Never echoed:
   - free text (`name`, `q`, `rationale`, URLs);
   - a GTIN that failed its check digit;
   - secrets (keys appear only as their public prefix, `hsk_ab12cd34`).
3. **Name the fix in API terms**: the parameter, scope or endpoint (`Send unit_price`, `needs scope "classify"`, `use GET /v1/hsn/search`).
4. **`title` is fixed per `type`**: no variable text, so it can be shown or translated.
5. **One problem per response.** Field-level issues go in `errors[]`, with JSON Pointers (`/lines/3/hsn`).
6. **No stack traces, SQL or library names**, even in development builds. 5xx returns only a generic detail plus `request_id`, which the server logs with full context.
7. **Ambiguity is not an error.** An ambiguous rate is a `200` with `coverage: "ambiguous"`, `default_rule_id` and the candidate rules. A low-confidence classification is a `200` with `needs_review: true`. An HSN with no rule on the date is a `200` with `coverage: "no_rate_rule"`. Errors are only for requests the API cannot answer.

**Problem type registry** (`src/lib/problem.ts`; the same list is in `openapi.yaml` `Problem` and `07-best-practices.md` §3)

| type (suffix) | status | title |
|---|---|---|
| `validation-failed` | 400 | Request validation failed |
| `idempotency-key-required` | 400 | Idempotency-Key header required |
| `source-url-not-document` | 400 | The rule cites an index page; verify needs the notification document URL (ruling 36; `errors[0]` is `/source/url`, `required`) |
| `unauthenticated` | 401 | API key missing or invalid |
| `insufficient-scope` | 403 | API key lacks a required scope |
| `forbidden-ip` | 403 | Client address not allowed for admin keys |
| `maker-checker-violation` | 403 | Approver must differ from proposer |
| `not-proposer` | 403 | Only the proposer can withdraw a proposal |
| `hsn-not-found` | 404 | HSN/SAC code not found |
| `not-found` | 404 | Resource not found |
| `proposal-not-found` | 404 | Rate proposal not found |
| `method-not-allowed` | 405 | Method not allowed (a known path with the wrong method; the response carries `Allow`. An unknown path gets 404 `not-found`.) |
| `overlapping-rule` | 409 | Overlapping rate rule |
| `proposal-not-pending` | 409 | Proposal is not pending |
| `proposal-hash-mismatch` | 409 | expected_sha256 does not match the proposal |
| `proposal-stale` | 409 | Proposal no longer applies to the published data |
| `rule-not-active` | 409 | Referenced rate rule cannot be changed this way |
| `proposer-disabled` | 409 | Proposal was made by a disabled actor |
| `idempotency-conflict` | 409 | Idempotency key reused with a different request |
| `duplicate-notification` | 409 | Notification is already being watched |
| `feed-window-expired` | 410 | Change feed position expired |
| `payload-too-large` | 413 | Request body too large |
| `unsupported-media-type` | 415 | Content-Type must be application/json |
| `invalid-gtin` | 422 | Barcode is not a valid GTIN |
| `unknown-hsn` | 422 | Unknown HSN/SAC code |
| `rule-choice-invalid` | 422 | Chosen rule does not apply to this line |
| `rate-limited` | 429 | Too many requests |
| `quota-exceeded` | 429 | Daily quota exceeded |
| `internal` | 500 | Internal error |
| `not-ready` | 503 | Service not ready |
| `dataset-not-loaded` | 503 | Rate dataset not loaded |
| `classifier-unavailable` | 503 | Classifier not available |
| `admin-writes-disabled` | 503 | Admin writes are disabled |

`no-rate-for-date` was removed (validator fix 22).

**Other DX conventions**

- Every response has `X-Request-Id`, equal to the server's `request_id` in problems and logs. A client may send its own `X-Request-Id` (`^[A-Za-z0-9._-]{1,64}$`); it comes back as `client_request_id` and is logged, but it never replaces `request_id` (validator fix 23).
- Every authenticated response has `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Cost` and `RateLimit-Policy`, all counted in tokens (classify costs 5, tax 1 + floor(lines/50), other requests 1). The tax cost is charged from the raw `lines` length before validation, so an invalid oversized request still pays for its size (core round 10).
- `snake_case` JSON everywhere; dates `YYYY-MM-DD`; timestamps UTC RFC 3339; money in INR with 2 decimals; rates as `*_bp` integers, plus `*_percent` for display.
- Unknown request fields are rejected (`additionalProperties: false`), so a typo such as `unitPrice` fails loudly instead of being silently ignored.
- `curl` quick start: `server/README.md` goes from a clean checkout to a first lookup, classify and tax call in 10 commands (tested verbatim from a clean copy, docs round 4), e.g.
  ```
  curl -s localhost:3000/v1/hsn/7113 -H "Authorization: Bearer $HSN_KEY" | jq '{code, description, rate: (.rate | {coverage, warnings, rule: (.applicable_rule | {igst_rate_percent, verification_status, citation_note})})}'
  ```
- A typed client can be generated from `openapi.yaml`. Docs show the "honesty fields" first in every example: `source`, `verification_status`, `citation_note`, `warnings`, `coverage`, `code_in_master` / `resolved_via`, and for tax `complete` / `partial_totals` / `warnings`.
- Display rules added in rounds 4–6: show a rule's `citation_note` next to the rate while it is unverified; when `code_in_master` is false, show "answered under <resolved_via>, check the code"; when an invoice is `complete: false`, show no total (never present `partial_totals` as the invoice total).

## 2. Admin review screen (future; not built in v1)

**Status (00c ruling 21, SA-D-05):** v1 has **no admin web UI**. Admin work is done through the API on the loopback admin listener and the operator CLIs. The wireframe below is a **future, illustrative** design. Before any such UI ships, it must meet `05` SEC-45:

- served from its own origin or listener, never from API responses;
- a server-side session (`HttpOnly; Secure; SameSite=Strict` cookie, CSRF token, short idle timeout); the admin key never lives in the browser;
- a strict CSP (`script-src 'self'` with nonces, no `unsafe-inline`, `frame-ancestors 'none'`);
- every maker-supplied field (`rationale`, `condition_text`, `notification`, `source.url`, comments) rendered as text only;
- source links rendered only after `new URL()` parsing with scheme `https:` and an exact host from `HSN_SOURCE_HOSTS`, with `rel="noopener noreferrer"`;
- an XSS fixture (`<script>`, `"><img onerror>`, `javascript:` URL) that renders inert.

*Illustrative mock-up. Ids, counts and the "current" notification are placeholders, not research data.*

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ HSN Rate API · Admin (future)      Dataset 2026.10.03-1 · You: <checker handle>      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Pending proposals (3)      [Pending ▾]                                               │
│ ┌────────────┬─────────┬──────────────┬───────────┬──────────┬─────────┬───────────┐ │
│ │ ID         │ HSN     │ Change       │ Effective │ Proposer │ Age     │           │ │
│ ├────────────┼─────────┼──────────────┼───────────┼──────────┼─────────┼───────────┤ │
│ │▶rp_01J9ZR… │ 3004    │ 12% → 5%     │ 2025-09-22│ <maker>  │ 2 h     │ Review    │ │
│ │ rp_01J9ZS… │ 61      │ +price rule  │ 2025-09-22│ <maker>  │ 1 d     │ Review    │ │
│ │ rp_01J9ZT… │ 7113    │ end-date only│ —         │ <you>    │ 3 h     │ (yours)   │ │
│ └────────────┴─────────┴──────────────┴───────────┴──────────┴─────────┴───────────┘ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Proposal rp_01J9ZR0000000000000000000A · SUPERSEDE rr_01H0…B4                        │
│ content_sha256 3f9a…c21e (bound to this review)                                      │
│                                                                                      │
│   HSN prefix 3004  Medicaments … put up in measured doses or for retail sale         │
│                                                                                      │
│                      CURRENT (rr_01H0…B4)        PROPOSED                            │
│   IGST               12%  (1200 bp)              5%   (500 bp)          ◀ changed     │
│   CGST / SGST        6% / 6%                     2.5% / 2.5%            ◀ changed     │
│   Cess               0                           0                                   │
│   Condition          none                        none (general rule)                 │
│   Effective          2017-07-01 → open           2025-09-22 → open                   │
│                      (will become → 2025-09-21)                                      │
│   Source             <earlier notification>      9/2025-CT(Rate), Schedule I         │
│                                                  taxinformation.cbic.gov.in/view-pdf/│
│                                                  1010436/ENG/Notifications  [open]   │
│   Serial / PDF       —                           S.No. <n> · sha256 9b1c…07aa        │
│                                                                                      │
│   Rationale (maker, shown as plain text): GST rate rationalisation; medicaments in   │
│   3004 moved from 12% to 5% from 22 Sep 2025.                                        │
│                                                                                      │
│   Impact preview: 1 rule end-dated, 1 rule added; <n> HSN codes under 3004 affected. │
│   Overlap check: ✓ none     Slab check: ✓ 500 bp     Retroactive: no                 │
│                                                                                      │
│   Confirm the schedule serial from the PDF: [ ____ ]                                 │
│   Comment: [Checked 9/2025-CT(Rate) entry for 3004_____________________________]     │
│                                                                                      │
│        [ Reject… ]                                      [ Approve & publish ]        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Audit (latest page) · span chain ✓ (verify=true; full check is verify-audit)         │
│ #5119 09:02 <maker>  rate_proposal.created  rp_01J9ZR…                               │
│ #5118 08:40 <maker>  rate_proposal.created  rp_01J9ZS…                               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Behaviour (future UI; the API already enforces each rule):
- **Approve** stays disabled until the checker re-enters the schedule serial and it matches. The call sends `expected_sha256` = the `content_sha256` shown. A mismatch (409 `proposal-hash-mismatch`) or a target that changed meanwhile (409 `rule-not-active`) forces a reload and a fresh review.
- **No bulk approve.** Each proposal is approved by its own call (00c ruling 20).
- The proposer's own rows show `(yours)` with no action. The server enforces this on `actor_id` (403 `maker-checker-violation`); the UI only mirrors it.
- **Reject…** requires a reason of at least 5 characters. **Withdraw** is offered only on your own pending proposals.
- A retroactive proposal shows a red banner, "changes rates for N past days", and its `retroactive_reason`.
- The diff highlights every changed field. The "will become" line shows how the superseded rule will be end-dated.
- After approval, a toast shows `Published <dataset_version> · change feed seq <from>–<to>`. v1 sends no out-of-band notice to the other actors (00c ruling 29); a future screen would show pending proposals and `admin.grant_approved` events instead.
- A watcher panel (future) shows `GET /v1/admin/watcher/status`: last run, `freshness.alert` and its reasons, untriaged rows with a **Triage** action (affected prefixes, effective date) and **Resolve** (published / dismissed).
- The audit strip calls `GET /v1/admin/audit?verify=true` (00c ruling 27) and labels the result as a check of the returned span (`chain_ok`, `chain_broken_at`; when `verify_note` is set the span was not checked). It shows `head_id` so the operator can compare it with the exported head. It never claims full-chain verification; that is `scripts/verify-audit.ts` against the off-host head (SEC-53, SEC-97).

## 3. How client apps show HSN, GST, confidence and source

Shared rules for any client:
1. **Always show the source and its verification status**: the notification number, a link to it, and either "verified <last_verified_at>" (only when `verification_status` is `verified`) or "unverified". Also show any `warnings` (`verification_overdue`, `pending_change_detected`). All seed data is currently unverified, so the mock-ups below show "unverified". Do not label it "official" or "live".
2. **Never auto-apply a classification that is not `high`.** For medium or low, show the candidates and require a tap to confirm, and store who confirmed it. A barcode-only result is never `high` (00c ruling 22).
3. **Never pick a rate when `coverage` is `ambiguous`.** Ask for the missing input (usually unit price) or let the user choose a rule, then send that `rule_id` (or `condition: "general"`) on the tax line.
4. **Store `hsn`, `rule_id`, `igst_rate_bp` and `dataset_version` on each invoice line**, so old invoices stay reproducible.
5. Show confidence as a word plus a bar, not as a raw decimal alone: High / Medium / Low.

### 3.1 Sunarone (jewellery billing): add item, high confidence

```
┌─ New bill · Item 1 ───────────────────────────────────────────┐
│ Item name   [22K gold ring__________________]   Wt [8.250 g]  │
│ Price       [₹ 68,500.00]                                     │
│                                                               │
│ HSN  7113  Jewellery of precious metal        ●●●●● High 0.91 │
│ GST  3%   (CGST 1.5% + SGST 1.5%)  intra-state                │
│      Tax ₹2,055.00   ·   Line total ₹70,555.00                │
│ ⓘ 9/2025-CT(Rate), Schedule IV · unverified (not yet checked) │
│   Rates curated from CBIC notifications. Not an official      │
│   government service.                         [Why 7113? ▸]   │
│                                                               │
│                                    [ Change HSN ]  [ Add ✓ ]  │
└───────────────────────────────────────────────────────────────┘
 "Why 7113?" expands:
   ✓ Matches saved term "22k gold ring" → 7113
   ✓ "gold" → Chapter 71 (precious metals)
   ✓ Text match in HSN keywords (gold, ring)
   Other options: 7117 Imitation jewellery · Low 0.27
```

While the 7113 rule is unverified, the billing app computes tax only because it sends `accept_unverified: true`, a business decision made once in settings (00c ruling 24).

### 3.2 Health app (pharmacy): medium confidence, then an ambiguous rate

```
┌─ Add medicine ────────────────────────────────────────────────┐
│ Paracetamol 500 mg tablet                                     │
│                                                               │
│ ⚠ Please confirm the HSN code (Medium confidence)             │
│                                                               │
│ (•) 3004  Medicaments in measured doses / retail packs        │
│          ●●●○○ Medium 0.72                                    │
│          GST: 5% general rate, or 0% if on the nil-rate list  │
│          Note: bulk paracetamol (not tablets) is 2924.        │
│ ( ) 2924  Carboxyamide-function compounds (bulk drug)         │
│          ●○○○○ Low 0.22 · GST rate: not in dataset            │
│ ( ) Search another code…                                      │
│                                                               │
│ Which rate applies?                                           │
│ (•) 5%  General rate (default) · 9/2025-CT(Rate), Schedule I  │
│ ( ) 0%  Drug on the nil-rate list of 10/2025-CT(Rate)         │
│ ⓘ unverified · Suggestion only: check with your tax advisor.  │
│                                                               │
│                           [ Cancel ]  [ Confirm 3004 & save ] │
└───────────────────────────────────────────────────────────────┘
```

Notes:
- 3004 resolves to `coverage: "ambiguous"` with `default_rule_id` = the general 5% rule and an `other`-condition 0% rule (00c ruling 5). The app pre-selects the default but asks; it then sends `condition: "general"` or the chosen `rule_id` on the tax line.
- If the caller's own product name exactly matches a curated nil-rated drug synonym, the API selects the 0% rule itself (warning `selected_by_hint`), and the app shows that as the chosen rate with the warning.
- `coverage = "no_rate_rule"` is shown as "GST rate: not in dataset". The app shows no number and does not fall back to a default.

### 3.3 Barcode scan (grocery or general store): medium, confirm once

```
┌─ Scan ────────────────────────────────────────────────────────┐
│ ▌▌▌▌▌▌ 8901234012345  ✓ valid barcode                         │
│ Glucose Biscuits 250 g    (Open Food Facts, fetched 6 Oct)    │
│                                                               │
│ HSN 1905  Biscuits & bakers' wares         ●●●●○ Medium 0.84  │
│ ⚠ Product data is publicly editable. Confirm the HSN.         │
│ GST 5%  (CGST 2.5% + SGST 2.5%)                               │
│ ⓘ 9/2025-CT(Rate) · unverified                                │
│                                   [ Change ]  [ Confirm ✓ ]   │
└───────────────────────────────────────────────────────────────┘
 Invalid scan → "Barcode didn't read correctly (check digit). Scan again or type the name."
 Lookup unavailable (product.source = lookup_failed) → "Product lookup is busy. Type the name instead."
```

A barcode-only result is capped at medium (0.84) because the name and category come from crowd-edited data (00c ruling 22). If the app also sends the product name and it hits an exact curated synonym, the result can be `high` (0.94 in the worked example). The confirmed choice is remembered per GTIN on the client, so the user confirms once.

### 3.4 Ambiguous rate (price threshold), from any client

```
┌─ Item: Cotton T-shirt · HSN 6109 ─────────────────────────────┐
│ GST depends on price per piece:                               │
│   ≤ ₹2,500 → 5%      > ₹2,500 → 18%                           │
│ Enter price per piece: [₹ ________ ]   → GST shown after entry│
│ ⓘ 9/2025-CT(Rate) · unverified                                │
└───────────────────────────────────────────────────────────────┘
```

If the line already has a quantity, the API derives the price per piece from `taxable_value ÷ quantity` to pick the rule; the tax is still computed on `taxable_value`.

### 3.5 Printed invoice line (Sunarone)

```
 # Item            HSN   Qty  Taxable   CGST 1.5%  SGST 1.5%   Total
 1 22K gold ring   7113  1    68,500.00  1,027.50   1,027.50  70,555.00
 ------------------------------------------------------------------
 GST rates per CBIC notification 9/2025-CT(Rate), Schedule IV as curated in
 HSN Rate API dataset 2026.10.03-1 (rate not yet verified by a reviewer).
```

### 3.6 Stale-data and pending-change banners (client side)

- **Stale data:** if `GET /v1/meta/dataset` fails, or the client's last successful change-feed poll is more than 24 h old, the app shows `GST rates last updated 2 days ago. Rates may have changed. [Retry]`. It keeps billing with the cached rules and does not block the user.
- **Pending change:** if `/v1/meta/dataset` lists `pending_notifications[]` (a CBIC notification detected and triaged to affected codes but not yet published; 00c ruling 10), the app shows `A new GST notification (<number>) is being reviewed; rates for <affected codes> may change soon.` Rate responses for affected codes also carry the `pending_change_detected` warning. `untriaged_notifications` > 0 means a notification was just detected and its affected codes are not known yet; apps may show a generic `A new GST notification is being reviewed.` without naming codes.
- **Lineage change:** if `feed_epoch` changes, the app silently resyncs its cache from `since=0` (07 §13).
