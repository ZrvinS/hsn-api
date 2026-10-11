-- 0001_init.sql ---------------------------------------------------------------
-- Connection pragmas (set by db/open.ts on every connection, not part of the migration):
--   journal_mode=WAL; foreign_keys=ON; busy_timeout=5000; synchronous=NORMAL; trusted_schema=OFF

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- Admin identities (ruling 17 / SA-D-01) --------------------------------------------
-- Handles are normalised in zod before insert (NFKC → lowercase → trim); the DDL re-checks the charset.
CREATE TABLE admin_actors (
  actor_id            TEXT PRIMARY KEY CHECK (actor_id LIKE 'act\_%' ESCAPE '\'),   -- 'act_' + ULID
  handle              TEXT NOT NULL UNIQUE
                      CHECK (length(handle) BETWEEN 3 AND 32 AND handle NOT GLOB '*[^a-z0-9_-]*'),
  display_name        TEXT,                        -- erasable (SEC-89)
  contact             TEXT,                        -- how to reach the actor (v1 sends no notices); erasable
  created_at          TEXT NOT NULL,
  created_by_actor_id TEXT REFERENCES admin_actors(actor_id),   -- NULL only for the two bootstrap actors
  bootstrap           INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap IN (0,1)),
  grant_proposal_id   TEXT UNIQUE REFERENCES rate_proposals(id), -- approved admin_grant (kind 'actor')
  disabled_at         TEXT,
  CHECK ((bootstrap = 1) = (grant_proposal_id IS NULL)),
  CHECK ((bootstrap = 1) = (created_by_actor_id IS NULL))
);
-- At most two bootstrap actors (scripts/bootstrap-admins.ts creates both in one transaction);
-- every later actor needs an approved admin_grant proposed by created_by_actor_id.
CREATE TRIGGER admin_actors_guard_insert BEFORE INSERT ON admin_actors
WHEN (new.bootstrap = 1 AND (SELECT count(*) FROM admin_actors) >= 2)
  OR (new.bootstrap = 0 AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p
        WHERE p.id = new.grant_proposal_id AND p.action = 'admin_grant' AND p.status = 'approved'
          AND json_extract(p.grant_json, '$.kind') = 'actor'
          AND json_extract(p.grant_json, '$.handle') = new.handle
          AND p.proposed_by_actor_id = new.created_by_actor_id))
BEGIN SELECT RAISE(ABORT, 'admin_actors: only two bootstrap actors; later actors need an approved admin_grant'); END;
-- Only disabled_at (once) may be set; display_name/contact may only be erased (set to NULL);
-- handle may only be replaced by its erased form 'x-' || lower(ulid).
CREATE TRIGGER admin_actors_guard_update BEFORE UPDATE ON admin_actors
WHEN new.actor_id IS NOT old.actor_id OR new.created_at IS NOT old.created_at
  OR new.created_by_actor_id IS NOT old.created_by_actor_id OR new.bootstrap IS NOT old.bootstrap
  OR new.grant_proposal_id IS NOT old.grant_proposal_id
  OR (new.handle IS NOT old.handle AND new.handle IS NOT ('x-' || lower(substr(old.actor_id, 5))))
  OR (old.disabled_at IS NOT NULL AND new.disabled_at IS NOT old.disabled_at)
  OR (new.display_name IS NOT old.display_name AND new.display_name IS NOT NULL)
  OR (new.contact IS NOT old.contact AND new.contact IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'admin_actors: only disabled_at (once) and erasure are allowed'); END;
CREATE TRIGGER admin_actors_no_delete BEFORE DELETE ON admin_actors
BEGIN SELECT RAISE(ABORT, 'admin_actors: delete not allowed; set disabled_at'); END;

-- API keys --------------------------------------------------------------------------
-- Scope sets are stored as one canonical string so the admin rules are plain CHECKs (SA-D-10):
-- admin never combines with another scope, and an admin key always has an actor and a ≤ 90-day expiry.
CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY CHECK (id LIKE 'key\_%' ESCAPE '\'),
  prefix             TEXT NOT NULL UNIQUE CHECK (length(prefix) = 12),   -- 'hsk_ab12cd34' (public)
  key_hash           TEXT NOT NULL CHECK (length(key_hash) = 64),        -- hex HMAC-SHA256(secret, pepper[pepper_id]); peppers from HSN_KEY_PEPPERS
  pepper_id          TEXT NOT NULL DEFAULT 'p1',                         -- id from HSN_KEY_PEPPERS ('id:secret,…', newest first; ruling 29)
  scopes             TEXT NOT NULL CHECK (scopes IN ('read','classify','read,classify','admin')),
  tenant             TEXT NOT NULL,                                      -- 'sunarone', 'healthapp', 'internal'
  actor_id           TEXT REFERENCES admin_actors(actor_id),
  grant_proposal_id  TEXT UNIQUE REFERENCES rate_proposals(id),          -- approved admin_grant (kind 'key')
  label              TEXT NOT NULL DEFAULT '',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 600 CHECK (rate_limit_per_min > 0),
  daily_quota        INTEGER CHECK (daily_quota IS NULL OR daily_quota > 0),               -- NULL = HSN_DAILY_QUOTA_DEFAULT
  outbound_daily_cap INTEGER CHECK (outbound_daily_cap IS NULL OR outbound_daily_cap >= 0), -- NULL = HSN_OUTBOUND_PER_KEY_DAILY
  llm_opt_out        INTEGER NOT NULL DEFAULT 0 CHECK (llm_opt_out IN (0,1)),
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  revoked_at         TEXT,
  last_used_at       TEXT,                                               -- updated at most once per minute
  CHECK ((scopes = 'admin') = (actor_id IS NOT NULL)),
  CHECK (scopes <> 'admin' OR (expires_at IS NOT NULL
                               AND julianday(expires_at) - julianday(created_at) BETWEEN 0 AND 90)),
  CHECK (scopes = 'admin' OR grant_proposal_id IS NULL)
);
CREATE TRIGGER api_keys_admin_insert BEFORE INSERT ON api_keys
WHEN new.scopes = 'admin' AND (
     EXISTS (SELECT 1 FROM admin_actors a WHERE a.actor_id = new.actor_id AND a.disabled_at IS NOT NULL)
  OR NOT (
       (new.grant_proposal_id IS NULL
          AND EXISTS (SELECT 1 FROM admin_actors a WHERE a.actor_id = new.actor_id AND a.bootstrap = 1)
          AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.actor_id = new.actor_id))
    OR EXISTS (SELECT 1 FROM rate_proposals p
               WHERE p.id = new.grant_proposal_id AND p.action = 'admin_grant' AND p.status = 'approved'
                 AND json_extract(p.grant_json, '$.kind') = 'key'
                 AND json_extract(p.grant_json, '$.actor_id') = new.actor_id)))
