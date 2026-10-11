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
