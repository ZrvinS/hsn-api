# Security review: design documents, round 1

Reviewer: security auditor · Date: 2026-10-10 · Scope: `docs/00`, `00b`, `02-TRD`, `03-app-flow`, `05-security-checklist`, `06-ai-restrictions`, `07-best-practices`, `design/openapi.yaml`, `design/data-model.md`, `design/architecture.md`, plus `design/ui-and-dx.md` (it specifies the admin screen) and `01-PRD.md` Q3/Q5.
Method: read every document in full. Threat-modelled the system from attacker goals, starting with the worst case (a wrong rate printed on real invoices), then the misuse paths: maker–checker bypass, data tampering, classification poisoning, SSRF, injection, DoS, leakage, supply chain and compliance. Commands run: `ls`, `cat`, `sed`, `grep` over `docs/` only. There is no code yet, so this round tests nothing.

Severity scale (from `05` §How to use): **Critical** blocks merge or release. **High** blocks release. **Medium** must be fixed within the current milestone. **Low** is tracked.

## Verdict: **FAIL**

The baseline is strong. It has peppered HMAC keys, default-deny scopes, `additionalProperties: false`, an FTS query builder, layered SSRF controls, append-only triggers, retrieve-then-rank AI and a deterministic fallback. Even so, the main integrity control can be bypassed by one person. Maker–checker identity is a free-text `actor` string chosen by whoever runs the key CLI, so that person can mint a second identity (SA-D-01). Several High findings also leave the worst-case harm reachable:
- rate rows can be tampered with undetectably (SA-D-02, SA-D-03);
- approvals are not bound to the content the checker reviewed (SA-D-04);
- an XSS in the admin UI can steal the checker's key (SA-D-05);
- crowd-sourced barcode data can produce auto-applied `high` classifications (SA-D-06);
- classification reference data has no change control (SA-D-07);
- unreviewed seed rates are served for real invoices (SA-D-08).

Each Critical and High finding needs a design change before the matching code is accepted. The code audit will check SEC items plus the new items requested below.

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 7 |
| Medium | 12 |
| Low | 6 |
| **Total** | **26** |

---

## Findings

### SA-D-01 · Critical: one person can satisfy maker–checker alone (identity is a self-asserted string)
**Location:** `02-TRD` §9 (issuance via `npm run keys -- create`), `data-model.md` `api_keys.actor` (nullable free text, not unique, no registry), `rate_proposals` `CHECK (decided_by <> proposed_by)`, `05` SEC-50 ("owner identity", undefined), `03` §1 (operator Amit runs the CLI on the server host), `architecture.md` §2.4.

**Issue:** The approver ≠ proposer check compares `api_keys.actor`. The operator sets that string when creating a key. The maker (Amit in every flow) is also the operator with CLI and host access, so he can run `keys create --scopes admin --actor priya` and approve his own proposal. Nothing records that the actor consented, nothing notifies the real Priya, and no second person approves the key creation. The comparison is also a raw string comparison, so `amit`, `Amit`, `amit ` and `аmit` (Cyrillic а) all count as different actors. SEC-50's test ("same owner, different keys → 403") passes while this bypass stays open. The design's claim that "one person holding two keys cannot approve their own proposal" is therefore false.

**Required change:**
1. Add an `admin_actors` table: `actor_id` (ULID), `handle` (NFKC, lowercase, `^[a-z][a-z0-9_-]{2,31}$`, UNIQUE), `display_name`, `contact` (out-of-band channel), `created_at`, `created_by_actor`, `disabled_at`. Make `api_keys.actor_id` an FK to it, NOT NULL when the key has the `admin` scope. Maker–checker compares `actor_id`, not text.
2. Put creation of an admin actor, or of an admin key for an actor, under two-person control: a pending request that a *different* existing admin actor confirms. Bootstrap the first two actors with an explicit, audited `bootstrap` command that works only when `admin_actors` is empty.
3. On every admin key creation, send an out-of-band notice to the named actor's registered contact ("an admin key was created for you; if this wasn't you, …"). Record an audit entry `admin_key.created` with `created_by_actor`.
4. Change the DDL CHECK to compare `decided_by_actor_id <> proposed_by_actor_id`.
5. State the residual risk in `05` §0: whoever holds host or DB-file access plus the pepper can bypass the whole application layer. SA-D-02 adds the compensating controls (external anchoring and notifications).
6. Add SEC items, all tested: an admin key cannot be created without confirmation from a second actor; handles are normalised and unique; approval is decided on `actor_id`.

### SA-D-02 · High: tamper-evidence does not cover rate content and is not anchored outside the trust boundary
**Location:** `data-model.md` §2 (audit_log hash and chain-head comment), §4; `05` SEC-53, SEC-54, SEC-81; `openapi.yaml` `GET /v1/admin/audit?verify` ("re-computes the hash chain for the returned page"); `02-TRD` §14 (`/readyz` "manifest hash verifies"); the `rate_proposal.approved` example in `openapi.yaml`.

