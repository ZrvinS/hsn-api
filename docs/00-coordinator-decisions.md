# Coordinator decisions (binding for all documents and code)

Product working name: **HSN Rate API** (`hsn-api`). Owner: Amit. Example clients: Sunarone (jewellery billing), a health app.

## Honesty rules (non-negotiable)
1. There is no official free real-time GST rate API from the Government of India. We never claim "official" or "real-time". We claim: *rates curated from CBIC notifications, versioned by effective date, each with a citation and a `last_verified_at` timestamp*.
2. Rates come only from our versioned rate table (human-reviewed). AI/heuristics may suggest an HSN code; they never produce or alter a rate.
3. Product name / barcode → HSN is a best-guess match. Every classification returns ranked candidates with a `confidence` (0–1), a `confidence_band` (`high` ≥0.85, `medium` 0.6–0.85, `low` <0.6), the reasons, and `needs_review: true` unless band is high. Never a single silent answer.
4. Every rate response carries: `effective_from`, `effective_to`, `source` (notification number + URL), `last_verified_at`, and `disclaimer`.
5. Where one HSN has several rates (price thresholds, conditions), we return all applicable rate rules and, if the caller passes `unit_price`, the one that applies — otherwise `ambiguous: true`.

## Stack (keeps deps minimal, no native builds)
- Node.js 22 + TypeScript (strict), ESM.
- HTTP: Fastify 5 with JSON-schema validation; zod for domain validation of config and ingestion.
- Storage: SQLite through built-in `node:sqlite` (FTS5 for search) behind a repository interface, so Postgres can replace it later.
- Tests: vitest. Lint: TypeScript `--noEmit` strict.
- Config via `HSN_`-prefixed env vars validated at boot; fail closed.

## API surface (v1, all under `/v1`, JSON, API-key auth via `Authorization: Bearer <key>`)
- `GET /v1/hsn/{code}` – HSN/SAC detail + current applicable rate rules (`?date=YYYY-MM-DD` for historical, `?unit_price=` to resolve thresholds).
- `GET /v1/hsn/search?q=&limit=` – text search over HSN descriptions.
- `POST /v1/classify` – body `{ "name"?: string, "barcode"?: string, "unit_price"?: number }` → candidates with confidence + rates.
- `POST /v1/tax/calculate` – line items `{hsn, taxable_value, supply_type: "intra"|"inter"}` → CGST/SGST/IGST/cess breakdown.
- `GET /v1/rates/changes?since=` – change feed so clients keep caches fresh.
- `GET /v1/meta/dataset` – dataset version, last sync, coverage stats.
- `GET /healthz`, `GET /readyz` (no auth).
- Admin (separate admin key scope): `POST /v1/admin/rate-proposals`, `POST /v1/admin/rate-proposals/{id}/approve` (maker–checker: approver ≠ proposer), `GET /v1/admin/audit`.

## Classification pipeline
barcode → (validate GTIN checksum) → local product cache → external product lookup adapters (Open Food Facts etc., pluggable, off by default without config) → product name/category → name classifier.
name → normalise → synonym/keyword rules (curated, e.g. "22k gold ring" → 7113) + FTS5 search over HSN descriptions → score fusion → candidates. Optional LLM re-ranker adapter (disabled by default) constrained to choose from the retrieved candidate list only (see AI restrictions).

## Security baseline
API keys stored as HMAC-SHA256 (server pepper) with a per-key prefix for lookup (see 00b ruling 10 and 00c ruling 17); scopes `read`, `classify`, `admin`. Per-key rate limiting. Strict input validation and size limits. No PII stored; request logs redact keys. Security headers. Outbound HTTP only to allow-listed hosts with timeouts. Audit log for every rate change.

## Layout
`/mnt/project-files/hsn-api/` → `docs/` (documents), `research/`, `server/` (code), `reviews/` (validator + security audit reports).

> Later rulings in 00b and 00c supersede this file where they differ.

## Eval gate scope decision (AG-12 sign-off), 2026-10-11

- **Decision:** the AI-42 top-3 recall gate (≥ 0.90 at 4 digits) is measured only on eval items whose labelled heading exists in the shipped HSN master. Top-3 over all positives is still computed and reported on every run, but does not gate.
- **Reason:** the seed master holds ~356 of the ~1,200+ tariff headings because the full GST-portal HSN master could not be downloaded from this environment. Items whose correct heading is absent cannot be answered by any classifier, so gating on them measures data coverage, not classifier quality.
- **Status:** coordinator-approved and **provisional**. Amit's sign-off is pending. The eval labels are LLM drafts (`reviewed_by: null`), so all gates are provisional until humans review them (AI-40).
- **Exit condition:** once the full HSN master is loaded (via `import-dataset`) and labels are human-reviewed, the gate reverts to all positives and this entry is closed.

## Ruling 36 (2026-10-11): verification must replace an index-page citation

A `verify` proposal accepts `source.url` and `notification`. When the rule's current URL is a listing/index page rather than a notification document, `source.url` is required (400 otherwise). Approval replaces the URL and notification in the same transaction; the DB trigger and audit cross-check allow exactly this change.
