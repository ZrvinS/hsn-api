# hsn-api server

An HTTP API for Indian GST work. It looks up HSN/SAC codes, resolves the GST rate in force on a date,
classifies a product name or barcode into candidate HSN codes, and calculates the tax on invoice lines.
It is built with Node.js 22, Fastify, `node:sqlite` and zod.

- The design documents are in `../../docs` (in the project files: `hsn-api/docs`).
- The API contract is `docs/design/openapi.yaml`.
- Read [Data status](#data-status-read-this-first) before you rely on any rate.
- Deploying it? See [docs/guides/deployment.md](../docs/guides/deployment.md) (Docker with the `Dockerfile` here, and Render). Integrating it into an app? See [docs/guides/integration-guide.md](../docs/guides/integration-guide.md).

## Quick start (local, about 5 minutes)

**Prerequisites:** Node.js 22 (`.nvmrc`; `node:sqlite` is built in), `openssl`, `curl` and `jq`.

Run these 10 commands from this directory, in one shell:

```sh
npm ci
cp .env.example .env && for v in HSN_KEY_PEPPER HSN_AUDIT_KEY HSN_LOG_KEY; do echo "$v=$(openssl rand -hex 32)" >> .env; done
set -a; . ./.env; set +a
npm run seed
(umask 077; npm run -s bootstrap-admins -- --admin amit:"Amit K" --admin priya:"Priya S" > admin-keys.txt)
export HSN_KEY=$(npm run -s create-key -- --tenant demo --scopes read,classify --label quickstart)
npm run dev > server.log 2>&1 & until curl -sf localhost:3000/readyz > /dev/null; do sleep 1; done
curl -s localhost:3000/v1/hsn/7113 -H "Authorization: Bearer $HSN_KEY" | jq '{code, description, rate: (.rate | {coverage, warnings, rule: (.applicable_rule | {igst_rate_percent, verification_status, citation_note})})}'
curl -s localhost:3000/v1/classify -H "Authorization: Bearer $HSN_KEY" -H 'Content-Type: application/json' -d '{"name":"22K gold ring","unit_price":68500}' | jq '{needs_review, top: (.candidates[0] | {hsn, confidence, confidence_band})}'
curl -s localhost:3000/v1/tax/calculate -H "Authorization: Bearer $HSN_KEY" -H 'Content-Type: application/json' -d '{"accept_unverified":true,"lines":[{"hsn":"7113","taxable_value":68500,"supply_type":"intra"}]}' | jq '{complete, line: (.lines[0] | {igst_rate_bp, tax, unverified_accepted}), totals}'
```

What each command does:

1. **`npm ci`** installs the exact locked dependencies. The runtime dependencies are only `fastify` and `zod`.
2. **`cp .env.example .env` …** creates `.env` and appends three generated secrets: the API-key pepper, the audit-chain key and the log key. The server and scripts read `process.env` only, so:
3. **`set -a; . ./.env; set +a`** loads `.env` into this shell.
4. **`npm run seed`** creates and migrates `./hsn.db` and loads `data/seed`. It is refused in production; see [First production load](#first-production-load).
5. **`bootstrap-admins`** creates the first two admin actors (maker–checker needs two). Their keys go to `admin-keys.txt`, readable only by you. In production, hand each key to its owner over a separate channel.
6. **`create-key`** prints a client key once, and the command stores it in `$HSN_KEY`.
7. **`npm run dev`** starts the public listener on `:3000` and the admin listener on `127.0.0.1:3001`, then waits for `/readyz`. If port 3000 or 3001 is taken, set `HSN_PORT` / `HSN_ADMIN_PORT` (e.g. `HSN_PORT=3927 HSN_ADMIN_PORT=3928 npm run dev`) and use that port in the `curl` lines.
8. **The first `curl`** looks up 7113 (articles of jewellery):

   ```json
   {"code":"7113","description":"Articles of jewellery and parts thereof, of precious metal or of metal clad with precious metal",
    "rate":{"coverage":"ok","warnings":["rate_unverified"],
            "rule":{"igst_rate_percent":3,"verification_status":"unverified",
                    "citation_note":"Transcribed from secondary sources; schedule S.No. and gazette text not yet checked against the CBIC PDF. 9/2025-Central Tax (Rate) dt 17-09-2025, w.e.f. 22-09-2025 …"}}}
   ```

9. **The second `curl`** classifies a product name. It gives `{"needs_review":false,"top":{"hsn":"7113","confidence":0.86,"confidence_band":"high"}}`.
10. **The third `curl`** calculates tax on one intra-state line. It gives CGST 1027.5 and SGST 1027.5, with `unverified_accepted: true` and `complete: true`.

**Stop the server** with `kill %1`. `npm run dev` runs `tsx watch`, so if `kill %1` leaves a process behind, stop it with `pkill -f "tsx watch src/main.ts"`.

**Other commands:**
- Production build: `npm run build && npm start`.
- Tests: `npm test`. The docs traceability test reads the TRD at `HSN_TRD_PATH` (default `../docs/02-TRD.md`, the docs folder in this repo) and fails if it is missing; set `HSN_TRD_PATH=skip` in a checkout without the docs.
- Type check: `npm run typecheck`.
- Classifier eval: `npm run eval`.

## Using the API

- **Authentication:** every `/v1/*` call needs `Authorization: Bearer <key>`.
- **Scopes:** `read` covers lookup, search, tax, the change feed and meta. `classify` covers `POST /v1/classify`.
- **Errors:** RFC 9457 `application/problem+json`, with a `type` from the registry in `docs/design/ui-and-dx.md` §1.
- **Walkthroughs:** `docs/03-app-flow.md` walks through every client flow with real responses captured from this server.

| Call | What it does |
|---|---|
| `GET /v1/hsn/{code}[?date=&unit_price=]` | Description, ancestors, and the rate rule(s) in force on the date (default: today, IST). |
| `GET /v1/hsn/search?q=` | Full-text search over HSN descriptions. |
| `POST /v1/classify` | `{name?, barcode?}` → up to 5 ranked candidates, with confidence, band, reasons and the rate. |
| `POST /v1/tax/calculate` | Invoice lines → CGST/SGST/UTGST/IGST/cess per line plus totals, in rupees and in paise. |
| `GET /v1/rates/changes?since=` | Change feed. Poll it every 15 minutes and invalidate cached codes. |
| `GET /v1/meta/dataset` | Dataset version, content hash, coverage counts, freshness and pending notifications. |
| `GET /healthz`, `GET /readyz` | Liveness and readiness. The body carries only a status. |

The admin API (`/v1/admin/*`: rate proposals, approvals, watched notifications, audit) and `GET /metrics` are served only on the admin listener (`HSN_ADMIN_HOST:HSN_ADMIN_PORT`, loopback by default). Every admin write needs an `Idempotency-Key` header holding a UUID. A proposal needs one admin to make it and a *different* admin to approve it.

## Configuration

Every variable is listed, with its default, in **`.env.example`**, and is validated at start-up by `src/config.ts`. A bad value stops the process with a message. Generate each secret with `openssl rand -hex 32`, use a different value for each, and keep them in your secret store.

These are required in production:

| Variable | Notes |
|---|---|
| `NODE_ENV` | Set it to `production`. |
| `HSN_DB_PATH` | The SQLite database path. |
| `HSN_KEY_PEPPER` or `HSN_KEY_PEPPERS` | Pepper for API-key hashes. Use `HSN_KEY_PEPPERS` to rotate. |
| `HSN_AUDIT_KEY` | Key for the audit HMAC chain. |
| `HSN_LOG_KEY` | Key for name fingerprints in the logs. |
| `HSN_TRUST_PROXY` | Required behind a proxy. Without a proxy, set `HSN_DIRECT_EXPOSURE=true` instead. |
| `HSN_STATE_HWM_FILE` | Restore-detection sidecar. **Required in production**, and its directory must not be the database's directory. Put it on a different volume and backup set, for example `/var/lib/hsn-state/hwm.json` next to `HSN_DB_PATH=/var/lib/hsn/hsn.db`. The development default is `<db>.hwm.json`. |

A non-loopback `HSN_ADMIN_HOST` also requires `HSN_ADMIN_IP_ALLOWLIST`.

Optional data settings:

| Variable | Notes |
|---|---|
| `HSN_SOURCE_INDEX_PAGES` | Extra listing/index pages (CSV of absolute URLs) that never count as a notification document (ruling 36). They add to the built-in CBIC rate pages and the watcher pages. |
| `HSN_KNOWN_GAPS_FILE` | The curated known-gaps list served by `GET /v1/meta/dataset` as `known_data_gaps`. The default is `data/seed/known_gaps.json`; if that default is absent the list is empty. A file you set explicitly must exist, be a regular file of at most 256 KiB and be valid, or the server refuses to start. In production the path must be absolute. |

## Production notes

### First production load
`npm run seed` is refused when `NODE_ENV=production`. Production data is loaded through maker–checker with `import-dataset`:

1. **Create the empty database and the first two admins.** Start the server once, or run any script, to create the empty database. Then run `npm run bootstrap-admins -- --admin <a>:"Name" --admin <b>:"Name"`.
2. **Maker (admin A) proposes the import:**

   ```sh
   HSN_ADMIN_KEY=<A's admin key> npm run import-dataset -- propose --dir data/seed --rationale "Initial load, data/seed @ <commit>"
   ```

   The script validates the files, records each file's sha256 and the row counts, and prints `proposal_id` and `content_sha256`.
3. **Checker (admin B, a different person) reviews the proposal against the same commit, then approves it:**

   ```sh
   HSN_ADMIN_KEY=<B's admin key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed
   ```

   The approval publishes the first dataset version, with every rule `unverified`, and writes the audit entries.
4. **Start or restart the server.** `/readyz` should return 200.

- **Exit codes:** 0 ok; 1 refused; 2 seed validation failed; 3 imported but the integrity check reported problems. Investigate an exit code 3 before serving.
- **Never pass an admin key on the command line.** `HSN_ADMIN_KEY` is read from the environment.
- **The API cannot approve a `dataset_import`.** An API approve returns 409, because only the host can re-hash the files.

### CBIC notification watcher (cron)
The watcher checks the CBIC rate-notification pages and queues new notifications for an admin to triage. It never changes a rate. Run it from cron, **or** in-process with `HSN_WATCHER_ENABLED=true`, never both:

```
17 */6 * * *  cd /srv/hsn-api/server && set -a && . /etc/hsn-api/env && set +a && npm run --silent watch-cbic >> /var/log/hsn-api/watch-cbic.log 2>&1
```

Exit codes: 0 ok; 1 config error; 2 run failed; 3 ok, but a freshness alert is raised (no successful run in 36 h, or a notification untriaged for more than 2 business days).

### Audit anchoring
- **Daily and after each publish:** run `npm run export-audit-head -- --out head-$(date +%F).json` and copy the file somewhere the API host cannot write.
- **Verify:** `npm run verify-audit -- --head head-<date>.json` checks the HMAC chain, that the log was not truncated since the export, and the dataset hashes. It also cross-checks current state against the audit log: every published version, rule, verification and citation note; each proposal's content hash, created versus approved content and decision; key creation, revocation, expiry and policy (tenant, LLM opt-out, rate limit, quota), actor disablement, and each watched notification's state and prefixes. Exit 0 = ok; 3 = problems found: page someone. The same cross-check runs at boot, and a failure makes `/readyz` return 503.

### Backups and restore
- **Back up nightly:** `VACUUM INTO` a backup file. Keep `HSN_STATE_HWM_FILE` and `HSN_AUDIT_KEY` *out* of the database's backup set. A backup that restores the database and the sidecar together defeats restore detection.
- **What happens at boot after a restore:** the server compares the database with the high-water mark. When the database is behind it, or the sidecar is missing for a database that had one (`dataset.hwm_missing`), the server:
  - rotates `feed_epoch`, so clients resync from `since=0`;
  - writes the `dataset.restore_detected` audit entry and alert log line;
  - fails `/readyz` with 503.
- **To bring it back into service:**
  1. Confirm the restore was intended.
  2. Run `npm run ack-restore -- --by <you> --note "restored <date> backup after <reason>"`.
  3. Restart.
  4. Run `verify-audit --head` against the last exported head.
- **After upgrading the server:** boot once, which writes `dataset.hwm_initialised` to the audit log, then export a fresh audit head off-host. A backup taken before that first boot, restored with the sidecar deleted, would initialise a new sidecar silently, so verify any older backup with `verify-audit --head` against an export before using it.
- **Manual rotation:** `rotate-feed-epoch` remains available for rotating the epoch by hand.

### Incident response
- **Disable a compromised admin:** run `npm run disable-actor -- --handle <h> --by <you> --note "<incident>"`. Two admins can do the same through the API with a `disable_actor` proposal. Either way, the actor's keys stop at once and their pending proposals are withdrawn.
- **Keep two active admins:** disabling is refused, by the API and by the script, if fewer than two active admins would remain. Grant a third admin first through an `admin_grant` proposal, or revoke only the leaked key with `npm run create-key -- --revoke <key_id> --by <you>`.
- **Stop admin writes:** `HSN_ADMIN_WRITES_ENABLED=false` stops all admin writes.
- **Stop outbound lookups:** `HSN_ADAPTERS_ENABLED=false` stops all outbound product lookups. It is already the default.

### Residual risk
Someone who holds both the database file **and** `HSN_AUDIT_KEY` can forge consistent history. Maker–checker and the audit chain protect against single admins acting through the API, and against database edits made without the key. They do not protect against the host owner. Keep the audit key off the database host's backups and anchor the head off-host daily.

## Data status (read this first)

This is a working engine on **unverified data**. Do not file a GST return from it until the rules your business uses are verified.

- **No rate is verified yet.** The shipped seed has 356 HSN/SAC codes and 70 active rate rules, and **every rule is `unverified`**.
  - The rates were transcribed from secondary sources (KPMG, ICAI, taxmann and others), because the official CBIC hosts could not be reached when the data was compiled.
  - Each rule carries a `citation_note` that says what has not been checked. Schedule serials and PDF hashes are null.
  - A rule becomes `verified` only when a second admin approves a `verify` proposal after reading the gazette PDF. That approval also clears the note.
  - Some seed rules cite a CBIC listing page (for example `central-tax-rate.html`) instead of the notification PDF. Their first `verify` must send `source.url`, the notification document, or it is refused with 400 `source-url-not-document` (ruling 36). Approval replaces the URL and notification in one step.
- **Tax refuses unverified rates by default.** `POST /v1/tax/calculate` computes an unverified rate only when the request sets `accept_unverified: true`. The line then says `unverified_accepted: true` and the acceptance is logged.
  - **Lookups and classify always show the `rate_unverified` warning.**
  - Production launch rule: every rule in the chapters a live tenant uses is verified first.
- **Some codes have no rule of their own.**
  - The master is a curated subset, not the full tariff of about 23k rows. A code that is not in it but has a known parent is answered under that parent, with `code_in_master: false`, `resolved_via` and the warning `code_not_in_master`.
  - Many headings have no rate rule at all (`coverage: no_rate_rule`). Those never default to zero. `GET /v1/meta/dataset` counts them in `coverage.codes_without_rules` and lists the curated gaps (disputed, not researched, not transcribed, and so on) in `known_data_gaps`.
- **The 3004 nil-rate list is not transcribed.** 3004 is returned as ambiguous: a 5% general rule, plus a 0% rule for the 33 life-saving drugs of 10/2025-CT(Rate). The caller must choose with `condition: "general"` or a `rule_id`.
- **The classifier is rules-based, with no ML and no LLM by default.**
  - It is `high` only when a curated phrase is the whole product name, apart from quantities with a known unit and pack or form words. Brand names from a barcode lookup never count. It never sets a rate.
  - The classifier version is `rules-fts-2.3`. A name that describes an accessory of an article ("mobile phone stand") is capped at low for that article's heading.
  - Its eval set (`test/eval/classify-eval.jsonl`, 495 items) has labels that are **LLM drafts pending human review**, so its gates are provisional. The last run gave high-band precision 1.00 on only 16 high answers (Wilson 95% lower bound 0.806; the eval flags this as an insufficient sample below 50) and top-3 recall 0.942 on headings that are in the master; across all positives top-3 recall is 0.858. Top-3 is gated on in-master headings only, a provisional scope that awaits Amit's sign-off (`docs/00-coordinator-decisions.md`, "Eval gate scope decision (AG-12 sign-off)").
  - Anything not `high` has `needs_review: true`, and a person should confirm the code.
- **Barcode lookups are off.** Open Food Facts and Open Beauty Facts are disabled by default. Their data is crowd-edited and caps confidence at medium.
- **The CBIC watcher has not been run against the live CBIC pages.** The parser fails closed when a page changes shape.

| Field | Where | Meaning |
|---|---|---|
| `verification_status` | every rule | `unverified` until a second admin checks the PDF. |
| `citation_note` | every rule | What has not been checked yet. It is null once the rule is verified. |
| `warnings` | `rate` | `rate_unverified`, `code_not_in_master`, `pending_change_detected`, `verification_overdue`, `selected_by_hint`, `no_rate_rule`, `ambiguous`. |
| `coverage` | `rate` | `ok`, `ambiguous` (a person must choose) or `no_rate_rule`. |
| `needs_review`, `confidence_band` | classify | Whether a person must confirm the code. |
| `needs_input` | tax line | What would resolve an unresolved line; any one entry is enough. 3004 without a choice gives `["rule_id", "condition"]`. |
| `complete`, `partial_totals` | tax | `complete: false` means some line needs input. `totals` is then null, and `partial_totals` sums only the computed lines. |
| `warnings` | tax line and response | `code_not_in_master` when a line's code was answered under its nearest known parent; the line is still computed. |