**Issue:**
- (a) The chain is plain SHA-256 with no key. Anyone who can write the DB file can drop the triggers (they live in the same file), edit `rate_rules`, rewrite `audit_log` and recompute every hash. The only outside copy is "the chain head in stdout logs", and those logs usually sit with the same platform and operator and are deleted after 180 days.
- (b) Audit `details` for an approval hold IDs (`rule_id`, `dataset_version`) but not the rate values, so an edit to `rate_rules.igst_rate_bp` (triggers dropped, or a replaced DB file) leaves the audit chain valid.
- (c) `dataset_versions.content_hash` and the "manifest" live in the same DB and are recomputed by the same process, so `/readyz` checks the DB against itself.
- (d) The Ed25519 signature (SEC-54) is optional, and its key would sit on the same host.
- (e) `verify=true` checks one page only. It cannot detect truncation of the tail or a wholesale rewrite, and the admin UI then shows "chain ✓ verified to #5119", which gives false assurance.

**Required change:**
1. Audit `details` for `rate_proposal.approved` (and for seed, verify and end_date) must include `rule_sha256 = sha256(canonical_json(full rate_rules row))` and `dataset_content_hash`. Add a verifier that recomputes every `rate_rules` row hash and checks it against its audit entry. It runs at boot, in `/readyz` and nightly. A mismatch pages someone and blocks readiness.
2. Anchor outside the host. After every publish, and at least daily, write `{audit_id, audit_hash, dataset_version, content_hash, last_change_seq}` to a store the app host cannot rewrite: object storage with object lock or WORM, or a separate log service, or an email or webhook to both reviewers. The verifier compares the DB against the latest anchor.
3. Make the manifest signature mandatory in production. Use a signing key the request-handling process cannot read (a separate signer process or KMS), or have the checker sign offline. Publish the public key so clients can verify `/v1/meta/dataset`.
4. Split audit verification into `verify=page` and an admin-only, rate-limited `verify=full` (from id 1 up to the anchor). The UI must say which one ran.
5. Update SEC-53/54 tests: a full rewrite with valid recomputed hashes must be detected through the anchor, and a rate edit with triggers dropped must be detected through `rule_sha256`.

### SA-D-03 · High: DB-level guards leave rate-changing write paths open
**Location:** `data-model.md` §2 (`rate_rules_guard_update`, no INSERT guard, `rate_proposals` with no triggers, `dataset_state`/`dataset_versions` with no triggers), §1 (Immutability).

**Issue:**
- (a) **INSERT is unguarded.** Any write connection can insert a rule with `verification_status='verified'`, any `verified_by` and `proposal_id NULL`. "NULL only for seed rows" is a comment, not a constraint.
- (b) The update trigger lets a closed rule's `effective_to` move **earlier** (the comment says "or to an earlier date"). That retroactively cuts short a rate that past invoices relied on, and it can be done repeatedly.
- (c) `superseded_by`, `end_dated_in_version`, `verified_by` and `last_verified_at` are not in the trigger's WHEN list, so they can be rewritten at will, including rewriting who verified a rule.
- (d) `rate_proposals` has no immutability. `rule_json` can be edited after review, and `status` can go from `approved`/`rejected` back to `pending`, so a proposal can be re-approved and replayed.
- (e) `dataset_state.current_version` can be pointed back at an older version.

**Required change:** Add triggers, mirrored in Postgres:
- `rate_rules` BEFORE INSERT: `proposal_id` must reference a proposal in status `pending` that is being approved in this transaction. Reorder §4 so the proposal is marked `approving` first, or check `decided_at IS NOT NULL`. The only exception is `created_in_version` whose `dataset_versions.reason='seed'` while `dataset_state` is empty. A `verified` insert requires `verified_by` to equal the proposal's `decided_by`.
- `rate_rules` BEFORE UPDATE: `effective_to` may change only from NULL to a date, once. Shortening needs a new `correction` proposal kind with its own feed event (see SA-D-11). `superseded_by` and `end_dated_in_version` may change only from NULL, once, together with `effective_to`. `verified_by` and `last_verified_at` may change only together with the unverified → verified transition.
- `rate_proposals` BEFORE UPDATE: only `status` (`pending` → `approved|rejected|withdrawn`, one way) and the `decided_*` and `resulting_*` columns may change; `rule_json`, `action`, `supersedes_rule_id`, `end_date`, `rationale` and `proposed_*` are immutable. No DELETE.
- `dataset_versions`: append-only. `dataset_state.current_version` may only move to a version whose `parent_version` is the current one.
- SEC-52: extend the test list to cover each of these.

### SA-D-04 · High: approval is not bound to what the checker reviewed; stale or racy approvals
**Location:** `openapi.yaml` `/approve` (body is only `verified_against_source: true` and `comment`), `data-model.md` §4, `ui-and-dx.md` §2, `07` §11 ("Bulk approvals show a diff summary first"), `withdrawn` status (no endpoint).