BEGIN SELECT RAISE(ABORT, 'api_keys: an admin key needs an approved admin_grant (or is the first key of a bootstrap actor)'); END;
CREATE TRIGGER api_keys_guard_update BEFORE UPDATE ON api_keys
WHEN new.id IS NOT old.id OR new.prefix IS NOT old.prefix OR new.key_hash IS NOT old.key_hash
  OR new.pepper_id IS NOT old.pepper_id OR new.scopes IS NOT old.scopes OR new.tenant IS NOT old.tenant
  OR new.actor_id IS NOT old.actor_id OR new.grant_proposal_id IS NOT old.grant_proposal_id
  OR new.created_at IS NOT old.created_at
  OR (new.expires_at IS NOT old.expires_at
      AND (new.expires_at IS NULL OR (old.expires_at IS NOT NULL AND new.expires_at > old.expires_at)))
  OR (old.revoked_at IS NOT NULL AND new.revoked_at IS NOT old.revoked_at)
BEGIN SELECT RAISE(ABORT, 'api_keys: identity fields are immutable; revoked_at is set once; expiry can only shorten'); END;
CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON api_keys
BEGIN SELECT RAISE(ABORT, 'api_keys: delete not allowed; revoke instead'); END;
-- Full key format: hsk_<8-char prefix>_<43-char base64url secret> (32 bytes from crypto.randomBytes).
-- Lookup on every request (no auth cache, ruling 20): prefix → row → timingSafeEqual(HMAC-SHA256(secret,
-- pepper[pepper_id]), key_hash) → revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)
-- → for admin keys also actor not disabled.

-- Seed batches (the only non-proposal write path; once, into an empty database) ---------
CREATE TABLE seed_batches (
  seed_batch_id     TEXT PRIMARY KEY CHECK (seed_batch_id LIKE 'sb\_%' ESCAPE '\'),
  files_sha256_json TEXT NOT NULL CHECK (json_valid(files_sha256_json)),  -- {"rate_rules.json":"<hex>",…}
  started_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'loading' CHECK (status IN ('loading','loaded'))
);
CREATE TRIGGER seed_batches_guard_insert BEFORE INSERT ON seed_batches
WHEN EXISTS (SELECT 1 FROM seed_batches) OR EXISTS (SELECT 1 FROM dataset_state) OR new.status <> 'loading'
BEGIN SELECT RAISE(ABORT, 'seed_batches: seeding is allowed once, into an empty database'); END;
CREATE TRIGGER seed_batches_guard_update BEFORE UPDATE ON seed_batches
WHEN new.seed_batch_id IS NOT old.seed_batch_id OR new.files_sha256_json IS NOT old.files_sha256_json
  OR new.started_at IS NOT old.started_at OR NOT (old.status = 'loading' AND new.status = 'loaded')
BEGIN SELECT RAISE(ABORT, 'seed_batches: only loading → loaded, once'); END;
CREATE TRIGGER seed_batches_no_delete BEFORE DELETE ON seed_batches
BEGIN SELECT RAISE(ABORT, 'seed_batches: delete not allowed'); END;

-- Dataset versions (append-only) and the current pointer (forward-only) ---------------------
CREATE TABLE dataset_versions (
  version               TEXT PRIMARY KEY
                        CHECK (version GLOB '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-[1-9]*'),  -- 'YYYY.MM.DD-n'
  parent_version        TEXT REFERENCES dataset_versions(version),       -- NULL only for the seed version
  published_at          TEXT NOT NULL,
  published_by_actor_id TEXT REFERENCES admin_actors(actor_id),          -- checker; NULL for the seed version
  reason                TEXT NOT NULL,                                   -- 'seed' | 'proposal rp_…'
  proposal_id           TEXT REFERENCES rate_proposals(id),
  seed_batch_id         TEXT REFERENCES seed_batches(seed_batch_id),
  rule_count            INTEGER NOT NULL,                                -- active rules in force on publish day
  content_sha256        TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
                        -- sha256 of the canonical (RFC 8785) export of active rules + codes + refdata;
                        -- set once, at the end of the publishing transaction
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK ((parent_version IS NULL) = (seed_batch_id IS NOT NULL))
);
CREATE TRIGGER dataset_versions_guard_insert BEFORE INSERT ON dataset_versions
WHEN new.parent_version IS NOT (SELECT current_version FROM dataset_state WHERE id = 1)
  OR new.content_sha256 IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'dataset_versions: parent must be the current version; content_sha256 is sealed later'); END;
CREATE TRIGGER dataset_versions_guard_update BEFORE UPDATE ON dataset_versions
WHEN new.version IS NOT old.version OR new.parent_version IS NOT old.parent_version
  OR new.published_at IS NOT old.published_at OR new.published_by_actor_id IS NOT old.published_by_actor_id
  OR new.reason IS NOT old.reason OR new.proposal_id IS NOT old.proposal_id
  OR new.seed_batch_id IS NOT old.seed_batch_id OR new.rule_count IS NOT old.rule_count
  OR old.content_sha256 IS NOT NULL OR new.content_sha256 IS NULL
BEGIN SELECT RAISE(ABORT, 'dataset_versions: append-only; content_sha256 is set once'); END;
CREATE TRIGGER dataset_versions_no_delete BEFORE DELETE ON dataset_versions
BEGIN SELECT RAISE(ABORT, 'dataset_versions: append-only'); END;

CREATE TABLE dataset_state (                    -- single row
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  current_version TEXT NOT NULL REFERENCES dataset_versions(version),
  last_change_seq INTEGER NOT NULL,
  feed_epoch      TEXT NOT NULL CHECK (length(feed_epoch) BETWEEN 8 AND 64)
                  -- random token; replaced by scripts/rotate-feed-epoch.ts after any restore, so clients resync
);
CREATE TRIGGER dataset_state_guard_insert BEFORE INSERT ON dataset_state
WHEN (SELECT content_sha256 FROM dataset_versions WHERE version = new.current_version) IS NULL
BEGIN SELECT RAISE(ABORT, 'dataset_state: current version must be sealed'); END;
CREATE TRIGGER dataset_state_guard_update BEFORE UPDATE ON dataset_state
WHEN (new.current_version IS NOT old.current_version
      AND (SELECT parent_version FROM dataset_versions WHERE version = new.current_version) IS NOT old.current_version)
  OR (SELECT content_sha256 FROM dataset_versions WHERE version = new.current_version) IS NULL
  OR new.last_change_seq < old.last_change_seq
