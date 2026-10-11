# Seed data format (`data/seed/*.json`)

`npm run seed` (`tsx scripts/seed.ts [--dir data/seed]`) loads the five files below into the SQLite
database at `DB_PATH`, inside one transaction, and publishes dataset version
`YYYY.MM.DD-n` with `published_by = "seed"`, `reason = "seed"`. Seeding is
only allowed into an empty database and is refused when `NODE_ENV=production`
(production rate changes go through maker–checker proposals). The seed writes one
`seed_batches` row; every rule carries its `seed_batch_id` (a database trigger refuses rule
inserts that name neither an approved proposal nor the seed batch of an empty database), and the
`dataset.seeded` audit entry records the sha256 of every file, the batch id and the verifier list. Every file is
validated with zod before anything is written; **any invalid row aborts the
whole seed** (fail closed) and the error names the file, the array index and
the field.

> **Ruling 33:** seed rows are always `unverified` (no `verified_by`, no `last_verified_at`). Rules become
> verified only through a maker–checker `verify` proposal. The loader's `allowVerified` flag is
> test-fixture-only and is never set by `npm run seed`.

## Container

Each file is either a bare JSON array of rows, or an object with an `items`
array plus any metadata you like (ignored by the loader, but useful for
provenance):

```json
{ "_comment": "Compiled from CBIC notifications, see research/…", "items": [ … ] }
```

Unknown fields **inside a row** are rejected (strict schemas), so typos fail
loudly. All strings are UTF-8. Dates are `YYYY-MM-DD` (Asia/Kolkata civil
dates); timestamps are RFC 3339 UTC (`2026-10-01T00:00:00Z`).

Database path comes from `HSN_DB_PATH` (or `--db <path>`). Load order: `hsn_codes` → `rate_rules` → `synonyms` → `category_map` →
`chapter_keywords`. All files are optional except `hsn_codes.json`; a missing
file is skipped with a warning.

---

## 1. `hsn_codes.json`

| field | type | required | notes |
|---|---|---|---|
| `code` | string | yes | digits only, length 2, 4, 6 or 8; length 5 only for SAC groups (`99xxx`, e.g. `99972`). SAC service codes are 6 digits starting `99`. |
| `type` | `"goods"` \| `"service"` | no | default: `"service"` if code starts with `99`, else `"goods"`. |
| `description` | string | yes | official description (1–2000 chars). |
| `keywords` | string | no | curated extra search terms, space-separated (default `""`). |

`level`, `chapter` and `parent` are derived by the loader. **Every non-chapter
code must have its parent present** (the nearest shorter code among 2/4/5/6
that exists, so `999721` hangs under `99972`, which hangs under `9997`; for an 8-digit code whose 6-digit parent is not listed, the
4-digit heading is used; the 2-digit chapter must always exist). Order in
the file does not matter — the loader sorts by length.

```json
[
  { "code": "71", "description": "Natural or cultured pearls, precious or semi-precious stones, precious metals …" },
  { "code": "7113", "description": "Articles of jewellery and parts thereof, of precious metal or of metal clad with precious metal", "keywords": "jewellery jewelry ornament ring chain bangle necklace" },
  { "code": "99", "type": "service", "description": "Services" },
  { "code": "9988", "type": "service", "description": "Manufacturing services on physical inputs (goods) owned by others" },
  { "code": "998892", "type": "service", "description": "Jewellery manufacturing services (job work)" }
]
```

## 2. `rate_rules.json`

Money is integer **paise**, rates are integer **basis points** (300 = 3%).