**Issue:**
- (a) There is no edit endpoint today, but nothing in the contract or DDL stops one being added. The `withdrawn` status implies a lifecycle, and SA-D-03(d) shows the row can change. Approve takes only the ID, so the checker can review content X and approve content Y.
- (b) A long-pending `supersede` is approved against whatever state its target is in now. The design does not assert that the target rule is still open (`effective_to IS NULL`, `superseded_by IS NULL`). Together with SA-D-03(b), that can silently shorten an already-closed rule.
- (c) The attestation is a boolean the UI sets from a tick box. It proves nothing about which document was read. TRD §3.1 A3 `source_sha256` and `serial_no` are "optional" and not in the DDL.
- (d) "Bulk approvals" (07) defeats per-item review.
- (e) A checker key revoked less than 60 s ago still approves (SEC-16 cache), and pending proposals from a revoked or compromised maker key stay approvable.

**Required change:**
1. `GET` proposal returns `content_hash` (sha256 of canonical proposal content plus the current state of `supersedes_rule_id`). Approve and reject require `If-Match: "<content_hash>"` (or a body field `content_hash`). On mismatch → 412/409, re-review.
2. Inside the approval transaction, assert that the target rule for `supersede`/`end_date`/`verify` is current (`effective_to IS NULL AND superseded_by IS NULL`, and for `verify`, `verification_status='unverified'`), else 409 `proposal-stale`.
3. Make `source_sha256` (of the notification PDF) and `serial_no` mandatory on create and supersede proposals and store them on `rate_rules`. The checker's approval must re-enter or confirm the `serial_no`. This is a real, if cheap, proof of reading.
4. No bulk-approve API. If the UI offers bulk, it must send one approve call with its own `content_hash` per proposal. Remove "Bulk approvals" from `07` or redefine it that way.
5. Admin-scope keys are never served from the key cache: re-check `revoked_at`/`expires_at` inside the approval transaction. Revoking an admin key, or disabling an actor, auto-withdraws that actor's pending proposals (audited).
6. Define `withdraw`: maker-only, pending-only, audited.

### SA-D-05 · High: the admin review UI puts admin keys in a browser and renders attacker-controlled text
**Location:** `ui-and-dx.md` §2 ("A server-rendered page or small SPA over the admin endpoints… signed in with an admin key"), `03` header ("Keys never go into a browser"), `05` SEC-70 (`CSP default-src 'none'` would break any UI), SEC-71.

**Issue:** The UI shows maker-supplied text: `rationale`, `condition_text`, `notification`, `source.url` and `comment`. A malicious or compromised maker puts an XSS payload in `rationale`. The checker opens the review page, the script reads the checker's admin key from JS memory or storage and approves the maker's proposal, which bypasses maker–checker. The `[open ↗]` source link is another sink (`javascript:` URLs, or a look-alike host if validation is loose, see SA-D-17). The docs give no session, CSRF, CSP or framing design for this UI, and it contradicts the "no keys in browsers" rule.

**Required change:** Before any admin UI is built, add a section and SEC items covering:
- The UI is served from a separate origin or listener (see SA-D-09), not from the API's `default-src 'none'` responses.
- The admin key is never stored in JS-readable storage. Either use a server-side session with an `HttpOnly; Secure; SameSite=Strict` cookie, CSRF token and short idle timeout, or keep the UI as a CLI only.
- Strict CSP (`script-src 'self'` with nonces, no `unsafe-inline`), `frame-ancestors 'none'`.
- All proposal fields rendered as text (auto-escaping templates or `textContent` only).
- Links are rendered only after parsing with `URL` and checking scheme `https:` and an exact host from `HSN_SOURCE_HOSTS`, with `rel="noopener noreferrer"`.
- An XSS test fixture: a proposal with `<script>`, `"><img onerror>` and a `javascript:` URL renders inert.

### SA-D-06 · High: crowd-sourced barcode data can yield `high` / `needs_review: false` and be auto-applied
**Location:** `architecture.md` §5.3–5.4 (gate: `s_bar(c) = 1.0` lifts the 0.84 cap), §2.2 (product name from adapter feeds the name classifier), `data-model.md` `products` (30-day cache), `03` §11 ("Small retailer app: barcode scan → high-band results auto-filled"), `06` A.2 (treats OFF as untrusted for the LLM only).

**Issue:** Open Food Facts is publicly editable. For a barcode-only request, an attacker who edits the OFF product controls both the product name (which drives `s_syn`/`s_fts`/`s_chap`) and the category (which drives `s_bar`). Example: they set category `en:biscuits` and name "glucose biscuits" on some other product's GTIN. The worked example shows this reaches 0.94 `high`, so the client auto-fills the HSN and its rate without review, and the poisoned entry is cached for 30 days. This is the worst-case harm (wrong tax on real invoices) reached through third-party data, and AI-16-style corpora do not test it.

**Required change:**
1. When every text signal comes from adapter data (no request `name`), cap confidence at 0.84 (`medium`, `needs_review: true`) with reason `external_product_data`. Only a request `name` combined with an agreeing barcode category may reach `high`.
2. Return provenance (`product.source`, `fetched_at`). Record OFF's `last_modified_t` and revision, and do not use OFF records modified in the last N days for scoring, or treat them as `low`.
3. Expose a `products` cache purge for admins (audited), and log category changes for a GTIN between fetches.
4. Add an SEC item and test: a barcode-only request with an adapter fixture whose name and category both match a synonym and category_map → band ≤ medium.

