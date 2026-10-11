import sys
S='/tmp/claude-0/-home-claude/962f84b0-1380-5f53-8c9f-f3c861af4b17/scratchpad/oa/'
p1=open(S+'part1.yaml').read(); p2=open(S+'part2.yaml').read()
def rep(s,a,b,n=1):
    c=s.count(a)
    if c!=n: print('MISSING',c,a[:100]); sys.exit(1)
    return s.replace(a,b)
# classifier version
p2=rep(p2,"currently rules-fts-2.1 (round 4: synonym exactness and the imitation-jewellery qualifier).'","currently rules-fts-2.2 (2.1: synonym exactness and the imitation-jewellery qualifier; 2.2: quantity tokens need an allow-listed unit, and brand words from a barcode lookup never count towards exactness).'")
p1=rep(p1,"fusion, `classifier.version` `rules-fts-2.1`, architecture.md §5.4).","fusion, `classifier.version` `rules-fts-2.2`, architecture.md §5.4).")
p1=rep(p1,"""        since `rules-fts-2.1` (round 4, validator R2) a synonym is exact only when it is
        the whole name: after removing its tokens nothing may remain except quantities,
        units, pack words, dosage forms, function words and (from a barcode lookup) the
        brand.""","""        since `rules-fts-2.1` (validator R2) a synonym is exact only when it is the whole
        name: after removing its tokens nothing may remain except quantities (a number,
        optionally with an allow-listed unit such as g, kg, mg, ml, l, cm, pcs, x, mah, gb,
        or a karat value; `rules-fts-2.2`), pack words, dosage forms and function words.
        Brand words from a barcode lookup never count (`rules-fts-2.2`, SA-K3-01).""")
n=p1.count("version: rules-fts-2.1"); p1=p1.replace("version: rules-fts-2.1","version: rules-fts-2.2")
n2=p1.count("'rules-fts-2.1'"); p1=p1.replace("'rules-fts-2.1'","'rules-fts-2.2'")
print('example versions replaced',n,n2)
# tax warnings
p2=rep(p2,"warning, candidate_rules, code_in_master, resolved_via, needs_input, notes]","warning, warnings, candidate_rules, code_in_master, resolved_via, needs_input, notes]")
p2=rep(p2,"""        unverified_accepted: { type: boolean, description: 'true when tax was computed on an unverified rule because the request set accept_unverified.' }
""","""        unverified_accepted: { type: boolean, description: 'true when tax was computed on an unverified rule because the request set accept_unverified.' }
        warnings:
          type: array
          items: { type: string, enum: [code_not_in_master] }
          description: 'Round 6 (SA-C3-08): `["code_not_in_master"]` when the line''s code is not in the HSN master and was resolved under `resolved_via`; the line is still computed. Otherwise `[]`. Open enum: clients must ignore unknown values.'
""")
p2=rep(p2,"      required: [invoice_date, complete, lines, totals, totals_paise, partial_totals, invoice_rounding, dataset_version, disclaimer]","      required: [invoice_date, complete, lines, totals, totals_paise, partial_totals, invoice_rounding, warnings, dataset_version, disclaimer]")
p2=rep(p2,"""        invoice_rounding: { type: string, enum: [none, nearest_rupee] }
        round_off_paise:""","""        invoice_rounding: { type: string, enum: [none, nearest_rupee] }
        warnings:
          type: array
          items: { type: string, enum: [code_not_in_master] }
          description: 'Round 6 (SA-C3-08): contains `code_not_in_master` when any line does. A not-in-master line is computed, so `complete` can be true together with this warning.'
        round_off_paise:""")
# hash mismatch on stored content
p1=rep(p1,"""        `actor_id` equals the proposer's; `409 proposal-hash-mismatch` when
        `expected_sha256` ≠ the proposal's `content_sha256`;""","""        `actor_id` equals the proposer's; `409 proposal-hash-mismatch` when
        `expected_sha256` ≠ the proposal's `content_sha256`, or when the stored content no
        longer hashes to its `content_sha256` (edited in the database; round 6, SA-C3-01);""")
p1=rep(p1,"      description: Same maker–checker, `expected_sha256`, idempotency and not-pending rules as approve.","      description: Same maker–checker, `expected_sha256` (including the stored-content re-hash, 409 `proposal-hash-mismatch`), idempotency and not-pending rules as approve.")
# watched notifications: keyed rows and first triage
p1=rep(p1,"""        **Two admins to remove prefixes (round 4, SA-C2-03).** A triage that removes
        prefixes from a `cbic_watcher` row is first stored as `pending_action`""","""        **Two admins (rounds 4 and 6, SA-C2-03, SA-C3-03).** On a row that carries a CBIC
        `notification_key` (every `cbic_watcher` row, and manual rows whose notification
        parses to a key), the **first** triage (setting prefixes on an untriaged row) and
        any triage that **removes** prefixes is first stored as `pending_action`""")
p1=rep(p1,"""        Adding prefixes, and manual rows, stay single-admin.
      security:""","""        Later additions of prefixes, and manual rows without a notification key, stay
        single-admin. The database trigger refuses a direct change (schema v7).
      security:""")
p1=rep(p1,"          description: Removal of prefixes from a watcher row stored as `pending_action`; a second admin must repeat it.","          description: First triage, or removal of prefixes, on a keyed row stored as `pending_action`; a second admin must repeat it.")
p1=rep(p1,"""        **Two admins for watcher rows (round 4, SA-C2-03).** Resolving a
        `cbic_watcher` row turns its warnings and SLA alert off, so the first request
        is stored as `pending_action` and returns **202** with the row; a *different*
        admin repeating it applies it (403 `maker-checker-violation` for the same
        actor). Manual rows resolve in one step.""","""        **Two admins for keyed rows (rounds 4 and 6, SA-C2-03, SA-C3-03).** Resolving a
        row that carries a CBIC `notification_key` (every `cbic_watcher` row, and a manual
        row whose notification parses to a key) turns its warnings and SLA alert off, so
        the first request is stored as `pending_action` and returns **202** with the row;
        a *different* admin repeating it applies it (403 `maker-checker-violation` for
        the same actor). Manual rows without a notification key resolve in one step.""")
p1=rep(p1,"          description: First admin's request on a watcher row, stored as `pending_action`; a second admin must repeat it.","          description: First admin's request on a keyed row, stored as `pending_action`; a second admin must repeat it.")
p2=rep(p2,"          description: 'Round 4 (SA-C2-03): a request on a `cbic_watcher` row that waits for a second admin (resolve, or a triage that removes prefixes); null otherwise.'","          description: 'Rounds 4 and 6 (SA-C2-03, SA-C3-03): a request on a row with a `notification_key` that waits for a second admin (resolve, first triage, or a triage that removes prefixes); null otherwise.'")
open(S+'part1.yaml','w').write(p1); open(S+'part2.yaml','w').write(p2); print('ok')
p1=open(S+'part1.yaml').read()
p1=rep(p1,"""        not behind the MAC'd high-water mark in `HSN_STATE_HWM_FILE`, SA-C2-06; after
        a detected restore it stays 503 until `npm run ack-restore` and a restart).""","""        not behind the MAC'd high-water mark in `HSN_STATE_HWM_FILE`, SA-C2-06, and the
        sidecar is not missing for a database that had one, SA-C3-04; after a detected
        restore it stays 503 until `npm run ack-restore` and a restart).""")
open(S+'part1.yaml','w').write(p1); print('readyz ok')
