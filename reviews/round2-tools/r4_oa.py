import sys, json, yaml, re
S='/tmp/claude-0/-home-claude/962f84b0-1380-5f53-8c9f-f3c861af4b17/scratchpad/'
d=S+'oa/'; L=S+'live/'
p1=open(d+'part1.yaml').read(); p2=open(d+'part2.yaml').read()
miss=[]
def rep(s,a,b,n=1):
    if s.count(a)!=n: miss.append((a[:80],s.count(a))); return s
    return s.replace(a,b)
def live(n): return json.load(open(L+n+'.json'))
def dump(obj, ind):
    y=yaml.safe_dump(obj, default_flow_style=False, allow_unicode=True, sort_keys=False, width=10000)
    return ''.join(' '*ind+l+'\n' for l in y.splitlines())
def set_example(s, anchor, key, obj, summary):
    """after the unique text `anchor`, find the example `key:` and replace its summary and value block."""
    i=s.find(anchor)
    if i<0: miss.append(('anchor',anchor)); return s
    m=re.compile(r'^( +)'+re.escape(key)+r':\n', re.M).search(s, i)
    if not m: miss.append(('key',key)); return s
    ind=len(m.group(1)); start=m.start()
    # end of this example: next line with indentation <= ind
    pos=m.end()
    while True:
        nl=s.find('\n',pos)
        if nl<0: end=len(s); break
        line=s[pos:nl]
        if line.strip() and (len(line)-len(line.lstrip()))<=ind: end=pos; break
        pos=nl+1
    block=' '*ind+key+':\n'+' '*(ind+2)+'summary: '+json.dumps(summary, ensure_ascii=False)+'\n'+' '*(ind+2)+'value:\n'+dump(obj, ind+4)
    return s[:start]+block+s[end:]
def insert_example(s, anchor, after_key, key, obj, summary):
    i=s.find(anchor)
    m=re.compile(r'^( +)'+re.escape(after_key)+r':\n', re.M).search(s, i)
    ind=len(m.group(1)); pos=m.end()
    while True:
        nl=s.find('\n',pos); line=s[pos:nl]
        if line.strip() and (len(line)-len(line.lstrip()))<=ind: end=pos; break
        pos=nl+1
    block=' '*ind+key+':\n'+' '*(ind+2)+'summary: '+json.dumps(summary, ensure_ascii=False)+'\n'+' '*(ind+2)+'value:\n'+dump(obj, ind+4)
    return s[:end]+block+s[end:]

LIVE=' (live output, quick-start seed, 2026-10-11)'
# ---------------- part2: schemas
p2=rep(p2,"""      enum: [create, supersede, end_date, verify, correct, refdata_change, admin_grant]""","""      enum: [create, supersede, end_date, verify, correct, refdata_change, admin_grant, disable_actor, dataset_import]
      description: '`disable_actor` (round 4, SA-C2-04) is stored as an `admin_grant` row with `payload.op = "disable_actor"`; `dataset_import` (round 5, R11) as a `refdata_change` row with `payload.op = "dataset_import"`. The API shows the action name. `dataset_import` is created and approved only by `scripts/import-dataset.ts`.'""")
p2=rep(p2,"""        action: { $ref: '#/components/schemas/ProposalAction' }
        supersedes_rule_id: { allOf: [{ $ref: '#/components/schemas/RuleId' }], description: 'Required for supersede, end_date, verify and correct (the target rule); refused otherwise.' }""","""        action: { type: string, enum: [create, supersede, end_date, verify, correct, admin_grant, disable_actor, refdata_change], description: '`dataset_import` is not accepted here (scripts/import-dataset.ts only).' }
        supersedes_rule_id: { allOf: [{ $ref: '#/components/schemas/RuleId' }], description: 'Required for supersede, end_date, verify and correct (the target rule); refused otherwise.' }""")
p2=rep(p2,"""        grant: { allOf: [{ $ref: '#/components/schemas/AdminGrant' }], description: 'Required for admin_grant, refused otherwise.' }""","""        grant: { allOf: [{ $ref: '#/components/schemas/AdminGrant' }], description: 'Required for admin_grant, refused otherwise.' }
        disable:
          type: object
          additionalProperties: false
          required: [handle]
          description: 'Required for disable_actor, refused otherwise (round 4, SA-C2-04). 400 `validation-failed` with error code `last_actors` when it would leave fewer than two active admins. On approval the actor is disabled at once (its keys get 401), its pending proposals are withdrawn, and `admin.disabled` is audited.'
          properties:
            handle: { type: string, minLength: 1, maxLength: 64 }""")