### SA-D-07 · High: classification reference data has no change control, audit or append-only protection
**Location:** `data-model.md` `synonyms`, `category_map`, `chapter_keywords`, `hsn_codes` (`description`, `keywords` updatable; `hsn_codes_au` trigger), `products.source='manual'`; `change_feed.change_type` has `synonym_changed` and `hsn_updated`; the `openapi.yaml` audit `entity_type` enum includes `synonym`, but no write API or process exists. `06` AI-45 covers only "review of rule PRs".

**Issue:** One curated synonym gives `s_syn = 1.0` → `high` → auto-applied. Rows are only "seed examples" with `created_by` free text. There is no defined path, no maker–checker, no audit entry and no trigger for editing synonyms, the category map, chapter keywords or HSN descriptions and keywords. Example: whoever edits `synonyms` maps "gold ring" to 7117 (imitation jewellery, different rate) and the rate follows the code. Changes to `hsn_codes` also change FTS retrieval silently.

**Required change:** Treat `synonyms`, `category_map`, `chapter_keywords`, `hsn_codes` and manual `products` as integrity-relevant data:
- Changes go through the same proposal → approve flow (new `entity` kinds) with actor-ID maker–checker, audit (hash-chained with row hashes per SA-D-02), `change_feed` events and a new `dataset_version`.
- Rows are soft-deactivated, never deleted (triggers).
- Seed loads are recorded as `dataset.seeded` with file hashes.
- Add SEC-5x items with tests (direct UPDATE or DELETE aborts; a synonym change produces audit and feed rows; a self-approved synonym change → 403).

### SA-D-08 · High: unreviewed seed rates are served for real invoices
**Location:** `00` honesty rule 2 ("Rates come only from our versioned rate table (human-reviewed)"), `02-TRD` §4 and §6 ("Unverified rule: tax is computed"), §13 (seed bypasses proposals), PRD Q5 ("serve with flag… launch gate covers Amit's own apps"), `README` (research rates are from secondary sources and unverified, compiled by agents).

**Issue:** At launch every rule is `unverified` (`meta` example: `rate_rules_verified: 0`). The rates were compiled by AI agents from secondary sources. `/v1/tax/calculate` computes tax from them, attaching only a note that clients may ignore. That breaks honesty rule 2 and is the worst-case harm path. It also makes the seed loader (no maker–checker, "only when `dataset_state` is empty") the one write path that bypasses review for the whole dataset.

**Required change:**
1. Production launch gate: every rule in the chapters a live tenant uses must be `verified`. Record this as an explicit go/no-go in `reviews/`.
2. Until then, `/v1/tax/calculate` returns `tax: null` with `needs_input: accept_unverified` for unverified rules, unless the request sends `accept_unverified: true`. That makes the risk an explicit client choice, logged per key. Lookups keep returning the rule with the warning.
3. Seed in production requires a second actor to confirm the seed file hashes (two-person rule, audited), and refuses unless `NODE_ENV` and DB are fresh.
4. Resolve PRD Q5 in `00b` accordingly.

### SA-D-09 · Medium: admin plane is exposed and weakly separated
**Location:** `02-TRD` §8 (`HSN_HOST 0.0.0.0`, `HSN_ADMIN_IP_ALLOWLIST` optional), §9 (admin keys "expire within 1 year and are rotated every 90 days"), `data-model.md` `api_keys` (no admin expiry constraint), `05` SEC-14/15/16/18.

**Issue:** `/v1/admin/*` is on the public listener, and a leaked bearer string gives full maker or checker power from anywhere. The 1-year expiry and 90-day rotation conflict and neither is enforced. Admin keys go through the same 60 s cache. No notification goes to the other reviewers when a proposal is created or approved, which is the cheapest detection control for a compromised maker or checker pair.

**Required change:**
- In production, require `HSN_ADMIN_IP_ALLOWLIST` (fail closed when it is empty), or serve admin on a separate listener or port reachable only over VPN.
- Enforce admin `expires_at` ≤ 90 days in the key CLI and a DDL CHECK.
- Bypass the cache for admin keys (see SA-D-04).
- Send an out-of-band notification to all admin actors on every `rate_proposal.created/approved/rejected`, `admin_key.created/revoked` and audit-verify failure.
- Add SEC items for each.

### SA-D-10 · Medium: scope storage allows a combined admin key and an admin key with no actor
**Location:** `data-model.md` `api_keys` `CHECK (NOT (scopes LIKE '%"admin"%') OR actor IS NOT NULL)`, `openapi.yaml` securitySchemes ("a key may hold several"), `05` SEC-18 ("Admin keys are distinct keys, not a scope added to a client key").