BEGIN SELECT RAISE(ABORT, 'dataset_state: the pointer only moves forward to a sealed child version'); END;
CREATE TRIGGER dataset_state_no_delete BEFORE DELETE ON dataset_state
BEGIN SELECT RAISE(ABORT, 'dataset_state: delete not allowed'); END;

-- Maker–checker proposals --------------------------------------------------------------
CREATE TABLE rate_proposals (
  id                    TEXT PRIMARY KEY CHECK (id LIKE 'rp\_%' ESCAPE '\'),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','withdrawn')),
  action                TEXT NOT NULL CHECK (action IN
                        ('create','supersede','end_date','verify','correct','refdata_change','admin_grant')),
  supersedes_rule_id    TEXT REFERENCES rate_rules(rule_id),   -- target rule of supersede/end_date/verify/correct
  end_date              TEXT,
  rule_json             TEXT CHECK (rule_json IS NULL OR json_valid(rule_json)),       -- RateRuleInput (paise/bp)
  refdata_json          TEXT CHECK (refdata_json IS NULL OR json_valid(refdata_json)), -- RefdataChange
  grant_json            TEXT CHECK (grant_json IS NULL OR json_valid(grant_json)),     -- AdminGrant
  evidence_notification TEXT,                                  -- canonical notification_ref
  evidence_url          TEXT CHECK (evidence_url IS NULL OR evidence_url LIKE 'https://%'),
  source_pdf_sha256     TEXT CHECK (source_pdf_sha256 IS NULL
                                    OR (length(source_pdf_sha256) = 64 AND source_pdf_sha256 NOT GLOB '*[^0-9a-f]*')),
  schedule_serial       TEXT CHECK (schedule_serial IS NULL OR length(schedule_serial) BETWEEN 1 AND 64),
  retroactive_reason    TEXT CHECK (retroactive_reason IS NULL OR length(retroactive_reason) >= 10),
  rationale             TEXT NOT NULL,
  content_sha256        TEXT NOT NULL CHECK (length(content_sha256) = 64),  -- sha256(RFC 8785 JSON of the content)
  proposed_by_actor_id  TEXT NOT NULL REFERENCES admin_actors(actor_id),
  proposed_key_id       TEXT NOT NULL REFERENCES api_keys(id),
  proposed_at           TEXT NOT NULL,
  decided_by_actor_id   TEXT REFERENCES admin_actors(actor_id),
  decided_key_id        TEXT REFERENCES api_keys(id),
  decided_at            TEXT,
  decision_comment      TEXT,
  resulting_rule_id     TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED, -- pre-allocated rr_ id
  resulting_version     TEXT REFERENCES dataset_versions(version),
  CHECK ((action IN ('supersede','end_date','verify','correct')) = (supersedes_rule_id IS NOT NULL)),
  CHECK ((action IN ('create','supersede','correct')) = (rule_json IS NOT NULL)),
  CHECK ((action = 'end_date') = (end_date IS NOT NULL)),
  CHECK ((action = 'refdata_change') = (refdata_json IS NOT NULL)),
  CHECK ((action = 'admin_grant') = (grant_json IS NOT NULL)),
  CHECK (action IN ('refdata_change','admin_grant')
         OR (evidence_notification IS NOT NULL AND evidence_url IS NOT NULL
             AND source_pdf_sha256 IS NOT NULL AND schedule_serial IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved','rejected')
         OR (decided_by_actor_id IS NOT NULL AND decided_by_actor_id <> proposed_by_actor_id)),  -- maker ≠ checker
  CHECK (status <> 'withdrawn' OR decided_by_actor_id IS NULL OR decided_by_actor_id = proposed_by_actor_id),
  CHECK ((status = 'approved' AND action <> 'admin_grant') = (resulting_version IS NOT NULL)),  -- grants publish no dataset version
  CHECK ((status = 'approved' AND action IN ('create','supersede','correct')) = (resulting_rule_id IS NOT NULL))
);
CREATE INDEX rate_proposals_status ON rate_proposals(status, proposed_at);
CREATE TRIGGER rate_proposals_guard_insert BEFORE INSERT ON rate_proposals
WHEN new.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'rate_proposals: a proposal is created pending'); END;
-- Terminal proposals are immutable; while pending only the decision columns may be written,
-- and the status moves one way.
CREATE TRIGGER rate_proposals_guard_update BEFORE UPDATE ON rate_proposals
WHEN old.status <> 'pending'
  OR new.status = 'pending'
  OR new.id IS NOT old.id OR new.action IS NOT old.action OR new.supersedes_rule_id IS NOT old.supersedes_rule_id
  OR new.end_date IS NOT old.end_date OR new.rule_json IS NOT old.rule_json
  OR new.refdata_json IS NOT old.refdata_json OR new.grant_json IS NOT old.grant_json
  OR new.evidence_notification IS NOT old.evidence_notification OR new.evidence_url IS NOT old.evidence_url
  OR new.source_pdf_sha256 IS NOT old.source_pdf_sha256 OR new.schedule_serial IS NOT old.schedule_serial
  OR new.retroactive_reason IS NOT old.retroactive_reason OR new.rationale IS NOT old.rationale
  OR new.content_sha256 IS NOT old.content_sha256 OR new.proposed_by_actor_id IS NOT old.proposed_by_actor_id
  OR new.proposed_key_id IS NOT old.proposed_key_id OR new.proposed_at IS NOT old.proposed_at
BEGIN SELECT RAISE(ABORT, 'rate_proposals: content is immutable and terminal proposals cannot change'); END;
CREATE TRIGGER rate_proposals_no_delete BEFORE DELETE ON rate_proposals
BEGIN SELECT RAISE(ABORT, 'rate_proposals: delete not allowed'); END;