p2=rep(p2,"""`new_actor: false` authorises an admin key for the existing, enabled actor `handle`;""","""`new_actor: false` authorises an extra admin key for the existing, enabled actor `handle` and must be proposed by that actor itself (else 400, error code `not_self`; round 4, SA-C2-05);""")
p2=rep(p2,"""--grant <proposal id>`. `handle` is NFKC""","""--grant <proposal id>` within `HSN_ADMIN_GRANT_TTL_HOURS` (default and maximum 72) of the approval, after which the grant expires. `handle` is NFKC""")
p2=rep(p2,"""admin_grant → `{handle, display_name, new_actor}`; refdata_change → the `RefdataChange` object).""","""admin_grant → `{handle, display_name, new_actor}`; disable_actor → `{op, handle}` with op `disable_actor`; dataset_import → `{op, files, counts}` with op `dataset_import` and files mapping name to sha256; refdata_change → the `RefdataChange` object).""")
p2=rep(p2,"""        action: { $ref: '#/components/schemas/ProposalAction' }
        supersedes_rule_id: { oneOf: [{ $ref: '#/components/schemas/RuleId' }, { type: 'null' }] }""","""        action: { $ref: '#/components/schemas/ProposalAction' }
        supersedes_rule_id: { oneOf: [{ $ref: '#/components/schemas/RuleId' }, { type: 'null' }] }""")
# WatchedNotification pending_action
p2=rep(p2,"""        notification_date: { type: [string, 'null'], format: date }

    WatchedNotificationCreate:""","""        notification_date: { type: [string, 'null'], format: date }
        pending_action:
          description: 'Round 4 (SA-C2-03): a request on a `cbic_watcher` row that waits for a second admin (resolve, or a triage that removes prefixes); null otherwise.'
          oneOf:
            - type: object
              required: [kind, by, at]
              properties:
                kind: { type: string, enum: [published, dismissed, triage] }
                affected_prefixes: { type: [array, 'null'], items: { type: string } }
                effective_from: { type: [string, 'null'], format: date }
                by: { type: string, description: 'Handle of the admin who asked.' }
                at: { type: string, format: date-time }
            - type: 'null'

    WatchedNotificationCreate:""")
# Problem registry
p2=rep(p2,"""        method-not-allowed (405; registered, not raised in v1: an unknown method gets 404 not-found), overlapping-rule (409),""","""        method-not-allowed (405, with an `Allow` header), overlapping-rule (409),""")
p2=rep(p2,"""proposal-hash-mismatch (409), proposal-stale (409), rule-not-active (409),""","""proposal-hash-mismatch (409), proposal-stale (409), rule-not-active (409),
        proposer-disabled (409),""")
# HsnDetail
p2=rep(p2,"""      required: [code, level, type, chapter, description, ancestors, rate, dataset_version, disclaimer]
      properties:
        code: { $ref: '#/components/schemas/HsnCodeString' }
        level: { type: integer, enum: [2, 4, 5, 6, 8] }
        type: { type: string, enum: [goods, service] }
        chapter: { type: string, pattern: '^\\d{2}$' }
        description: { type: string }""","""      required: [code, level, type, chapter, description, code_in_master, resolved_via, ancestors, rate, dataset_version, disclaimer]
      properties:
        code: { $ref: '#/components/schemas/HsnCodeString' }
        level: { type: integer, enum: [2, 4, 5, 6, 8], description: 'Length of the requested code (also when it is not in the master).' }
        type: { type: string, enum: [goods, service] }
        chapter: { type: string, pattern: '^\\d{2}$' }
        description: { type: string, description: 'For a code not in the master: "<code> is not in the HSN master; shown under <parent>: <parent description>".' }
        code_in_master: { type: boolean, description: 'false when the code is not in the HSN master and was resolved under its nearest known ancestor (round 5, R3).' }
        resolved_via: { type: [string, 'null'], description: 'The ancestor the code was resolved under (6, then 5 for SAC 99xxx, then 4, then 2 digits); null when code_in_master.' }""")