**Issue:**
- The contract and DDL contradict SEC-18: `["read","classify","admin"]` is valid.
- The LIKE check runs on JSON text, so `["admin"]` passes `json_valid`, misses the LIKE (no actor required), and parses to `"admin"` in the app. The result is an admin key with a NULL actor, which then hits undefined behaviour in `proposed_by NOT NULL` and the maker–checker comparison.
- Unknown scope strings are not rejected.

**Required change:**
- Store scopes in a normalised table (`api_key_scopes(key_id, scope CHECK IN ('read','classify','admin'))`) or validate with `json_each` in a trigger.
- Forbid `admin` alongside any other scope.
- Require `actor_id` (SA-D-01) for admin.
- The app's scope parser rejects unknown values and refuses to authenticate a row that fails validation.
- Fix `openapi.yaml` wording.
- Test with the `admin` case.

### SA-D-11 · Medium: retroactive rate changes are unrestricted and not flagged
**Location:** `RateRuleInput.effective_from` (any date ≥ 2017-07-01), `end_date` proposal (any date), `data-model.md` §3 (supersede end-dates to `new.effective_from − 1`), `03` §8 ("effective_from future or past").

**Issue:** A proposal can rewrite the answer for dates on which clients have already issued invoices, through a back-dated supersede, a back-dated end_date or a new longer-prefix rule that shadows an old one. Legitimate corrections need this, but nothing distinguishes a correction from a mistake or an abuse. Clients get no signal that history changed, and the checker's diff shows no warning.

**Required change:**
- Any change whose effect starts before the approval date (IST) must be flagged `retroactive: true` in the proposal. It needs a `correction` rationale prefix and an extra explicit attestation in approve. The diff shows a red "changes rates for N past days" banner.
- `change_feed` rows carry `retroactive: true` and `affects_from`.
- Set a bound: `end_date` and `effective_from` no earlier than the cited notification's own effective date (checked by the checker, recorded).
- Test that a back-dated proposal without the flag → 400.

### SA-D-12 · Medium: DB restore or replacement makes the change feed go backwards undetected
**Location:** `02-TRD` §12, §16 (backups, restore), `openapi.yaml` `/v1/rates/changes`, `03` §8.

**Issue:** After restoring a backup, or a malicious DB swap, `seq` resumes from a lower value. Clients holding `since=N` above the server's max get empty pages and quietly keep stale or newer-than-server rules. Later publishes reuse seq numbers the clients have already skipped, so they never receive those changes. A rollback to an older dataset (with older rates) is also invisible to clients.

**Required change:**
- Add a `dataset_lineage_id` (random, generated at seed, changed on any restore) to every feed page and to `/meta`.
- `since > last_change_seq` → 410 `feed-window-expired` (resync).
- Clients must resync when `lineage_id` changes, and `dataset_version` must never go backwards (document it in `07` §13).
- Restores are an audited admin action with an incident note.
- Add SEC-78/81 tests.

### SA-D-13 · Medium: the read-only request connection is contradicted, and one process holds all secrets
**Location:** `05` SEC-42, `02-TRD` §16, `data-model.md` §1 and `products`/`api_keys.last_used_at`, `07` §8 (idempotency store), `architecture.md` §4.

**Issue:**
- The request path must write the `products` cache upsert, `api_keys.last_used_at` and idempotency records, and the design also implies brute-force and quota counters if they are persisted. A "read-only request connection" cannot do this, so the implementation will either open the main connection read-write or add an ad-hoc writer, and either way SEC-42 is defeated.
- The same process also holds `HSN_KEY_PEPPER`, the LLM key, the dataset signing key and the admin write connection. A single RCE in a parsing dependency or in Fastify gets all of them.

**Required change:**
- Define three connections in `db/open.ts`: a read-only rate connection; a "cache writer" whose repository exposes only `products`, `last_used_at` and idempotency writes, with a trigger or test proving it cannot touch `rate_rules`, `audit_log`, `rate_proposals` or the reference tables; and an admin writer used only by `ProposalService`.
- Record the single-process limitation in `05` §0. Plan the admin plane as a separate process or listener (SA-D-09) and the signer outside the request process (SA-D-02).
- Test with the arch test plus a DB test.

### SA-D-14 · Medium: the DoS cost model does not match the real cost of requests
**Location:** `00b` ruling 11, `05` SEC-19/22/36/38, `02-TRD` §10/§11/§17, `architecture.md` §6.

**Issue:**
- (a) `POST /v1/tax/calculate` with 500 lines costs 1 token (up to 500 resolver calls). Varying `unit_price` per line defeats the LRU (key includes `unit_price`) and evicts other tenants' entries.
- (b) Barcode amplification: valid GTINs are easy to generate (10¹² space). Each unique one is a cache miss that takes one of only 4 global outbound slots for up to 3 s, inserts a `products` row and spends the service's shared OFF quota. One key at 120 classify/min can starve every tenant's barcode lookups and get the service IP throttled or banned by OFF. Negative caching does not help with unique barcodes.
- (c) LLM calls are opt-in per request (`allow_llm: true`) with no per-key or global budget, which opens a direct cost attack on the provider bill.
- (d) `products` grows without bound until the nightly purge of rows expired more than 90 days ago.