-- HSN / SAC master (reference data: deactivate, never update or delete) -------------------
CREATE TABLE hsn_codes (
  id               INTEGER PRIMARY KEY,           -- FTS rowid
  code             TEXT NOT NULL
                   CHECK (code NOT GLOB '*[^0-9]*'
                          AND (length(code) IN (2,4,6,8) OR (length(code) = 5 AND substr(code,1,2) = '99'))),
  level            INTEGER NOT NULL CHECK (level = length(code)),
  parent           TEXT,                          -- NULL for chapters; must be an active code (trigger)
  chapter          TEXT NOT NULL CHECK (chapter = substr(code,1,2)),
  type             TEXT NOT NULL CHECK (type IN ('goods','service')),
  description      TEXT NOT NULL,
  keywords         TEXT NOT NULL DEFAULT '',      -- curated extra search terms, space-separated
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_in_version     TEXT NOT NULL REFERENCES dataset_versions(version),
  deactivated_in_version TEXT REFERENCES dataset_versions(version),
  proposal_id      TEXT REFERENCES rate_proposals(id),
  seed_batch_id    TEXT REFERENCES seed_batches(seed_batch_id),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK ((active = 1) = (deactivated_in_version IS NULL)),
  CHECK ((level = 2) = (parent IS NULL)),
  CHECK (type = 'service' OR chapter <> '99')
);
CREATE UNIQUE INDEX hsn_codes_active_code ON hsn_codes(code) WHERE active = 1;
CREATE INDEX hsn_codes_parent ON hsn_codes(parent);
CREATE INDEX hsn_codes_chapter ON hsn_codes(chapter);

CREATE VIRTUAL TABLE hsn_fts USING fts5(
  code UNINDEXED, description, keywords,
  content = 'hsn_codes', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
-- query: SELECT code, bm25(hsn_fts, 0, 1.0, 0.5) AS rank FROM hsn_fts WHERE hsn_fts MATCH ? ORDER BY rank LIMIT ?;
-- (never called with an empty MATCH string: zero tokens → empty result, SA-D-23)

-- Provenance shared by every reference-data table: an approved refdata_change proposal that published
-- this dataset version, or the open seed batch on an empty database.
-- hsn_codes after the seed (watcher round): a row is inserted only by an approved refdata_change whose payload
-- names this exact code, either {table:'hsn_code', op:'add_code'} (a new code; no active row may exist) or
-- {table:'hsn_description', op:'update'} (replacement row for a description change). proposal_id plays the
-- role of the code's hsn_codes.added_by_proposal and, like it, is immutable.
CREATE TRIGGER hsn_codes_guard_insert BEFORE INSERT ON hsn_codes
WHEN new.active <> 1
  OR (new.parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.parent AND h.active = 1))
  OR NOT (
       EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
                 AND p.action = 'refdata_change' AND p.resulting_version = new.created_in_version
                 AND json_extract(p.refdata_json, '$.code') = new.code
                 AND ((json_extract(p.refdata_json, '$.table') = 'hsn_code'
                       AND json_extract(p.refdata_json, '$.op') = 'add_code'
                       AND NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.code AND h.active = 1))
                   OR (json_extract(p.refdata_json, '$.table') = 'hsn_description'
                       AND json_extract(p.refdata_json, '$.op') = 'update')))
    OR (EXISTS (SELECT 1 FROM seed_batches s WHERE s.seed_batch_id = new.seed_batch_id AND s.status = 'loading')
        AND NOT EXISTS (SELECT 1 FROM dataset_state)))
BEGIN SELECT RAISE(ABORT, 'hsn_codes: insert needs an approved refdata_change or the open seed batch; parent must exist'); END;
CREATE TRIGGER hsn_codes_guard_update BEFORE UPDATE ON hsn_codes
WHEN NOT (new.id IS old.id AND new.code IS old.code AND new.level IS old.level AND new.parent IS old.parent
          AND new.chapter IS old.chapter AND new.type IS old.type AND new.description IS old.description
          AND new.keywords IS old.keywords AND new.created_in_version IS old.created_in_version
          AND new.proposal_id IS old.proposal_id AND new.seed_batch_id IS old.seed_batch_id
          AND old.active = 1 AND new.active = 0
          AND EXISTS (SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'refdata_change'
                        AND p.resulting_version = new.deactivated_in_version
                        AND json_extract(p.refdata_json, '$.table') = 'hsn_description'
                        AND json_extract(p.refdata_json, '$.op') = 'update'
                        AND json_extract(p.refdata_json, '$.code') = old.code))
BEGIN SELECT RAISE(ABORT, 'hsn_codes: a row is only replaced, by an approved hsn_description update for that code'); END;
CREATE TRIGGER hsn_codes_no_delete BEFORE DELETE ON hsn_codes
BEGIN SELECT RAISE(ABORT, 'hsn_codes: delete not allowed; deactivate instead'); END;
CREATE TRIGGER hsn_codes_fts_ai AFTER INSERT ON hsn_codes BEGIN
  INSERT INTO hsn_fts(rowid, code, description, keywords) VALUES (new.id, new.code, new.description, new.keywords);
END;
CREATE TRIGGER hsn_codes_fts_deactivate AFTER UPDATE OF active ON hsn_codes WHEN old.active = 1 AND new.active = 0 BEGIN
  INSERT INTO hsn_fts(hsn_fts, rowid, code, description, keywords)
  VALUES ('delete', old.id, old.code, old.description, old.keywords);
END;

