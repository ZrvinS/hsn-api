# Integrating the HSN Rate API into your app

This guide is for developers who want to call the HSN Rate API from their own application: a billing system, a point-of-sale app, an e-commerce backend or an accounting tool. It covers getting a key, every public endpoint, how to read the answers, and the cases your app must handle.

If you run the API yourself, read [deployment.md](deployment.md) first. The full contract is in [../design/openapi.yaml](../design/openapi.yaml).

Every request and response in this guide was run against a real server on 2026-10-14 (the quick-start seed, dataset `2026.10.14-1`). Long responses are trimmed with `…`. Ids such as `rr_…` and `req_…` will differ on your server.

## Contents

1. [What the API does, and what it does not](#1-what-the-api-does-and-what-it-does-not)
2. [Before you start](#2-before-you-start)
3. [Your first call](#3-your-first-call)
4. [Look up a code: `GET /v1/hsn/{code}`](#4-look-up-a-code)
5. [Search descriptions: `GET /v1/hsn/search`](#5-search-descriptions)
6. [Detect the HSN from a product: `POST /v1/classify`](#6-detect-the-hsn-from-a-product)
7. [Calculate invoice tax: `POST /v1/tax/calculate`](#7-calculate-invoice-tax)
8. [Unverified rates: what they mean for you](#8-unverified-rates-what-they-mean-for-you)
9. [Keep a local cache: the change feed](#9-keep-a-local-cache-the-change-feed)
10. [Dataset status: `GET /v1/meta/dataset`](#10-dataset-status)
11. [Errors](#11-errors)
12. [Rate limits and retries](#12-rate-limits-and-retries)
13. [Client code (Node.js and Python)](#13-client-code)
14. [Integration checklist](#14-integration-checklist)

## 1. What the API does, and what it does not

**It does:**
- Return the description and the GST rate in force on a date for an HSN code (goods) or SAC code (services).
- Suggest HSN codes for a product name or barcode, with a confidence score and the reasons behind it.
- Calculate CGST, SGST, UTGST, IGST and cess for invoice lines, in rupees and in paise.
- Publish a change feed so your app can cache rates and refresh only what changed.

**It does not:**
- It is **not an official Government of India service** and not real-time. Rates are curated by people from CBIC notifications and can lag a new notification by up to 2 business days.
- It does **not give legal or tax advice**. A suggested HSN code is a best guess, not a legal classification.
- It does **not yet have verified rates.** Every rate in the current dataset was transcribed from secondary sources and is marked `unverified` until a reviewer checks it against the CBIC gazette PDF. [Section 8](#8-unverified-rates-what-they-mean-for-you) explains what this means for your app.
- It does **not cover the whole tariff.** The master holds 356 codes (320 HSN, 36 SAC), and 148 of them have no rate rule yet. The API never invents a rate: when it has none, it says so.

## 2. Before you start

**Base URL.** Whoever runs the API gives you a base URL, for example `https://hsn-api.example.com`. Locally it is `http://localhost:3000`. Every path below starts with `/v1`.

**An API key.** Ask the API owner for a key. They create it with `npm run create-key` (see [deployment.md §6](deployment.md#6-issue-and-revoke-client-keys)). A key looks like `hsk_FqGahFUX_` followed by 43 more characters, and it is shown only once. Keys carry scopes:

| Scope | Allows |
|---|---|
| `read` | Lookup, search, tax calculation, the change feed and dataset meta. |
| `classify` | `POST /v1/classify`. Ask for both `read,classify` if you need product detection. |

**Keep the key on your server.** Call the API from your backend, never from a browser or a mobile app bundle, where anyone can extract the key. Use one key per environment (test and live), so you can revoke one without touching the other.

**Send JSON.** Every `POST` needs `Content-Type: application/json`.

## 3. Your first call

```sh
export HSN_API_URL=http://localhost:3000
export HSN_API_KEY=hsk_...

curl -s "$HSN_API_URL/v1/hsn/7113" -H "Authorization: Bearer $HSN_API_KEY"
```

If the key is missing or wrong you get `401` with a problem body (see [section 11](#11-errors)). Two endpoints need no key: `GET /healthz` (the process is up) and `GET /readyz` (the data is loaded and the service can answer). Both return only a status, like `{"status":"ready"}`.

## 4. Look up a code

`GET /v1/hsn/{code}` returns the code's description, its parent codes, and the GST rate rule in force.

| Parameter | Where | Notes |
|---|---|---|
| `code` | path | 2, 4, 6 or 8 digits, or 5 digits starting with `99` for a SAC group. No dots or dashes: `7113`, not `71.13`. |
| `date` | query | `YYYY-MM-DD`, the time-of-supply date. Default: today in India (IST). Send it for back-dated or future invoices. |
| `unit_price` | query | Price per piece in rupees, for codes whose rate depends on price (apparel and footwear). |

```sh
curl -s "$HSN_API_URL/v1/hsn/7113" -H "Authorization: Bearer $HSN_API_KEY"
```

```json
{
  "code": "7113", "level": 4, "type": "goods", "chapter": "71",
  "description": "Articles of jewellery and parts thereof, of precious metal or of metal clad with precious metal",
  "code_in_master": true,
  "resolved_via": null,
  "ancestors": [{ "code": "71", "level": 2, "description": "Natural or cultured pearls, precious or semi-precious stones, precious metals, …" }],
  "rate": {
    "hsn_queried": "7113",
    "as_of": "2026-10-14",
    "ambiguous": false,
    "coverage": "ok",
    "matched_at_level": 4,
    "applicable_rule": {
      "rule_id": "rr_E1ZB3AQE2ESK0YWX5EJKQ6SZ4P",
      "hsn_prefix": "7113",
      "igst_rate_bp": 300,
      "igst_rate_percent": 3,
      "cgst_rate_percent": 1.5,
      "sgst_rate_percent": 1.5,
      "utgst_rate_percent": 1.5,
      "cess": { "rate_bp": 0, "specific_amount": null, "specific_unit": null },
      "condition": { "kind": "none", "code": null, "text": null, "min_unit_price": null, "max_unit_price": null },
      "effective_from": "2025-09-22",
      "effective_to": null,
      "source": {
        "notification": "9/2025-CT(Rate), Schedule IV",
        "url": "https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications",
        "pdf_sha256": null,
        "schedule_serial": null
      },
      "last_verified_at": null,
      "reverify_due_at": null,
      "verified_by": null,
      "verification_status": "unverified",
      "warning": "Unverified rate: this rule has not yet been checked by a reviewer against the cited notification. Confirm it against the source before relying on it.",
      "citation_note": "Transcribed from secondary sources; schedule S.No. and gazette text not yet checked against the CBIC PDF. …",
      "dataset_version": "2026.10.14-1"
    },
    "default_rule_id": null,
    "rules": [],
    "warnings": ["rate_unverified"],
    "unit_price": null,
    "rule_selected_by": null,
    "verification_status": "unverified",
    "disclaimer": "Rates are curated from CBIC notifications … This rate has not yet been checked against the notification PDF by a reviewer."
  },
  "dataset_version": "2026.10.14-1",
  "disclaimer": "…"
}
```

### Reading the rate

Always look at `rate.coverage` first. It has one of three values, and your app must handle all three:

| `coverage` | Meaning | What your app does |
|---|---|---|
| `ok` | Exactly one rule applies. It is in `applicable_rule`. | Use `applicable_rule.igst_rate_percent` (or `igst_rate_bp`, in basis points: 300 = 3%). |
| `ambiguous` | More than one rule could apply. `applicable_rule` is `null`; the choices are in `rules`, each with its `condition.text`. | Resend with `unit_price` if the condition is a price, or show the choices to the user. See below. |
| `no_rate_rule` | The code exists but no curated rule covers it on that date. | Do **not** assume 0%. Ask the user for the rate or block billing for that item. |

Rates are in basis points (`igst_rate_bp`) and in percent. The CGST and SGST (or UTGST) rates are each half the IGST rate. Use basis points for arithmetic to avoid floating-point surprises.

### A price-dependent rate

Some rates depend on the selling price per piece. T-shirts (6109) are 5% up to Rs 2,500 per piece and 18% above it. Without a price the answer is ambiguous:

```sh
curl -s "$HSN_API_URL/v1/hsn/6109" -H "Authorization: Bearer $HSN_API_KEY"
```

```json
{
  "rate": {
    "coverage": "ambiguous",
    "warnings": ["rate_unverified", "ambiguous"],
    "applicable_rule": null,
    "rules": [
      { "rule_id": "rr_7VMJHGKBET16Q8JMQ7CX1NRDH5", "igst_rate_percent": 5,
        "condition": { "kind": "price", "text": "sale value not exceeding Rs 2500 per piece", "max_unit_price": 2500, … } },
      { "rule_id": "rr_8PR2V0T0RAN5YWZVB9QZTTV45P", "igst_rate_percent": 18,
        "condition": { "kind": "price", "text": "sale value exceeding Rs 2500 per piece", "min_unit_price": 2500.01, … } }
    ],
    …
  }
}
```

Send the price and the API picks the rule:

```sh
curl -s "$HSN_API_URL/v1/hsn/6109?unit_price=999.50" -H "Authorization: Bearer $HSN_API_KEY"
# rate.coverage: "ok", rate.applicable_rule.igst_rate_percent: 5
```

### A choice only a person can make

Medicines (3004) are 5% in general, but 33 specified life-saving drugs are nil-rated. The API cannot tell which drug you are selling, so it returns `coverage: "ambiguous"` and names the general rule in `default_rule_id`. It still does not pick it for you: your user decides, and you send the choice on the tax line (see [section 7](#choosing-a-rule-on-a-line)).

### A code that is not in the master

The master is a curated subset of the tariff. If you send a well-formed code that is not in it but whose parent is, the API answers under the parent and tells you so:

```sh
curl -s "$HSN_API_URL/v1/hsn/71131999" -H "Authorization: Bearer $HSN_API_KEY"
```

```json
{
  "code": "71131999",
  "code_in_master": false,
  "resolved_via": "711319",
  "description": "71131999 is not in the HSN master; shown under 711319: Of precious metal whether or not plated or clad with precious metal: …",
  "rate": { "warnings": ["rate_unverified", "code_not_in_master"], … }
}
```

Show the `code_not_in_master` warning so the user can check the code. Only a code whose chapter does not exist returns `404` (for example `/v1/hsn/00`).

### Dates

`date` selects the rule in force on that day. The current dataset holds the rates that took effect on 2025-09-22 (the GST rate rationalisation) and later. Earlier dates mostly return `no_rate_rule`:

```sh
curl -s "$HSN_API_URL/v1/hsn/6109?unit_price=999.50&date=2025-09-01" -H "Authorization: Bearer $HSN_API_KEY"
# rate.as_of: "2025-09-01", rate.coverage: "no_rate_rule"
```

### Warnings

`rate.warnings` lists everything your user should know. Show them next to the rate; do not hide them.

| Warning | Meaning |
|---|---|
| `rate_unverified` | No reviewer has checked this rule against the gazette PDF yet. |
| `verification_overdue` | The rule was verified, but its re-check date has passed. |
| `pending_change_detected` | A new CBIC notification that may affect this code is waiting for review. |
| `code_not_in_master` | The code was answered under its nearest parent. |
| `ambiguous` | Several rules apply; see `rules`. |
| `no_rate_rule` | No rule covers this code on this date. |
| `selected_by_hint` | A curated hint picked one of several rules (classify only). |

### Caching lookups

Lookups return an `ETag` and `Cache-Control: private, max-age=3600, must-revalidate`. Send the ETag back in `If-None-Match` and you get `304 Not Modified` with no body when nothing changed:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$HSN_API_URL/v1/hsn/7113" \
  -H "Authorization: Bearer $HSN_API_KEY" -H 'If-None-Match: W/"ds-2026.10.14-1-a885ad96e96164c4"'
# 304
```

For a longer-lived cache, use the change feed ([section 9](#9-keep-a-local-cache-the-change-feed)).

## 5. Search descriptions

`GET /v1/hsn/search?q=` is a full-text search over HSN and SAC descriptions. Use it for a code picker where the user types words. It returns a relevance `score`, not a confidence; for "which code is this product?" use classify instead.

| Parameter | Notes |
|---|---|
| `q` | 2 to 100 characters. Required. |
| `limit` | 1 to 50, default 10. |
| `type` | `goods` or `service`. |
| `level` | Only codes of this many digits: 2, 4, 5, 6 or 8. |

```sh
curl -s "$HSN_API_URL/v1/hsn/search?q=gold%20jewellery&limit=3" -H "Authorization: Bearer $HSN_API_KEY"
```

```json
{
  "query": "gold jewellery",
  "results": [
    { "code": "71131910", "level": 8, "type": "goods", "chapter": "71", "description": "Of gold, unstudded", "score": 1, "highlight": "Of [gold], unstudded" },
    { "code": "71131930", "level": 8, "type": "goods", "chapter": "71", "description": "Of gold, set with diamonds", "score": 0.88, "highlight": "Of [gold], set with diamonds" },
    { "code": "711319", "level": 6, "type": "goods", "chapter": "71", "description": "Of precious metal whether or not plated or clad with precious metal: …", "score": 0.47, "highlight": "…" }
  ],
  "dataset_version": "2026.10.14-1"
}
```

Search results carry no rate. Call `GET /v1/hsn/{code}` for the code the user picks.

## 6. Detect the HSN from a product

`POST /v1/classify` (scope `classify`) takes a product name, a barcode, or both, and returns up to 5 candidate HSN codes ranked by confidence, each with its rate.

| Field | Notes |
|---|---|
| `name` | 2 to 200 characters. The product description only, never customer names, phone numbers or order notes. |
| `barcode` | A GTIN-8, 12, 13 or 14 (digits only). The check digit is validated. |
| `unit_price` | Optional, in rupees; it is passed to each candidate's rate resolution for price-dependent rates. |

Send at least one of `name` or `barcode`. Classify costs 5 rate-limit tokens (a lookup costs 1).

```sh
curl -s "$HSN_API_URL/v1/classify" -H "Authorization: Bearer $HSN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"name":"22K gold ring","unit_price":68500}'
```

Trimmed to the fields that matter for a decision:

```json
{
  "input": { "name": "22K gold ring", "barcode": null, "unit_price": 68500 },
  "normalized_name": "22k gold ring",
  "product": null,
  "needs_review": false,
  "message": null,
  "candidates": [
    {
      "hsn": "7113",
      "description": "Articles of jewellery and parts thereof, of precious metal or of metal clad with precious metal",
      "confidence": 0.86,
      "confidence_band": "high",
      "needs_review": false,
      "reasons": [
        { "code": "synonym_exact", "detail": "Curated synonym \"gold ring\" → 7113", "weight": 0.5882 },
        { "code": "fts_match", "detail": "FTS matched \"ring\" in the description/keywords of 7113 (s_fts 0.39)", "weight": 0.0926 },
        { "code": "chapter_keyword", "detail": "Keywords \"22k\", \"gold\" indicate chapter 71", "weight": 0.1765 },
        { "code": "review_hint", "detail": "Generic jewellery word: precious-metal jewellery is 7113 (3%); imitation jewellery is 7117 and glass bangles 7018 - confirm the metal.", "weight": 0 }
      ],
      "rate": { "coverage": "ok", "applicable_rule": { "igst_rate_percent": 3, … }, … },
      "rule_hint": null
    },
    { "hsn": "7108", "confidence": 0.32, "confidence_band": "low", "needs_review": true, … },
    { "hsn": "7106", "confidence": 0.28, "confidence_band": "low", "needs_review": true, … }
  ],
  "classifier": { "version": "rules-fts-2.3", "llm_rerank": false },
  "scoring": { "applicable": { "synonym": true, "fts": true, "chapter_keyword": true, "barcode_category": false }, "denominator": 0.85 },
  "llm_used": false,
  "dataset_version": "2026.10.14-1",
  "disclaimer": "HSN suggestions are best-guess matches, not a legal classification. …"
}
```

### Confidence bands

| Band | Confidence | When the API gives it | What your app does |
|---|---|---|---|
| `high` | 0.85 and above | Only when a curated phrase is the whole product name (apart from quantities and pack words). | You may pre-fill the code. Still show it, with the `review_hint` reasons if any, so the user can correct it. |
| `medium` | 0.60 to 0.84 | Partial matches, barcode-only lookups, or a runner-up within 0.10 of the top. | Pre-select the top candidate but ask the user to confirm. |
| `low` | below 0.60 | Weak text matches, or an accessory of an article ("mobile phone stand"). | Show all candidates and make the user choose. Do not auto-apply. |

The top-level `needs_review` is `true` whenever the top candidate is not `high`. **Treat `needs_review: true` as "a person must confirm this code before it goes on an invoice."** Every `review_hint` reason is a note written for that person; display it.

### Handling a low-confidence result

The classifier is rules-based (curated synonyms plus full-text search), not machine learning, and it is honest about what it does not know. Three examples from the live server:

**A partial match.** "mobile phone stand" matches the phrase "mobile phone", but a stand is not a phone:

```json
{
  "needs_review": true,
  "candidates": [
    { "hsn": "8517", "confidence": 0.45, "confidence_band": "low",
      "reasons": [
        { "code": "synonym_partial", "detail": "Curated synonym \"mobile phone\" → 8517 found, but the name has other product words (scored 0.7)", … },
        { "code": "review_hint", "detail": "The name describes a \"stand\" for this article, not the article itself. Accessories and parts are classified on their own (by material or as parts), so this heading is capped at low. Check what is actually sold.", … }
      ] }
  ]
}
```

**No match at all.** A valid `200` with an empty list and a message:

```json
{ "needs_review": true, "message": "No HSN candidate matched this product. Send a more specific product name.", "candidates": [] }
```

**A good match with an ambiguous rate.** "Paracetamol 500 mg tablet" is `high` for 3004, but the rate is ambiguous (general 5% or the nil-rate drug list), and the reasons say why:

```json
{
  "hsn": "3004", "confidence": 0.87, "confidence_band": "high",
  "reasons": [
    { "code": "synonym_exact", "detail": "Curated synonym \"paracetamol tablet\" → 3004", … },
    { "code": "review_hint", "detail": "Retail dosage form assumed (3004). 33 specified life-saving drugs are Nil under 10/2025 - drug-level check needed; HSN alone is not enough.", … },
    { "code": "review_hint", "detail": "Bulk paracetamol (API) is 2924; confirm retail dosage form.", … }
  ],
  "rate": { "coverage": "ambiguous", "default_rule_id": "rr_72KQVJKG3748XTVPMCKWX5DHF4", "rules": [ { "igst_rate_percent": 5, … }, { "igst_rate_percent": 0, "condition": { "code": "nil_rate_list", … } } ], … }
}
```

A confident code does not mean a resolved rate. Check `candidate.rate.coverage` too.

**A good pattern for your UI:**
1. Classify when the user creates a product, not on every sale.
2. If `needs_review` is `false`, pre-fill the top code and show its reasons.
3. If `needs_review` is `true`, show the candidates (code, description, band, reasons) and a search box backed by `/v1/hsn/search`. Never put an unconfirmed code on an invoice.
4. If `candidates` is empty, show `message` and the search box.
5. Store the confirmed code on the product in your own database, so the user is asked once per product, not once per sale.

### Barcodes

Barcode lookups against external product databases (Open Food Facts, Open Beauty Facts) are **off by default** on the server. With them off, a valid barcode that is not in the server's product cache returns no candidates:

```sh
curl -s "$HSN_API_URL/v1/classify" -H "Authorization: Bearer $HSN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"barcode":"8901063010017"}'
```

```json
{
  "needs_review": true,
  "message": "Barcode 8901063010017 was not found in the local product cache or the enabled product databases. Send the product name to get HSN suggestions.",
  "product": {
    "gtin": "8901063010017", "gtin_valid": true, "name": null, "brand": null, "category": null,
    "source": "not_found", "fetched_at": null,
    "hints": ["GS1 prefix 890: the number was allotted through GS1 India. This is not proof of country of origin, manufacturer, or classification."]
  },
  "candidates": []
}
```

A barcode with a wrong check digit returns `422 invalid-gtin`. When the lookups are on, a barcode-only answer is capped at `medium` because the product data is crowd-edited. **Send the product name together with the barcode whenever you have it.** `product.source` is `lookup_failed` when the external lookup errored or was over budget; that does not mean the product does not exist.

## 7. Calculate invoice tax

`POST /v1/tax/calculate` (scope `read`) takes up to 500 invoice lines and returns the tax per line and in total.

| Field | Notes |
|---|---|
| `lines[].hsn` | Required. The confirmed HSN/SAC code. |
| `lines[].taxable_value` | Required. Rupees, as a number or a decimal string with at most 2 decimals (`68500`, `"120.50"`). Use a string if your language has floating-point trouble. |
| `lines[].supply_type` | Required. `intra` (same state: CGST + SGST), `intra_ut` (within a Union Territory without a legislature: CGST + UTGST) or `inter` (across states, imports and exports: IGST). |
| `lines[].line_id` | Your own id for the line, up to 64 characters. It is echoed back. Default: the line's index (`"0"`, `"1"`, …). |
| `lines[].unit_price` | Price per piece, for price-dependent rates. |
| `lines[].quantity` | Optional, informational. |
| `lines[].rule_id` / `lines[].condition` | Your choice when a rate is ambiguous. See [Choosing a rule](#choosing-a-rule-on-a-line). |
| `invoice_date` | `YYYY-MM-DD`, the time-of-supply date. Default: today (IST). |
| `invoice_rounding` | `none` (default) or `nearest_rupee`, which adds `round_off_paise` and `grand_total_paise`. |
| `accept_unverified` | `true` to compute with rules no reviewer has verified yet. **Without it, no tax is computed on any unverified rule, which today is every rule.** Read [section 8](#8-unverified-rates-what-they-mean-for-you). |

Tax calculation costs 1 rate-limit token plus 1 for every 50 lines.

### A complete invoice

Three lines: gold jewellery sold within a state, a medicine sold to another state (using the general rule), and a T-shirt sold within a Union Territory with its per-piece price:

```sh
curl -s "$HSN_API_URL/v1/tax/calculate" -H "Authorization: Bearer $HSN_API_KEY" \
  -H 'Content-Type: application/json' -d '{
  "accept_unverified": true,
  "invoice_rounding": "nearest_rupee",
  "lines": [
    {"line_id": "1", "hsn": "7113", "taxable_value": 68500,  "supply_type": "intra"},
    {"line_id": "2", "hsn": "3004", "taxable_value": 120.50, "supply_type": "inter", "condition": "general"},
    {"line_id": "3", "hsn": "6109", "taxable_value": 1999, "quantity": 2, "unit_price": 999.50, "supply_type": "intra_ut"}
  ]
}'
```

Trimmed (each line also carries its `source`, `effective_from`, `verification_status`, `tax_paise` and `notes`):

```json
{
  "invoice_date": "2026-10-14",
  "complete": true,
  "lines": [
    { "line_id": "1", "rule_selected_by": "resolver", "igst_rate_percent": 3, "unverified_accepted": true,
      "tax": { "cgst": 1027.5, "sgst": 1027.5, "utgst": 0, "igst": 0, "cess": 0, "total_tax": 2055 }, "needs_input": [] },
    { "line_id": "2", "rule_selected_by": "condition_general", "igst_rate_percent": 5, "unverified_accepted": true,
      "tax": { "cgst": 0, "sgst": 0, "utgst": 0, "igst": 6.03, "cess": 0, "total_tax": 6.03 }, "needs_input": [] },
    { "line_id": "3", "rule_selected_by": "resolver", "igst_rate_percent": 5, "unverified_accepted": true,
      "tax": { "cgst": 49.98, "sgst": 0, "utgst": 49.98, "igst": 0, "cess": 0, "total_tax": 99.96 }, "needs_input": [] }
  ],
  "totals": { "cgst": 1077.48, "sgst": 1027.5, "utgst": 49.98, "igst": 6.03, "cess": 0, "total_tax": 2160.99, "taxable_value": 70619.5 },
  "totals_paise": { "cgst": 107748, "sgst": 102750, "utgst": 4998, "igst": 603, "cess": 0, "total_tax": 216099, "taxable_value": 7061950 },
  "round_off_paise": -49,
  "grand_total_paise": 7278000,
  "invoice_rounding": "nearest_rupee",
  "dataset_version": "2026.10.14-1",
  "warnings": [],
  "disclaimer": "Calculated from rates curated from CBIC notifications. …"
}
```

The grand total is 70,619.50 + 2,160.99 = 72,780.49, rounded to Rs 72,780 (`round_off_paise: -49`). Use the `_paise` integers when you store or add amounts.

### When `complete` is `false`

An invoice the API cannot fully compute is still a `200`, never an error. `complete` is `false`, `totals` is `null`, and `partial_totals` sums only the lines that were computed. Each unresolved line says why in `needs_input` (what would fix it; any one entry is enough) and `notes`. Here is the same jewellery line and a 3004 line with no choice:

```json
{
  "complete": false,
  "lines": [
    { "line_id": "1", "tax": { "total_tax": 2055, … }, "needs_input": [] },
    { "line_id": "2", "hsn": "3004", "ambiguous": true, "tax": null,
      "default_rule_id": "rr_72KQVJKG3748XTVPMCKWX5DHF4",
      "candidate_rules": ["rr_72KQVJKG3748XTVPMCKWX5DHF4", "rr_XC755EY7H2Q8ZDAXNB33FREDCZ"],
      "needs_input": ["rule_id", "condition"],
      "notes": ["needs_input: rule_id, condition. A general rule and conditional rules apply; the general rule (rr_72KQVJKG3748XTVPMCKWX5DHF4) applies unless a listed condition is met. Choose the rule. Send condition \"general\" to use rr_72KQVJKG3748XTVPMCKWX5DHF4, or rule_id for a listed condition."] }
  ],
  "totals": null,
  "partial_totals": { "complete": false, "included_line_ids": ["1"], "excluded_line_ids": ["2"], "totals": { "total_tax": 2055, … }, … }
}
```

| `needs_input` contains | Fix |
|---|---|
| `accept_unverified` | The rule is unverified. Resend with `accept_unverified: true` if your business accepts that (section 8). |
| `rule_id`, `condition` | Several rules apply. Send `condition: "general"` for the default rule, or the `rule_id` of the rule that applies. |
| `unit_price` | The rate depends on the price per piece. Send `unit_price` (or `quantity`, so the price per piece can be worked out), or choose a `rule_id`. |
| `hsn` | The rules differ below this code. Send a more specific (longer) code. |

A line whose code has no rule (`no_rate_rule`) has an empty `needs_input` and a note saying so: there is nothing to send, and no tax is computed. **Never issue an invoice from `partial_totals`.**

### Choosing a rule on a line

When a lookup or a line comes back ambiguous:
- If the ambiguity is a price condition, send `unit_price`.
- Otherwise, show the user each rule's `condition.text` and rate, then send either `"condition": "general"` (use the `default_rule_id`) or `"rule_id": "rr_…"` for the rule that applies.

A `rule_id` that does not apply to that line's code and date returns `422 rule-choice-invalid`. A code whose chapter does not exist returns `422 unknown-hsn`.

### Store what you used

Save these with every invoice line, so you can explain the invoice later even after rates change: `rule_id`, `igst_rate_bp`, `effective_from`, `source.notification`, `verification_status`, `unverified_accepted` and the response's `dataset_version`.

## 8. Unverified rates: what they mean for you

This is the most important section for anyone putting this API in front of real invoices.

**The state today.** The dataset has 70 active rate rules and **none is verified**. They were transcribed from secondary sources (professional firms and publishers) because the official CBIC sites could not be reached when the data was compiled. Each rule carries a `citation_note` saying what has not been checked. A rule becomes `verified` only when one admin proposes the verification after reading the gazette PDF and a second, different admin approves it. `GET /v1/meta/dataset` shows the live counts in `coverage.rate_rules_verified` and `coverage.rate_rules_unverified`.

**What the API does about it:**
- Every lookup and classify result for an unverified rule carries the warning `rate_unverified`, the rule's `warning` text and its `citation_note`.
- `POST /v1/tax/calculate` **refuses to compute tax on an unverified rule** unless the request says `accept_unverified: true`. Without it, the line comes back with `tax: null`, `needs_input: ["accept_unverified"]` and a note:

  ```json
  { "line_id": "0", "hsn": "7113", "tax": null, "unverified_accepted": false, "verification_status": "unverified",
    "needs_input": ["accept_unverified"],
    "notes": ["rate_unverified_refused: rule rr_E1ZB3AQE2ESK0YWX5EJKQ6SZ4P has not been verified against its notification; no tax computed. Set accept_unverified: true to calculate with it anyway."] }
  ```

- With `accept_unverified: true`, the line is computed and marked `unverified_accepted: true`, and the server logs the acceptance.
- Once a rule is verified, it computes without the flag, `rate_unverified` disappears, `citation_note` becomes `null` and `last_verified_at` is set.

**What your app should do:**
1. Make `accept_unverified` a **deliberate business setting**, not a hard-coded `true`. Someone who files GST returns for the business should switch it on, knowing the rates have not been checked against the gazette.
2. Show the user that a rate is unverified wherever it appears, for example: `GST 3% · 9/2025-CT(Rate), Schedule IV · effective 22 Sep 2025 · unverified`. When `verification_status` is `verified`, show `verified <last_verified_at>` instead.
3. Record `unverified_accepted` per invoice line, so you can find and re-check those invoices once the rules are verified.
4. Do not call the rate "official". The service is not a Government of India service.

## 9. Keep a local cache: the change feed

If your app bills offline or at high volume, keep the rates for the codes you use in your own database and refresh them from the change feed. Your billing then keeps working even if the API is down.

`GET /v1/rates/changes?since=<seq>&limit=<n>` returns changes with a sequence number greater than `since`, oldest first, at most 500 per page.

```sh
curl -s "$HSN_API_URL/v1/rates/changes?since=0&limit=2" -H "Authorization: Bearer $HSN_API_KEY"
```

```json
{
  "since": 0,
  "next_since": 2,
  "has_more": true,
  "current_dataset_version": "2026.10.14-1",
  "feed_epoch": "fe_892a9af31ccfdeb6ab23c39c",
  "changes": [
    { "seq": 1, "change_type": "hsn_added", "dataset_version": "2026.10.14-1", "published_at": "2026-10-14T15:58:38Z",
      "hsn_prefix": "01", "affected_prefix": "01", "rule_id": null, "related_rule_id": null,
      "effective_from": null, "effective_to": null, "retroactive": false, "summary": "01 added" },
    …
  ]
}
```

When a reviewer verifies a rule, a change like this appears:

```json
{ "seq": 438, "change_type": "rule_verified", "dataset_version": "2026.10.14-2", "hsn_prefix": "7113", "affected_prefix": "7113",
  "rule_id": "rr_E1ZB3AQE2ESK0YWX5EJKQ6SZ4P", "effective_from": "2025-09-22", "retroactive": false,
  "summary": "7113 3% rule verified against 9/2025-CT(Rate), Schedule IV" }
```

**The sync loop:**
1. On first run, call with `since=0` and page through until `has_more` is `false`. Store `next_since` and `feed_epoch`.
2. Every 15 minutes, and at startup, call with your stored `next_since`.
3. For each change, invalidate every cached code `c` where `c.startsWith(affected_prefix)` **or** `affected_prefix.startsWith(c)`. A change to `61` affects your cached `6109`, and a change to `61091000` affects your cached `6109`. Then re-fetch those codes with `GET /v1/hsn/{code}`.
4. For a `rule_corrected` change, also drop anything that used `related_rule_id` (the voided rule).
5. If `feed_epoch` differs from the one you stored, or you get `410 feed-window-expired`, the server was restored from a backup or your position is too old. Drop your cache and start again from `since=0`.
6. If a change has `retroactive: true`, re-check invoices dated on or after its `affects_from`.

`change_type` is one of `rule_added`, `rule_end_dated`, `rule_verified`, `rule_corrected`, `hsn_added`, `hsn_updated` and `refdata_changed`. Treat any type you do not recognise as "invalidate this prefix".

## 10. Dataset status

`GET /v1/meta/dataset` tells you the state of the data. Show it on an admin or settings page in your app.

```json
{
  "dataset_version": "2026.10.14-1",
  "published_at": "2026-10-14T15:58:38Z",
  "content_sha256": "6dede5ca312ca5f76f90471d63d9f3ad62b694ee8a2833055ed352d3bb6c1625",
  "feed_epoch": "fe_892a9af31ccfdeb6ab23c39c",
  "last_change_seq": 437,
  "freshness_sla_business_days": 2,
  "sources_checked_at": null,
  "untriaged_notifications": 0,
  "pending_notifications": [],
  "coverage": {
    "hsn_codes": 320, "sac_codes": 36,
    "rate_rules_active": 70, "rate_rules_verified": 0, "rate_rules_unverified": 70,
    "rate_rules_verification_overdue": 0, "hsn_chapters_with_rules": 22,
    "rules_verified_last_90_days_percent": 0, "codes_without_rules": 148
  },
  "known_data_gaps": [
    { "prefix": "7104", "kind": "disputed", "reason": "Synthetic / lab-grown stones: sources disagree (0.25% vs 1.5%); no rule seeded." },
    …
  ],
  "sources": [ { "notification": "9/2025-CT(Rate), Schedule IV", "url": "https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications", "rule_count": 5, "verified_count": 0 }, … ],
  "classifier": { "llm_configured": false, "llm_provider": null, "external_lookups": [] },
  "disclaimer": "…"
}
```

Check `known_data_gaps` for the chapters your business sells in: these are codes the curators know are missing or disputed.

## 11. Errors

Errors use the RFC 9457 `application/problem+json` format. **Switch on `type`**, never on `title` or `detail`, which are for people. Every error carries `request_id`; quote it when you report a problem to the API owner.

```json
{
  "type": "https://hsn-api.example/problems/validation-failed",
  "title": "Request validation failed",
  "status": 400,
  "instance": "/v1/hsn/71-13",
  "request_id": "req_01M4XJ8FMV0DFBF6WAEAPB8ANC",
  "code": "validation_failed",
  "client_request_id": "order-1234",
  "detail": "Request validation failed: 1 problem. See errors[].",
  "errors": [{ "pointer": "/code", "code": "pattern", "message": "must match pattern \"^([0-9]{2}|[0-9]{4}|99[0-9]{3}|[0-9]{6}|[0-9]{8})$\"" }]
}
```

`errors[].pointer` is a JSON Pointer to the bad field, for example `/lines/3/hsn`. You can send your own `X-Request-Id` header (letters, digits, `.`, `_`, `-`, up to 64 characters); it comes back as `client_request_id`, which helps you match logs.

The errors a client will meet:

| Status | `type` ends with | Cause | What to do |
|---|---|---|---|
| 400 | `validation-failed` | A parameter or field is malformed. | Fix the field named in `errors[]`. Do not retry unchanged. |
| 401 | `unauthenticated` | Key missing, wrong, revoked or expired. | Check the `Authorization: Bearer` header; ask for a new key. |
| 403 | `insufficient-scope` | The key lacks a scope, e.g. classify with a `read`-only key. | Ask the owner for a key with that scope. |
| 404 | `hsn-not-found` | The code's chapter does not exist. | Use search. |
| 404 | `not-found` | Unknown path. | Check the URL. |
| 410 | `feed-window-expired` | Your change-feed position is too old or ahead of the server. | Resync from `since=0`. |
| 413 | `payload-too-large` | Body too big (tax allows 256 KiB). | Split the invoice. |
| 415 | `unsupported-media-type` | Missing `Content-Type: application/json`. | Add the header. |
| 422 | `invalid-gtin` | Barcode check digit is wrong. | Re-scan, or send the name. |
| 422 | `unknown-hsn` | A tax line's code does not exist. | Fix the code. |
| 422 | `rule-choice-invalid` | A line's `rule_id` does not apply to its code and date. | Pick from the lookup's `rules`. |
| 429 | `rate-limited` | Too many requests for your key. | Wait `Retry-After` seconds. |
| 429 | `quota-exceeded` | Daily quota used up. | Resets at midnight IST; ask for a higher quota. |
| 503 | `not-ready`, `dataset-not-loaded`, `classifier-unavailable` | The server is starting, restoring or has no data. | Retry with backoff; use your cache meanwhile. |
| 500 | `internal` | A server bug. | Report the `request_id`. |

Remember that "ambiguous", "low confidence" and "no rate rule" are **not errors**: they are `200` answers you must handle (sections 4, 6 and 7).

## 12. Rate limits and retries

Each key has a token bucket: by default 600 tokens a minute with bursts up to 100, plus a daily quota (default 50,000 tokens, reset at midnight IST). A lookup, search or feed call costs 1 token, classify 5, and tax 1 plus 1 per 50 lines. Every authenticated response tells you where you stand:

```
ratelimit-limit: 600
ratelimit-remaining: 99
ratelimit-reset: 1
ratelimit-cost: 1
ratelimit-policy: 600;w=60;burst=100
```

When you exceed it, you get `429` with `Retry-After`:

```json
{ "type": "https://hsn-api.example/problems/rate-limited", "status": 429,
  "detail": "Key hsk_FqGahFUX is limited to 600 tokens per 60 s (this request costs 5). Retry in 1 s, or cache with ETag / the change feed." }
```

**Retry rules:** retry only `429` and `503`, wait at least `Retry-After` seconds, add exponential backoff with a little random jitter, and give up after a few attempts. Never retry other `4xx` errors: they will fail the same way. If you hit limits regularly, cache (sections 4 and 9) or ask the owner for a higher limit.

## 13. Client code

### Node.js

[examples/hsn-client.mjs](examples/hsn-client.mjs) is a small dependency-free client (Node 18+) with typed errors and 429/503 retries, plus a demo that classifies a product, checks `needs_review`, calculates tax and handles an error. It was run against the live server:

```sh
HSN_API_URL=http://localhost:3000 HSN_API_KEY=hsk_... node docs/guides/examples/hsn-client.mjs
# Suggested HSN 7113, confidence 0.86 (high)
# Tax: { cgst: 1027.5, sgst: 1027.5, utgst: 0, igst: 0, cess: 0, total_tax: 2055, taxable_value: 68500 } Grand total (paise): 7055500
# Error 400 validation-failed: /code
```

Use it in your code:

```js
import { HsnClient, HsnApiError } from './hsn-client.mjs';

const api = new HsnClient({ baseUrl: process.env.HSN_API_URL, apiKey: process.env.HSN_API_KEY });
const { rate } = await api.lookup('6109', { unitPrice: 999.5 });
if (rate.coverage === 'ok') console.log(rate.applicable_rule.igst_rate_percent); // 5
```

### Python

Standard library only:

```python
import json, os, urllib.request, urllib.error

BASE = os.environ["HSN_API_URL"]
KEY = os.environ["HSN_API_KEY"]

def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        problem = json.load(e)
        raise RuntimeError(f"{e.code} {problem['type']}: {problem.get('detail')}") from None

rate = call("GET", "/v1/hsn/7113")["rate"]
rule = rate["applicable_rule"]
print(rate["coverage"], rule["igst_rate_percent"], rule["verification_status"])   # ok 3 unverified

tax = call("POST", "/v1/tax/calculate", {
    "accept_unverified": True,
    "lines": [{"hsn": "7113", "taxable_value": "68500.00", "supply_type": "inter"}],
})
print(tax["complete"], tax["totals"]["igst"])   # True 2055
```

### Other languages

The API is plain HTTPS and JSON. You can generate a typed client from [../design/openapi.yaml](../design/openapi.yaml) with any OpenAPI 3.1 generator (for example `openapi-generator`), or call it with your language's HTTP library as above.

## 14. Integration checklist

Before you go live, check that your app:

- [ ] Calls the API from your backend only, with the key in a secret store, and separate test and live keys.
- [ ] Handles all three `rate.coverage` values: `ok`, `ambiguous` and `no_rate_rule` (and never treats a missing rate as 0%).
- [ ] Sends `unit_price` for price-dependent codes, and `date` for back-dated or future invoices.
- [ ] Never puts a classify result with `needs_review: true` on an invoice without a person confirming it, and shows the `review_hint` reasons.
- [ ] Stores the confirmed HSN per product, so users confirm once.
- [ ] Treats `accept_unverified` as a deliberate business setting, and shows "unverified" next to every unverified rate.
- [ ] Never issues an invoice when tax `complete` is `false`; resolves each line's `needs_input` first.
- [ ] Stores `rule_id`, `igst_rate_bp`, `effective_from`, `source.notification`, `verification_status`, `unverified_accepted` and `dataset_version` with each invoice line.
- [ ] Uses the `_paise` integers for stored amounts.
- [ ] Switches on the problem `type`, logs `request_id`, retries only 429/503 with `Retry-After` and backoff.
- [ ] Caches rates and follows the change feed, including the `feed_epoch` resync, if it bills at volume or offline.
- [ ] Sends only product descriptions in `name`, never customer data.
- [ ] Shows the disclaimer: not an official government service, not tax advice.

More background: client flows with diagrams are in [../03-app-flow.md](../03-app-flow.md), the display rules for confidence and source are in [../design/ui-and-dx.md](../design/ui-and-dx.md) §3, and the client best practices are in [../07-best-practices.md](../07-best-practices.md) §13.