| field | type | required | notes |
|---|---|---|---|
| `rule_id` | string | no | **Recommended: omit.** The loader derives a deterministic id `rr_` + 26 Crockford base32 chars from `(hsn_prefix, effective_from, condition_kind, min_unit_price_paise, max_unit_price_paise)`, so re-seeding is stable and ids match the API pattern `^rr_[0-9A-HJKMNP-TV-Z]{26}$`. If given, it must match that pattern. |
| `hsn_prefix` | string | yes | 2, 4, 6 or 8 digits (5 only for `99xxx`), and **must exist in `hsn_codes.json`** (SA-C-14). A rule at `7113` applies to every code starting `7113`. |
| `igst_rate_bp` | integer | yes | must be an allowed slab: 0, 10, 25, 100, 150, 300, 500, 600, 1200, 1800, 2800, 4000 (config `HSN_ALLOWED_RATES_BP`). Anything else (e.g. 1700) aborts the seed. |
| `cess_rate_bp` | integer | no | ad-valorem compensation cess, 0–30000, default 0. |
| `cess_specific_paise` | integer | no | specific cess amount per unit (returned as data, not computed). Requires `cess_specific_unit`. |
| `cess_specific_unit` | string | no | e.g. `"1000 sticks"`. Requires `cess_specific_paise`. |
| `condition_kind` | `"none"` \| `"price"` \| `"other"` | no | default `"none"`. |
| `condition_text` | string | if kind ≠ none | verbatim/near-verbatim notification wording, e.g. `"sale value not exceeding Rs 2500 per piece"`. |
| `condition_code` | `"nil_rate_list"` \| null | no | machine code for an `other` condition, e.g. the 0% rule for drugs on the nil-rate list next to the general 3004 rule (ruling 5). A synonym with the same `rule_hint` lets the classifier pick this rule. |
| `min_unit_price_paise` | integer | price only | inclusive lower bound, paise. |
| `max_unit_price_paise` | integer | price only | inclusive upper bound, paise. `kind="price"` ⇔ at least one bound set. Use `250000` / `250001` for "not exceeding ₹2500" / "exceeding ₹2500". |
| `effective_from` | date | yes | inclusive, ≥ `2017-07-01`. |
| `effective_to` | date \| null | no | inclusive; `null`/omitted = open-ended. Must be ≥ `effective_from`. |
| `notification_ref` | string | yes | canonical form `N/YYYY-…` with **no zero padding**, e.g. `"1/2017-IT(Rate), Schedule V"`, `"9/2025-CT(Rate), Schedule IV"`. The loader (and every API input) normalises `01/2026` to `1/2026` and the long series names (`Central Tax (Rate)`, `Integrated Tax (Rate)`, `Union Territory Tax (Rate)`, `Compensation Cess (Rate)`) to `CT`/`IT`/`UTT`/`Cess(Rate)`; the result must match `<n>/<yyyy>-<CT\|IT\|UTT\|Cess>(Rate)[, Schedule <I–VII>]` or the load (and import-dataset) fails. The serial number goes in `schedule_serial`, not here. |
| `source_url` | string | yes | must start with `https://`. |
| `source_pdf_sha256` | string \| null | no | sha256 (64 hex) of the notification PDF. Nullable on the seed path; **required** on every proposal that publishes or verifies a rule (ruling 12). |
| `schedule_serial` | string \| null | no | schedule and serial number in the notification, e.g. `"Sch IV Sr 3"`. Same rule as `source_pdf_sha256`. |
| `verification_status` | `"unverified"` | no | default and **only accepted value** (ruling 33, SA-C-17): the seed bypasses maker–checker, so rows are promoted later with a `verify` proposal (which records `source_pdf_sha256` and `schedule_serial`). Unverified rates are served with a warning, and `/v1/tax/calculate` refuses them unless the request sets `accept_unverified: true` (ruling 24). Seed rows are always unverified. The loader option `allowVerified` exists only for test fixtures (`test/fixtures/seed`); `scripts/seed.ts` never sets it, and a verified row in `data/seed` aborts the seed. |
| `verified_by` | null | no | must be null/omitted. |
| `last_verified_at` | null | no | must be null/omitted. |
| `research_ref` | string | no | free-text pointer into `research/` (not loaded into the DB; ignored). |
| `citation_note` | string \| null | no | 1–1000 chars. The caveat a client should see with this rule while it is unverified (e.g. "gazette not read; schedule S.No. not verified; secondary source: …"). Loaded into `rate_rules.citation_note` and served as `citation_note` in every rule DTO; set **only** on the seed path (a proposal cannot set it) and cleared to `null` when a `verify` proposal is approved. Unlike `research_ref`, write it for API consumers, not for maintainers. |

`source_url` must be `https://` on an allowed host: cbic-gst.gov.in,
taxinformation.cbic.gov.in, cbic.gov.in, egazette.gov.in, gstcouncil.gov.in
(and their `www.` forms; config `HSN_SOURCE_HOSTS`).