p2=rep(p2,"""          items: { type: string, enum: [rate_unverified, verification_overdue, pending_change_detected, selected_by_hint, no_rate_rule, ambiguous] }""","""          items: { type: string, enum: [rate_unverified, verification_overdue, pending_change_detected, selected_by_hint, no_rate_rule, ambiguous, code_not_in_master] }""")
p2=rep(p2,"""            `pending_change_detected`: a detected""","""            `code_not_in_master` (GET /v1/hsn/{code} only): the code is not in the HSN master and was resolved under `resolved_via`.
            `pending_change_detected`: a detected""")
p2=rep(p2,"""          description: |
            Open enum (clients ignore unknown values).""","""          description: |
            Open enum (clients ignore unknown values).""")
# RateRule citation_note
p2=rep(p2,"""        dataset_version: { type: string, description: 'Version in which this rule was published.' }""","""        dataset_version: { type: string, description: 'Version in which this rule was published.' }
        citation_note: { type: [string, 'null'], description: 'Present on every rule (round 5). The caveat shown with a seed rule while it is unverified, e.g. "Transcribed from secondary sources; schedule S.No. and gazette text not yet checked against the CBIC PDF. …"; null after a verify approval and on rules published through maker–checker.' }""",)
# Tax
p2=rep(p2,"""        candidate_rules:
          type: array
          items: { $ref: '#/components/schemas/RuleId' }
          description: 'Ambiguous lines only; empty otherwise.'""","""        candidate_rules:
          type: array
          items: { $ref: '#/components/schemas/RuleId' }
          description: 'Ambiguous lines only; empty otherwise.'
        code_in_master: { type: boolean, description: 'false when the line''s code is not in the HSN master and was resolved under its nearest known ancestor (round 5, R3; note `code_not_in_master`).' }
        resolved_via: { type: [string, 'null'] }""")
p2=rep(p2,"""      required: [line_id, hsn, supply_type, taxable_value, ambiguous, rule_id, rule_selected_by, default_rule_id, unverified_accepted, igst_rate_bp, igst_rate_percent, tax, tax_paise, effective_from, effective_to, source, last_verified_at, verification_status, warning, candidate_rules, needs_input, notes]""","""      required: [line_id, hsn, supply_type, taxable_value, ambiguous, rule_id, rule_selected_by, default_rule_id, unverified_accepted, igst_rate_bp, igst_rate_percent, tax, tax_paise, effective_from, effective_to, source, last_verified_at, verification_status, warning, candidate_rules, code_in_master, resolved_via, needs_input, notes]""")
p2=rep(p2,"""`needs_input: …` (unresolved line, excluded from totals; mirrors the needs_input array),""","""`needs_input: …` (unresolved line, excluded from totals; mirrors the needs_input array), `code_not_in_master: …`,""")
old_resp=p2[p2.index('    TaxCalculateResponse:\n'):p2.index('    Change:\n')]
new_resp='''    TaxCalculateResponse:
      type: object
      description: |
        Round 5 (R13): an incomplete invoice never carries a total. When any line has
        `tax: null` (`needs_input` or refused), `complete` is false, `totals`,
        `totals_paise`, `round_off_paise` and `grand_total_paise` are null, and
        `partial_totals` sums the computed lines only, naming the included and excluded
        `line_id`s. A complete invoice has `totals` and `partial_totals: null`.
      required: [invoice_date, complete, lines, totals, totals_paise, partial_totals, invoice_rounding, dataset_version, disclaimer]
      properties:
        invoice_date: { type: string, format: date }
        complete: { type: boolean, description: 'false if any line has tax null.' }
        lines:
          type: array
          items: { $ref: '#/components/schemas/TaxLineResult' }
        totals:
          description: Sum over all lines; null when complete is false.
          oneOf:
            - $ref: '#/components/schemas/TaxTotals'
            - type: 'null'
        totals_paise:
          oneOf:
            - $ref: '#/components/schemas/TaxTotalsPaise'
            - type: 'null'
        partial_totals:
          description: Only when complete is false; null otherwise.
          oneOf:
            - type: object
              required: [complete, included_line_ids, excluded_line_ids, totals, totals_paise]
              properties:
                complete: { type: boolean, const: false }
                included_line_ids: { type: array, items: { type: string } }
                excluded_line_ids: { type: array, items: { type: string } }
                totals: { $ref: '#/components/schemas/TaxTotals' }
                totals_paise: { $ref: '#/components/schemas/TaxTotalsPaise' }
            - type: 'null'
        invoice_rounding: { type: string, enum: [none, nearest_rupee] }
        round_off_paise: { type: [integer, 'null'], description: 'Present only when invoice_rounding = nearest_rupee: grand_total_paise − (taxable value + total tax); null when complete is false.' }
        grand_total_paise: { type: [integer, 'null'], description: 'Present only when invoice_rounding = nearest_rupee: taxable value plus total tax, rounded half-up to the rupee; null when complete is false.' }
        dataset_version: { type: string }
        disclaimer: { $ref: '#/components/schemas/Disclaimer' }

    TaxTotals:
      allOf:
        - $ref: '#/components/schemas/TaxAmounts'
        - type: object
          required: [taxable_value]
          properties:
            taxable_value: { type: number }

    TaxTotalsPaise:
      allOf:
        - $ref: '#/components/schemas/TaxAmountsPaise'
        - type: object
          required: [taxable_value]
          properties:
            taxable_value: { type: integer }

'''
p2=p2.replace(old_resp,new_resp)
# classifier version
p2=rep(p2,"""            version: { type: string, description: 'Formula and weights version; currently rules-fts-2.0.' }""","""            version: { type: string, description: 'Formula and weights version; currently rules-fts-2.1 (round 4: synonym exactness and the imitation-jewellery qualifier).' }""")