**Required change:**
- Token cost for tax = 1 + ⌈lines/25⌉, and lines count toward the daily quota.
- Keep the LRU keyed on resolved rule-set (code, date), with price filtering applied after the cache.
- Per-key outbound budget (e.g. ≤ 10 cache misses/min/key) and a global outbound rate below OFF's published limit; misses beyond either → `product.source: not_found` with reason `lookup_throttled`, no slot taken.
- Per-key and global LLM call budgets, with a circuit breaker on cost.
- Cap `products` rows; prefer LRU eviction.
- Add tests for each.

### SA-D-15 · Medium: the pre-auth IP limiter and brute-force block can lock out legitimate tenants
**Location:** `05` SEC-19/21/23, `02-TRD` §10 ("per truncated IP, 60/min"; "≥ 20 401s → 15-min block").

**Issue:**
- It is unclear whether every request counts against the per-IP bucket before key lookup. If it does, a tenant backend on one IP (Sunarone at up to 600/min) is capped at 60/min.
- Truncating to /24 (IPv4) means an attacker on a shared carrier NAT, a shared cloud range or the same /24 can trigger a 15-min block for real tenants by sending 20 bad keys.
- If `HSN_TRUST_PROXY` is misconfigured on Fly or Render, every client appears as the proxy IP and one attacker blocks everyone.
- 256-bit secrets make online brute force pointless anyway.

**Required change:**
- Count only *failed* authentications against the per-IP bucket and block, keyed on full IP (not truncated).
- A request with a valid key is never blocked by the IP rule.
- At boot, fail when running behind a known platform proxy with `HSN_TRUST_PROXY` unset.
- Clarify SEC-19 and SEC-21 and test: valid-key traffic from a blocked IP still succeeds.

### SA-D-16 · Medium: gaps in the SSRF controls
**Location:** `05` SEC-32–36, `02-TRD` §2 and §13 (watcher in `db/watcher.ts` uses `lib/http.ts`, but only `adapters/**` may import it), `architecture.md` §1 (LLM 5 s vs `lib/http.ts` 3 s total).

**Issue:**
- The IP deny-list misses `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), `2002::/16` (6to4 embedding private v4), `2001::/32` (Teredo), `::/128`, `100::/64`, `192.0.0.0/24`, `198.18.0.0/15`, `240.0.0.0/4`, `255.255.255.255`, and the documentation and benchmark ranges.
- The body cap does not say it applies after decompression.
- Nothing forbids disabling TLS verification or honouring `HTTP(S)_PROXY` env vars, either of which moves the IP check onto the proxy.
- The watcher's location breaks the import rule, and its HTML/PDF parsing is a new untrusted-input surface.
- Timeouts conflict.

**Required change:**
- Classify IPs as *allow only global unicast* (deny everything that is not), applying the IPv4 rules to the embedded v4 of mapped, NAT64 and 6to4 forms.
- Apply the 256 KiB cap to decoded bytes and allow only `identity`/`gzip` encodings.
- Never set `rejectUnauthorized: false`; ignore proxy env vars (explicit dispatcher).
- Per-caller timeouts are passed in but capped by `lib/http.ts` (LLM 5 s, OFF 3 s).
- Move the watcher into `adapters/cbicWatcher.ts` (or a separate process) with its own allow-list. No PDF-parsing dependency without auditor sign-off.
- Extend the SEC-34 address table test accordingly.

### SA-D-17 · Medium: source URL validation and citation strength
**Location:** `05` SEC-51, `00b` ruling 25, the `openapi.yaml` example (both citations point to the generic `gst-goods-services-rates.html` page), `02-TRD` §3.1 A3.

**Issue:** The design says only that the host must be "allow-listed". Weak implementations (`includes`/`endsWith`, regex) accept `https://cbic-gst.gov.in.evil.example/`, `https://cbic-gst.gov.in@evil.example/`, a trailing dot, IDN look-alikes or odd ports. The examples cite a generic rates page rather than the notification itself, so the citation cannot be checked against a specific document. The `source.url` is also returned to every client, so a malicious one is distributed widely.

**Required change:**
- Validate with `new URL()`: `protocol === 'https:'`, no username or password, default port, `hostname` (lowercased, trailing dot stripped, ASCII only) exactly in `HSN_SOURCE_HOSTS`.
- Require a path to the specific notification document for create and supersede.
- Store `source_sha256` (SA-D-04).
- Test each bypass string → 400.

### SA-D-18 · Medium: hashed product names in logs can be reversed
**Location:** `05` SEC-62, `06` AI-50, `architecture.md` §6 ("64-char truncated, hashed name").

**Issue:** An unsalted SHA-256 of a short normalised string can be reversed with a dictionary. Names that contain phone numbers (10 digits, about 10¹⁰ space) or customer names are recoverable, so the "hash" is not the minimisation SEC-86 and DPDP rely on. The architecture wording ("truncated, hashed") is ambiguous and could be read as logging a truncated raw name. Logs also use `key prefix` (architecture) where SEC-63 says `key_id`.

