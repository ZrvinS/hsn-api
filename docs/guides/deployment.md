# Running and deploying the HSN Rate API

This guide is for the API owner: the person who runs the server, loads the data, issues keys to client apps and keeps the rates trustworthy. It covers running locally, running in production with Docker on any server or VM, and a worked example on Render.

Developers who only call the API should read [integration-guide.md](integration-guide.md) instead.

**How this was checked (2026-10-14).** The local quick start, the Docker image (build, first production load with two admins, key issue and revoke, a rate verification through the admin API, audit export and verify, backup, restart, and the restore-detection drill) and the Render build and start commands were all run for real. Render itself was not deployed to: the Render-specific settings in [section 5](#5-worked-example-render) come from Render's documented behaviour and are marked where they need confirming on the first deploy.

## Contents

1. [What you are running](#1-what-you-are-running)
2. [Run it locally](#2-run-it-locally)
3. [Production configuration](#3-production-configuration)
4. [Deploy with Docker (any server or VM)](#4-deploy-with-docker-any-server-or-vm)
5. [Worked example: Render](#5-worked-example-render)
6. [Issue and revoke client keys](#6-issue-and-revoke-client-keys)
7. [Verify rates (the most important ongoing job)](#7-verify-rates)
8. [Day-to-day operations](#8-day-to-day-operations)
9. [Upgrading](#9-upgrading)
10. [Troubleshooting](#10-troubleshooting)

## 1. What you are running

One Node.js 22 process (Fastify, with SQLite built into Node as `node:sqlite`). It has no other runtime services: no separate database server, no queue, no cache server.

| Part | Default | What it is |
|---|---|---|
| Public listener | `0.0.0.0:3000` (`HSN_HOST`, `HSN_PORT`) | The `/v1` API for client apps, `/healthz` and `/readyz`. Put it behind HTTPS. |
| Admin listener | `127.0.0.1:3001` (`HSN_ADMIN_HOST`, `HSN_ADMIN_PORT`) | `/v1/admin/*` (rate proposals, approvals, watched notifications, audit) and `/metrics`. Keep it private. The public port answers `404` for admin paths. |
| Database | `HSN_DB_PATH` | One SQLite file (plus its `-wal` and `-shm` files). Must be on persistent storage. |
| Restore-detection sidecar | `HSN_STATE_HWM_FILE` | A small file that lets the server notice when the database was rolled back to an older backup. Must be persistent, and in a **different directory** from the database. |
| Operator scripts | `npm run <script>` in `server/` | Seeding, admin bootstrap, key management, the production data load, audit export and verify, restore acknowledgement. They work on the database file directly, so they run on the same machine (or container) as the server. |

Because SQLite is a single file, **run exactly one instance**. Do not scale horizontally or put the database on a network file system.

**Two-person rule.** Every change to published data (a new rate, a correction, a verification, the first data load) needs one admin to propose it and a *different* admin to approve it. So you need **two admin people** from day one. The server refuses to drop below two active admins.

## 2. Run it locally

You need Node.js 22 (`server/.nvmrc`), `openssl`, `curl` and `jq`. From `server/`:

```sh
npm ci
cp .env.example .env && for v in HSN_KEY_PEPPER HSN_AUDIT_KEY HSN_LOG_KEY; do echo "$v=$(openssl rand -hex 32)" >> .env; done
set -a; . ./.env; set +a
npm run seed
(umask 077; npm run -s bootstrap-admins -- --admin amit:"Amit K" --admin priya:"Priya S" > admin-keys.txt)
export HSN_KEY=$(npm run -s create-key -- --tenant demo --scopes read,classify --label local)
npm run dev
```

In another shell:

```sh
curl -s localhost:3000/readyz                                   # {"status":"ready"}
curl -s localhost:3000/v1/hsn/7113 -H "Authorization: Bearer $HSN_KEY" | jq .rate.applicable_rule.igst_rate_percent   # 3
```

What each step does is explained in [server/README.md](../../server/README.md#quick-start-local-about-5-minutes). In short: `.env` holds three generated secrets; the server and scripts read only environment variables, which is why you load `.env` with `set -a`; `npm run seed` creates `./hsn.db` and loads `server/data/seed` (development only); `bootstrap-admins` creates the two admins and prints their keys once; `create-key` prints a client key once.

Useful while developing:

| Command | What it does |
|---|---|
| `npm test` | The test suite (Vitest). |
| `npm run typecheck` | TypeScript check. |
| `npm run build && npm start` | Production build in `dist/`, then run it. |
| `npm run eval` | Classifier accuracy against the labelled eval set. |

Stop the dev server with Ctrl-C (or `pkill -f "tsx watch src/main.ts"` if it was started in the background).

## 3. Production configuration

All settings are environment variables. Every one is listed with its default in [server/.env.example](../../server/.env.example) and validated at start-up; a bad value stops the process with a clear message, for example:

```
Invalid configuration:
  HSN_STATE_HWM_FILE: required in production: a path on a different volume / backup set than HSN_DB_PATH (SA-C3-04)
  HSN_TRUST_PROXY: set it to the platform proxy addresses/CIDRs, or set HSN_DIRECT_EXPOSURE=true if clients connect directly (SA-C-01)
```

**Required in production:**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HSN_DB_PATH` | Database file on persistent storage, e.g. `/var/lib/hsn/hsn.db`. |
| `HSN_STATE_HWM_FILE` | Sidecar file in a different directory, e.g. `/var/lib/hsn-state/hwm.json`. |
| `HSN_KEY_PEPPER` | Secret, at least 32 characters (`openssl rand -hex 32`). Hashes API keys. |
| `HSN_AUDIT_KEY` | Secret, at least 32 characters, different from the pepper. Signs the audit chain. |
| `HSN_LOG_KEY` | Secret, at least 32 characters. Fingerprints product names in logs. |
| `HSN_TRUST_PROXY` **or** `HSN_DIRECT_EXPOSURE=true` | Behind a reverse proxy or load balancer, set `HSN_TRUST_PROXY` to the proxy's address or CIDR so the real client IP is used for rate limiting. Only if clients connect straight to the process, set `HSN_DIRECT_EXPOSURE=true`. |

**Treat the three secrets carefully.**
- Generate each one separately and keep them in a secret store (your platform's secret settings, a password manager), never in git.
- **Never change `HSN_KEY_PEPPER` casually**: every issued key stops working. To rotate it, use `HSN_KEY_PEPPERS` (see `.env.example`).
- **Never lose `HSN_AUDIT_KEY`**: without it the audit chain cannot be verified. Keep a copy outside the server's backups.

**Often useful:**

| Variable | Default | Notes |
|---|---|---|
| `HSN_RATE_LIMIT_PER_MIN` | `600` | Default tokens per minute per key (a key can override it). |
| `HSN_DAILY_QUOTA_DEFAULT` | `50000` | Default tokens per key per IST day. |
| `HSN_CORS_ORIGINS` | empty | Browser origins allowed by CORS. Leave empty: clients should call from their backends. |
| `HSN_WATCHER_ENABLED` | `false` | `true` runs the CBIC notification watcher inside the server every `HSN_WATCHER_INTERVAL_MIN` (360) minutes. Use this **or** the cron script, never both. |
| `HSN_ADMIN_HOST` / `HSN_ADMIN_IP_ALLOWLIST` | `127.0.0.1` / empty | A non-loopback admin host requires an allowlist in production. |
| `HSN_ADMIN_WRITES_ENABLED` | `true` | Incident switch: `false` stops every admin write. |
| `HSN_LOG_LEVEL` | `info` | Logs are JSON lines on stdout. |

Barcode lookups (`HSN_ADAPTERS_ENABLED`, Open Food Facts) and the LLM re-ranker (`HSN_LLM_*`) are off by default. Leave them off until you have a reason; both send data to third parties, and the LLM needs an explicit `HSN_LLM_DATA_DISCLOSURE_ACK=true`.

## 4. Deploy with Docker (any server or VM)

This works on any Linux VM (AWS Lightsail or EC2, DigitalOcean, Hetzner, Azure, GCP), or any host that runs containers with persistent volumes (Fly.io, Railway and similar).

### 4.1 Build the image

[server/Dockerfile](../../server/Dockerfile) builds a Node 22 image that runs `node dist/main.js` as the unprivileged `node` user. It includes the operator scripts and `data/seed`, and creates the parent directories of `HSN_DB_PATH` and `HSN_STATE_HWM_FILE` at start-up. It defaults to `NODE_ENV=production`, port 3000, the database at `/var/lib/hsn/hsn.db` and the sidecar at `/var/lib/hsn-state/hwm.json`.

```sh
cd server
docker build -t hsn-api .
```

### 4.2 Create the secrets file

On the server, create an env file readable only by you:

```sh
umask 077
cat > /etc/hsn-api.env <<EOF
HSN_KEY_PEPPER=$(openssl rand -hex 32)
HSN_AUDIT_KEY=$(openssl rand -hex 32)
HSN_LOG_KEY=$(openssl rand -hex 32)
HSN_TRUST_PROXY=172.17.0.1
EOF
```

Copy `HSN_AUDIT_KEY` into your password manager now. `HSN_TRUST_PROXY=172.17.0.1` is right when a reverse proxy on the same host connects through Docker's default bridge (checked: the logs then show the real client address from `X-Forwarded-For`). If clients connect directly to the container with no proxy, use `HSN_DIRECT_EXPOSURE=true` instead.

### 4.3 Start the container

Use two named volumes, one for the database and one for the sidecar:

```sh
docker volume create hsn-data
docker volume create hsn-state

docker run -d --name hsn --restart unless-stopped \
  --env-file /etc/hsn-api.env \
  -p 127.0.0.1:3000:3000 \
  -v hsn-data:/var/lib/hsn \
  -v hsn-state:/var/lib/hsn-state \
  hsn-api
```

The port is published on `127.0.0.1` only, so the reverse proxy is the only way in. Check it:

```sh
curl -s localhost:3000/healthz    # {"status":"ok"}       the process is up
curl -s localhost:3000/readyz     # 503 not-ready          expected: no data loaded yet
```

If you bind-mount host directories instead of named volumes, make them writable by the container user (uid 1000): `sudo chown 1000:1000 /srv/hsn/data /srv/hsn/state`.

### 4.4 Load the data (two admins)

`npm run seed` is refused in production. The first load goes through the two-person rule, with each admin using their own key. Run these on the server:

```sh
# 1. Create the two admins. Their keys are printed once: hand each key to its owner privately.
(umask 077; docker exec hsn npx tsx scripts/bootstrap-admins.ts \
  --admin amit:"Amit K" --admin priya:"Priya S" > admin-keys.txt)

# 2. Admin A proposes the import of data/seed.
docker exec -e HSN_ADMIN_KEY="<A's admin key>" hsn \
  npx tsx scripts/import-dataset.ts propose --dir data/seed --rationale "Initial load, data/seed @ <git commit>"
```

The propose step validates the files and prints the counts and a line like:

```
A different admin approves with: import-dataset approve --proposal rp_01M4XJF6ASW2QXFJ6J3Y6SP1C0 --expected-sha256 cbc3c7ac…d7ac06 --dir <same directory>
```

```sh
# 3. Admin B reviews the same commit, then approves.
docker exec -e HSN_ADMIN_KEY="<B's admin key>" hsn \
  npx tsx scripts/import-dataset.ts approve --proposal rp_… --expected-sha256 <hash from step 2> --dir data/seed
```

The approval prints `"integrity": "ok"` and publishes the first dataset version. `/readyz` now returns `{"status":"ready"}` (no restart needed). If admin A tries to approve their own proposal it is refused: `it must be approved by a different actor.`

Then delete `admin-keys.txt` once both people have their keys. Never put an admin key on a command line that ends up in shell history; `docker exec -e HSN_ADMIN_KEY` with the key pasted from a password manager, or `read -s`, keeps it out of the process list.

### 4.5 HTTPS with a reverse proxy

Any reverse proxy works. With [Caddy](https://caddyserver.com), which gets a TLS certificate automatically, the whole config is:

```
hsn-api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

With nginx, proxy to `http://127.0.0.1:3000` and set `X-Forwarded-For $proxy_add_x_forwarded_for`. Point your domain's DNS at the server, and open only ports 80 and 443 in the firewall. (The proxy configs above are standard; they were not run as part of this check.)

### 4.6 Reaching the admin API

The admin listener is on `127.0.0.1:3001` *inside* the container. Two ways to use it:

- **From inside the container** (simplest, nothing exposed):
  ```sh
  docker exec hsn node -e "fetch('http://127.0.0.1:3001/v1/admin/watcher/status',{headers:{authorization:'Bearer '+process.env.K}}).then(r=>r.text()).then(console.log)"
  ```
  (pass the key with `docker exec -e K=…`).
- **From the host, over SSH**: add `-e HSN_ADMIN_HOST=0.0.0.0 -e HSN_ADMIN_IP_ALLOWLIST=172.17.0.1 -p 127.0.0.1:3001:3001` to `docker run`. Then `curl localhost:3001/…` works on the server, and from your laptop through `ssh -L 3001:127.0.0.1:3001 you@server`. Checked: `/v1/admin/watcher/status` and `/metrics` answer on the host this way.

Never publish port 3001 on a public interface.

### 4.7 Without Docker

To run directly on a VM: install Node 22, check out the repo, and in `server/` run `npm ci --include=dev && npm run build`. Create the two data directories (the server does not create them), put the environment in a file loaded by your service manager (for systemd, `EnvironmentFile=/etc/hsn-api.env`), and run `node dist/main.js` from `server/` as a dedicated user with `Restart=always`. Run the scripts from `server/` with the same environment loaded (`set -a; . /etc/hsn-api.env; set +a; npm run …`). Everything else in this guide is the same, with `docker exec hsn npx tsx scripts/X.ts` becoming `npm run X --`.

## 5. Worked example: Render

[Render](https://render.com) can run this as a **Web Service with a persistent disk**. Nothing is deployed yet; these are the steps to follow.

**Limits to know first (Render's documented behaviour):**
- A persistent disk needs a **paid instance type** (Starter or above). The free tier has no disk, and without one the database is wiped on every deploy.
- A service with a disk runs **one instance** and has **no zero-downtime deploys**: each deploy stops the old instance before starting the new one, so expect a short outage per deploy.
- A service gets **one disk**. The database and the sidecar therefore share it, in different directories. This passes the server's checks, but a Render disk snapshot restores both together, which weakens restore detection. That makes the off-host audit head export ([section 8.2](#82-audit-anchoring-daily)) more important on Render.
- Only the disk's mount path survives a deploy. Everything else on the instance is reset.

### 5.1 Create the service

In the Render dashboard: **New → Web Service**, connect the GitHub repo `ZrvinS/hsn-api`, and set:

| Setting | Value |
|---|---|
| Language / runtime | Node |
| Region | Singapore (closest to India) |
| Branch | `main` |
| Root directory | `server` |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `mkdir -p /var/data/db /var/data/state && node dist/main.js` |
| Instance type | Starter or above |
| Health check path | `/healthz` |

Notes:
- `--include=dev` matters. Because `NODE_ENV=production` is set, a plain `npm ci` skips the TypeScript compiler and the build fails; the scripts also need `tsx`. (Checked by running the same commands locally with `NODE_ENV=production`.)
- The start command creates the two data directories because the server does not create them.
- Use `/healthz` for Render's health check. `/readyz` returns 503 until the data is loaded and after a detected restore, which would make Render mark the first deploy as failed. Point an external uptime monitor at `/readyz` instead ([section 8.5](#85-monitoring)).
- Render reads the Node version from `"engines": {"node": "22.x"}` in `server/package.json`.

(Render can also build the [Dockerfile](../../server/Dockerfile). The native Node runtime is used here because Render mounts the disk with its own permissions, and the image runs as a non-root user; the native runtime avoids that question.)

### 5.2 Add the disk

**Advanced → Add Disk**: name `hsn-data`, mount path `/var/data`, size 1 GB (the database is under 1 MB today; grow it later if needed).

### 5.3 Environment variables

Under **Environment**, add:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HSN_PORT` | `10000` (Render's default port; it must match the port the service listens on) |
| `HSN_DB_PATH` | `/var/data/db/hsn.db` |
| `HSN_STATE_HWM_FILE` | `/var/data/state/hwm.json` |
| `HSN_KEY_PEPPER` | output of `openssl rand -hex 32` |
| `HSN_AUDIT_KEY` | another `openssl rand -hex 32` (also save it in your password manager) |
| `HSN_LOG_KEY` | another `openssl rand -hex 32` |
| `HSN_TRUST_PROXY` | `10.0.0.0/8` (see below) |
| `HSN_WATCHER_ENABLED` | `true` (Render cron jobs cannot reach another service's disk, so run the watcher in-process) |

**About `HSN_TRUST_PROXY`.** Render's load balancer reaches your service from a private address and passes the client IP in `X-Forwarded-For`. `10.0.0.0/8` is the usual private range; this is an inference, not something checked on Render. Confirm it after the first deploy: in the logs, request lines carry an `ip` field (shortened to a /24). If it shows your own public IP prefix when you call the API, trust is working. If every request shows the same `10.x.x.0/24`, the proxy is in a different range: set `HSN_TRUST_PROXY` to that range.

### 5.4 First deploy and data load

1. Click **Create Web Service**. The build runs and the service starts. `https://<your-service>.onrender.com/healthz` returns `{"status":"ok"}`; `/readyz` returns 503 because no data is loaded yet.
2. Open **Shell** on the service (paid instances have it; it runs on the instance, with the disk and environment). If the prompt is not in the `server` folder, `cd` into it. Then run the same first load as [section 4.4](#44-load-the-data-two-admins), without `docker exec`:

   ```sh
   (umask 077; npx tsx scripts/bootstrap-admins.ts --admin amit:"Amit K" --admin priya:"Priya S" > /var/data/admin-keys.txt)
   cat /var/data/admin-keys.txt    # copy each key to its owner, then: rm /var/data/admin-keys.txt

   HSN_ADMIN_KEY='<A key>' npx tsx scripts/import-dataset.ts propose --dir data/seed --rationale "Initial load @ <commit>"
   HSN_ADMIN_KEY='<B key>' npx tsx scripts/import-dataset.ts approve --proposal rp_… --expected-sha256 <hash> --dir data/seed
   ```

   Ideally admin B runs the approve from their own Render login.
3. `/readyz` now returns `{"status":"ready"}`.
4. Create the first client key ([section 6](#6-issue-and-revoke-client-keys)) and test a lookup against `https://<your-service>.onrender.com`.
5. Optionally add a custom domain under **Settings → Custom Domains**; Render issues the certificate.

The admin API is reachable only from the Render Shell, with `curl localhost:3001/…`. That is the intended setup: it is never exposed to the internet.

### 5.5 Deploys after that

Each push to `main` redeploys (turn off auto-deploy if you prefer to deploy by hand). The disk keeps the database and sidecar, so the service comes back ready. After a deploy that upgrades the server, export a fresh audit head ([section 9](#9-upgrading)).

## 6. Issue and revoke client keys

Every client app gets its own key, created on the server (inside the container, or in the Render Shell):

```sh
npx tsx scripts/create-key.ts --tenant sunarone --scopes read,classify --label "sunarone live" --expires 2027-12-31T00:00:00Z
```

```
created key_01M4XJVY965TPHXD6Y7PDYSBC6 (hsk_A70BX1OK); the key below is shown once and is not stored:
hsk_A70BX1OK_…
```

| Option | Meaning |
|---|---|
| `--tenant` | Lower-case name of the client (letters, digits, `-`, `_`). |
| `--scopes` | `read` (lookup, search, tax, feed, meta) and/or `classify`. |
| `--label` | Free text to tell keys apart, e.g. "test" or "live". |
| `--expires` | Optional expiry timestamp (UTC). |
| `--rate-limit` | Tokens per minute for this key (default `HSN_RATE_LIMIT_PER_MIN`). |
| `--daily-quota` | Tokens per IST day for this key. |
| `--llm-opt-out` | Never send this tenant's product names to an LLM, even if one is configured. |

Send the key to the client over a private channel. Only its prefix (`hsk_A70BX1OK`) appears in logs, so you can tell keys apart without seeing them.

**Revoke** a key by its id; it stops working immediately (checked: the next call returns 401):

```sh
npx tsx scripts/create-key.ts --revoke key_01M4XJVY965TPHXD6Y7PDYSBC6 --by amit
# revoked key_01M4XJVY965TPHXD6Y7PDYSBC6
```

Give clients a separate test key and live key, and rotate keys by issuing a new one, letting the client switch, then revoking the old one. A third admin key is granted through an `admin_grant` proposal approved by two admins, not with `create-key` alone (see `docs/design/openapi.yaml`, `/v1/admin/rate-proposals`).

## 7. Verify rates

Today **all 70 rate rules are `unverified`**, so client apps can only compute tax by sending `accept_unverified: true`. Verifying rules is what turns this from a useful draft into something businesses can rely on. Start with the chapters your first clients actually sell in.

For each rule:

1. **Admin A** opens the cited notification PDF (`source.url` from `GET /v1/hsn/{code}`), finds the schedule entry, checks the rate and conditions, and computes the PDF's SHA-256 (`sha256sum file.pdf`).
2. Admin A proposes the verification on the admin listener:

   ```sh
   curl -s localhost:3001/v1/admin/rate-proposals \
     -H "Authorization: Bearer $ADMIN_A_KEY" \
     -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
     -H 'Content-Type: application/json' \
     -d '{
       "action": "verify",
       "supersedes_rule_id": "rr_E1ZB3AQE2ESK0YWX5EJKQ6SZ4P",
       "source": { "pdf_sha256": "<sha256 of the PDF>", "schedule_serial": "Schedule IV, S.No. <n>" },
       "rationale": "Checked 7113 at 3% against 9/2025-CT(Rate) Schedule IV S.No. <n>."
     }'
   ```

   The response has `"status": "pending"`, an `id` (`rp_…`) and a `content_sha256`. Rules whose `source.url` is a CBIC listing page rather than the PDF also need `"url"` (the PDF's address) inside `source`, or the proposal is refused with `400 source-url-not-document`.
3. **Admin B** independently opens the same PDF, checks the same entry, and approves:

   ```sh
   curl -s localhost:3001/v1/admin/rate-proposals/rp_…/approve \
     -H "Authorization: Bearer $ADMIN_B_KEY" \
     -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
     -H 'Content-Type: application/json' \
     -d '{"verified_against_source": true, "expected_sha256": "<content_sha256 from step 2>"}'
   ```

Checked end to end: the approval returned `"status": "approved"`; the rule then showed `verification_status: "verified"`, `citation_note: null` and a `last_verified_at`; the `rate_unverified` warning disappeared; a `rule_verified` change appeared in the feed; and tax on that rule computed **without** `accept_unverified`. If admin A tries to approve, the API answers `403 maker-checker-violation`.

The same propose-then-approve flow handles new rates (`create`), rate changes from a new notification (`supersede`), mistakes (`correct`), end-dating (`end_date`), and reference data such as synonyms or new codes (`refdata_change`). Every field and rule is in `docs/design/openapi.yaml` under `/v1/admin/rate-proposals`, and the walkthrough with live responses is in [../03-app-flow.md](../03-app-flow.md).

## 8. Day-to-day operations

### 8.1 Watch for new CBIC notifications

The watcher checks the CBIC rate-notification pages and queues new notifications for an admin to triage. It never changes a rate itself. Run it **either** in-process (`HSN_WATCHER_ENABLED=true`, used on Render) **or** from cron on a VM, never both:

```
17 */6 * * *  docker exec hsn npx tsx scripts/watch-cbic.ts >> /var/log/hsn-watch-cbic.log 2>&1
```

Exit codes: 0 ok; 1 config error; 2 run failed; 3 ok but a freshness alert is raised (no successful run in 36 hours, or a notification untriaged for more than 2 business days). Check `GET /v1/admin/watcher/status` and triage queued items with `/v1/admin/watched-notifications`. The watcher has not yet been run against the live CBIC pages; its parser stops safely if a page changes shape.

The promise to clients is a **2-business-day freshness SLA**: a new rate notification should be reflected within two business days.

### 8.2 Audit anchoring (daily)

Every admin action is recorded in an HMAC-signed audit chain. Export its head daily and after each publish, and keep the file **somewhere the API server cannot write** (your laptop, a separate storage bucket):

```sh
docker exec hsn npx tsx scripts/export-audit-head.ts --out /tmp/head.json && docker cp hsn:/tmp/head.json head-$(date +%F).json
```

To check that nothing was altered since an export:

```sh
docker exec hsn npx tsx scripts/verify-audit.ts --head /tmp/head.json    # exit 0 = ok, 3 = problems: investigate
```

(On Render, run the same scripts in the Shell and copy the JSON output off the instance.) The same cross-check runs at every boot; a failure makes `/readyz` return 503.

### 8.3 Backups

Back up the database nightly with SQLite's `VACUUM INTO`, which makes a consistent copy while the server runs (the image has no `sqlite3` binary, so use Node):

```sh
docker exec hsn node -e "new (require('node:sqlite').DatabaseSync)('/var/lib/hsn/hsn.db').exec(\"VACUUM INTO '/var/lib/hsn/backup-$(date +%F).db'\")"
docker cp hsn:/var/lib/hsn/backup-$(date +%F).db ./ && docker exec hsn rm /var/lib/hsn/backup-$(date +%F).db
```

Copy the backup off the server. **Do not back up the sidecar (`hwm.json`) or `HSN_AUDIT_KEY` together with the database**: restoring the database and the sidecar from the same backup defeats restore detection. On Render, also turn on (or rely on) Render's disk snapshots, and keep your own `VACUUM INTO` copies off Render.

### 8.4 After a restore

When the database is older than the sidecar says, or the sidecar is missing, the server assumes a restore: it logs a `dataset.restore_detected` or `dataset.hwm_missing` alert, rotates the change-feed epoch so clients resync, and **fails `/readyz` with 503**. Checked: starting the container with the data volume but without the state volume gave exactly this.

To bring it back:
1. Confirm the restore was intended.
2. `npx tsx scripts/ack-restore.ts --by <you> --note "restored <date> backup after <reason>"` (the note needs at least 10 characters).
3. Restart the server.
4. Run `verify-audit --head` against the last exported head.

### 8.5 Monitoring

| Check | Where | Alert when |
|---|---|---|
| Liveness | `GET /healthz` | not 200 |
| Readiness | `GET /readyz` | 503 (no data, restore detected, or audit cross-check failed) |
| Data freshness | `GET /v1/meta/dataset` (`untriaged_notifications`, `pending_notifications`) or the watcher exit code 3 | anything pending past 2 business days |
| Metrics | `GET /metrics` on the admin listener (Prometheus format) | error rates, latency |
| Logs | stdout, JSON lines | `"alert":true` in any line |

Logs never contain API keys (only their prefixes), and product names appear only as HMAC fingerprints.

### 8.6 Incidents

- **A client key leaked:** revoke it ([section 6](#6-issue-and-revoke-client-keys)) and issue a new one.
- **An admin key leaked:** `npx tsx scripts/disable-actor.ts --handle <h> --by <you> --note "<incident>"` stops all that admin's keys and withdraws their pending proposals. It is refused if fewer than two active admins would remain: grant a third admin first, or revoke just the leaked key with `create-key --revoke`.
- **Stop all admin writes:** set `HSN_ADMIN_WRITES_ENABLED=false` and restart.
- **Stop outbound product lookups:** `HSN_ADAPTERS_ENABLED=false` (already the default).

More detail on each is in [server/README.md, Production notes](../../server/README.md#production-notes).

## 9. Upgrading

1. Back up the database ([section 8.3](#83-backups)) and export the audit head ([section 8.2](#82-audit-anchoring-daily)).
2. Deploy the new version: on Docker, `git pull`, `docker build -t hsn-api .`, `docker rm -f hsn`, then the same `docker run` as in [section 4.3](#43-start-the-container); on Render, push to `main`. Database migrations run automatically at start-up.
3. Check `/readyz` returns `{"status":"ready"}`.
4. Export a fresh audit head after this first boot and copy it off the server. (The first boot of an upgraded server writes a `dataset.hwm_initialised` audit entry; an export taken after it is what later restores are checked against.)

Stopping the container sends SIGTERM; the server finishes in-flight requests and closes the database cleanly (checked).

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid configuration:` and the process exits | A required variable is missing or wrong. | The message names each variable; see [section 3](#3-production-configuration). |
| `fatal: Error: unable to open database file` | The database's directory does not exist or is not writable. | Create it (the Docker image and the Render start command do), or fix ownership (`chown 1000:1000` for the Docker image). |
| `fatal: Error: ENOENT … hwm.json.tmp-…` | The sidecar's directory does not exist. | Same as above, for `HSN_STATE_HWM_FILE`'s directory. |
| `listen EADDRINUSE … :3001` | Something else holds the admin port. | Set `HSN_ADMIN_PORT`. |
| `/healthz` 200 but `/readyz` 503 | No data loaded yet, a restore was detected, or the audit cross-check failed. | Check the logs for `alert` lines. Load the data ([section 4.4](#44-load-the-data-two-admins)) or acknowledge the restore ([section 8.4](#84-after-a-restore)). |
| Every client gets 429 at once | Rate limiting sees the proxy's IP for everyone. | Set `HSN_TRUST_PROXY` to the proxy's address or range. |
| Clients get 401 for every key after a config change | `HSN_KEY_PEPPER` changed. | Restore the old value, or rotate with `HSN_KEY_PEPPERS`. |
| `npm run build` fails with `tsc: not found` | `NODE_ENV=production` made `npm ci` skip dev dependencies. | Use `npm ci --include=dev`. |
| `import-dataset approve` says it must be approved by a different actor | The proposer's key was used to approve. | The second admin approves with their own key. |
| `POST /v1/classify` returns 503 `classifier-unavailable` | The classifier module failed to load. | Check the start-up logs for `classifier.unavailable`. |

Deeper reference: technical requirements and the deployment section are in [../02-TRD.md](../02-TRD.md), security requirements in [../05-security-checklist.md](../05-security-checklist.md), and the architecture in [../design/architecture.md](../design/architecture.md).