# ---------------- part1
p1=rep(p1,"""        Checks (server-side): DB open, migrations at head, FTS5 available, dataset state
        present and the current version sealed, last audit entry's HMAC verifies.""","""        Checks (server-side): DB open, migrations at head, FTS5 available, dataset state
        present and the current version sealed, `audit_integrity` (at boot the whole
        HMAC chain is verified and the state-to-audit cross-check run, round 4
        SA-C2-02) and `state_continuity` (no unacknowledged restore: the database is
        not behind the MAC'd high-water mark in `HSN_STATE_HWM_FILE`, SA-C2-06; after
        a detected restore it stays 503 until `npm run ack-restore` and a restart).""")
p1=rep(p1,"""    codes that matched the pattern, ids) but never free text such as `name` or `q`, and never a GTIN that failed its check digit.""","""    codes that matched the pattern, ids) but never free text such as `name` or `q`, and never a GTIN that failed its check digit.
    A known path with the wrong method returns `405 method-not-allowed` with an
    `Allow` header (GET implies HEAD); an unknown path returns `404 not-found`.""")
p1=rep(p1,"""        a general rule plus condition rules (e.g. 3004 and the nil-rate drug list),
        `default_rule_id` names the general rule; the API still does not pick it for you.""","""        a general rule plus condition rules (e.g. 3004 and the nil-rate drug list),
        `default_rule_id` names the general rule; the API still does not pick it for you.

        **Codes outside the HSN master (round 5, R3).** A well-formed code that is not
        in the master but has a known ancestor (6, then 5 for SAC 99xxx, then 4, then 2
        digits) returns 200, resolved against that ancestor: `code_in_master: false`,
        `resolved_via: "<parent>"`, the warning `code_not_in_master`, and a description
        saying so. Only a code whose chapter does not exist returns 404 `hsn-not-found`.""")
# 404 example
p2=rep(p2,"""      description: HSN/SAC code not present in the current dataset.""","""      description: The code's chapter does not exist in the current dataset (a code with a known ancestor resolves under it instead).""")
p2=rep(p2,"""            detail: 'No HSN/SAC "7199" in dataset 2026.10.03-1. Try GET /v1/hsn/search?q=… or the parent heading "71".'
            instance: /v1/hsn/7199""","""            detail: 'No HSN/SAC "0012" in dataset 2026.10.11-1, and chapter 00 does not exist. Try GET /v1/hsn/search?q=….'
            instance: /v1/hsn/0012""")
