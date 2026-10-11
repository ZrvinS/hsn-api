# Coordinator rulings on document inconsistencies (binding, supersedes conflicting text)

Numbering follows the "Inconsistencies found" list in 02-TRD.md §20.

1. **Module layout:** architecture.md §3 wins (`routes/ services/ repositories/ classify/ adapters/ lib/ db/`).
2. **Entrypoint:** `src/main.ts`; app factory `src/app.ts`.
3. **Errors:** openapi/ui-and-dx form wins: RFC 9457 with kebab-case `type` URI, `title`, `status`, `detail`, `instance` = request path, plus `request_id`. The three extra codes in 07 are added to the registry.
4. **Reasons:** `{code, detail, weight}`; code names from openapi.
5. **Close top candidates:** both apply. Margin penalty (≤0.05) and, if gap between top two < 0.10, top is capped at medium (`needs_review: true`).
6. **Weak matches:** drop candidates < 0.10. If the best is < 0.30 we still return what remains, all band `low`, `needs_review: true`, with a message. An empty list only when nothing ≥ 0.10.
7. **LLM re-ranker:** architecture wins. Reorder only within the candidate list; confidence may only go down, never up.
8. **LLM fields:** response gets `llm_used: boolean`; request accepts optional `allow_llm: boolean` (default false); per-key `llm_opt_out` overrides; `/v1/meta/dataset` discloses whether an LLM is configured and which provider.
9. **Env vars:** `HSN_` prefix everywhere (`HSN_DB_PATH`, `HSN_LLM_RERANK_ENABLED`, ...).
10. **API keys:** format `hsk_<8-char prefix>_<43-char base64url secret>` (32 random bytes). Stored as HMAC-SHA256(secret, `HSN_KEY_PEPPER`); timing-safe compare.
11. **Rate limits:** one token bucket per key, 600/min, classify costs 5 tokens.
12. **Making charges:** default per research: making charges billed with a jewellery sale are part of the 3% supply; SAC 9988 job work at 5% applies only to work on customer-owned metal. 07 is corrected. Remains open question Q1 for Amit's CA.
13. **Tax maths:** openapi numbers (INR, max 2 decimals, validated) in; outputs give both rupee numbers and integer `*_paise`; optional `invoice_rounding`; unresolved lines get `needs_input` in `notes[]` and are excluded from totals.
14. **Specific cess:** returned as data, not computed in v1 (note added to the line).
15. **Allowed slabs (bp):** configurable `HSN_ALLOWED_RATES_BP`, default `0,10,25,100,150,300,500,600,1200,1800,2800,4000` (historical slabs kept so old effective-dated rules load).
16. **`verification_status`** (`verified`|`unverified`) added to DDL and openapi `RateRule`; may only move unverified → verified via a maker–checker `verify` proposal.
17. **`last_verified_at` / `verified_by`:** null while unverified.
18. **7113 citation:** 9/2025-CT(Rate) Schedule IV, effective 2025-09-22, `unverified`. No mock-up may say "verified".
19. **ETag:** weak.
20. **Change feed page:** max 500.
21. **Feed cursor:** integer `since` sequence.
22. **Outbound response cap:** 256 KiB.
23. **Proposal IDs:** `rp_` + ULID.
24. **Candidates:** max 5.
25. **Proposal source:** field `notification`; `source_url` must be https on allow-listed hosts (cbic-gst.gov.in, taxinformation.cbic.gov.in, cbic.gov.in, egazette.gov.in, gstcouncil.gov.in).
26. **api_keys columns added:** `expires_at`, `daily_quota`, `llm_opt_out`.
27. **Freshness alert:** fires when the notification watcher's last successful run is older than 36 h, or a watched notification is unreviewed past the 2-business-day SLA; not on dataset age.
28. **Client polling:** every 15 min with `If-None-Match`.

Notes recorded in round 2 (coordinator decisions, 2026-10-10):
- **Body limits:** `POST /v1/tax/calculate` accepts bodies up to 256 KiB (500 fully populated lines are about 55 KB); every other route keeps its limit (64 KiB global, 16 KiB for `POST /v1/classify`). This overrides the single 64 KiB value in validator fix 18; see `05` SEC-24.
- **Search `q`:** 2–100 characters after normalisation (`05` SEC-27, openapi).
- **Ruling 9 env name:** the code and all docs use `HSN_LLM_ENABLED`; `HSN_LLM_RERANK_ENABLED` above is its earlier name.
