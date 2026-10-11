/**
 * Incremental migrations applied on top of schema.sql (the version-2 base). A fresh database runs
 * schema.sql and then every step below; an existing version-2 database runs only the steps it lacks.
 * Steps are additive (ALTER TABLE ADD COLUMN, new tables, trigger replacement) so data is kept.
 */
export interface MigrationStep {
  version: number;
  name: string;
  sql: string;
}

const V3_WATCHER_AND_ADD_CODE = `
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
`;

const V4_PEPPER_ID_AND_PRODUCT_CACHE = `
-- (1) Pepper rotation (ruling 29): each key records which pepper hashed it. Keys issued before this
--     step were hashed with HSN_KEY_PEPPER, whose id is "default". Set once at insert, never changed.
ALTER TABLE api_keys ADD COLUMN pepper_id TEXT NOT NULL DEFAULT 'default'
  CHECK (length(pepper_id) BETWEEN 1 AND 32 AND NOT pepper_id GLOB '*[^a-z0-9_-]*');
CREATE TRIGGER api_keys_pepper_id_immutable BEFORE UPDATE OF pepper_id ON api_keys
WHEN new.pepper_id IS NOT old.pepper_id
BEGIN SELECT RAISE(ABORT, 'api_keys: pepper_id is immutable (re-issue the key instead)'); END;

-- (2) Product cache bound (ruling 30): oldest-first eviction scans by fetched_at.
CREATE INDEX products_fetched_at ON products(fetched_at, gtin);
`;

const V5_BOUND_GUARDS = `
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
`;

/** v6 (round 5): seed caveat text on rate rules. Set only by the seed path; cleared only by a verify. */
const V6_CITATION_NOTE = `
ALTER TABLE rate_rules ADD COLUMN citation_note TEXT CHECK (citation_note IS NULL OR length(citation_note) BETWEEN 1 AND 1000);
CREATE TRIGGER rate_rules_guard_citation_note_insert BEFORE INSERT ON rate_rules
WHEN new.citation_note IS NOT NULL AND new.seed_batch_id IS NULL
BEGIN SELECT RAISE(ABORT, 'rate_rules: citation_note is set only by the seed path'); END;
CREATE TRIGGER rate_rules_guard_citation_note_update BEFORE UPDATE OF citation_note ON rate_rules
WHEN new.citation_note IS NOT old.citation_note
 AND NOT (new.citation_note IS NULL AND new.last_verified_at IS NOT old.last_verified_at)
BEGIN SELECT RAISE(ABORT, 'rate_rules: citation_note can only be cleared, and only by a verify'); END;
`;

/**
 * v7 (round 6, SA-C3-03): two-admin confirmation also for (a) any row carrying a CBIC notification key (a manual
 * row for a not-yet-listed notification would otherwise pre-empt the watcher and be dismissed by one admin) and
 * (b) the first triage of an untriaged row.
 */
const V7_WATCH_CONFIRM_KEYED = `
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
`;

/**
 * v8 (round 9, ruling 36): the first verify of a seed rule may replace its citation (source_url, notification_ref)
 * with exactly the document URL / canonical notification of the approved verify proposal, in the same update
 * that marks it verified. Every other citation change stays refused.
 */
const V8_VERIFY_CITATION = `
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
`;

export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 3, name: 'cbic watcher + add_code', sql: V3_WATCHER_AND_ADD_CODE },
  { version: 4, name: 'api key pepper_id + product cache index', sql: V4_PEPPER_ID_AND_PRODUCT_CACHE },
  { version: 5, name: 'bound guards, proposal insert guard, watcher confirmation', sql: V5_BOUND_GUARDS },
  { version: 6, name: 'rate_rules.citation_note', sql: V6_CITATION_NOTE },
  { version: 7, name: 'two-admin confirmation for keyed watch rows and first triage', sql: V7_WATCH_CONFIRM_KEYED },
  { version: 8, name: 'verify may replace an index-page citation (ruling 36)', sql: V8_VERIFY_CITATION },
];

/** schema.sql creates this version; MIGRATIONS move it forward. */
export const BASE_SCHEMA_VERSION = 2;