-- Rate rules (published, human-reviewed) ----------------------------------------------------
CREATE TABLE rate_rules (
  rule_id              TEXT PRIMARY KEY CHECK (rule_id LIKE 'rr\_%' ESCAPE '\'),
  hsn_prefix           TEXT NOT NULL
                       CHECK (hsn_prefix NOT GLOB '*[^0-9]*'
                              AND (length(hsn_prefix) IN (2,4,6,8)
                                   OR (length(hsn_prefix) = 5 AND substr(hsn_prefix,1,2) = '99'))),
  igst_rate_bp         INTEGER NOT NULL CHECK (igst_rate_bp BETWEEN 0 AND 10000), -- slab list HSN_ALLOWED_RATES_BP (zod)
  cess_rate_bp         INTEGER NOT NULL DEFAULT 0 CHECK (cess_rate_bp BETWEEN 0 AND 30000),
  cess_specific_paise  INTEGER CHECK (cess_specific_paise IS NULL OR cess_specific_paise > 0),
  cess_specific_unit   TEXT,
  condition_kind       TEXT NOT NULL DEFAULT 'none' CHECK (condition_kind IN ('none','price','other')),
  condition_text       TEXT,                       -- verbatim/near-verbatim from the notification
  condition_code       TEXT CHECK (condition_code IS NULL
                                   OR (length(condition_code) BETWEEN 3 AND 32 AND condition_code NOT GLOB '*[^a-z_]*')),
                                                   -- machine code of an 'other' condition, e.g. 'nil_rate_list' (ruling 5;
                                                   -- allowed values listed in zod CONDITION_CODES); matched by synonyms.rule_hint
  min_unit_price_paise INTEGER CHECK (min_unit_price_paise IS NULL OR min_unit_price_paise >= 0), -- inclusive
  max_unit_price_paise INTEGER CHECK (max_unit_price_paise IS NULL OR max_unit_price_paise >= 0), -- inclusive
  effective_from       TEXT NOT NULL CHECK (effective_from >= '2017-07-01'),
  effective_to         TEXT CHECK (effective_to IS NULL OR effective_to >= effective_from),   -- set once
  notification_ref     TEXT NOT NULL,              -- canonical, e.g. '9/2025-CT(Rate), Schedule IV'
  source_url           TEXT NOT NULL CHECK (source_url LIKE 'https://%'),  -- exact host in HSN_SOURCE_HOSTS (zod)
  schedule_serial      TEXT,                       -- e.g. 'S.No. 3'; set once (seed rows: by their verify proposal)
  source_pdf_sha256    TEXT CHECK (source_pdf_sha256 IS NULL
                                   OR (length(source_pdf_sha256) = 64 AND source_pdf_sha256 NOT GLOB '*[^0-9a-f]*')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_in_version    TEXT REFERENCES dataset_versions(version),
  voided_by_proposal_id TEXT REFERENCES rate_proposals(id),
  verification_status  TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('verified','unverified')),
  verified_by          TEXT REFERENCES admin_actors(actor_id),   -- first verifier; set once
  last_verified_at     TEXT,                                     -- moves forward only (re-verification)
  reverify_due_at      TEXT GENERATED ALWAYS AS (
                         CASE WHEN last_verified_at IS NULL THEN NULL
                              ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_verified_at, '+12 months') END) VIRTUAL,
  retroactive          INTEGER NOT NULL DEFAULT 0 CHECK (retroactive IN (0,1)),
  created_in_version   TEXT NOT NULL REFERENCES dataset_versions(version),
  end_dated_in_version TEXT REFERENCES dataset_versions(version),   -- set once
  superseded_by        TEXT REFERENCES rate_rules(rule_id) DEFERRABLE INITIALLY DEFERRED,  -- set once
  proposal_id          TEXT REFERENCES rate_proposals(id),
  seed_batch_id        TEXT REFERENCES seed_batches(seed_batch_id),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK (seed_batch_id IS NOT NULL OR (schedule_serial IS NOT NULL AND source_pdf_sha256 IS NOT NULL)),
  CHECK ((condition_kind = 'price') = (min_unit_price_paise IS NOT NULL OR max_unit_price_paise IS NOT NULL)),
  CHECK (condition_kind = 'none' OR condition_text IS NOT NULL),
  CHECK (condition_code IS NULL OR condition_kind = 'other'),
  CHECK (min_unit_price_paise IS NULL OR max_unit_price_paise IS NULL OR min_unit_price_paise <= max_unit_price_paise),
  CHECK ((cess_specific_paise IS NULL) = (cess_specific_unit IS NULL)),
  CHECK ((status = 'voided') = (voided_in_version IS NOT NULL)),
  CHECK ((voided_in_version IS NULL) = (voided_by_proposal_id IS NULL)),
  CHECK (superseded_by IS NULL OR effective_to IS NOT NULL),
  CHECK (end_dated_in_version IS NULL OR effective_to IS NOT NULL),
  CHECK (verification_status = 'unverified' OR (verified_by IS NOT NULL AND last_verified_at IS NOT NULL)),
  CHECK (verification_status = 'verified' OR (verified_by IS NULL AND last_verified_at IS NULL))
);
CREATE INDEX rate_rules_prefix_dates ON rate_rules(hsn_prefix, effective_from, effective_to) WHERE status = 'active';

-- Insert: an approved create/supersede/correct proposal that pre-allocated exactly this rule_id
-- (the proposal row is marked approved first in the same transaction), or the open seed batch.
CREATE TRIGGER rate_rules_guard_insert BEFORE INSERT ON rate_rules
WHEN new.status <> 'active' OR new.superseded_by IS NOT NULL OR new.end_dated_in_version IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.hsn_prefix AND h.active = 1)
  OR NOT (
       (new.proposal_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM rate_proposals p
          WHERE p.id = new.proposal_id AND p.status = 'approved' AND p.action IN ('create','supersede','correct')
            AND p.resulting_rule_id = new.rule_id AND p.resulting_version = new.created_in_version
            AND new.verification_status = 'verified' AND new.verified_by = p.decided_by_actor_id
            AND new.last_verified_at = p.decided_at
            AND new.source_pdf_sha256 = p.source_pdf_sha256 AND new.schedule_serial = p.schedule_serial))
    OR (new.seed_batch_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM seed_batches s WHERE s.seed_batch_id = new.seed_batch_id AND s.status = 'loading')
        AND NOT EXISTS (SELECT 1 FROM dataset_state)
        AND new.verification_status = 'unverified'))
BEGIN SELECT RAISE(ABORT, 'rate_rules: insert needs an approved proposal naming this rule (verified by its checker) or the open seed batch (unverified)'); END;