# classify description
p1=rep(p1,"""fusion, `classifier.version` `rules-fts-2.0`, architecture.md §5.4).""","""fusion, `classifier.version` `rules-fts-2.1`, architecture.md §5.4).""")
p1=rep(p1,"""        `high` (≥ 0.85) requires an exact curated synonym on the name the client sent;
        otherwise the cap is 0.84""","""        `high` (≥ 0.85) requires an exact curated synonym on the name the client sent;
        since `rules-fts-2.1` (round 4, validator R2) a synonym is exact only when it is
        the whole name: after removing its tokens nothing may remain except quantities,
        units, pack words, dosage forms, function words and (from a barcode lookup) the
        brand. A phrase inside a longer name scores 0.7 (at most medium), a one-word
        phrase inside a longer name 0.3, and single generic words (tablet, shirt,
        chocolate, ring, chain, oil, …) are never exact. Imitation-jewellery qualifiers
        (plated, imitation, artificial, brass, "one gram", …) move jewellery evidence
        from 7113 to 7117 and lower other Chapter 71 evidence; otherwise the cap is 0.84""")
p1=p1.replace("classifier: { version: 'rules-fts-2.0', llm_rerank: false }","classifier: { version: 'rules-fts-2.1', llm_rerank: false }")
# approve 409 + proposer-disabled + dataset_import
p1=rep(p1,"""a `retroactive_reason`, a reference row changed meanwhile, or a granted actor
        was created meanwhile;""","""a `retroactive_reason`, a reference row changed meanwhile, a granted actor
        was created meanwhile, or the proposal is a `dataset_import` (approve it with
        `scripts/import-dataset.ts` on the host, which re-hashes the files);
        `409 proposer-disabled` when the proposer's actor has been disabled (round 4);""")
p1=rep(p1,"""          description: '`proposal-not-pending`, `proposal-hash-mismatch`, `rule-not-active`, `proposal-stale`, `overlapping-rule` or `idempotency-conflict`.'""","""          description: '`proposal-not-pending`, `proposal-hash-mismatch`, `rule-not-active`, `proposal-stale`, `proposer-disabled`, `overlapping-rule` or `idempotency-conflict`.'""")
p1=rep(p1,"""          `new_actor: true` creates the actor, `false` authorises an admin key for an
          existing actor; it publishes no dataset version.""","""          `new_actor: true` creates the actor, `false` authorises an extra admin key for
          the proposer itself (400 `not_self` otherwise); the grant must be redeemed
          within `HSN_ADMIN_GRANT_TTL_HOURS` (≤ 72 h). It publishes no dataset version.
        - `disable_actor` (round 4) carries `disable {handle}`; refused (400
          `last_actors`) if fewer than two active admins would remain. Approval
          disables the actor (its keys get 401 at once) and withdraws its pending
          proposals. A disabled actor's pending proposals cannot be approved (409
          `proposer-disabled`).
        - `dataset_import` (round 5) is the first production data load. It is created
          and approved only with `npm run import-dataset` on the host (see TRD §16);
          it is listed here and can be rejected, but approve returns 409
          `proposal-stale`.""")
p1=rep(p1,"""        - name: action
          in: query
          schema: { $ref: '#/components/schemas/ProposalAction' }
""","")
p1=rep(p1,"""              adminGrant:
                summary: Authorise an admin key for an existing actor (admin_grant)""","""              disableActor:
                summary: Disable an admin actor (disable_actor, round 4)
                value:
                  action: disable_actor
                  disable: { handle: ravi }
                  rationale: Ravi left the team; disable his admin actor and keys.
              adminGrant:
                summary: Request an extra admin key for yourself (admin_grant, new_actor false)""")
p1=rep(p1,"""                  grant: { handle: priya, new_actor: false }
                  rationale: Quarterly rotation of Priya's admin key.""","""                  grant: { handle: amit, new_actor: false }
                  rationale: Quarterly rotation of Amit's admin key (proposed by amit).""")