**Required change:** Use HMAC-SHA256 with a log-specific secret rotated at the log-retention interval (or drop the field), and specify that only the hash is logged, never the truncated text. Align on `key_id`. Update T-S07 to assert that neither the raw name nor its plain SHA-256 appears in logs.

### SA-D-19 · Medium: gaps in CERT-In and DPDP
**Location:** `05` §15–16 (SEC-64, SEC-84, SEC-88, SEC-89), `02-TRD` §16 / `architecture.md` §4 (Fly or Render hosting, object-storage backups).

**Issue:**
- CERT-In Directions (28 April 2022) also require ICT system logs to be maintained *within Indian jurisdiction* for 180 days, clock sync to NIC or NPL NTP (or traceable sources), and a designated point of contact. None is listed, and the suggested platforms and regions may hold logs and backups outside India.
- The DPDP Rules were notified in November 2025 (most obligations commence in a phased way). As I read them, Rule 6 expects logs to be kept for one year for detection and investigation, which conflicts with SEC-64's "180 days, then deleted". Breach intimation to the Board is "without delay", with a detailed report within 72 h. Counsel must confirm both points.
- SEC-89 says audit actor IDs are "pseudonymous", but the handles are first names (`amit`, `priya`).

**Required change:**
- Add SEC items for log and backup location (India region or justified), NTP source, and CERT-In PoC registration.
- Set log retention to max(180 d CERT-In, 1 y DPDP Rule 6, if confirmed), with the location stated.
- Put the DPDP 72 h detailed report in the runbook.
- Make audit actors the `actor_id` ULID (SA-D-01), with the handle-to-person mapping held in `admin_actors` and erasable.
- Mark every legal reading "confirm with counsel".

### SA-D-20 · Medium: the security checklist is incomplete and some items cannot be verified
**Location:** `05` throughout.

**Issue:**
- Numbering jumps from SEC-42 to SEC-50 (43–49 missing, with no "reserved" note).
- Items not covered: admin identity and key issuance (SA-D-01); proposal immutability and approval binding (SA-D-03/04); admin UI (SA-D-05); external-data confidence cap (SA-D-06); reference-data change control (SA-D-07); unverified-rate serving gate (SA-D-08); feed lineage (SA-D-12); connection separation (SA-D-13); cost model (SA-D-14); retroactive changes (SA-D-11); backup encryption-key management; CERT-In localisation and NTP (SA-D-19).
- Some verifications are not pass/fail. SEC-39's grep only catches template literals on the same line as `prepare(`, so SQL built in a variable passes. SEC-56's "grep returns only reads via the rate service" has no clear criterion. SEC-50 tests "same owner", which is undefined.
- SEC-55's "unless explicitly flagged and approved" is an undefined bypass of the slab allow-list.
- SEC-14, 42, 60, 63 and 76 are "review" items that could easily be tests.

**Required change:**
- Add SEC-43…49 (and further numbers) for the uncovered areas above, each with a test.
- Replace SEC-39 and SEC-56 greps with the T-X01 architecture test plus a lint rule (no non-literal argument to `prepare`/`exec`).
- Define SEC-50 on `actor_id`.
- Remove the SEC-55 bypass, or define it as a separate proposal flag needing two checkers.
- Turn SEC-14, 42, 60, 63 and 76 into tests: migration schema snapshot, write via read connection, response scan for env secret values, logger config snapshot, and server option assertions.

### SA-D-21 · Low: cross-document inconsistencies with security impact
**Location:** various.

**Issue:**
- `q` max length is 100 in SEC-27 and 200 in `openapi.yaml`.
- `unit_price` is ≥ 0 in SEC-28 and `exclusiveMinimum: 0` in OpenAPI. `TaxLineInput.unit_price` has **no maximum** (SEC-28 says ≤ 1e9), which risks paise overflow past `MAX_SAFE_INTEGER`.
- The ETag hash is 8 hex in OpenAPI and architecture and 16 in the TRD. Cache-Control is `max-age=300` in OpenAPI and 3600 in the TRD.
- `ui-and-dx` §1 rule 2 says "echo the offending value" and SEC-75 says not to.
- `00` still says "SHA-256 hashes" while ruling 10 says HMAC.
- SEC-65 says "Fastify 5 + plugins" while the TRD says no plugins.
- Idempotency is a global `UNIQUE` in the DDL but `(key_id, idempotency_key)` in `07` §8, and there is no store for approve.
- The `/readyz` 503 example detail names the library ("SQLite build lacks FTS5"), against SEC-73.

**Required change:** Align on the stricter value in each case: `q` ≤ 100, `unit_price` max 1e9 everywhere, one ETag length, the SEC-75 rule (echo only validated or derived values, never free text), and HMAC wording in `00`. Add an `idempotency_records(key_id, route, idem_key, request_hash, response, expires_at)` table keyed per key. Keep `/readyz` failure detail generic in production.

### SA-D-22 · Low: rule prefixes can have odd lengths or not exist
**Location:** `data-model.md` `rate_rules.hsn_prefix` (`length BETWEEN 2 AND 8`), `RateRuleInput.hsn_prefix` `^\d{2,8}$`.