-- Update: rate content never changes. effective_to, end_dated_in_version, superseded_by, verified_by,
-- schedule_serial, source_pdf_sha256 and the void columns are each set once from NULL, and only with the
-- matching approved proposal; last_verified_at only moves forward; a voided rule never changes again.
CREATE TRIGGER rate_rules_guard_update BEFORE UPDATE ON rate_rules
WHEN old.status = 'voided'
  OR new.rule_id IS NOT old.rule_id OR new.hsn_prefix IS NOT old.hsn_prefix
  OR new.igst_rate_bp IS NOT old.igst_rate_bp OR new.cess_rate_bp IS NOT old.cess_rate_bp
  OR new.cess_specific_paise IS NOT old.cess_specific_paise OR new.cess_specific_unit IS NOT old.cess_specific_unit
  OR new.condition_kind IS NOT old.condition_kind OR new.condition_text IS NOT old.condition_text OR new.condition_code IS NOT old.condition_code
  OR new.min_unit_price_paise IS NOT old.min_unit_price_paise OR new.max_unit_price_paise IS NOT old.max_unit_price_paise
  OR new.effective_from IS NOT old.effective_from OR new.notification_ref IS NOT old.notification_ref
  OR new.source_url IS NOT old.source_url OR new.created_in_version IS NOT old.created_in_version
  OR new.proposal_id IS NOT old.proposal_id OR new.seed_batch_id IS NOT old.seed_batch_id
  OR new.retroactive IS NOT old.retroactive
  OR (old.effective_to IS NOT NULL AND new.effective_to IS NOT old.effective_to)
  OR (old.end_dated_in_version IS NOT NULL AND new.end_dated_in_version IS NOT old.end_dated_in_version)
  OR (old.superseded_by IS NOT NULL AND new.superseded_by IS NOT old.superseded_by)
  OR (old.verified_by IS NOT NULL AND new.verified_by IS NOT old.verified_by)
  OR (old.schedule_serial IS NOT NULL AND new.schedule_serial IS NOT old.schedule_serial)
  OR (old.source_pdf_sha256 IS NOT NULL AND new.source_pdf_sha256 IS NOT old.source_pdf_sha256)
  OR (old.verification_status = 'verified' AND new.verification_status IS NOT 'verified')
  OR (new.last_verified_at IS NOT old.last_verified_at
      AND (new.last_verified_at IS NULL OR (old.last_verified_at IS NOT NULL AND new.last_verified_at <= old.last_verified_at)))
  -- end-dating needs an approved supersede/end_date proposal for this rule that published end_dated_in_version
  OR (old.effective_to IS NULL AND new.effective_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action IN ('supersede','end_date')
          AND p.supersedes_rule_id = old.rule_id AND p.resulting_version = new.end_dated_in_version))
  -- voiding needs the approved correct proposal for this rule
  OR (new.status = 'voided' AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.id = new.voided_by_proposal_id AND p.status = 'approved'
          AND p.action = 'correct' AND p.supersedes_rule_id = old.rule_id AND p.resulting_version = new.voided_in_version))
  -- (re)verification needs an approved verify proposal for this rule decided at exactly new.last_verified_at
  OR (new.last_verified_at IS NOT old.last_verified_at AND NOT EXISTS (
        SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'verify'
          AND p.supersedes_rule_id = old.rule_id AND p.decided_at = new.last_verified_at
          AND (old.verified_by IS NOT NULL OR p.decided_by_actor_id = new.verified_by)
          AND (old.schedule_serial IS NOT NULL OR p.schedule_serial = new.schedule_serial)
          AND (old.source_pdf_sha256 IS NOT NULL OR p.source_pdf_sha256 = new.source_pdf_sha256)))
  -- evidence columns may only be filled together with a verification
  OR ((new.schedule_serial IS NOT old.schedule_serial OR new.source_pdf_sha256 IS NOT old.source_pdf_sha256
       OR new.verified_by IS NOT old.verified_by)
      AND new.last_verified_at IS old.last_verified_at)
BEGIN SELECT RAISE(ABORT, 'rate_rules: published rule content is immutable; use supersede, end_date, correct or verify'); END;
CREATE TRIGGER rate_rules_no_delete BEFORE DELETE ON rate_rules
BEGIN SELECT RAISE(ABORT, 'rate_rules: delete not allowed; end-date or correct instead'); END;

-- Every verification (publish, first verify, re-verify), append-only ------------------------
CREATE TABLE rule_verifications (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id              TEXT NOT NULL REFERENCES rate_rules(rule_id),
  proposal_id          TEXT NOT NULL UNIQUE REFERENCES rate_proposals(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('publish','verify','reverify')),
  verified_by_actor_id TEXT NOT NULL REFERENCES admin_actors(actor_id),
  verified_at          TEXT NOT NULL,
  source_pdf_sha256    TEXT NOT NULL CHECK (length(source_pdf_sha256) = 64),
  schedule_serial      TEXT NOT NULL
);
CREATE TRIGGER rule_verifications_no_update BEFORE UPDATE ON rule_verifications
BEGIN SELECT RAISE(ABORT, 'rule_verifications is append-only'); END;
CREATE TRIGGER rule_verifications_no_delete BEFORE DELETE ON rule_verifications
BEGIN SELECT RAISE(ABORT, 'rule_verifications is append-only'); END;

-- Change feed (clients poll /v1/rates/changes?since=seq) -------------------------------------
CREATE TABLE change_feed (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_version  TEXT NOT NULL REFERENCES dataset_versions(version),
  published_at     TEXT NOT NULL,
  change_type      TEXT NOT NULL CHECK (change_type IN
                   ('rule_added','rule_end_dated','rule_verified','rule_corrected','hsn_added','hsn_updated','refdata_changed')),
  affected_prefix  TEXT NOT NULL CHECK (affected_prefix NOT GLOB '*[^0-9]*' AND length(affected_prefix) BETWEEN 2 AND 8),
                   -- clients invalidate cached code c when c starts with it OR it starts with c (ruling 3)
  rule_id          TEXT REFERENCES rate_rules(rule_id),
  related_rule_id TEXT REFERENCES rate_rules(rule_id),     -- rule_corrected: the voided rule
  effective_from   TEXT,
  effective_to     TEXT,
  retroactive      INTEGER NOT NULL DEFAULT 0 CHECK (retroactive IN (0,1)),
  affects_from     TEXT,                                     -- first date whose answer changed (retroactive rows)
  summary          TEXT NOT NULL,
  CHECK ((change_type = 'rule_corrected') = (related_rule_id IS NOT NULL)),
  CHECK (change_type NOT LIKE 'rule\_%' ESCAPE '\' OR rule_id IS NOT NULL),
  CHECK (retroactive = 0 OR affects_from IS NOT NULL)
);
CREATE TRIGGER change_feed_no_update BEFORE UPDATE ON change_feed
BEGIN SELECT RAISE(ABORT, 'change_feed is append-only'); END;
CREATE TRIGGER change_feed_no_delete BEFORE DELETE ON change_feed
BEGIN SELECT RAISE(ABORT, 'change_feed is append-only'); END;

-- Audit log (append-only, HMAC-chained with HSN_AUDIT_KEY) -----------------------------------
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('admin','operator','system')),
  actor_id     TEXT REFERENCES admin_actors(actor_id),    -- set for 'admin'; never a name (SA-D-19)
  key_id       TEXT,                                      -- never key material
  action       TEXT NOT NULL,       -- 'rate_proposal.approved', 'admin_key.created', 'dataset.seeded', …
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  prev_hash    TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash         TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  CHECK ((actor_kind = 'admin') = (actor_id IS NOT NULL))
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Idempotency for admin writes (ruling 8) ---------------------------------------------------
CREATE TABLE idempotency_keys (
  key_id          TEXT NOT NULL REFERENCES api_keys(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 64),
  route           TEXT NOT NULL,          -- route pattern + resolved id, e.g. 'POST /v1/admin/rate-proposals/rp_…/approve'
  request_hash    TEXT NOT NULL CHECK (length(request_hash) = 64),   -- sha256(method, route, RFC 8785 body)
  response_status INTEGER NOT NULL,
  response_json   TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,          -- created_at + 24 h; expired rows are ignored and purged hourly
  PRIMARY KEY (key_id, idempotency_key)
);
CREATE INDEX idempotency_keys_expiry ON idempotency_keys(expires_at);