Rules for a valid set (checked by the loader, aborting on violation):
- Two rules with the same `hsn_prefix` must not overlap on **both** date range
  and price range (`none`/`other` overlap every price). End-date the older rule
  (`effective_to` = new `effective_from` − 1 day) instead.

```json
[
  { "hsn_prefix": "7113", "igst_rate_bp": 300,
    "effective_from": "2017-07-01", "effective_to": null,
    "notification_ref": "01/2017-Integrated Tax (Rate), Schedule V",
    "source_url": "https://cbic-gst.gov.in/…", "verification_status": "unverified" },
  { "hsn_prefix": "61", "igst_rate_bp": 500,
    "condition_kind": "price", "condition_text": "sale value not exceeding Rs 2500 per piece",
    "max_unit_price_paise": 250000, "effective_from": "2025-09-22",
    "notification_ref": "…", "source_url": "https://…" },
  { "hsn_prefix": "61", "igst_rate_bp": 1800,
    "condition_kind": "price", "condition_text": "sale value exceeding Rs 2500 per piece",
    "min_unit_price_paise": 250001, "effective_from": "2025-09-22",
    "notification_ref": "…", "source_url": "https://…" },
  { "hsn_prefix": "3004", "igst_rate_bp": 0,
    "condition_kind": "other", "condition_code": "nil_rate_list",
    "condition_text": "drugs and medicines on the nil-rate list (illustrative wording)",
    "effective_from": "2025-09-22", "notification_ref": "…", "source_url": "https://…" }
]
```

## 3. `synonyms.json`

| field | type | required | notes |
|---|---|---|---|
| `phrase` | string | yes | lower-case, normalised (NFKC, karat → `22k`, single spaces), 1–200 chars. |
| `hsn_code` | string | yes | must exist in `hsn_codes.json`. |
| `strength` | `"primary"` \| `"related"` | no | default `"primary"`. |
| `note` | string | no | reviewer hint, surfaced as reason `review_hint`. |
| `rule_hint` | `"nil_rate_list"` \| null | no | marks a curated synonym (e.g. a named nil-rated drug) whose match may select the rule with the same `condition_code` (ruling 5). |
| `created_by` | string | no | default `"seed"`. |

`(phrase, hsn_code)` must be unique.

```json
[
  { "phrase": "22k gold ring", "hsn_code": "7113" },
  { "phrase": "paracetamol", "hsn_code": "3004", "note": "Bulk paracetamol (API) is 2924; confirm retail dosage form." },
  { "phrase": "paracetamol", "hsn_code": "2924", "strength": "related", "note": "Only for bulk drug substance" }
]
```

## 4. `category_map.json`

| field | type | required | notes |
|---|---|---|---|
| `source` | string | yes | e.g. `"open_food_facts"`. |
| `category` | string | yes | source taxonomy tag, e.g. `"en:biscuits"`. |
| `hsn_prefix` | string | yes | 2, 4, 6 or 8 digits (5 for `99xxx`), e.g. heading `"1905"` or chapter `"19"`; must exist in `hsn_codes.json`. |

```json
[ { "source": "open_food_facts", "category": "en:biscuits", "hsn_prefix": "1905" } ]
```

## 5. `chapter_keywords.json`

| field | type | required | notes |
|---|---|---|---|
| `keyword` | string | yes | single normalised token, lower-case, no spaces: `"gold"`, `"22k"`, `"tablet"`. |
| `chapter` | string | yes | 2 digits. |

```json
[ { "keyword": "gold", "chapter": "71" }, { "keyword": "tablet", "chapter": "30" } ]
```


## After the seed

Synonyms, category map, chapter keywords and HSN descriptions are reference data: after the seed
they change only through approved `refdata_change` proposals, and rows are deactivated, never
edited or deleted (ruling 23; database triggers enforce this).

## known_gaps.json (optional)

Curated list of known data gaps, served as `known_data_gaps[]` by `GET /v1/meta/dataset` (read at boot; not part of
the dataset content hash). `{"items": [{"prefix": "7117" | null, "kind": "disputed" | "not_researched" |
"not_transcribed" | "not_expressible" | "period_gap", "reason": "5–500 chars"}]}`, at most 200 items. A malformed
file stops the server from starting; a missing file serves an empty list. Override the path with `HSN_KNOWN_GAPS_FILE`.
