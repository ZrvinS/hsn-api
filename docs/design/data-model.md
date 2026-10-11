# HSN Rate API — Data model (SQLite, `node:sqlite`)

Binding inputs: `docs/00-coordinator-decisions.md`, `00b-coordinator-rulings.md`, `00c-coordinator-rulings-round2.md` (including Part C, rulings 26–34). Companion files: `openapi.yaml`, `architecture.md`.

**Source of truth (00c ruling 34).** The DDL in §2 mirrors the code exactly. It is generated from `server/src/db/schema.sql` (the base, schema version 2) and the steps in `server/src/db/migrations.ts` (versions 3 to 8), in that order. Do not edit §2 by hand: change the code, then regenerate it with `reviews/round2-tools/gen-ddl.cjs`. `reviews/round2-tools/test-ddl.cjs` checks three things (§9):
- each block is byte-identical to the code;
- running the blocks yields the same `sqlite_master` as the code;
- the triggers and constraints behave as described below.

## 1. Conventions

| Concern | Rule |
|---|---|
| Engine | SQLite via built-in `node:sqlite` (`DatabaseSync`), WAL, `foreign_keys=ON`, `trusted_schema=OFF`. Extension loading stays disabled. |
| Connections | Read-only for request handlers; a read-write connection for the cache writes (`products`, `api_keys.last_used_at`, `idempotency_keys`) and admin writes (proposals, approvals, scripts). Admin writes run in one `BEGIN IMMEDIATE` transaction each. |
| Schema versions | `schema_migrations(version, applied_at)`. An empty database runs `schema.sql` and then every migration step. An existing database runs only the steps it lacks. All of this happens in one transaction. The app refuses a schema newer than it knows. Current version: 8 (v5: bound guards and watcher confirmation, round 4; v6: `rate_rules.citation_note`, round 5; v7: the watcher confirmation guard extended to every row with a `notification_key` and to the first triage, round 6; v8: the first verify may replace an index-page citation, ruling 36, round 9). |
| Money | Integer **paise** (`*_paise`). The API takes INR as JSON numbers (or decimal strings where the route allows) and converts them from the decimal string, never with `x*100` float maths. Outputs carry rupee numbers plus integer paise (`tax_paise`, `totals_paise`). |
| Rates | Integer **basis points** (`*_bp`; 300 = 3%), checked 0–10000 in the DDL. Allowed slabs (`HSN_ALLOWED_RATES_BP`) are checked in code. CGST = SGST (or UTGST) = `roundHalfUp(taxable_paise × igst_rate_bp, 20000)`. |
| Dates | `effective_from` / `effective_to` are `TEXT 'YYYY-MM-DD'` IST civil dates, **both inclusive**; `effective_to IS NULL` = open-ended; `effective_from ≥ 2017-07-01`. |
| Timestamps | `TEXT` RFC 3339 UTC (`2026-10-03T09:15:02Z`). |
| IDs | Prefixed ULIDs: `rr_` rule, `rp_` proposal, `key_` API key, `act_` admin actor, `sb_` seed batch, `wn_` watched notification, `req_` request. Integer ids only for append-only logs (`change_feed.seq`, `audit_log.id`, `watcher_runs.id`, `hsn_code_history.id`) and reference-data rows. |
| HSN / SAC codes | Digits only, length **2, 4, 6 or 8**, or **5** in chapter `99` (SAC groups such as `99972`, ruling 6). `level = length(code)`, `chapter = substr(code,1,2)`, and every non-chapter code has a `parent`. Rule prefixes follow the same lengths and must exist in `hsn_codes`. |
| Notification citation | `notification_ref` canonical form `<n>/<yyyy>-<CT\|IT\|UTT\|Cess>(Rate)[, Schedule <roman>]`, e.g. `9/2025-CT(Rate), Schedule IV`, with **no zero padding** in `N/YYYY` and whitespace collapsed. **Enforced everywhere (core round 10):** after normalisation the value must match `^[1-9][0-9]{0,3}/(19\|20)[0-9]{2}-(CT\|IT\|UTT\|Cess)\(Rate\)(, Schedule (I\|II\|III\|IV\|V\|VI\|VII))?$`. `normaliseNotificationRef` strips zero padding, collapses whitespace and rewrites the long series names (`Central Tax (Rate)`, `Integrated Tax (Rate)`, `Union Territory Tax (Rate)`, `(Compensation) Cess (Rate)`, `CT (Rate)`) to the short form (`09/2025-Central Tax (Rate), Schedule I` → `9/2025-CT(Rate), Schedule I`). Entry points and failures: create/supersede/correct → 400 `validation-failed` at `/rule/source/notification` (code `pattern`); verify → 400 at `/source/notification`; the seed loader → `SeedError` naming `rate_rules[i].notification_ref`; `import-dataset propose`/`approve` (same `prepareSeed`) → exit 2. Content hashes change only for data loaded after round 9. The serial number inside the schedule is `schedule_serial`. The API field `source.notification` is `notification_ref`. `source_url` must be a notification document (path contains `/view-pdf/` or ends in `.pdf`, and is not a listing/index page) on every proposal that creates a rule (ruling 36); seed rules may still cite an index page until their first verify. A document URL (core round 10, SA-C5-03) has no query or fragment, no `;`, `..`, `//`, `%2e`, `%2f` or `%5c` in its path, and a path of `/view-pdf/<id>[/…]` or a `*.pdf` file; index pages are compared on origin plus lower-cased path with repeated slashes collapsed. Seed URLs are not re-checked. |
| Canonical JSON | RFC 8785 (JCS) for every hash or MAC input: proposal `content_sha256`, `target_sha256`, idempotency `request_sha256`, audit entries, the dataset `content_hash`. |
| Immutability | Enforced by triggers. Published rule content never changes. `effective_to`, `end_dated_in_version`, `superseded_by`, `verified_by`, `source_pdf_sha256` and `schedule_serial` are each set once from NULL. `last_verified_at` only moves forward, and verification only goes `unverified → verified`. A voided rule never changes again. `citation_note` is set only by the seed and can only be cleared, by a verify (migration 6). `source_url` and `notification_ref` never change, except in the one update that takes a rule from `unverified` to `verified` under an approved verify proposal whose `decided_at` equals the new `last_verified_at`; the new values must then equal that proposal's `payload.source.url` / `.notification`, or stay unchanged where the proposal left them out (migration 8, ruling 36). Proposal content is immutable and decisions are final. `dataset_versions` (after its hash is filled), `change_feed`, `audit_log`, `seed_batches`, `hsn_code_history` and `watcher_runs` are append-only. The dataset pointer only moves forward. Reference rows are deactivated, never deleted. HSN descriptions change in place, with the old text kept in `hsn_code_history`. |
| Provenance | Every rule references an approved proposal that names it (`proposal_id` = the proposal's `resulting_rule_id`, `created_in_version` = its `resulting_version`), or the seed batch of the empty-database publish (`seed_batch_id`). Reference rows and new HSN codes reference an approved `refdata_change` (`added_by_proposal`) unless written by the seed (ruling 19). |

**Residual risk (ruling 17, SEC-53; round 4 wording).** The triggers, including the migration 5 guards that bind every rule, version-pointer, code and reference-row change to the approved proposal that makes exactly that change, stop writes through the application and through a careless SQL client. Anyone with host or DB-file access can still drop them, forge rows or replace the file. Two controls detect what they cannot prevent:
- **State-to-audit cross-check** (`services/integrity.ts`, round 4 SA-C2-02, extended in round 6 SA-C3-01/02/07). At boot, in `verify-audit` and in `import-dataset`, every dataset version, proposal, rule change, API key and admin actor must have a matching HMAC'd audit entry. Since round 6 it also recomputes every proposal's `content_sha256` from its stored content, requires the stored rule and payload to equal those in the `rate_proposal.created` entry (and, for approvals, the published rule snapshot to equal it), compares revocations, key expiry, actor disablement and each proposal's status with the latest audited decision, and checks every seed rule's `citation_note` against the `citation_notes` map in `dataset.seeded` (a cleared note needs an audited verification; seeds from before round 6 are reported as `legacy`). Since round 7 (SA-C4-01/02) it also compares each key's `tenant`, `llm_opt_out`, `rate_limit_per_min` and `daily_quota` with its `api_key.created` entry (keys from before round 7 on `tenant` only), and each watched notification with its history: a `detected` entry, `affected_prefixes` equal as a set to the last detected/triaged entry, the resolve entry (with `requested_by`/`confirmed_by` on keyed rows) for a closed row, and no resolve entry for a row still `detected`. Since round 9 (ruling 36) a rule's `source_url` / `notification_ref` must equal the citation in its latest verify approval's audit snapshot (or its seed / creation snapshot when never verified). A database writer **without** `HSN_AUDIT_KEY` is detected: `/readyz` returns 503 (`audit_integrity`) and `verify-audit` exits 3.
- **Restore detection** (`services/restoreGuard.ts`, SA-C2-06, SA-C3-04). A sidecar high-water mark, MAC'd with `HSN_AUDIT_KEY` and kept on a different volume and backup set, detects a database that is behind it, and a sidecar that went missing (§4.5).

Someone who holds **both** the database and `HSN_AUDIT_KEY` can still forge matching audit entries and a matching sidecar. That is the documented residual risk. Mitigations: keep the audit key off the DB host's backups and volumes, and anchor the chain head off-host daily (`export-audit-head`, `verify-audit --head`, §8). Versions approved before migration 5 have no audited content hash; they are checked by name only (`legacy`, warn log `audit.legacy_state`) until the next publish.

## 2. DDL

Generated from the code (ruling 34). Blocks run in order: the base, then each migration.

### 2.1 Base schema (version 2): `server/src/db/schema.sql`

```sql
-- HSN Rate API schema: the version-2 BASE. src/db/migrations.ts applies later steps on top of it
-- (v3: watcher_runs, watched_notifications listing fields, hsn_codes.added_by_proposal + add_code guards).
-- Source of truth: docs/design/data-model.md §2,
-- amended by docs/00c-coordinator-rulings-round2.md. Additions vs data-model.md:
--   * rate_rules: verification_status, status/voided_* (ruling 1), source_pdf_sha256 + schedule_serial
--     (ruling 12), condition_code (ruling 5 classifier hint), seed_batch_id (ruling 19), retroactive_reason (25).
--   * rate_proposals: actions correct / admin_grant / refdata_change, content_sha256 (ruling 20),
--     actor ids (ruling 17), target_sha256 (approval fails when the target changed).
--   * admin_actors (17), seed_batches (19), idempotency_keys (8), watched_notifications (10),
--     hsn_code_history + refdata change control (23).
--   * change_feed: affected_prefix, related_rule_id, retroactive (rulings 1, 3, 25); dataset_state.feed_epoch (25).
-- Guards are triggers: they protect against application bugs and single-actor API misuse, NOT against
-- someone with direct write access to the database file (documented residual risk, ruling 17).
-- Foreign keys between proposals and rules are DEFERRABLE so an approval can record its results before
-- the rows they point to are written in the same transaction.

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- Dataset versions -------------------------------------------------------------
-- rowid order is publication order; dataset_state may only move forward along it.
CREATE TABLE dataset_versions (
  version        TEXT PRIMARY KEY CHECK (version GLOB '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-*'),
  parent_version TEXT REFERENCES dataset_versions(version),
  published_at   TEXT NOT NULL,
  published_by   TEXT NOT NULL,
  reason         TEXT NOT NULL,
  rule_count     INTEGER NOT NULL,
  content_hash   TEXT NOT NULL CHECK (length(content_hash) = 64),
  signature      TEXT
);
-- stats are filled exactly once (placeholder hash -> real hash); otherwise append-only
CREATE TRIGGER dataset_versions_guard_update BEFORE UPDATE ON dataset_versions
WHEN old.content_hash <> '0000000000000000000000000000000000000000000000000000000000000000'
  OR new.version IS NOT old.version OR new.parent_version IS NOT old.parent_version
  OR new.published_at IS NOT old.published_at OR new.published_by IS NOT old.published_by OR new.reason IS NOT old.reason
BEGIN SELECT RAISE(ABORT, 'dataset_versions: published versions are immutable'); END;
CREATE TRIGGER dataset_versions_no_delete BEFORE DELETE ON dataset_versions
BEGIN SELECT RAISE(ABORT, 'dataset_versions: delete not allowed'); END;

CREATE TABLE dataset_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  current_version TEXT NOT NULL REFERENCES dataset_versions(version),
  last_change_seq INTEGER NOT NULL,
  feed_epoch      TEXT NOT NULL CHECK (length(feed_epoch) BETWEEN 8 AND 64)
);
CREATE TRIGGER dataset_state_forward_only BEFORE UPDATE ON dataset_state
WHEN (SELECT rowid FROM dataset_versions WHERE version = new.current_version)
     < (SELECT rowid FROM dataset_versions WHERE version = old.current_version)
  OR new.last_change_seq < old.last_change_seq
BEGIN SELECT RAISE(ABORT, 'dataset_state: the current dataset pointer can only move forward'); END;
CREATE TRIGGER dataset_state_no_delete BEFORE DELETE ON dataset_state
BEGIN SELECT RAISE(ABORT, 'dataset_state: delete not allowed'); END;

-- One row per seed run; only possible while no dataset has been published (empty database).
CREATE TABLE seed_batches (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'sb_%'),
  dataset_version TEXT NOT NULL UNIQUE REFERENCES dataset_versions(version),
  created_at      TEXT NOT NULL,
  files_json      TEXT NOT NULL CHECK (json_valid(files_json))
);
CREATE TRIGGER seed_batches_empty_db_only BEFORE INSERT ON seed_batches
WHEN EXISTS (SELECT 1 FROM dataset_state)
BEGIN SELECT RAISE(ABORT, 'seed_batches: seeding is only allowed into an empty database'); END;
CREATE TRIGGER seed_batches_no_update BEFORE UPDATE ON seed_batches
BEGIN SELECT RAISE(ABORT, 'seed_batches is append-only'); END;
CREATE TRIGGER seed_batches_no_delete BEFORE DELETE ON seed_batches
BEGIN SELECT RAISE(ABORT, 'seed_batches is append-only'); END;

-- HSN / SAC master ---------------------------------------------------------------
-- Lengths 2, 4, 6, 8; 5 digits only for SAC groups (99xxx) (ruling 6).
CREATE TABLE hsn_codes (
  code         TEXT PRIMARY KEY
               CHECK (code GLOB '[0-9][0-9]*' AND NOT code GLOB '*[^0-9]*'
                      AND (length(code) IN (2,4,6,8) OR (length(code) = 5 AND substr(code,1,2) = '99'))),
  level        INTEGER NOT NULL CHECK (level IN (2,4,5,6,8)),
  parent       TEXT REFERENCES hsn_codes(code),
  chapter      TEXT NOT NULL CHECK (length(chapter) = 2),
  type         TEXT NOT NULL CHECK (type IN ('goods','service')),
  description  TEXT NOT NULL,
  keywords     TEXT NOT NULL DEFAULT '',
  added_in_version TEXT NOT NULL REFERENCES dataset_versions(version),
  changed_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (level = length(code)),
  CHECK (chapter = substr(code,1,2)),
  CHECK ((level = 2 AND parent IS NULL) OR (level > 2 AND parent IS NOT NULL))
);
CREATE INDEX hsn_codes_parent ON hsn_codes(parent);
CREATE INDEX hsn_codes_chapter ON hsn_codes(chapter);

CREATE VIRTUAL TABLE hsn_fts USING fts5(
  code UNINDEXED,
  description,
  keywords,
  content = 'hsn_codes',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER hsn_codes_ai AFTER INSERT ON hsn_codes BEGIN
  INSERT INTO hsn_fts(rowid, code, description, keywords)
  VALUES (new.rowid, new.code, new.description, new.keywords);
END;
CREATE TRIGGER hsn_codes_ad AFTER DELETE ON hsn_codes BEGIN
  INSERT INTO hsn_fts(hsn_fts, rowid, code, description, keywords)
  VALUES ('delete', old.rowid, old.code, old.description, old.keywords);
END;
CREATE TRIGGER hsn_codes_au AFTER UPDATE ON hsn_codes BEGIN
  INSERT INTO hsn_fts(hsn_fts, rowid, code, description, keywords)
  VALUES ('delete', old.rowid, old.code, old.description, old.keywords);
  INSERT INTO hsn_fts(rowid, code, description, keywords)
  VALUES (new.rowid, new.code, new.description, new.keywords);
END;
-- New codes come only from the seed (empty database). Descriptions/keywords change only through an
-- approved refdata_change proposal; the replaced text is kept in hsn_code_history (ruling 23).
CREATE TRIGGER hsn_codes_guard_insert BEFORE INSERT ON hsn_codes
WHEN EXISTS (SELECT 1 FROM dataset_state)
BEGIN SELECT RAISE(ABORT, 'hsn_codes: codes are added by the seed only'); END;
CREATE TRIGGER hsn_codes_guard_update BEFORE UPDATE ON hsn_codes
WHEN new.code IS NOT old.code OR new.level IS NOT old.level OR new.parent IS NOT old.parent
  OR new.chapter IS NOT old.chapter OR new.type IS NOT old.type OR new.added_in_version IS NOT old.added_in_version
  OR new.changed_by_proposal IS NULL OR new.changed_by_proposal IS old.changed_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.changed_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'hsn_codes: descriptions change only through an approved refdata_change proposal'); END;
CREATE TRIGGER hsn_codes_no_delete BEFORE DELETE ON hsn_codes
BEGIN SELECT RAISE(ABORT, 'hsn_codes: delete not allowed'); END;

CREATE TABLE hsn_code_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL REFERENCES hsn_codes(code),
  description TEXT NOT NULL,
  keywords    TEXT NOT NULL,
  replaced_by_proposal TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);
CREATE TRIGGER hsn_codes_history AFTER UPDATE ON hsn_codes BEGIN
  INSERT INTO hsn_code_history(code, description, keywords, replaced_by_proposal, replaced_at)
  VALUES (old.code, old.description, old.keywords, new.changed_by_proposal, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;
CREATE TRIGGER hsn_code_history_no_update BEFORE UPDATE ON hsn_code_history
BEGIN SELECT RAISE(ABORT, 'hsn_code_history is append-only'); END;
CREATE TRIGGER hsn_code_history_no_delete BEFORE DELETE ON hsn_code_history
BEGIN SELECT RAISE(ABORT, 'hsn_code_history is append-only'); END;

-- Admin actors (ruling 17) -----------------------------------------------------------
-- handle: NFKC + lower-case + trim, [a-z0-9_-]{3,32}, unique. Maker ≠ checker compares actor ids.
CREATE TABLE admin_actors (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'act_%'),
  handle       TEXT NOT NULL UNIQUE CHECK (length(handle) BETWEEN 3 AND 32 AND NOT handle GLOB '*[^a-z0-9_-]*'),
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  created_via  TEXT NOT NULL CHECK (created_via IN ('bootstrap','admin_grant')),
  grant_proposal_id TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  disabled_at  TEXT,
  CHECK ((created_via = 'admin_grant') = (grant_proposal_id IS NOT NULL))
);
-- Bootstrap creates at most the first two actors; afterwards only an approved admin_grant can add one.
CREATE TRIGGER admin_actors_guard_insert BEFORE INSERT ON admin_actors
WHEN (new.created_via = 'bootstrap' AND (SELECT COUNT(*) FROM admin_actors) >= 2)
  OR (new.created_via = 'admin_grant' AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.id = new.grant_proposal_id AND p.action = 'admin_grant'
          AND p.status = 'approved' AND json_extract(p.payload_json, '$.handle') = new.handle))
BEGIN SELECT RAISE(ABORT, 'admin_actors: new actors need bootstrap (first two) or an approved admin_grant'); END;
CREATE TRIGGER admin_actors_guard_update BEFORE UPDATE ON admin_actors
WHEN new.id IS NOT old.id OR new.handle IS NOT old.handle OR new.created_at IS NOT old.created_at
  OR new.created_via IS NOT old.created_via OR new.grant_proposal_id IS NOT old.grant_proposal_id
  OR (old.disabled_at IS NOT NULL AND new.disabled_at IS NOT old.disabled_at)
BEGIN SELECT RAISE(ABORT, 'admin_actors: only display_name and disabled_at (once) may change'); END;
CREATE TRIGGER admin_actors_no_delete BEFORE DELETE ON admin_actors
BEGIN SELECT RAISE(ABORT, 'admin_actors: delete not allowed; disable instead'); END;

-- API keys -------------------------------------------------------------------------
-- scopes are stored in one canonical spelling, so the admin CHECKs cannot be dodged by JSON
-- spelling (ruling 25, SA-D-10); admin is exclusive (SA-C-06) and needs an actor (ruling 17).
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'key_%'),
  prefix      TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL CHECK (length(key_hash) = 64),
  scopes      TEXT NOT NULL CHECK (scopes IN ('["read"]','["classify"]','["read","classify"]','["admin"]')),
  tenant      TEXT NOT NULL,
  actor_id    TEXT REFERENCES admin_actors(id),
  admin_grant_id TEXT UNIQUE REFERENCES rate_proposals(id),
  label       TEXT NOT NULL DEFAULT '',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 600 CHECK (rate_limit_per_min > 0),
  daily_quota INTEGER CHECK (daily_quota IS NULL OR daily_quota > 0),   -- NULL = HSN_DAILY_QUOTA_DEFAULT
  llm_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (llm_opt_out IN (0,1)),
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT,
  last_used_at TEXT,
  CHECK ((scopes = '["admin"]') = (actor_id IS NOT NULL)),
  CHECK (scopes = '["admin"]' OR admin_grant_id IS NULL),
  -- admin keys expire within 90 days (SA-D-09)
  CHECK (scopes <> '["admin"]' OR (expires_at IS NOT NULL AND julianday(expires_at) - julianday(created_at) <= 90.0001))
);
CREATE INDEX api_keys_actor ON api_keys(actor_id);
CREATE TRIGGER api_keys_guard_admin_insert BEFORE INSERT ON api_keys
WHEN new.scopes = '["admin"]' AND NOT (
  EXISTS (SELECT 1 FROM admin_actors a WHERE a.id = new.actor_id AND a.disabled_at IS NULL)
  AND (
    (new.admin_grant_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM rate_proposals p JOIN admin_actors a ON a.id = new.actor_id
        WHERE p.id = new.admin_grant_id AND p.action = 'admin_grant' AND p.status = 'approved'
          AND json_extract(p.payload_json, '$.handle') = a.handle))
    OR (new.admin_grant_id IS NULL
        AND EXISTS (SELECT 1 FROM admin_actors a WHERE a.id = new.actor_id AND a.created_via = 'bootstrap')
        AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.actor_id = new.actor_id))
  ))
BEGIN SELECT RAISE(ABORT, 'api_keys: admin keys need a bootstrap actor (first key) or an approved admin_grant'); END;
CREATE TRIGGER api_keys_guard_update BEFORE UPDATE ON api_keys
WHEN new.id IS NOT old.id OR new.prefix IS NOT old.prefix OR new.key_hash IS NOT old.key_hash
  OR new.scopes IS NOT old.scopes OR new.tenant IS NOT old.tenant OR new.actor_id IS NOT old.actor_id
  OR new.admin_grant_id IS NOT old.admin_grant_id OR new.created_at IS NOT old.created_at
  OR new.expires_at IS NOT old.expires_at OR new.rate_limit_per_min IS NOT old.rate_limit_per_min
  OR new.daily_quota IS NOT old.daily_quota OR new.llm_opt_out IS NOT old.llm_opt_out
  OR (old.revoked_at IS NOT NULL AND new.revoked_at IS NOT old.revoked_at)
BEGIN SELECT RAISE(ABORT, 'api_keys: only revoked_at (once), last_used_at and label may change'); END;
CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON api_keys
BEGIN SELECT RAISE(ABORT, 'api_keys: delete not allowed; revoke instead'); END;

-- Idempotency store for admin writes (ruling 8): 24 h TTL enforced on read + purge.
CREATE TABLE idempotency_keys (
  key_id         TEXT NOT NULL REFERENCES api_keys(id),
  idem_key       TEXT NOT NULL,
  route          TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  status_code    INTEGER NOT NULL,
  response_json  TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys(created_at);

-- Maker–checker proposals --------------------------------------------------------
CREATE TABLE rate_proposals (
  id                 TEXT PRIMARY KEY CHECK (id LIKE 'rp_%'),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','withdrawn')),
  action             TEXT NOT NULL CHECK (action IN
                     ('create','supersede','end_date','verify','correct','admin_grant','refdata_change')),
  supersedes_rule_id TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  end_date           TEXT,
  rule_json          TEXT CHECK (rule_json IS NULL OR json_valid(rule_json)),
  payload_json       TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  rationale          TEXT NOT NULL,
  retroactive_reason TEXT,
  content_sha256     TEXT NOT NULL CHECK (length(content_sha256) = 64),
  target_sha256      TEXT CHECK (target_sha256 IS NULL OR length(target_sha256) = 64),
  proposed_by        TEXT NOT NULL,
  proposed_by_actor_id TEXT NOT NULL REFERENCES admin_actors(id),
  proposed_key_id    TEXT NOT NULL REFERENCES api_keys(id),
  proposed_at        TEXT NOT NULL,
  decided_by         TEXT,
  decided_by_actor_id TEXT REFERENCES admin_actors(id),
  decided_key_id     TEXT REFERENCES api_keys(id),
  decided_at         TEXT,
  decision_comment   TEXT,
  resulting_rule_id  TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  resulting_version  TEXT REFERENCES dataset_versions(version) DEFERRABLE INITIALLY DEFERRED,
  CHECK (action IN ('create','admin_grant','refdata_change') OR supersedes_rule_id IS NOT NULL),
  CHECK (action NOT IN ('create','admin_grant','refdata_change') OR supersedes_rule_id IS NULL),
  CHECK ((action IN ('create','supersede','correct')) = (rule_json IS NOT NULL)),
  CHECK ((action IN ('verify','admin_grant','refdata_change')) = (payload_json IS NOT NULL)),
  CHECK ((action = 'end_date') = (end_date IS NOT NULL)),
  CHECK (decided_by_actor_id IS NULL OR decided_by_actor_id <> proposed_by_actor_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status = 'pending' OR decided_by_actor_id IS NOT NULL OR status = 'withdrawn')
);
CREATE INDEX rate_proposals_status ON rate_proposals(status, proposed_at);
-- Proposal content is immutable; a decision is written once (pending -> terminal) and terminal
-- proposals never change again (ruling 19).
CREATE TRIGGER rate_proposals_guard_update BEFORE UPDATE ON rate_proposals
WHEN old.status <> 'pending' OR new.status = 'pending'
  OR new.id IS NOT old.id OR new.action IS NOT old.action OR new.supersedes_rule_id IS NOT old.supersedes_rule_id
  OR new.end_date IS NOT old.end_date OR new.rule_json IS NOT old.rule_json OR new.payload_json IS NOT old.payload_json
  OR new.rationale IS NOT old.rationale OR new.retroactive_reason IS NOT old.retroactive_reason
  OR new.content_sha256 IS NOT old.content_sha256 OR new.target_sha256 IS NOT old.target_sha256
  OR new.proposed_by IS NOT old.proposed_by OR new.proposed_by_actor_id IS NOT old.proposed_by_actor_id
  OR new.proposed_key_id IS NOT old.proposed_key_id OR new.proposed_at IS NOT old.proposed_at
BEGIN SELECT RAISE(ABORT, 'rate_proposals: content is immutable and decisions are final'); END;
CREATE TRIGGER rate_proposals_no_delete BEFORE DELETE ON rate_proposals
BEGIN SELECT RAISE(ABORT, 'rate_proposals: delete not allowed'); END;

-- Rate rules (published, human-reviewed) ----------------------------------------
CREATE TABLE rate_rules (
  rule_id            TEXT PRIMARY KEY CHECK (rule_id LIKE 'rr_%'),
  hsn_prefix         TEXT NOT NULL CHECK (hsn_prefix GLOB '[0-9][0-9]*' AND NOT hsn_prefix GLOB '*[^0-9]*'
                     AND (length(hsn_prefix) IN (2,4,6,8) OR (length(hsn_prefix) = 5 AND substr(hsn_prefix,1,2) = '99'))),
  igst_rate_bp       INTEGER NOT NULL CHECK (igst_rate_bp BETWEEN 0 AND 10000),  -- odd bp allowed: 25 bp -> CGST = SGST = 12.5 bp (tax divides by 20000)
  cess_rate_bp       INTEGER NOT NULL DEFAULT 0 CHECK (cess_rate_bp BETWEEN 0 AND 30000),
  cess_specific_paise INTEGER CHECK (cess_specific_paise IS NULL OR cess_specific_paise > 0),
  cess_specific_unit TEXT,
  condition_kind     TEXT NOT NULL DEFAULT 'none' CHECK (condition_kind IN ('none','price','other')),
  condition_text     TEXT,
  condition_code     TEXT CHECK (condition_code IS NULL OR condition_code IN ('nil_rate_list')),
  min_unit_price_paise INTEGER CHECK (min_unit_price_paise IS NULL OR min_unit_price_paise >= 0),
  max_unit_price_paise INTEGER CHECK (max_unit_price_paise IS NULL OR max_unit_price_paise >= 0),
  effective_from     TEXT NOT NULL CHECK (effective_from >= '2017-07-01'),
  effective_to       TEXT CHECK (effective_to IS NULL OR effective_to >= effective_from),
  notification_ref   TEXT NOT NULL,
  source_url         TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  source_pdf_sha256  TEXT CHECK (source_pdf_sha256 IS NULL OR (length(source_pdf_sha256) = 64 AND NOT source_pdf_sha256 GLOB '*[^0-9a-f]*')),
  schedule_serial    TEXT,
  verified_by        TEXT,
  last_verified_at   TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('verified','unverified')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_at          TEXT,
  voided_in_version  TEXT REFERENCES dataset_versions(version),
  voided_by_rule     TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  retroactive_reason TEXT,
  created_in_version TEXT NOT NULL REFERENCES dataset_versions(version),
  end_dated_in_version TEXT REFERENCES dataset_versions(version),
  superseded_by      TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  proposal_id        TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  seed_batch_id      TEXT REFERENCES seed_batches(id),
  CHECK ((condition_kind = 'price') = (min_unit_price_paise IS NOT NULL OR max_unit_price_paise IS NOT NULL)),
  CHECK (condition_kind = 'none' OR condition_text IS NOT NULL),
  CHECK (condition_code IS NULL OR condition_kind = 'other'),
  CHECK (min_unit_price_paise IS NULL OR max_unit_price_paise IS NULL OR min_unit_price_paise <= max_unit_price_paise),
  CHECK ((cess_specific_paise IS NULL) = (cess_specific_unit IS NULL)),
  CHECK ((verification_status = 'verified') = (verified_by IS NOT NULL AND last_verified_at IS NOT NULL)),
  CHECK (verified_by IS NULL OR verified_by <> 'seed-unreviewed'),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL))
);
CREATE INDEX rate_rules_prefix_dates ON rate_rules(hsn_prefix, effective_from, effective_to);

-- Every rule comes from an approved proposal that names it, or from the seed batch of the first
-- (empty-database) publish; its prefix must exist in hsn_codes (ruling 19, SA-C-14).
CREATE TRIGGER rate_rules_guard_insert BEFORE INSERT ON rate_rules
WHEN NOT (
  (new.proposal_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
        AND p.resulting_rule_id = new.rule_id AND p.resulting_version = new.created_in_version))
  OR (new.seed_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dataset_state) AND EXISTS (
     SELECT 1 FROM seed_batches s WHERE s.id = new.seed_batch_id AND s.dataset_version = new.created_in_version)))
  OR new.status <> 'active' OR new.superseded_by IS NOT NULL OR new.end_dated_in_version IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.hsn_prefix)
BEGIN SELECT RAISE(ABORT, 'rate_rules: insert needs an approved proposal or the seed batch, and an existing hsn_prefix'); END;

-- Published rule content is immutable. verified_by, superseded_by, effective_to (and their version
-- markers, the source PDF hash and serial) may each be set once from NULL; last_verified_at only moves
-- forward; verification only goes unverified -> verified; a voided rule never changes again.
CREATE TRIGGER rate_rules_guard_update BEFORE UPDATE ON rate_rules
WHEN old.status = 'voided'
  OR new.rule_id IS NOT old.rule_id OR new.hsn_prefix IS NOT old.hsn_prefix
  OR new.igst_rate_bp IS NOT old.igst_rate_bp OR new.cess_rate_bp IS NOT old.cess_rate_bp
  OR new.cess_specific_paise IS NOT old.cess_specific_paise OR new.cess_specific_unit IS NOT old.cess_specific_unit
  OR new.condition_kind IS NOT old.condition_kind OR new.condition_text IS NOT old.condition_text
  OR new.condition_code IS NOT old.condition_code
  OR new.min_unit_price_paise IS NOT old.min_unit_price_paise OR new.max_unit_price_paise IS NOT old.max_unit_price_paise
  OR new.effective_from IS NOT old.effective_from OR new.notification_ref IS NOT old.notification_ref
  OR new.source_url IS NOT old.source_url OR new.created_in_version IS NOT old.created_in_version
  OR new.proposal_id IS NOT old.proposal_id OR new.seed_batch_id IS NOT old.seed_batch_id
  OR new.retroactive_reason IS NOT old.retroactive_reason
  OR (old.effective_to IS NOT NULL AND new.effective_to IS NOT old.effective_to)
  OR (old.end_dated_in_version IS NOT NULL AND new.end_dated_in_version IS NOT old.end_dated_in_version)
  OR (old.superseded_by IS NOT NULL AND new.superseded_by IS NOT old.superseded_by)
  OR (old.verified_by IS NOT NULL AND new.verified_by IS NOT old.verified_by)
  OR (old.source_pdf_sha256 IS NOT NULL AND new.source_pdf_sha256 IS NOT old.source_pdf_sha256)
  OR (old.schedule_serial IS NOT NULL AND new.schedule_serial IS NOT old.schedule_serial)
  OR (old.verification_status = 'verified' AND new.verification_status <> 'verified')
  OR (old.last_verified_at IS NOT NULL AND (new.last_verified_at IS NULL OR new.last_verified_at < old.last_verified_at))
BEGIN
  SELECT RAISE(ABORT, 'rate_rules: published rule fields are immutable; propose a superseding or correcting rule');
END;
-- superseded_by / voided_by_rule never cross prefixes (SA-C-02)
CREATE TRIGGER rate_rules_guard_link BEFORE UPDATE ON rate_rules
WHEN (new.superseded_by IS NOT NULL AND new.superseded_by IS NOT old.superseded_by
      AND (SELECT r.hsn_prefix FROM rate_rules r WHERE r.rule_id = new.superseded_by) IS NOT new.hsn_prefix)
  OR (new.voided_by_rule IS NOT NULL AND (SELECT r.hsn_prefix FROM rate_rules r WHERE r.rule_id = new.voided_by_rule) IS NOT new.hsn_prefix)
BEGIN SELECT RAISE(ABORT, 'rate_rules: a superseding or correcting rule must have the same hsn_prefix'); END;
CREATE TRIGGER rate_rules_no_delete BEFORE DELETE ON rate_rules
BEGIN SELECT RAISE(ABORT, 'rate_rules: delete not allowed; end-date or correct instead'); END;

-- Change feed ------------------------------------------------------------------------
-- Clients invalidate a cached code c when c starts with affected_prefix OR affected_prefix starts
-- with c (ruling 3).
CREATE TABLE change_feed (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_version TEXT NOT NULL REFERENCES dataset_versions(version),
  published_at   TEXT NOT NULL,
  change_type    TEXT NOT NULL CHECK (change_type IN
                  ('rule_added','rule_end_dated','rule_verified','rule_corrected','hsn_added','hsn_updated',
                   'synonym_changed','refdata_changed')),
  hsn_prefix     TEXT NOT NULL,
  affected_prefix TEXT NOT NULL,
  rule_id        TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  related_rule_id TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,
  effective_from TEXT,
  effective_to   TEXT,
  retroactive    INTEGER NOT NULL DEFAULT 0 CHECK (retroactive IN (0,1)),
  summary        TEXT NOT NULL
);
CREATE TRIGGER change_feed_no_update BEFORE UPDATE ON change_feed
BEGIN SELECT RAISE(ABORT, 'change_feed is append-only'); END;
CREATE TRIGGER change_feed_no_delete BEFORE DELETE ON change_feed
BEGIN SELECT RAISE(ABORT, 'change_feed is append-only'); END;

-- Audit log (append-only, HMAC-chained with HSN_AUDIT_KEY, ruling 18) ----------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  key_prefix  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  prev_hash   TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash        TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Pending-change signal (ruling 10) ----------------------------------------------------
CREATE TABLE watched_notifications (
  id                TEXT PRIMARY KEY CHECK (id LIKE 'wn_%'),
  notification_ref  TEXT NOT NULL,
  source_url        TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  affected_prefixes TEXT NOT NULL CHECK (json_valid(affected_prefixes) AND json_type(affected_prefixes) = 'array'),
  effective_from    TEXT,
  detected_at       TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'detected' CHECK (state IN ('detected','published','dismissed')),
  expedite          INTEGER NOT NULL DEFAULT 0 CHECK (expedite IN (0,1)),
  note              TEXT,
  created_by        TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,
  CHECK ((state = 'detected') = (resolved_at IS NULL))
);
CREATE INDEX watched_notifications_state ON watched_notifications(state);
CREATE TRIGGER watched_notifications_guard_update BEFORE UPDATE ON watched_notifications
WHEN old.state <> 'detected' OR new.id IS NOT old.id OR new.notification_ref IS NOT old.notification_ref
  OR new.source_url IS NOT old.source_url OR new.affected_prefixes IS NOT old.affected_prefixes
  OR new.detected_at IS NOT old.detected_at OR new.created_by IS NOT old.created_by
BEGIN SELECT RAISE(ABORT, 'watched_notifications: only detected -> published/dismissed'); END;
CREATE TRIGGER watched_notifications_no_delete BEFORE DELETE ON watched_notifications
BEGIN SELECT RAISE(ABORT, 'watched_notifications: delete not allowed'); END;

-- Barcode product cache (no PII) ------------------------------------------------------
CREATE TABLE products (
  gtin         TEXT PRIMARY KEY CHECK (length(gtin) = 14),
  name         TEXT,
  brand        TEXT,
  category     TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','open_food_facts','open_beauty_facts')),
  source_ref   TEXT,
  found        INTEGER NOT NULL CHECK (found IN (0,1)),
  fetched_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Classification reference data (ruling 23): rows are added by the seed (empty DB) or an approved
-- refdata_change proposal, deactivated (never deleted or edited in place).
CREATE TABLE category_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  category    TEXT NOT NULL,
  hsn_prefix  TEXT NOT NULL CHECK (hsn_prefix GLOB '[0-9][0-9]*' AND NOT hsn_prefix GLOB '*[^0-9]*'
              AND (length(hsn_prefix) IN (2,4,6,8) OR (length(hsn_prefix) = 5 AND substr(hsn_prefix,1,2) = '99'))),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  deactivated_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((active = 0) = (deactivated_by_proposal IS NOT NULL))
);
CREATE UNIQUE INDEX category_map_active ON category_map(source, category) WHERE active = 1;

CREATE TABLE synonyms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase      TEXT NOT NULL,
  hsn_code    TEXT NOT NULL REFERENCES hsn_codes(code),
  strength    TEXT NOT NULL DEFAULT 'primary' CHECK (strength IN ('primary','related')),
  note        TEXT,
  rule_hint   TEXT CHECK (rule_hint IS NULL OR rule_hint IN ('nil_rate_list')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  deactivated_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((active = 0) = (deactivated_by_proposal IS NOT NULL))
);
CREATE UNIQUE INDEX synonyms_active_pair ON synonyms(phrase, hsn_code) WHERE active = 1;
CREATE INDEX synonyms_phrase ON synonyms(phrase) WHERE active = 1;

CREATE TABLE chapter_keywords (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword  TEXT NOT NULL,
  chapter  TEXT NOT NULL CHECK (length(chapter) = 2),
  active   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  added_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  deactivated_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((active = 0) = (deactivated_by_proposal IS NOT NULL))
);
CREATE UNIQUE INDEX chapter_keywords_active ON chapter_keywords(keyword, chapter) WHERE active = 1;

-- Same guard on all three reference tables.
CREATE TRIGGER synonyms_guard_insert BEFORE INSERT ON synonyms
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'synonyms: rows are added by the seed or an approved refdata_change proposal'); END;
CREATE TRIGGER synonyms_guard_update BEFORE UPDATE ON synonyms
WHEN old.active = 0 OR new.active <> 0 OR new.id IS NOT old.id OR new.phrase IS NOT old.phrase
  OR new.hsn_code IS NOT old.hsn_code OR new.strength IS NOT old.strength OR new.note IS NOT old.note
  OR new.rule_hint IS NOT old.rule_hint OR new.created_by IS NOT old.created_by OR new.created_at IS NOT old.created_at
  OR new.added_by_proposal IS NOT old.added_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'synonyms: rows are only deactivated, by an approved refdata_change proposal'); END;
CREATE TRIGGER synonyms_no_delete BEFORE DELETE ON synonyms
BEGIN SELECT RAISE(ABORT, 'synonyms: delete not allowed; deactivate instead'); END;

CREATE TRIGGER category_map_guard_insert BEFORE INSERT ON category_map
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'category_map: rows are added by the seed or an approved refdata_change proposal'); END;
CREATE TRIGGER category_map_guard_update BEFORE UPDATE ON category_map
WHEN old.active = 0 OR new.active <> 0 OR new.id IS NOT old.id OR new.source IS NOT old.source
  OR new.category IS NOT old.category OR new.hsn_prefix IS NOT old.hsn_prefix
  OR new.added_by_proposal IS NOT old.added_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'category_map: rows are only deactivated, by an approved refdata_change proposal'); END;
CREATE TRIGGER category_map_no_delete BEFORE DELETE ON category_map
BEGIN SELECT RAISE(ABORT, 'category_map: delete not allowed; deactivate instead'); END;

CREATE TRIGGER chapter_keywords_guard_insert BEFORE INSERT ON chapter_keywords
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: rows are added by the seed or an approved refdata_change proposal'); END;
CREATE TRIGGER chapter_keywords_guard_update BEFORE UPDATE ON chapter_keywords
WHEN old.active = 0 OR new.active <> 0 OR new.id IS NOT old.id OR new.keyword IS NOT old.keyword
  OR new.chapter IS NOT old.chapter OR new.added_by_proposal IS NOT old.added_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: rows are only deactivated, by an approved refdata_change proposal'); END;
CREATE TRIGGER chapter_keywords_no_delete BEFORE DELETE ON chapter_keywords
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: delete not allowed; deactivate instead'); END;
```

### 2.2 Migration 3 (cbic watcher + add_code): `server/src/db/migrations.ts`

```sql
-- (1) CBIC notification watcher (round 2): watched_notifications gains the parsed listing fields and an
--     idempotency key; a watcher run log feeds the 36 h freshness alert (00b ruling 27).
ALTER TABLE watched_notifications ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','cbic_watcher'));
-- "<series>:<number>/<year>" e.g. "central_tax_rate:1/2026" (corrigenda: ":corrigendum:<date>")
ALTER TABLE watched_notifications ADD COLUMN notification_key TEXT CHECK (notification_key IS NULL OR length(notification_key) BETWEEN 5 AND 120);
ALTER TABLE watched_notifications ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) <= 500);
ALTER TABLE watched_notifications ADD COLUMN notification_date TEXT CHECK (notification_date IS NULL OR notification_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
CREATE UNIQUE INDEX watched_notifications_key ON watched_notifications(notification_key) WHERE notification_key IS NOT NULL;

-- affected_prefixes may now be set while the row is still 'detected' (admin triage of a watcher row);
-- everything else stays immutable and a resolved row is frozen.
DROP TRIGGER watched_notifications_guard_update;
CREATE TRIGGER watched_notifications_guard_update BEFORE UPDATE ON watched_notifications
WHEN old.state <> 'detected' OR new.id IS NOT old.id OR new.notification_ref IS NOT old.notification_ref
  OR new.source_url IS NOT old.source_url
  OR new.detected_at IS NOT old.detected_at OR new.created_by IS NOT old.created_by
  OR new.source IS NOT old.source OR new.notification_key IS NOT old.notification_key
  OR new.title IS NOT old.title OR new.notification_date IS NOT old.notification_date
BEGIN SELECT RAISE(ABORT, 'watched_notifications: only affected prefixes (while detected) and detected -> published/dismissed'); END;

CREATE TABLE watcher_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL CHECK (source IN ('cbic')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','failed')),
  items_seen    INTEGER NOT NULL CHECK (items_seen >= 0),
  items_new     INTEGER NOT NULL CHECK (items_new >= 0),
  error         TEXT CHECK (error IS NULL OR length(error) <= 2000),
  details_json  TEXT NOT NULL CHECK (json_valid(details_json)),
  CHECK ((status = 'ok') = (error IS NULL))
);
CREATE INDEX watcher_runs_status ON watcher_runs(source, status, finished_at);
CREATE TRIGGER watcher_runs_no_update BEFORE UPDATE ON watcher_runs
BEGIN SELECT RAISE(ABORT, 'watcher_runs is append-only'); END;
CREATE TRIGGER watcher_runs_no_delete BEFORE DELETE ON watcher_runs
BEGIN SELECT RAISE(ABORT, 'watcher_runs is append-only'); END;

-- (2) New HSN/SAC codes after the seed: refdata_change op add_code (maker-checker). The insert must be
--     named by an approved refdata_change proposal whose payload is exactly this code.
ALTER TABLE hsn_codes ADD COLUMN added_by_proposal TEXT REFERENCES rate_proposals(id) DEFERRABLE INITIALLY DEFERRED;
DROP TRIGGER hsn_codes_guard_insert;
CREATE TRIGGER hsn_codes_guard_insert BEFORE INSERT ON hsn_codes
WHEN EXISTS (SELECT 1 FROM dataset_state)
  AND (new.added_by_proposal IS NULL OR NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.id = new.added_by_proposal
           AND p.action = 'refdata_change' AND p.status = 'approved'
           AND json_extract(p.payload_json, '$.op') = 'add_code'
           AND json_extract(p.payload_json, '$.code') = new.code))
BEGIN SELECT RAISE(ABORT, 'hsn_codes: codes are added by the seed or an approved refdata_change add_code proposal'); END;
DROP TRIGGER hsn_codes_guard_update;
CREATE TRIGGER hsn_codes_guard_update BEFORE UPDATE ON hsn_codes
WHEN new.code IS NOT old.code OR new.level IS NOT old.level OR new.parent IS NOT old.parent
  OR new.chapter IS NOT old.chapter OR new.type IS NOT old.type OR new.added_in_version IS NOT old.added_in_version
  OR new.added_by_proposal IS NOT old.added_by_proposal
  OR new.changed_by_proposal IS NULL OR new.changed_by_proposal IS old.changed_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.changed_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved')
BEGIN SELECT RAISE(ABORT, 'hsn_codes: descriptions change only through an approved refdata_change proposal'); END;
```

### 2.3 Migration 4 (api key pepper_id + product cache index): `server/src/db/migrations.ts`

```sql
-- (1) Pepper rotation (ruling 29): each key records which pepper hashed it. Keys issued before this
--     step were hashed with HSN_KEY_PEPPER, whose id is "default". Set once at insert, never changed.
ALTER TABLE api_keys ADD COLUMN pepper_id TEXT NOT NULL DEFAULT 'default'
  CHECK (length(pepper_id) BETWEEN 1 AND 32 AND NOT pepper_id GLOB '*[^a-z0-9_-]*');
CREATE TRIGGER api_keys_pepper_id_immutable BEFORE UPDATE OF pepper_id ON api_keys
WHEN new.pepper_id IS NOT old.pepper_id
BEGIN SELECT RAISE(ABORT, 'api_keys: pepper_id is immutable (re-issue the key instead)'); END;

-- (2) Product cache bound (ruling 30): oldest-first eviction scans by fetched_at.
CREATE INDEX products_fetched_at ON products(fetched_at, gtin);
```

### 2.4 Migration 5 (bound guards, proposal insert guard, watcher confirmation): `server/src/db/migrations.ts`

```sql
-- Round 4 (SA-C2-02 .. SA-C2-05). Guards stop application bugs and single-actor misuse; detection of a
-- direct database writer is the state-to-audit cross-check (services/integrity.ts), because such a
-- writer can also drop triggers.

-- (1) Proposals are born pending and undecided, from the proposer's own active admin key; an extra key
--     for an existing actor (admin_grant, new_actor false) is requested by that actor (SA-C2-05).
CREATE TRIGGER rate_proposals_guard_insert BEFORE INSERT ON rate_proposals
WHEN new.status <> 'pending' OR new.decided_by IS NOT NULL OR new.decided_by_actor_id IS NOT NULL
  OR new.decided_key_id IS NOT NULL OR new.decided_at IS NOT NULL OR new.decision_comment IS NOT NULL
  OR new.resulting_rule_id IS NOT NULL OR new.resulting_version IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM api_keys k JOIN admin_actors a ON a.id = k.actor_id
                  WHERE k.id = new.proposed_key_id AND k.actor_id = new.proposed_by_actor_id
                    AND k.revoked_at IS NULL AND a.disabled_at IS NULL)
  OR (new.action = 'admin_grant' AND json_extract(new.payload_json, '$.op') IS NULL
      AND json_extract(new.payload_json, '$.new_actor') = 0
      AND (SELECT a.handle FROM admin_actors a WHERE a.id = new.proposed_by_actor_id) IS NOT json_extract(new.payload_json, '$.handle'))
BEGIN SELECT RAISE(ABORT, 'rate_proposals: a new proposal is pending and undecided, made with the proposer''s own active admin key; an extra admin key is requested by its holder'); END;

-- (2) An approval is made with the checker's own key; a disabled actor's proposals cannot be approved (SA-C2-04).
CREATE TRIGGER rate_proposals_guard_decide BEFORE UPDATE ON rate_proposals
WHEN new.status = 'approved' AND (
     NOT EXISTS (SELECT 1 FROM api_keys k JOIN admin_actors a ON a.id = k.actor_id
                  WHERE k.id = new.decided_key_id AND k.actor_id = new.decided_by_actor_id AND a.disabled_at IS NULL)
  OR EXISTS (SELECT 1 FROM admin_actors a WHERE a.id = old.proposed_by_actor_id AND a.disabled_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'rate_proposals: approvals need an active checker key, and a disabled actor''s proposals cannot be approved'); END;

-- (3) Void, end-date, supersede and verify are bound to the approved proposal that does exactly that (SA-C2-02).
CREATE TRIGGER rate_rules_guard_bind BEFORE UPDATE ON rate_rules
WHEN (new.status = 'voided' AND old.status <> 'voided' AND NOT EXISTS (
        SELECT 1 FROM rate_rules c JOIN rate_proposals p ON p.id = c.proposal_id
         WHERE c.rule_id = new.voided_by_rule AND p.status = 'approved' AND p.action = 'correct'
           AND p.supersedes_rule_id = old.rule_id AND p.resulting_rule_id = c.rule_id
           AND p.resulting_version = new.voided_in_version))
  OR (new.status IS old.status AND (new.voided_at IS NOT old.voided_at OR new.voided_in_version IS NOT old.voided_in_version
       OR new.voided_by_rule IS NOT old.voided_by_rule))
  OR ((new.effective_to IS NOT old.effective_to OR new.end_dated_in_version IS NOT old.end_dated_in_version) AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.supersedes_rule_id = old.rule_id
           AND p.resulting_version = new.end_dated_in_version
           AND ((p.action = 'end_date' AND p.end_date = new.effective_to AND new.superseded_by IS old.superseded_by)
             OR (p.action = 'supersede' AND new.superseded_by = p.resulting_rule_id
                 AND new.effective_to = date(json_extract(p.rule_json, '$.effective_from'), '-1 day')))))
  OR (new.superseded_by IS NOT old.superseded_by AND new.end_dated_in_version IS old.end_dated_in_version)
  OR ((new.verified_by IS NOT old.verified_by OR new.last_verified_at IS NOT old.last_verified_at
       OR new.verification_status IS NOT old.verification_status) AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'verify' AND p.supersedes_rule_id = old.rule_id
           AND p.decided_at = new.last_verified_at AND new.verified_by IS COALESCE(old.verified_by, p.decided_by)
           AND new.source_pdf_sha256 IS COALESCE(old.source_pdf_sha256, json_extract(p.payload_json, '$.source.pdf_sha256'))))
  OR ((new.source_pdf_sha256 IS NOT old.source_pdf_sha256 OR new.schedule_serial IS NOT old.schedule_serial)
       AND new.last_verified_at IS old.last_verified_at)
BEGIN SELECT RAISE(ABORT, 'rate_rules: void, end-date, supersede and verify need the approved proposal that does exactly that'); END;

-- (4) A new rule's content is the approved proposal's rule_json (prefix, rate, dates, source).
DROP TRIGGER rate_rules_guard_insert;
CREATE TRIGGER rate_rules_guard_insert BEFORE INSERT ON rate_rules
WHEN NOT (
  (new.proposal_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
        AND p.resulting_rule_id = new.rule_id AND p.resulting_version = new.created_in_version
        AND json_extract(p.rule_json, '$.hsn_prefix') = new.hsn_prefix
        AND json_extract(p.rule_json, '$.igst_rate_bp') = new.igst_rate_bp
        AND json_extract(p.rule_json, '$.cess_rate_bp') = new.cess_rate_bp
        AND json_extract(p.rule_json, '$.effective_from') = new.effective_from
        AND json_extract(p.rule_json, '$.effective_to') IS new.effective_to
        AND json_extract(p.rule_json, '$.notification_ref') = new.notification_ref
        AND json_extract(p.rule_json, '$.source_url') = new.source_url
        AND new.verified_by IS p.decided_by AND new.last_verified_at IS p.decided_at))
  OR (new.seed_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dataset_state) AND EXISTS (
     SELECT 1 FROM seed_batches s WHERE s.id = new.seed_batch_id AND s.dataset_version = new.created_in_version)))
  OR new.status <> 'active' OR new.superseded_by IS NOT NULL OR new.end_dated_in_version IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.hsn_prefix)
BEGIN SELECT RAISE(ABORT, 'rate_rules: insert needs an approved proposal (with this content) or the seed batch, and an existing hsn_prefix'); END;

-- (5) The current dataset pointer moves only to a version an approved proposal published.
CREATE TRIGGER dataset_state_guard_bind BEFORE UPDATE ON dataset_state
WHEN new.current_version IS NOT old.current_version AND NOT EXISTS (
       SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.resulting_version = new.current_version)
BEGIN SELECT RAISE(ABORT, 'dataset_state: a new current version needs the approved proposal that published it'); END;

-- (6) add_code binds the whole payload; a description update binds its code and text (SA-C2-02).
DROP TRIGGER hsn_codes_guard_insert;
CREATE TRIGGER hsn_codes_guard_insert BEFORE INSERT ON hsn_codes
WHEN EXISTS (SELECT 1 FROM dataset_state)
  AND (new.added_by_proposal IS NULL OR NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.id = new.added_by_proposal
           AND p.action = 'refdata_change' AND p.status = 'approved'
           AND json_extract(p.payload_json, '$.table') = 'hsn_code'
           AND json_extract(p.payload_json, '$.op') = 'add_code'
           AND json_extract(p.payload_json, '$.code') = new.code
           AND json_extract(p.payload_json, '$.parent') IS new.parent
           AND json_extract(p.payload_json, '$.type') = new.type
           AND json_extract(p.payload_json, '$.description') = new.description
           AND json_extract(p.payload_json, '$.keywords') = new.keywords
           AND p.resulting_version = new.added_in_version))
BEGIN SELECT RAISE(ABORT, 'hsn_codes: codes are added by the seed or an approved refdata_change add_code proposal with exactly this content'); END;
DROP TRIGGER hsn_codes_guard_update;
CREATE TRIGGER hsn_codes_guard_update BEFORE UPDATE ON hsn_codes
WHEN new.code IS NOT old.code OR new.level IS NOT old.level OR new.parent IS NOT old.parent
  OR new.chapter IS NOT old.chapter OR new.type IS NOT old.type OR new.added_in_version IS NOT old.added_in_version
  OR new.added_by_proposal IS NOT old.added_by_proposal
  OR new.changed_by_proposal IS NULL OR new.changed_by_proposal IS old.changed_by_proposal
  OR NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.changed_by_proposal
                 AND p.action = 'refdata_change' AND p.status = 'approved'
                 AND json_extract(p.payload_json, '$.table') = 'hsn_description'
                 AND json_extract(p.payload_json, '$.code') = new.code
                 AND json_extract(p.payload_json, '$.description') = new.description
                 AND json_extract(p.payload_json, '$.keywords') = new.keywords)
BEGIN SELECT RAISE(ABORT, 'hsn_codes: descriptions change only through the approved refdata_change proposal for this code and text'); END;

-- (7) Reference-data rows are bound to a proposal for that table and row.
DROP TRIGGER synonyms_guard_insert;
CREATE TRIGGER synonyms_guard_insert BEFORE INSERT ON synonyms
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved'
       AND json_extract(p.payload_json, '$.table') = 'synonym' AND json_extract(p.payload_json, '$.op') = 'add'
       AND json_extract(p.payload_json, '$.phrase') = new.phrase AND json_extract(p.payload_json, '$.hsn_code') = new.hsn_code)
BEGIN SELECT RAISE(ABORT, 'synonyms: rows are added by the seed or the approved refdata_change proposal for this row'); END;
DROP TRIGGER category_map_guard_insert;
CREATE TRIGGER category_map_guard_insert BEFORE INSERT ON category_map
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved'
       AND json_extract(p.payload_json, '$.table') = 'category_map' AND json_extract(p.payload_json, '$.op') = 'add'
       AND json_extract(p.payload_json, '$.category') = new.category AND json_extract(p.payload_json, '$.hsn_prefix') = new.hsn_prefix)
BEGIN SELECT RAISE(ABORT, 'category_map: rows are added by the seed or the approved refdata_change proposal for this row'); END;
DROP TRIGGER chapter_keywords_guard_insert;
CREATE TRIGGER chapter_keywords_guard_insert BEFORE INSERT ON chapter_keywords
WHEN EXISTS (SELECT 1 FROM dataset_state) AND NOT EXISTS (SELECT 1 FROM rate_proposals p
     WHERE p.id = new.added_by_proposal AND p.action = 'refdata_change' AND p.status = 'approved'
       AND json_extract(p.payload_json, '$.table') = 'chapter_keyword' AND json_extract(p.payload_json, '$.op') = 'add'
       AND json_extract(p.payload_json, '$.keyword') = new.keyword AND json_extract(p.payload_json, '$.chapter') = new.chapter)
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: rows are added by the seed or the approved refdata_change proposal for this row'); END;
CREATE TRIGGER refdata_guard_deactivate_synonyms BEFORE UPDATE ON synonyms
WHEN NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
       AND json_extract(p.payload_json, '$.table') = 'synonym' AND json_extract(p.payload_json, '$.op') = 'deactivate'
       AND json_extract(p.payload_json, '$.id') = old.id)
BEGIN SELECT RAISE(ABORT, 'synonyms: deactivation needs the approved refdata_change proposal for this row'); END;
CREATE TRIGGER refdata_guard_deactivate_category_map BEFORE UPDATE ON category_map
WHEN NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
       AND json_extract(p.payload_json, '$.table') = 'category_map' AND json_extract(p.payload_json, '$.op') = 'deactivate'
       AND json_extract(p.payload_json, '$.id') = old.id)
BEGIN SELECT RAISE(ABORT, 'category_map: deactivation needs the approved refdata_change proposal for this row'); END;
CREATE TRIGGER refdata_guard_deactivate_chapter_keywords BEFORE UPDATE ON chapter_keywords
WHEN NOT EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.deactivated_by_proposal
       AND json_extract(p.payload_json, '$.table') = 'chapter_keyword' AND json_extract(p.payload_json, '$.op') = 'deactivate'
       AND json_extract(p.payload_json, '$.id') = old.id)
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: deactivation needs the approved refdata_change proposal for this row'); END;

-- (8) New actors need a grant (not a disable request) for that handle; admin keys from a grant are issued
--     within 72 h of its approval (SA-C2-05).
DROP TRIGGER admin_actors_guard_insert;
CREATE TRIGGER admin_actors_guard_insert BEFORE INSERT ON admin_actors
WHEN (new.created_via = 'bootstrap' AND (SELECT COUNT(*) FROM admin_actors) >= 2)
  OR (new.created_via = 'admin_grant' AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.id = new.grant_proposal_id AND p.action = 'admin_grant'
          AND p.status = 'approved' AND json_extract(p.payload_json, '$.op') IS NULL
          AND json_extract(p.payload_json, '$.new_actor') = 1
          AND json_extract(p.payload_json, '$.handle') = new.handle))
BEGIN SELECT RAISE(ABORT, 'admin_actors: new actors need bootstrap (first two) or an approved admin_grant'); END;
DROP TRIGGER api_keys_guard_admin_insert;
CREATE TRIGGER api_keys_guard_admin_insert BEFORE INSERT ON api_keys
WHEN new.scopes = '["admin"]' AND NOT (
  EXISTS (SELECT 1 FROM admin_actors a WHERE a.id = new.actor_id AND a.disabled_at IS NULL)
  AND (
    (new.admin_grant_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM rate_proposals p JOIN admin_actors a ON a.id = new.actor_id
        WHERE p.id = new.admin_grant_id AND p.action = 'admin_grant' AND p.status = 'approved'
          AND json_extract(p.payload_json, '$.op') IS NULL
          AND json_extract(p.payload_json, '$.handle') = a.handle
          AND julianday(new.created_at) - julianday(p.decided_at) <= 3.0001))
    OR (new.admin_grant_id IS NULL
        AND EXISTS (SELECT 1 FROM admin_actors a WHERE a.id = new.actor_id AND a.created_via = 'bootstrap')
        AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.actor_id = new.actor_id))
  ))
BEGIN SELECT RAISE(ABORT, 'api_keys: admin keys need a bootstrap actor (first key) or an approved, unexpired (72 h) admin_grant'); END;

-- (9) Two-person confirmation for silencing a CBIC watcher row (SA-C2-03): the first admin's request is
--     stored here; it is applied only when a different admin repeats it.
ALTER TABLE watched_notifications ADD COLUMN pending_action TEXT CHECK (pending_action IS NULL OR json_valid(pending_action));
CREATE TRIGGER watched_notifications_guard_confirm BEFORE UPDATE ON watched_notifications
WHEN old.source = 'cbic_watcher' AND (
     (new.state <> 'detected' AND old.state = 'detected'
      AND (old.pending_action IS NULL OR json_extract(old.pending_action, '$.kind') IS NOT new.state))
  OR (new.affected_prefixes IS NOT old.affected_prefixes
      AND EXISTS (SELECT 1 FROM json_each(old.affected_prefixes) o
                   WHERE o.value NOT IN (SELECT n.value FROM json_each(new.affected_prefixes) n))
      AND (old.pending_action IS NULL OR json_extract(old.pending_action, '$.kind') IS NOT 'triage'
           OR json(json_extract(old.pending_action, '$.affected_prefixes')) IS NOT json(new.affected_prefixes))))
BEGIN SELECT RAISE(ABORT, 'watched_notifications: resolving a watcher row or removing its prefixes needs a second admin''s confirmation'); END;
```

### 2.5 Migration 6 (rate_rules.citation_note): `server/src/db/migrations.ts`

```sql
ALTER TABLE rate_rules ADD COLUMN citation_note TEXT CHECK (citation_note IS NULL OR length(citation_note) BETWEEN 1 AND 1000);
CREATE TRIGGER rate_rules_guard_citation_note_insert BEFORE INSERT ON rate_rules
WHEN new.citation_note IS NOT NULL AND new.seed_batch_id IS NULL
BEGIN SELECT RAISE(ABORT, 'rate_rules: citation_note is set only by the seed path'); END;
CREATE TRIGGER rate_rules_guard_citation_note_update BEFORE UPDATE OF citation_note ON rate_rules
WHEN new.citation_note IS NOT old.citation_note
 AND NOT (new.citation_note IS NULL AND new.last_verified_at IS NOT old.last_verified_at)
BEGIN SELECT RAISE(ABORT, 'rate_rules: citation_note can only be cleared, and only by a verify'); END;
```

### 2.6 Migration 7 (two-admin confirmation for keyed watch rows and first triage): `server/src/db/migrations.ts`

```sql
DROP TRIGGER watched_notifications_guard_confirm;
CREATE TRIGGER watched_notifications_guard_confirm BEFORE UPDATE ON watched_notifications
WHEN (old.source = 'cbic_watcher' OR old.notification_key IS NOT NULL) AND (
     (new.state <> 'detected' AND old.state = 'detected'
      AND (old.pending_action IS NULL OR json_extract(old.pending_action, '$.kind') IS NOT new.state))
  OR (new.affected_prefixes IS NOT old.affected_prefixes
      AND (json_array_length(old.affected_prefixes) = 0
           OR EXISTS (SELECT 1 FROM json_each(old.affected_prefixes) o
                       WHERE o.value NOT IN (SELECT n.value FROM json_each(new.affected_prefixes) n)))
      AND (old.pending_action IS NULL OR json_extract(old.pending_action, '$.kind') IS NOT 'triage'
           OR json(json_extract(old.pending_action, '$.affected_prefixes')) IS NOT json(new.affected_prefixes))))
BEGIN SELECT RAISE(ABORT, 'watched_notifications: resolving a keyed row, its first triage, or removing its prefixes needs a second admin''s confirmation'); END;
```

### 2.7 Migration 8 (verify may replace an index-page citation (ruling 36)): `server/src/db/migrations.ts`

```sql
DROP TRIGGER rate_rules_guard_update;
CREATE TRIGGER rate_rules_guard_update BEFORE UPDATE ON rate_rules
WHEN old.status = 'voided'
  OR new.rule_id IS NOT old.rule_id OR new.hsn_prefix IS NOT old.hsn_prefix
  OR new.igst_rate_bp IS NOT old.igst_rate_bp OR new.cess_rate_bp IS NOT old.cess_rate_bp
  OR new.cess_specific_paise IS NOT old.cess_specific_paise OR new.cess_specific_unit IS NOT old.cess_specific_unit
  OR new.condition_kind IS NOT old.condition_kind OR new.condition_text IS NOT old.condition_text
  OR new.condition_code IS NOT old.condition_code
  OR new.min_unit_price_paise IS NOT old.min_unit_price_paise OR new.max_unit_price_paise IS NOT old.max_unit_price_paise
  OR new.effective_from IS NOT old.effective_from OR new.created_in_version IS NOT old.created_in_version
  OR ((new.notification_ref IS NOT old.notification_ref OR new.source_url IS NOT old.source_url) AND NOT (
       old.verification_status = 'unverified' AND new.verification_status = 'verified' AND EXISTS (
         SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'verify' AND p.supersedes_rule_id = old.rule_id
            AND p.decided_at = new.last_verified_at
            AND new.source_url IS COALESCE(json_extract(p.payload_json, '$.source.url'), old.source_url)
            AND new.notification_ref IS COALESCE(json_extract(p.payload_json, '$.source.notification'), old.notification_ref))))
  OR new.proposal_id IS NOT old.proposal_id OR new.seed_batch_id IS NOT old.seed_batch_id
  OR new.retroactive_reason IS NOT old.retroactive_reason
  OR (old.effective_to IS NOT NULL AND new.effective_to IS NOT old.effective_to)
  OR (old.end_dated_in_version IS NOT NULL AND new.end_dated_in_version IS NOT old.end_dated_in_version)
  OR (old.superseded_by IS NOT NULL AND new.superseded_by IS NOT old.superseded_by)
  OR (old.verified_by IS NOT NULL AND new.verified_by IS NOT old.verified_by)
  OR (old.source_pdf_sha256 IS NOT NULL AND new.source_pdf_sha256 IS NOT old.source_pdf_sha256)
  OR (old.schedule_serial IS NOT NULL AND new.schedule_serial IS NOT old.schedule_serial)
  OR (old.verification_status = 'verified' AND new.verification_status <> 'verified')
  OR (old.last_verified_at IS NOT NULL AND (new.last_verified_at IS NULL OR new.last_verified_at < old.last_verified_at))
BEGIN
  SELECT RAISE(ABORT, 'rate_rules: published rule fields are immutable; propose a superseding or correcting rule');
END;
```

### 2.6 Illustrative rows (shape only)

Seed rows are written by `npm run seed` inside one transaction while the database is empty (§4.4). Rates come from `research/sources.md` and are `unverified`.

```text
synonyms        (phrase 'gold ring', hsn_code '7113', strength 'primary', created_by 'seed', active 1, added_by_proposal NULL)
chapter_keywords(keyword 'gold', chapter '71')          category_map(source 'open_food_facts', category 'en:biscuits', hsn_prefix '1905')
Price-threshold pair (apparel, chapter 61; inclusive bounds in paise):
  rr_…A1  hsn_prefix '61', 500 bp,  condition_kind 'price', max_unit_price_paise 250000
  rr_…A2  hsn_prefix '61', 1800 bp, condition_kind 'price', min_unit_price_paise 250001
General rule plus a nil-rated condition (3004, ruling 5):
  rr_…B5  hsn_prefix '3004', 500 bp, condition_kind 'none'                      ← default_rule_id
  rr_…B6  hsn_prefix '3004', 0 bp,   condition_kind 'other', condition_code 'nil_rate_list',
          condition_text 'Drugs on the nil-rate list of 10/2025-CT(Rate)'
A curated synonym for a named nil-rated drug carries rule_hint 'nil_rate_list'.
```

## 3. Rate-resolution algorithm

Implemented once in `services/rates.ts` and used by `GET /v1/hsn/{code}`, `POST /v1/classify` (per candidate) and `POST /v1/tax/calculate` (per line). It is a pure function over rows fetched by the repository; no AI or heuristics.

**Input:** `code` (2, 4, 5, 6 or 8 digits), `date` D (default today IST), optional `unit_price` P (paise).

1. **Gather.** Fetch **active** rules (`status = 'active'`; voided rules never return) in force on D (`effective_from <= D AND (effective_to IS NULL OR effective_to >= D)`) whose prefix is related to `code`:
   - **ancestor-or-self:** `code LIKE hsn_prefix || '%'`;
   - **descendant:** `hsn_prefix LIKE code || '%' AND length(hsn_prefix) > length(code)`.
2. **Longest prefix.** Among the ancestor-or-self rules, keep those with the maximum `length(hsn_prefix)`. Call this set R.
3. **Descendant check.** If descendant rules exist and any has a different `(igst_rate_bp, cess_rate_bp, cess_specific_paise)` from R (or R is empty), the result is:
   - `ambiguous = true`, `coverage = 'ambiguous'`, `default_rule_id = null`;
   - the reason "Rate differs at a more specific code …";
   - `rules = R ∪ descendants`. Stop.
4. **Price filter.** If P is given, drop `price` rules whose inclusive bounds exclude P (NULL = unbounded).
5. **Decide.**
   - |R| = 0 → `coverage = 'no_rate_rule'`, no rate. A rate is never invented.
   - |R| = 1 → that rule, `coverage = 'ok'`.
   - |R| > 1 with identical `(igst_rate_bp, cess_rate_bp, cess_specific_paise)` → the one with the latest `last_verified_at` (NULL last; tie: smallest `rule_id`), `coverage = 'ok'`.
   - Otherwise → `ambiguous`, with one of these:
     - **General plus conditions (ruling 5):** exactly one `none` rule, at least one `other` rule and no `price` rule. `default_rule_id` is the `none` rule.
     - **Price:** every rule is `price` and P is absent. Reason "pass unit_price".
     - **Other conditions only** (e.g. paneer vs cheese). A human must choose.
6. **Warnings** (open enum):
   - `rate_unverified`;
   - `verification_overdue`: verified but `reverify_due_at < now`. `reverify_due_at = last_verified_at + 12 calendar months` is computed in `services/rates.ts`; it is not a column.
   - `pending_change_detected`: a `watched_notifications` row in state `detected` with a non-empty `affected_prefixes` containing `p`, where `code.startsWith(p) || p.startsWith(code)`. Untriaged rows (empty prefixes) never warn.
   - `selected_by_hint` (classify only);
   - `no_rate_rule` and `ambiguous`.
7. **Data-integrity guard.** Two overlapping active rules is a data error. The approval path rejects it (409 `overlapping-rule`); the resolver logs `rate_rule_overlap` and returns ambiguous rather than picking one.

**Overlap rule** (checked at proposal creation and again inside the approval transaction). Two active rules with the same `hsn_prefix` and overlapping date ranges conflict when:
- both are `none`;
- one is `none` and the other `price`;
- both are `price` with overlapping price ranges;
- both are `other` with the same `condition_text`.

**Classify-only hint (ruling 5).** A curated exact synonym hit on the caller's own `name` may carry `rule_hint` (a `condition_code`). If the resolution is ambiguous and exactly one candidate rule has that `condition_code`, it is chosen with the warning `selected_by_hint`. Lookups and tax never apply hints.

**Tax lines.** An ambiguous line is computed only with `rule_id` (one of the candidates, else 422 `rule-choice-invalid`) or `condition: "general"` (→ `default_rule_id`). The line's `rule_selected_by` records how. An unverified rule is computed only with `accept_unverified: true` (ruling 24).

**Historical queries.** Rules are end-dated or voided, never edited. So `?date=2025-09-01` for `3004` returns the fixture's 12% rule and today returns the 5% general rule. To reproduce an old answer exactly, clients store `rule_id` plus `dataset_version`.

## 4. Write paths

### 4.1 Approval (`services/proposals.ts`, one `BEGIN IMMEDIATE` transaction)

1. **Idempotency.** `runIdempotent`: same `(key_id, idem_key)` and same `request_sha256` within 24 h → the stored response (`Idempotent-Replayed: true`); different hash → 409 `idempotency-conflict`.
2. **Checks.**
   - The proposal exists (else 404 `proposal-not-found`).
   - The approver's actor differs from `proposed_by_actor_id` (else 403 `maker-checker-violation`; the DDL CHECK repeats it).
   - The proposer's actor is not disabled (else 409 `proposer-disabled`; the v5 decide guard repeats it, and also requires an active checker key).
   - A `dataset_import` is refused here with 409 `proposal-stale`: only `scripts/import-dataset.ts` approves it, because only the host can re-hash the seed files.
   - `status = 'pending'` (else 409 `proposal-not-pending`).
   - `expected_sha256 = content_sha256` (else 409 `proposal-hash-mismatch`).
   - For actions with a target: `sha256(JCS(target row)) = target_sha256` (else 409 `rule-not-active`: the target changed).
   - The overlap check against published rules.
   - A change that now takes effect before today (IST) without `retroactive_reason` → 409 `proposal-stale`.
3. **Begin publish** (not for `admin_grant` or `disable_actor`). Insert `dataset_versions` with the next `YYYY.MM.DD-n`, `parent_version` = current and the placeholder `content_hash` of 64 zeros.
4. **Decide first.** Update the proposal to `approved` with `decided_by`, `decided_by_actor_id`, `decided_key_id`, `decided_at`, `resulting_rule_id` and `resulting_version`. The insert triggers then accept rows that name this proposal.
5. **Apply.**
   - `create` / `supersede` / `correct`: insert the new rule as `verified` (`verified_by` = checker handle, `last_verified_at` = now, `proposal_id`).
   - `supersede`: end-date the target to the new `effective_from − 1 day` with `superseded_by`. `end_date` uses the proposal's `end_date`. Feed `rule_end_dated`.
   - `correct` (ruling 1): void the target (`status='voided'`, `voided_at`, `voided_in_version`, `voided_by_rule`; same prefix enforced). Feed `rule_corrected` (`rule_id` = replacement, `related_rule_id` = voided rule).
   - `verify` (its `rule_verified` feed summary names the citation as it stands after the approval, core round 10): `markVerified` sets `verified_by`, `last_verified_at`, `source_pdf_sha256` and `schedule_serial` (set once; a re-verification moves only `last_verified_at` forward). On the first verify, one statement also sets `source_url` / `notification_ref` from the proposal's `source.url` / `source.notification` when given, and `citation_note = NULL` (ruling 36; migration 8 allows exactly this). Feed `rule_verified`.
   - `refdata_change`:
     - `synonym` / `category_map` / `chapter_keyword` `add` inserts with `added_by_proposal`; `deactivate` sets `active=0` and `deactivated_by_proposal` (feed `synonym_changed` / `refdata_changed`);
     - `hsn_description` `update` changes `description` / `keywords` in place with `changed_by_proposal`; the trigger copies the old text to `hsn_code_history` (feed `hsn_updated`);
     - `hsn_code` `add_code` inserts the code with `added_by_proposal`; the trigger requires the approved proposal's payload `code` to equal the new code (feed `hsn_added`).
   - `disable_actor` (round 4, stored as an `admin_grant` row with `payload.op = "disable_actor"`; refused with `last_actors` when fewer than two active admins would remain): `disableActorInTx` sets `disabled_at` (the actor's keys get 401 at once), withdraws its pending proposals (each audited `rate_proposal.withdrawn`), audits `admin.disabled` and logs `admin.actor_disabled` (warn, `alert: true`). `scripts/disable-actor.ts` does the same on the host.
   - `admin_grant`: insert `admin_actors` (`created_via='admin_grant'`, `grant_proposal_id`) when `new_actor`; audit `admin.granted`; after commit, a warn log `admin.grant_approved` with `alert: true` (no out-of-band notifier in v1, ruling 29). The key is then minted with `scripts/create-key.ts … --grant rp_…` within `HSN_ADMIN_GRANT_TTL_HOURS` (default 72; the v5 trigger caps it at 72 h after `decided_at`); `api_keys.admin_grant_id` is UNIQUE and the trigger requires the approved grant for that actor's handle. A grant for an extra key (`new_actor: false`) must be proposed by that actor itself (400 `not_self`; the v5 insert guard repeats it).
6. **Overlap re-check** of the new rule against every rule on the prefix, then feed `rule_added` (or `rule_corrected`). Every feed row carries `affected_prefix` and `retroactive`.
7. **Finish publish.** Fill `rule_count` and `content_hash` (sha256 of the canonical export) and the optional Ed25519 `signature`. The trigger allows this once, from the placeholder. Then move `dataset_state` forward (`current_version`, `last_change_seq`).
8. **Audit.** Append `rate_proposal.approved` (HMAC chain, §8) with the canonical rule row, its `rule_sha256`, the proposal `content_sha256`, the payload and (since round 4) `dataset_content_hash`, which the state-to-audit cross-check compares with the version row.
9. **COMMIT.** Any failure rolls everything back. (Step 1 also recomputes `content_sha256` from the stored proposal content and refuses with 409 `proposal_hash_mismatch` when it differs, round 6 SA-C3-01; reject does the same.) After commit the restore-detection high-water mark moves forward.

Approve and reject are one proposal per call (ruling 20). Withdraw (ruling 26) is proposer-only and pending-only, with `{reason}`. Revoking an admin key or disabling an actor withdraws that actor's pending proposals.

### 4.2 Proposal creation

The code checks:
- zod and JSON-schema validation;
- the slab list and the exact source host;
- the dates;
- `rule.source` `{notification, url, pdf_sha256, schedule_serial}` for create / supersede / correct (the `url` must be a notification document, never an index page: ruling 36), and `source {pdf_sha256, schedule_serial, url?, notification?}` for verify. `url` / `notification` are allowed only while the rule is unverified (else 400 at `/source`, `forbidden`); `url` is required when the rule cites an index page (400 `source-url-not-document`). The index-page set is the CBIC rate listing pages, the watcher pages and `HSN_SOURCE_INDEX_PAGES`;
- `admin_grant` (`not_self` for `new_actor: false`) and `disable_actor` (`last_actors`: at least two active admins must remain);
- the `refdata` rules (for `add_code`: length, not existing, chapter exists, nearest existing ancestor as `parent`, 4-digit heading for 6/8-digit codes, type matches the chapter, no duplicate pending proposal);
- the overlap pre-check;
- retroactivity (`retroactive_reason` required).

It then computes `content_sha256 = sha256(JCS(content))` and the target's `target_sha256`, inserts the proposal as `pending` (`rule_json` or `payload_json` per the action CHECKs), and audits `rate_proposal.created`. The v5 insert guard requires a new proposal to be pending and undecided, made with the proposer's own active admin key.

### 4.3 Idempotency (rulings 8 and 28)

Every admin write requires an `Idempotency-Key` UUID; a missing header is 400 `idempotency-key-required`. The writes are:
- proposal create, approve, reject and withdraw;
- watched-notification create, triage and resolve;
- product purge.

The row `idempotency_keys(key_id, idem_key, route, request_sha256, status_code, response_json, created_at)` is written in the same transaction as the write. The 24 h TTL is applied on read (`created_at` older than 24 h is ignored), and expired rows are purged (index `idempotency_keys_created`).

### 4.4 Seed (once, into an empty database)

`npm run seed` (`src/db/seed.ts`) refuses in production and when `dataset_state` exists; the `seed_batches` trigger also refuses once a dataset is published. In one transaction it writes:
1. the seed dataset version (placeholder hash);
2. `seed_batches` (`files_json` with the sha256 of each seed file);
3. `hsn_codes`;
4. `rate_rules` with `seed_batch_id`;
5. `synonyms`, `category_map` and `chapter_keywords` (`added_by_proposal` NULL);
6. the filled `content_hash`, then `dataset_state` with a random `feed_epoch`;
7. the audit entry `dataset.seeded` (actor `seed`).

Seed rules are always `unverified` (ruling 33) and may carry a `citation_note` (round 5). The loader's `allowVerified` option is for test fixtures only, and the DDL does not check this. After the seed, the insert triggers refuse every seed-path row.

**Production first load (round 5, R11): `npm run import-dataset`.** `npm run seed` stays refused in production. Instead, after `bootstrap-admins`, the load is a maker–checker proposal of kind `dataset_import` (stored as `refdata_change` with `payload = {op: "dataset_import", files: {name: sha256}, counts}`):
1. Maker: `HSN_ADMIN_KEY=<A's key> npm run import-dataset -- propose --dir data/seed --rationale "…"`. It validates the directory with the seed's checks (fail closed; every rule unverified), records each file's sha256 and the row counts, and prints `proposal_id` and `content_sha256`. Refused when a dataset exists or another import is pending.
2. Checker (a different actor): `HSN_ADMIN_KEY=<B's key> npm run import-dataset -- approve --proposal rp_… --expected-sha256 <content_sha256> --dir data/seed`. Refused if B is the maker, the hash is wrong, the proposer is disabled, or any file's sha256 or row count differs. Otherwise one transaction publishes the first version through the seed path, marks the proposal approved with that version, and writes `dataset.seeded` (actor = checker, `proposal_id`) and `rate_proposal.approved`. It then runs the state-to-audit cross-check.
3. Exit codes: 0 ok; 1 refused; 2 seed validation failed; 3 imported but the cross-check reported problems. The key is read from `HSN_ADMIN_KEY` and checked as the API checks it; never pass it on the command line.

### 4.5 Admin bootstrap and restore

`scripts/bootstrap-admins.ts --admin amit:"…" --admin priya:"…"` creates the first two actors (`created_via='bootstrap'`) and one admin key each. It audits `admin.bootstrapped` and prints the keys once. The triggers refuse a third bootstrap actor and a second key for a bootstrap actor without an `admin_grant`.

**Restore (ruling 31; round 4, SA-C2-06; round 6, SA-C3-04).** The server keeps a high-water mark in `HSN_STATE_HWM_FILE`, MAC'd with `HSN_AUDIT_KEY`. In production the variable is required and its directory must not be the database's directory (put it on a different volume and backup set; a backup that restores both together defeats detection); the development default is `<HSN_DB_PATH>.hwm.json`. It records the audit head id and hash, `last_change_seq` and `feed_epoch`. It moves forward after each audited admin write and every 60 s. At boot a restore is detected when the audit head id is lower than recorded, the recorded head entry's hash differs, or the sequence is lower within the same epoch. Then:
1. the feed epoch is rotated (clients resync), `dataset.restore_detected` is audited and `dataset.restore_detected` is logged (error, `alert: true`);
2. `/readyz` returns 503 (`state_continuity`) until an operator runs `npm run ack-restore -- --by <actor> --note "<≥ 10 chars>"` (audited `dataset.restore_acknowledged`; it rewrites the sidecar) and restarts the server.

The first creation of a sidecar is audited `dataset.hwm_initialised`. A **missing** sidecar for a database whose log has that entry (or a `dataset.restore_acknowledged`) is treated as a possible restore: error log `dataset.hwm_missing` (`alert: true`), epoch rotated, `dataset.restore_detected` audited, 503 until `ack-restore`. Only a database that never had a sidecar initialises one silently. Accepted residual (SA-C4-04): a backup taken before the first boot of round-6 code, restored with the sidecar deleted, also initialises silently; so after upgrading, boot once (writing `dataset.hwm_initialised`) and export a fresh audit head off-host, and treat older backups as needing `verify-audit --head` against an export before use. A sidecar whose MAC fails gives `dataset.hwm_invalid` and 503. `HSN_STATE_HWM_FILE=off` disables detection and is refused in production. So the runbook is: restore the backup → the server detects it and fails readiness → `ack-restore` → restart. `scripts/rotate-feed-epoch.ts` stays for a manual epoch change. The quick-start drill in `reviews/docs-fix-round2.md` Round 4 ran this sequence on a live server.

**Disabling an actor.** `disable_actor` proposals (§4.1) or, on the host, `npm run disable-actor -- --handle <h> --by <who> --note "…"`. Both refuse when fewer than two active admins would remain (round 6, SA-C3-05): grant a third admin first, or revoke only the leaked key with `create-key --revoke <key_id> --by <who>`.

### 4.6 CBIC watcher (migration 3)

`npm run watch-cbic` runs from cron, or in-process with `HSN_WATCHER_ENABLED=true`. Each run is one append-only `watcher_runs` row:
- `source 'cbic'`;
- `status 'ok'|'failed'`, where `error` is set exactly when the run failed;
- `items_seen`, `items_new`, `details_json`.

New items become `watched_notifications` rows:
- `id wn_…`, `source 'cbic_watcher'`, `state 'detected'`, `affected_prefixes '[]'`;
- `notification_key`, e.g. `central_tax_rate:1/2026`; a corrigendum adds `:corrigendum:<date>`; unique when set;
- `title` and `notification_date`;
- audit `watched_notification.detected`, actor `system:cbic-watcher`.

Manual entries (`source 'manual'`) compute the same key, so a duplicate is 409 `duplicate-notification`. The update trigger allows two changes:
- `affected_prefixes` / `effective_from` while the row is `detected` (triage);
- `detected → published | dismissed` with `resolved_at` / `resolved_by`.

All other columns are frozen, and a resolved row never changes. The watcher never writes rates.

**Two admins for silencing a keyed row (migration 5, round 4 SA-C2-03; migration 7, round 6 SA-C3-03).** On every row that carries a `notification_key` (each `cbic_watcher` row and each manual row whose notification parses to a key), resolving it, setting its first prefixes (first triage) or removing prefixes is stored first in `pending_action` (`{kind, affected_prefixes?, effective_from?, by, by_actor_id, at}`; audited `watched_notification.confirmation_requested`; the API returns 202). A different admin repeating the request applies it (audited with `requested_by` and `confirmed_by`; warn log `watcher.row_silenced`). The `watched_notifications_guard_confirm` trigger (replaced in v7) refuses a direct resolve, first triage or prefix removal without a matching `pending_action`. Later additions of prefixes, and manual rows without a key, stay single-admin. The parser is linear with per-row caps, runs in a worker thread (64 MB heap, 2 s, fail closed as `shape_changed`) and skips hidden rows and elements, counting them (`PageOutcome.hidden`, warn log `watcher.hidden_rows`).

### 4.7 Key peppers (migration 4)

`api_keys.pepper_id` (default `default`, `[a-z0-9_-]{1,32}`) records which pepper of `HSN_KEY_PEPPERS` hashed the key (ruling 29). It is immutable; to change it, re-issue the key.

## 5. Size and retention

About 22k HSN plus 700 SAC rows and a few thousand rules: well under 50 MB. These are kept indefinitely (small):
- `change_feed`, `audit_log`, `hsn_code_history` and `watcher_runs`;
- proposals and voided rules.

**Products.** `products` rows expire per `expires_at` (found 7 days, not found 1 day). The table is capped at `HSN_PRODUCT_CACHE_MAX_ROWS` (default 50,000), and eviction deletes the oldest `fetched_at` first (ruling 30; index `products_fetched_at`). An admin can purge one GTIN:
- the request is `DELETE /v1/admin/products/{gtin}`;
- it returns 200 `{gtin, deleted: true}`;
- it is audited `product.purged` (entity_type `product`) with the old row's `source`, `found` and `fetched_at`.

Adapter errors are never written to `products`. They go to an in-memory error cache and surface as `product.source = lookup_failed`.

## 6. Postgres mapping (later)

| SQLite | Postgres |
|---|---|
| `TEXT` dates | `date`, `timestamptz` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint generated always as identity` |
| FTS5 `hsn_fts` + `bm25()` | `tsvector` generated column + GIN + `ts_rank_cd`; `pg_trgm` for typos |
| `json_valid` CHECK / `TEXT` JSON, `json_extract` in triggers | `jsonb`, `->>` |
| `RAISE(ABORT)` triggers | plpgsql `BEFORE` triggers with the same conditions, plus `REVOKE UPDATE, DELETE` on append-only tables |
| Partial unique indexes | Same |
| `DEFERRABLE INITIALLY DEFERRED` FKs | Same |
| `BEGIN IMMEDIATE` | `SERIALIZABLE`, or `SELECT … FOR UPDATE` on `dataset_state` |
| `GLOB` checks | `~ '^[0-9]+$'` |

## 7. Seed file format

The format is the shared `server/data/seed/FORMAT.md`. It states that seed rows are always `unverified` and that `allowVerified` is test-only (ruling 33; FORMAT.md is maintained by core).
- **Files:** `hsn_codes.json`, `rate_rules.json`, `synonyms.json`, `category_map.json`, `chapter_keywords.json`, validated row by row. Any invalid row aborts the seed.
- **`hsn_codes`:** lengths 2, 4, 5 (chapter 99 only), 6 and 8. Every non-chapter code needs an existing parent.
- **`rate_rules`:**
  - `hsn_prefix` must exist as a code;
  - `notification_ref` in canonical form: zero padding and long series names are normalised on load; anything else that does not match the §1 pattern aborts the seed (core round 10);
  - optional `condition_code` (`nil_rate_list`) on `other` rules;
  - `unverified`, with `verified_by` / `last_verified_at` NULL.
- **`synonyms`:** optional `rule_hint`.
- **File hashes:** the sha256 of every seed file goes into `seed_batches.files_json` and the `dataset.seeded` audit entry.
- **`known_gaps.json` (optional, round 9):** `{ "_comment"?, "items": [{ prefix: code | null, kind: disputed | not_researched | not_transcribed | not_expressible | period_gap, reason }] }`, at most 200 items. It is not a seed table and not part of the dataset hash: the server reads it once at boot (`services/knownGaps.ts`; path `HSN_KNOWN_GAPS_FILE`, default `data/seed/known_gaps.json`) and serves it as `known_data_gaps` in `GET /v1/meta/dataset`. The shipped default may be absent (`[]`). An explicitly set file must exist, be a regular file of at most 256 KiB and parse, or the boot is refused (errors say "not valid JSON" without quoting the contents; at most 5 schema issues of 120 characters); in production `HSN_KNOWN_GAPS_FILE` must be absolute (core round 10, SA-C5-04).

## 8. Audit chain and off-host anchor (ruling 18)

```
hash = hex(HMAC-SHA256(HSN_AUDIT_KEY, prev_hash || '\n' || JCS({id, at, actor, key_prefix, action,
                                                                  entity_type, entity_id, details})))
```

- **Columns.** `audit_log(id, at, actor, key_prefix, action, entity_type, entity_id, details_json, prev_hash, hash UNIQUE)`, append-only.
  - `actor` is the admin handle, `seed`, or `system:<job>` (e.g. `system:cbic-watcher`).
  - `key_prefix` is the key's display prefix (`hsk_` + 8 characters), or NULL for scripts and jobs.
  - The first row has `prev_hash = '0' × 64`.
  - The entry is appended inside the same transaction as the change, under `BEGIN IMMEDIATE`.
- **Secret.** `HSN_AUDIT_KEY` is separate from the key peppers and `HSN_LOG_KEY`.
- **Rule hashes.** Approval entries carry the canonical rule row and `rule_sha256 = sha256(JCS(row))`.
- **`scripts/export-audit-head.ts`** writes `{format, exported_at, audit_head_id, audit_head_hash, dataset_version, dataset_sha256, feed_epoch, mac}`, where `mac` is an HMAC with `HSN_AUDIT_KEY` over the other fields. The operator copies it off the host daily and after every publish.
- **`scripts/verify-audit.ts [--head <file>]`** recomputes the whole chain and the dataset `content_hash`, checks both against the exported head, and runs the state-to-audit cross-check (exit 3 with `state without matching audit entry: …`).
- **Boot.** The server verifies the whole chain and runs the cross-check at start-up (cost O(audit log)); a failure logs `audit.chain_broken` or `audit.state_mismatch` (error, `alert: true`) and `/readyz` returns 503 (`audit_integrity`).
- **Round 4 to 6 audit actions:** `admin.disabled`, `dataset.restore_detected`, `dataset.restore_acknowledged`, `dataset.hwm_initialised`, `watched_notification.confirmation_requested`; `dataset.seeded` carries `proposal_id` when written by `import-dataset` and (round 6) `citation_notes: {rule_id: note}`; `api_key.created` records (round 7) `llm_opt_out`, `rate_limit_per_min` and `daily_quota` besides `tenant`.
- **`GET /v1/admin/audit?verify=true`** (ruling 27) verifies only the returned span, up to 10,000 entries. It reports `chain_ok` / `chain_broken_at`, and always `head_id` / `head_hash`. The `entity_type` filter includes `product`.

## 9. Verification of this DDL

`reviews/docs-fix-round2.md` § Round 4 records the run of `node --no-warnings reviews/round2-tools/test-ddl.cjs docs/design/data-model.md <server dir>`:
- **Code mirror:** every §2 block is byte-identical to `schema.sql` and to each migration step.
- **Schema:** the resulting `sqlite_master` equals the code-built one.
- **Behaviour:** 124 checks pass (93 from round 3, updated for migrations 5 to 8, plus 31 new; round 9 added the migration 8 block and six citation checks).
- **Foreign keys:** `PRAGMA foreign_key_check` returns no rows.

The behaviour tests cover:
- the seed path, once and into an empty DB only;
- code length and SAC rules;
- rule provenance and immutability, no deletes, and the price and condition CHECKs;
- dataset versions filled once and a forward-only pointer;
- admin actors (bootstrap limit, handle charset) and admin keys (bootstrap first key, grant needed afterwards, the 90-day CHECK, exclusive admin scope);
- immutable `pepper_id` and revoke-once;
- the maker ≠ checker CHECK and final decisions;
- `add_code` bound to the approved code, FTS on the new code, and an immutable `added_by_proposal`;
- in-place description updates with history and FTS refresh;
- reference-data deactivation;
- append-only audit, feed, history and watcher runs;
- watcher key uniqueness, triage while detected, a frozen closed row and the `resolved_at` CHECK;
- the product cache source CHECK and the eviction index;
- migration 5: proposals born pending from the proposer's own active key, `not_self` grants, the 72 h grant-key window, `add_code` and description updates bound to the whole payload, deactivation bound to the row id, the dataset pointer bound to an approved publish, and the two-admin watcher guard;
- migration 6: `citation_note` set by the seed only and never edited or cleared without a verify;
- migration 7: first triage of a keyed row and resolve of a keyed manual row need a stored confirmation; later additions and unkeyed manual rows are single-admin;
- migration 8: a citation change is refused outside an approved first verify, a mismatched URL is refused even with an approved verify, and the matching URL and notification are accepted with the verification fields.