# watcher 202
p1=rep(p1,"""        those prefixes carry `pending_change_detected` (ruling 10). Audited
        `watched_notification.triaged` with the previous prefixes. Never changes a rate.""","""        those prefixes carry `pending_change_detected` (ruling 10). Audited
        `watched_notification.triaged` with the previous prefixes. Never changes a rate.

        **Two admins to remove prefixes (round 4, SA-C2-03).** A triage that removes
        prefixes from a `cbic_watcher` row is first stored as `pending_action`
        (audited `watched_notification.confirmation_requested`) and returns **202**
        with the row; the same request from a *different* admin applies it (audited
        with `requested_by` and `confirmed_by`, warn log `watcher.row_silenced`). The
        same actor confirming, even with another key, gets 403
        `maker-checker-violation`; a different request replaces the pending one.
        Adding prefixes, and manual rows, stay single-admin.""")
p1=rep(p1,"""        Only while the row is `detected` (else 404 `not-found`). After this the row is
        immutable. Audited `watched_notification.published` or
        `watched_notification.dismissed`.""","""        Only while the row is `detected` (else 404 `not-found`). After this the row is
        immutable. Audited `watched_notification.published` or
        `watched_notification.dismissed`.

        **Two admins for watcher rows (round 4, SA-C2-03).** Resolving a
        `cbic_watcher` row turns its warnings and SLA alert off, so the first request
        is stored as `pending_action` and returns **202** with the row; a *different*
        admin repeating it applies it (403 `maker-checker-violation` for the same
        actor). Manual rows resolve in one step.""")
p1=rep(p1,"""            example: { affected_prefixes: ['2202', '220299'], effective_from: '2026-11-01' }
      responses:
        '200':
          description: Triaged row (or an idempotent replay).""","""            example: { affected_prefixes: ['2202', '220299'], effective_from: '2026-11-01' }
      responses:
        '202':
          description: Removal of prefixes from a watcher row stored as `pending_action`; a second admin must repeat it.
          headers:
            Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/WatchedNotification' }
        '200':
          description: Triaged row (or an idempotent replay).""")
p1=rep(p1,"""            example: { state: published }
      responses:
        '200':
          description: Closed row (or an idempotent replay).""","""            example: { state: published }
      responses:
        '202':
          description: First admin's request on a watcher row, stored as `pending_action`; a second admin must repeat it.
          headers:
            Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/WatchedNotification' }
        '200':
          description: Closed row (or an idempotent replay).""")
# Tax description
p1=rep(p1,"""        sums of rounded line amounts and exclude unresolved lines.""","""        sums of rounded line amounts. An incomplete invoice (any line with `tax: null`)
        has `totals`, `totals_paise`, `round_off_paise` and `grand_total_paise` null and
        a `partial_totals` object over the computed lines only (round 5, R13).""")
p1=rep(p1,"""        adds `round_off_paise` and `grand_total_paise` (taxable value plus tax, half-up to
        the rupee) without touching tax components.""","""        adds `round_off_paise` and `grand_total_paise` (taxable value plus tax, half-up to
        the rupee; complete invoices only) without touching tax components.

        **Codes outside the master (round 5, R3).** A line whose code is not in the HSN
        master but has a known ancestor is computed under it (`code_in_master: false`,
        `resolved_via`, note `code_not_in_master`); 422 `unknown-hsn` only when the
        code's chapter does not exist.""")
p1=rep(p1,"""          description: A line references an unknown HSN code (`unknown-hsn`), or names a rule that is not one of its candidate rules (`rule-choice-invalid`).""","""          description: A line's code has no known ancestor, i.e. its chapter does not exist (`unknown-hsn`), or a line names a rule that is not one of its candidate rules (`rule-choice-invalid`).""")
ex=live('16c-tax-unknown')
p1=set_example(p1,"""          description: A line's code has no known ancestor""","unknownHsn",ex,"Chapter 00 does not exist"+LIVE)