-- CBIC notification watcher (ruling 10) ------------------------------------------------------
CREATE TABLE watched_notifications (
  notification_no       TEXT PRIMARY KEY,   -- canonical, e.g. '1/2026-CT(Rate)'
  kind                  TEXT NOT NULL CHECK (kind IN ('central_tax_rate','integrated_tax_rate','ut_tax_rate','cess_rate','other')),
  source                TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','cbic_watcher')),
  notification_key      TEXT CHECK (notification_key IS NULL OR length(notification_key) BETWEEN 5 AND 120),
                        -- '<series>:<number>/<year>', e.g. 'central_tax_rate:1/2026' (corrigenda ':corrigendum:<date>');
                        -- computed the same way for watcher and manual rows, so neither can create a duplicate
  title                 TEXT CHECK (title IS NULL OR length(title) <= 500),
  published_on          TEXT,               -- the notification's own date as listed (code: notification_date)
  url                   TEXT CHECK (url IS NULL OR url LIKE 'https://%'),   -- host in HSN_SOURCE_HOSTS; never fetched
  detected_at           TEXT NOT NULL,
  effective_from        TEXT,
  expedite              INTEGER NOT NULL DEFAULT 0 CHECK (expedite IN (0,1)),
  affected_prefixes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_prefixes_json)),  -- '[]' = untriaged
  state                 TEXT NOT NULL DEFAULT 'detected' CHECK (state IN ('detected','published','dismissed')),
  closed_at             TEXT,
  closed_in_version     TEXT REFERENCES dataset_versions(version),
  CHECK ((state = 'detected') = (closed_at IS NULL)),
  CHECK (state <> 'published' OR closed_in_version IS NOT NULL)
);
CREATE UNIQUE INDEX watched_notifications_key ON watched_notifications(notification_key) WHERE notification_key IS NOT NULL;
-- While 'detected', triage may set affected_prefixes_json, effective_from and expedite, and the row may be
-- closed (published | dismissed). Identity columns never change, and a closed row is frozen.
CREATE TRIGGER watched_notifications_guard_update BEFORE UPDATE ON watched_notifications
WHEN old.state <> 'detected' OR new.notification_no IS NOT old.notification_no OR new.detected_at IS NOT old.detected_at
  OR new.kind IS NOT old.kind OR new.source IS NOT old.source OR new.notification_key IS NOT old.notification_key
  OR new.title IS NOT old.title OR new.published_on IS NOT old.published_on OR new.url IS NOT old.url
BEGIN SELECT RAISE(ABORT, 'watched_notifications: closed rows are immutable; identity columns never change'); END;
CREATE TRIGGER watched_notifications_no_delete BEFORE DELETE ON watched_notifications
BEGIN SELECT RAISE(ABORT, 'watched_notifications: delete not allowed'); END;

-- CBIC watcher run log (freshness alert: last ok run older than 36 h; sources_checked_at) ------------
CREATE TABLE watcher_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL CHECK (source IN ('cbic')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','failed')),
  items_seen    INTEGER NOT NULL CHECK (items_seen >= 0),
  items_new     INTEGER NOT NULL CHECK (items_new >= 0),
  error         TEXT CHECK (error IS NULL OR length(error) <= 2000),   -- e.g. 'shape_changed', 'too_large', 'timeout'
  details_json  TEXT NOT NULL CHECK (json_valid(details_json)),        -- per page: url, status, reason, counts
  CHECK ((status = 'ok') = (error IS NULL))
);
CREATE INDEX watcher_runs_status ON watcher_runs(source, status, finished_at);
CREATE TRIGGER watcher_runs_no_update BEFORE UPDATE ON watcher_runs
BEGIN SELECT RAISE(ABORT, 'watcher_runs is append-only'); END;
CREATE TRIGGER watcher_runs_no_delete BEFORE DELETE ON watcher_runs
BEGIN SELECT RAISE(ABORT, 'watcher_runs is append-only'); END;

-- Barcode product cache (no PII; external data, untrusted) -------------------------------------
CREATE TABLE products (
  gtin                 TEXT PRIMARY KEY CHECK (length(gtin) = 14 AND gtin NOT GLOB '*[^0-9]*'),  -- GTIN-14
  name                 TEXT,
  brand                TEXT,
  category             TEXT,                          -- source taxonomy tag, e.g. 'en:biscuits'
  source               TEXT NOT NULL CHECK (source IN ('open_food_facts','open_beauty_facts')),
  source_ref           TEXT,                          -- source's product URL
  source_last_modified TEXT,                          -- OFF last_modified_t (RFC 3339)
  found                INTEGER NOT NULL CHECK (found IN (0,1)),     -- negative caching
  fetched_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL                  -- found: fetched_at + 7 days; not found: + 1 day
);
CREATE INDEX products_fetched ON products(fetched_at);  -- oldest-first eviction above HSN_PRODUCT_CACHE_MAX_ROWS (ruling 30)

-- Curated reference data (deactivate, never update or delete; ruling 23) ----------------------
CREATE TABLE synonyms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase         TEXT NOT NULL,                       -- normalised (architecture.md §5.1)
  hsn_code       TEXT NOT NULL,                       -- must be an active hsn_codes.code (trigger)
  strength       TEXT NOT NULL DEFAULT 'primary' CHECK (strength IN ('primary','related')),
  note           TEXT,                                -- reviewer hint surfaced as reason 'review_hint'
  rule_hint      TEXT CHECK (rule_hint IS NULL OR (length(rule_hint) BETWEEN 3 AND 32 AND rule_hint NOT GLOB '*[^a-z_]*')),
                                                      -- condition_code of the rule this exact phrase selects (ruling 5)
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_in_version     TEXT NOT NULL REFERENCES dataset_versions(version),
  deactivated_in_version TEXT REFERENCES dataset_versions(version),
  proposal_id    TEXT REFERENCES rate_proposals(id),
  seed_batch_id  TEXT REFERENCES seed_batches(seed_batch_id),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK ((active = 1) = (deactivated_in_version IS NULL))
);
CREATE UNIQUE INDEX synonyms_active ON synonyms(phrase, hsn_code) WHERE active = 1;