**Issue:** A 3-, 5- or 7-digit prefix (`711`) silently applies to every code beneath it under longest-prefix matching. A prefix that does not exist in `hsn_codes` (typo `7131` for `7113`) is accepted. Either one is a wrong-rate risk that relies only on the checker noticing.

**Required change:** Restrict to lengths 2, 4, 6 and 8, and require the prefix to exist in `hsn_codes` (zod plus trigger). Show the impacted-code count in the diff, as the UI already sketches.

### SA-D-23 · Low: robustness details in hashing, FTS and key management
**Location:** `05` SEC-40, SEC-12; `data-model.md` audit hash comment.

**Issue:**
- A query that sanitises to zero tokens (e.g. `q="***"`) must not reach `MATCH ''`, which is an FTS5 syntax error and a 500.
- `canonical_json` does not pin down number formatting or Unicode handling, so verification can produce false positives or negatives.
- There is no pepper rotation path: rotating `HSN_KEY_PEPPER` invalidates every key at once.

**Required change:**
- Return an empty result when there are no tokens.
- Use RFC 8785 (JCS) for canonical JSON.
- Add `api_keys.pepper_id` and support N active peppers during rotation.

### SA-D-24 · Low: supply-chain gaps
**Location:** `05` SEC-65–69, `02-TRD` §16.

**Issue:**
- The base image is not pinned by digest or scanned.
- CI actions are not pinned to commit SHAs.
- Nothing says CI jobs that run dev dependencies (vitest, tsx, typescript) must not hold production secrets.
- There is no SBOM.
- `node:sqlite` is still marked experimental in Node 22, so its behaviour and security fixes need tracking.

**Required change:** Add items for:
- the `node:22-slim@sha256:…` digest, with an image scan in CI;
- pinned action SHAs;
- no production secrets in CI test jobs;
- an SBOM (`npm sbom`) per release;
- a note to re-test SQLite pragmas and FTS behaviour on each Node update (SEC-69).

### SA-D-25 · Low: exposure of operational endpoints
**Location:** `02-TRD` §8/§14 (`HSN_METRICS_PORT`, `HSN_HOST 0.0.0.0`), `07` §11 ("internal port or behind admin scope"), `/readyz` unauthenticated.

**Issue:** If the metrics port binds the same `0.0.0.0` as the API, Prometheus output (routes, error rates, `dataset_version_info`, outbound host labels) is public. `/readyz` failure details are public too.

**Required change:** Bind metrics to loopback or an internal interface only (separate `HSN_METRICS_HOST`, default `127.0.0.1`). `/readyz` returns only `{status}` publicly.

### SA-D-26 · Low: LLM prompt payload is inconsistent about untrusted category text
**Location:** `architecture.md` §5.6 (input includes "product category"), `06` AI-22 (only "normalised product text and candidate codes + official descriptions").

**Issue:** The OFF category is untrusted (06 A.2) and would be a second injection channel that AI-22's payload snapshot test does not expect. The residual impact is low, because output is restricted to a permutation, confidence can only drop and the result is capped at medium if the top changes. The contract should still be single and explicit.

**Required change:** Decide on one payload. If the category is included, put it in its own delimited JSON field under the AI-10/11 limits and add it to the AI-16 corpus and the AI-22 snapshot.

---

## Items reviewed and found adequate at design level
The code audit will still verify each of these.
- Key format, storage and lookup: 256-bit secret, HMAC with an env pepper, prefix lookup, `timingSafeEqual`, identical 401s, no query-string keys (SEC-11–13, SEC-02).
- Default-deny, non-hierarchical scopes via declarative `config.scope` (SEC-05).
- Strict request schemas with `additionalProperties: false`, proto-poisoning rejection and explicit response schemas (SEC-03, SEC-25, SEC-31).
- FTS5 query builder (quote every token, strip operators, bind as a parameter) and prepared statements only (SEC-39/40). See SA-D-23 for the empty-token edge case.
- SSRF architecture: single module, exact allow-list, connect-time IP check via custom `lookup`, no redirects, timeouts, size cap, concurrency cap and circuit breaker, digit-only URL building (SEC-32–38). Gaps are in SA-D-16.
- LLM re-ranker: off by default, opt-in per request and per key, permutation-only output validated by zod, confidence can only go down, top capped at medium when the LLM changes it, never sees rates, 5 s timeout with deterministic fallback, injection corpus (AI-01–16, 30–32). Prompt injection cannot change a rate or raise confidence. At worst it reorders candidates that are already `needs_review`.
- Approval transaction is atomic (`BEGIN IMMEDIATE`, status re-checked in the transaction, rollback on failure, T-A03), so two concurrent approvals of one proposal cannot both succeed.
- Error model: RFC 9457, generic 5xx, no SQL or stack traces (SEC-41, SEC-73).
- Money as integer paise and BigInt, rate never taken from input (TRD §6).
- Kill switches (SEC-83), backup and restore drill (SEC-80/81), incident runbook scope (SEC-82).