# ---- live examples: tax request/response
reqs={
 'ring': ({"invoice_date":"2026-10-11","accept_unverified":True,"lines":[{"line_id":"1","hsn":"7113","taxable_value":68500.00,"quantity":8.250,"supply_type":"intra"}]}, '14-tax-ring', '22K ring, intra-state, unverified rate accepted explicitly'),
 'partial': ({"invoice_date":"2026-10-11","accept_unverified":True,"invoice_rounding":"nearest_rupee","lines":[{"line_id":"1","hsn":"7113","taxable_value":68500.00,"supply_type":"intra"},{"line_id":"2","hsn":"6109","taxable_value":3600.00,"supply_type":"intra"}]}, '16-tax-partial', 'Line 2 needs unit_price: totals null, partial_totals over line 1'),
 'pharmacy': ({"invoice_date":"2026-10-11","accept_unverified":True,"lines":[{"line_id":"1","hsn":"3004","taxable_value":120.00,"supply_type":"inter","condition":"general"},{"line_id":"2","hsn":"9018","taxable_value":1150.00,"supply_type":"inter"},{"line_id":"3","hsn":"3822","taxable_value":450.00,"supply_type":"inter"}]}, '15-tax-pharmacy', 'Pharmacy bill, inter-state; 3004 general rule chosen'),
 'notInMaster': ({"invoice_date":"2026-10-11","accept_unverified":True,"lines":[{"line_id":"1","hsn":"61091000","taxable_value":1800.00,"unit_price":1800,"supply_type":"intra"}]}, '16b-tax-r3', '8-digit code not in the master, resolved under 6109'),
 'unverifiedNotAccepted': ({"invoice_date":"2026-10-11","lines":[{"line_id":"1","hsn":"7113","taxable_value":68500.00,"supply_type":"intra"}]}, '14c-tax-ring-noaccept', 'Unverified rule without accept_unverified → tax null'),
}
a=p1.index('  /v1/tax/calculate:'); b=p1.index('  /v1/rates/changes:')
sec=p1[a:b]
# request examples block
ri=sec.index('            examples:\n              mixed:'); re_end=sec.index('      responses:',ri)
blk='            examples:\n'
for k,(rq,_,sm) in reqs.items():
    blk+='              '+k+':\n                summary: '+json.dumps(sm)+'\n                value:\n'+dump(rq,18)
sec=sec[:ri]+blk+sec[re_end:]
ri=sec.index('              examples:\n                mixed:'); re_end=sec.index("        '400':",ri)
blk='              examples:\n'
for k,(rq,f,sm) in reqs.items():
    blk+='                '+k+':\n                  summary: '+json.dumps(sm+LIVE)+'\n                  value:\n'+dump(live(f),20)
sec=sec[:ri]+blk+sec[re_end:]
p1=p1[:a]+sec+p1[b:]
HA='      operationId: getHsn'
p1=set_example(p1,HA,'goldJewellery',live('03-7113'),'7113 on 2026-10-11: 3%, unverified seed rule with citation_note'+LIVE)
p1=set_example(p1,HA,'apparelAmbiguous',live('11-6109'),'6109 without unit_price: ambiguous between the two price rules'+LIVE)
p1=set_example(p1,HA,'medicamentsGeneralPlusCondition',live('12-3004'),'3004: general 5% rule plus the nil_rate_list condition; default_rule_id names the general rule'+LIVE)
p1=insert_example(p1,HA,'medicamentsGeneralPlusCondition','notInMaster',live('04-7199'),'7199 is not in the master: resolved under chapter 71 (round 5, R3)'+LIVE)
CA="schema: { $ref: '#/components/schemas/ClassifyResponse' }"
p1=set_example(p1,CA,'goldRing',live('05-goldring'),'"22K gold ring" → 7113 at 3%, high (exact curated synonym: the phrase is the whole name)'+LIVE)
p1=set_example(p1,CA,'paracetamol',live('06-paracetamol'),'"Paracetamol 500 mg tablet" → 3004 high (synonym covers the whole name: quantity and dosage form are allowed residue); rate ambiguous with default_rule_id'+LIVE)
p2=rep(p2,"        message: { type: string, description: 'Present when no candidate reaches 0.30","        message: { type: [string, 'null'], description: 'Null unless no candidate reaches 0.30")
p2=rep(p2,"        verified_by: { oneOf: [{ $ref: '#/components/schemas/ActorId' }, { type: 'null' }], description: 'Pseudonymous actor_id of the first verifier (never a name); null while unverified.' }","        verified_by: { type: [string, 'null'], description: 'Handle of the checker who first verified the rule (as the code returns it and TRD §3 states; round 4 sweep); null while unverified.' }")
if miss: print('MISSING',miss); sys.exit(1)
open(d+'part1.yaml','w').write(p1); open(d+'part2.yaml','w').write(p2); print('ok')