CREATE TABLE category_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,                          -- 'open_food_facts'
  category    TEXT NOT NULL,                          -- 'en:biscuits'
  hsn_prefix  TEXT NOT NULL,                          -- '1905' (heading) or '19' (chapter); must be an active code
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_in_version     TEXT NOT NULL REFERENCES dataset_versions(version),
  deactivated_in_version TEXT REFERENCES dataset_versions(version),
  proposal_id    TEXT REFERENCES rate_proposals(id),
  seed_batch_id  TEXT REFERENCES seed_batches(seed_batch_id),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK ((active = 1) = (deactivated_in_version IS NULL))
);
CREATE UNIQUE INDEX category_map_active ON category_map(source, category) WHERE active = 1;

CREATE TABLE chapter_keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT NOT NULL,                          -- normalised single token: 'tablet','mg','gold','22k'
  chapter     TEXT NOT NULL CHECK (length(chapter) = 2 AND chapter NOT GLOB '*[^0-9]*'),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_in_version     TEXT NOT NULL REFERENCES dataset_versions(version),
  deactivated_in_version TEXT REFERENCES dataset_versions(version),
  proposal_id    TEXT REFERENCES rate_proposals(id),
  seed_batch_id  TEXT REFERENCES seed_batches(seed_batch_id),
  CHECK ((proposal_id IS NULL) <> (seed_batch_id IS NULL)),
  CHECK ((active = 1) = (deactivated_in_version IS NULL))
);
CREATE UNIQUE INDEX chapter_keywords_active ON chapter_keywords(keyword, chapter) WHERE active = 1;

-- The same three guards on each curated table (shown expanded for synonyms; category_map and
-- chapter_keywords are identical apart from the column lists and the code-existence check).
CREATE TRIGGER synonyms_guard_insert BEFORE INSERT ON synonyms
WHEN new.active <> 1
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.hsn_code AND h.active = 1)
  OR NOT (
       EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
                 AND p.action = 'refdata_change' AND p.resulting_version = new.created_in_version)
    OR (EXISTS (SELECT 1 FROM seed_batches s WHERE s.seed_batch_id = new.seed_batch_id AND s.status = 'loading')
        AND NOT EXISTS (SELECT 1 FROM dataset_state)))
BEGIN SELECT RAISE(ABORT, 'synonyms: insert needs an approved refdata_change or the open seed batch'); END;
CREATE TRIGGER synonyms_guard_update BEFORE UPDATE ON synonyms
WHEN NOT (new.id IS old.id AND new.phrase IS old.phrase AND new.hsn_code IS old.hsn_code
          AND new.strength IS old.strength AND new.note IS old.note AND new.rule_hint IS old.rule_hint
          AND new.created_in_version IS old.created_in_version AND new.proposal_id IS old.proposal_id
          AND new.seed_batch_id IS old.seed_batch_id AND old.active = 1 AND new.active = 0
          AND EXISTS (SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'refdata_change'
                        AND p.resulting_version = new.deactivated_in_version))
BEGIN SELECT RAISE(ABORT, 'synonyms: rows are only deactivated, by an approved refdata_change'); END;
CREATE TRIGGER synonyms_no_delete BEFORE DELETE ON synonyms
BEGIN SELECT RAISE(ABORT, 'synonyms: delete not allowed; deactivate instead'); END;

CREATE TRIGGER category_map_guard_insert BEFORE INSERT ON category_map
WHEN new.active <> 1
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.hsn_prefix AND h.active = 1)
  OR NOT (
       EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
                 AND p.action = 'refdata_change' AND p.resulting_version = new.created_in_version)
    OR (EXISTS (SELECT 1 FROM seed_batches s WHERE s.seed_batch_id = new.seed_batch_id AND s.status = 'loading')
        AND NOT EXISTS (SELECT 1 FROM dataset_state)))
BEGIN SELECT RAISE(ABORT, 'category_map: insert needs an approved refdata_change or the open seed batch'); END;
CREATE TRIGGER category_map_guard_update BEFORE UPDATE ON category_map
WHEN NOT (new.id IS old.id AND new.source IS old.source AND new.category IS old.category
          AND new.hsn_prefix IS old.hsn_prefix AND new.created_in_version IS old.created_in_version
          AND new.proposal_id IS old.proposal_id AND new.seed_batch_id IS old.seed_batch_id
          AND old.active = 1 AND new.active = 0
          AND EXISTS (SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'refdata_change'
                        AND p.resulting_version = new.deactivated_in_version))
BEGIN SELECT RAISE(ABORT, 'category_map: rows are only deactivated, by an approved refdata_change'); END;
CREATE TRIGGER category_map_no_delete BEFORE DELETE ON category_map
BEGIN SELECT RAISE(ABORT, 'category_map: delete not allowed; deactivate instead'); END;

CREATE TRIGGER chapter_keywords_guard_insert BEFORE INSERT ON chapter_keywords
WHEN new.active <> 1
  OR NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.code = new.chapter AND h.active = 1)
  OR NOT (
       EXISTS (SELECT 1 FROM rate_proposals p WHERE p.id = new.proposal_id AND p.status = 'approved'
                 AND p.action = 'refdata_change' AND p.resulting_version = new.created_in_version)
    OR (EXISTS (SELECT 1 FROM seed_batches s WHERE s.seed_batch_id = new.seed_batch_id AND s.status = 'loading')
        AND NOT EXISTS (SELECT 1 FROM dataset_state)))
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: insert needs an approved refdata_change or the open seed batch'); END;
CREATE TRIGGER chapter_keywords_guard_update BEFORE UPDATE ON chapter_keywords
WHEN NOT (new.id IS old.id AND new.keyword IS old.keyword AND new.chapter IS old.chapter
          AND new.created_in_version IS old.created_in_version
          AND new.proposal_id IS old.proposal_id AND new.seed_batch_id IS old.seed_batch_id
          AND old.active = 1 AND new.active = 0
          AND EXISTS (SELECT 1 FROM rate_proposals p WHERE p.status = 'approved' AND p.action = 'refdata_change'
                        AND p.resulting_version = new.deactivated_in_version))
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: rows are only deactivated, by an approved refdata_change'); END;
CREATE TRIGGER chapter_keywords_no_delete BEFORE DELETE ON chapter_keywords
BEGIN SELECT RAISE(ABORT, 'chapter_keywords: delete not allowed; deactivate instead'); END;
