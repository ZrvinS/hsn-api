import sys, json, yaml
S='/tmp/claude-0/-home-claude/962f84b0-1380-5f53-8c9f-f3c861af4b17/scratchpad/'
d=S+'oa/'; L=S+'live/'
p1=open(d+'part1.yaml').read(); p2=open(d+'part2.yaml').read()
def rep(s,a,b,n=1):
    c=s.count(a)
    if c!=n: print('MISSING',c,a[:120]); sys.exit(1)
    return s.replace(a,b)
def live(n): return json.load(open(L+n+'.json'))
def dump(obj, ind):
    y=yaml.safe_dump(obj, default_flow_style=False, allow_unicode=True, sort_keys=False, width=10000)
    return ''.join(' '*ind+l+'\n' for l in y.splitlines())
LIVE=' (live output, quick-start seed, 2026-10-11)'

# ---- Problem: new type, errors[] cap
p2=rep(p2,"        Registered `type` suffixes (kebab-case; the same list as ui-and-dx.md §1 and\n        best-practices §3): validation-failed (400), idempotency-key-required (400),",
          "        Registered `type` suffixes (kebab-case; the same list as ui-and-dx.md §1 and\n        best-practices §3): validation-failed (400), idempotency-key-required (400),\n        source-url-not-document (400, ruling 36),")
p2=rep(p2,"""        errors:
          type: array
          items:
            type: object
            required: [pointer, code, message]""","""        errors:
          type: array
          maxItems: 50
          description: 'Every problem found (request validation runs with allErrors since core round 9), one entry per pointer and constraint, at most 50. `detail` gives the total, e.g. "Request validation failed: 3 problems. See errors[]." or "…: 72 problems; the first 50 are in errors[]."'
          items:
            type: object
            required: [pointer, code, message]""")
# ---- BadRequest example: live multi-error
bad=live('18c-400-multi')
i=p1.find("    BadRequest:\n"); src=p1 if i>=0 else None
tgt='p1' if i>=0 else 'p2'
s=p1 if tgt=='p1' else p2
i=s.find("    BadRequest:\n"); a=s.find("          example:\n",i); b=s.find("    AdminBadRequest:",i)
assert i>=0 and a>i and b>a
s=s[:a]+"          example:\n"+dump(bad,12)+s[b:]
s=rep(s,"      description: Request failed schema validation. `errors[]` lists field pointers and constraint names; free-text values are never echoed.","      description: 'Request failed schema validation. `errors[]` lists every failing field pointer and constraint name (up to 50; the total is in `detail`); free-text values are never echoed. Example: live output, quick-start seed, 2026-10-11 (three tax lines without `supply_type`).'")
if tgt=='p1': p1=s
else: p2=s
# ---- needs_input
p2=rep(p2,"          items: { type: string, enum: [unit_price, rule_id, hsn, accept_unverified] }\n          description: 'What the client must send to resolve this line; empty when the line is computed.'",
          "          items: { type: string, enum: [unit_price, rule_id, condition, hsn, accept_unverified] }\n          description: 'What the client may send to resolve this line (any one entry suffices); empty when the line is computed. An ambiguous line on a non-price condition lists `[rule_id, condition]` when a default rule exists (send `rule_id`, or `condition: \"general\"` for `default_rule_id`), `[rule_id]` without one (core round 9).'")
p1=rep(p1,"`needs_input` listing what would resolve it (`unit_price`, `rule_id` or `hsn`);","`needs_input` listing what would resolve it (`unit_price`, `rule_id`, `condition` or `hsn`;\n        3004 without a choice gives `[rule_id, condition]`);")
# ---- DatasetMeta
p2=rep(p2,"      required: [dataset_version, published_at, content_sha256, signature, last_change_seq, feed_epoch, oldest_last_verified_at, sources_checked_at, freshness_sla_business_days, untriaged_notifications, pending_notifications, coverage, sources, llm, disclaimer]",
          "      required: [dataset_version, published_at, content_sha256, sha256, signature, signature_alg, last_change_seq, feed_epoch, oldest_last_verified_at, sources_checked_at, freshness_sla_business_days, untriaged_notifications, pending_notifications, coverage, known_data_gaps, sources, classifier, disclaimer]")
p2=rep(p2,"        signature: { type: [string, 'null'], description: 'Optional detached signature over content_sha256 (not produced in v1; null).' }",
          "        sha256: { allOf: [{ $ref: '#/components/schemas/Sha256Hex' }], description: 'Alias of content_sha256.' }\n        signature: { type: [string, 'null'], description: 'Optional detached signature over content_sha256 (not produced in v1; null).' }\n        signature_alg: { type: [string, 'null'], description: '\"ed25519\" when signature is set, else null.' }")
p2=rep(p2,"          required: [hsn_codes, sac_codes, rate_rules_active, rate_rules_verified, rate_rules_unverified, rate_rules_verification_overdue, hsn_chapters_with_rules, rules_verified_last_90_days_percent]",
          "          required: [hsn_codes, sac_codes, rate_rules_active, rate_rules_verified, rate_rules_unverified, rate_rules_verification_overdue, hsn_chapters_with_rules, rules_verified_last_90_days_percent, codes_without_rules]")
p2=rep(p2,"""            rules_verified_last_90_days_percent: { type: number }
        sources:
          type: array
          items: { $ref: '#/components/schemas/Source' }
        llm:
          type: object
          description: Disclosure of the optional LLM re-ranker.
          required: [configured, provider]
          properties:
            configured: { type: boolean, description: 'true if an LLM re-ranker is configured on this server (requests still need allow_llm: true).' }
            provider: { type: [string, 'null'], description: 'Provider name when configured, else null.' }""","""            rules_verified_last_90_days_percent: { type: number }
            codes_without_rules: { type: integer, minimum: 0, description: 'Master codes of 4+ digits with no rule in force today at, above or below them (core round 9). A lookup of such a code returns coverage no_rate_rule.' }
        known_data_gaps:
          type: array
          description: 'Curated list of known gaps (core round 9), read at boot from `data/seed/known_gaps.json` or `HSN_KNOWN_GAPS_FILE`; not part of the dataset hash. A prefix listed here means "not yet curated", not "no rate exists". Empty when the file is absent.'
          items:
            type: object
            required: [prefix, kind, reason]
            properties:
              prefix: { type: [string, 'null'], description: 'HSN/SAC prefix, or null for a gap that is not tied to one code (e.g. cess history).' }
              kind: { type: string, enum: [disputed, not_researched, not_transcribed, not_expressible, period_gap] }
              reason: { type: string }
        sources:
          type: array
          description: 'Distinct citations of the active rules: notification and URL only (the full Source, with pdf_sha256 and schedule_serial, is on GET /v1/hsn/{code}).'
          items:
            type: object
            required: [notification, url]
            properties:
              notification: { type: string }
              url: { type: string }
        classifier:
          type: object
          description: Disclosure of the optional LLM re-ranker and external barcode lookups.
          required: [llm_configured, llm_provider, external_lookups]
          properties:
            llm_configured: { type: boolean, description: 'true if an LLM re-ranker is configured on this server (requests still need allow_llm: true).' }
            llm_provider: { type: [string, 'null'], description: 'Provider name when configured, else null.' }
            external_lookups: { type: array, items: { type: string, enum: [open_food_facts, open_beauty_facts] }, description: 'Enabled barcode adapters; empty by default.' }""")
# meta example -> live (trimmed)
m=live('01-meta'); m['sources']=m['sources'][:3]; m['known_data_gaps']=m['known_data_gaps'][:4]
s=p1; i=s.find("  /v1/meta/dataset:"); a=s.find("              example:\n",i); b=s.find("        '304':",a)
assert i>=0 and a>i and b>a
s=s[:a]+"              example:\n"+dump(m,16)+s[b:]
p1=s
# ---- verify source: url + notification (ruling 36)
p2=rep(p2,"""          required: [pdf_sha256, schedule_serial]
          description: 'Required for verify, refused (400) otherwise (00c ruling 35): the PDF the reviewer read and the schedule serial; the notification and url are the target rule''s.'
          properties:
            pdf_sha256: { $ref: '#/components/schemas/Sha256Hex' }
            schedule_serial: { type: string, minLength: 1, maxLength: 100 }""","""          required: [pdf_sha256, schedule_serial]
          description: 'Required for verify, refused (400) otherwise (00c ruling 35; ruling 36): the PDF the reviewer read and the schedule serial. `url` and `notification` are allowed only on the first verify of an unverified rule and replace the rule''s citation on approval (in one statement with the verification fields; `citation_note` becomes null). `url` is required when the rule cites a listing/index page (400 `source-url-not-document`, pointer /source/url, code required); it must be on HSN_SOURCE_HOSTS and be a document (path contains /view-pdf/ or ends in .pdf, and is not one of the index pages: central-tax-rate.html, integrated-tax-rate.html, gst-goods-services-rates.html, the watcher pages and HSN_SOURCE_INDEX_PAGES), else 400 `validation-failed` at /source/url. On an already verified rule either field → 400 (pointer /source, code forbidden).'
          properties:
            pdf_sha256: { $ref: '#/components/schemas/Sha256Hex' }
            schedule_serial: { type: string, minLength: 1, maxLength: 100 }
            url: { type: string, minLength: 8, maxLength: 2000, description: 'Ruling 36: the notification document the reviewer read.' }
            notification: { type: string, minLength: 3, maxLength: 300, description: 'Ruling 36: canonical notification reference (normalised: N/YYYY without zero padding, whitespace collapsed).' }""")
p1=rep(p1,"`schedule_serial`. `verify` sends only `source {pdf_sha256, schedule_serial}`.",
          "`schedule_serial`; the `url` must be a notification document (`/view-pdf/` or `.pdf`),\n        never an index page (400, ruling 36). `verify` sends `source {pdf_sha256,\n        schedule_serial}` plus, on the first verify of an unverified rule, optional `url` and\n        `notification`; `url` is required when the rule cites an index page (400\n        `source-url-not-document`, ruling 36). Notification references are stored in the\n        canonical `N/YYYY` form without zero padding (`01/2026` → `1/2026`).")
p1=rep(p1,"          `{pdf_sha256, schedule_serial}`, no `rule`.","          `{pdf_sha256, schedule_serial, url?, notification?}`, no `rule` (ruling 36).")
p2=rep(p2,"description: 'Canonical notification_ref, e.g. \"9/2025-CT(Rate), Schedule IV\" (no leading zero; data-model §1).' }",
          "description: 'Canonical notification_ref, e.g. \"9/2025-CT(Rate), Schedule IV\": N/YYYY without zero padding, whitespace collapsed; the seed loader and every proposal input normalise to this form (core round 9; data-model §1).' }")
# ---- AdminBadRequest: add live ruling-36 example
s=p1 if "    AdminBadRequest:\n" in p1 else p2
i=s.find("    AdminBadRequest:\n"); j=s.find("          schema: { $ref: '#/components/schemas/Problem' }\n",i)
assert i>=0 and j>i
end=j+len("          schema: { $ref: '#/components/schemas/Problem' }\n")
b=s.find("    Unauthorized:\n",end)
oldex=s[end:b]
assert oldex.startswith("          example:\n")
body=''.join('    '+l+'\n' for l in oldex.splitlines()[1:])
ex="          examples:\n            idempotencyKeyRequired:\n              summary: Missing Idempotency-Key header\n              value:\n"+body+"            sourceUrlNotDocument:\n              summary: "+json.dumps('Verify of the 3004 nil rule, which cites the CBIC index page, without source.url'+LIVE)+"\n              value:\n"+dump(live('a18-verify-nil-nourl'),16)
s=s[:end]+ex+s[b:]
s=rep(s,"      description: '`validation-failed`, or `idempotency-key-required` when the Idempotency-Key header is missing (ruling 28).'","      description: '`validation-failed`, `idempotency-key-required` when the Idempotency-Key header is missing (ruling 28), or `source-url-not-document` (ruling 36).'")
if "    AdminBadRequest:\n" in p1: p1=s
else: p2=s

# ---- tax: ambiguous 3004 with no choice -> needs_input [rule_id, condition]
import re
def ins_after(s, key, ind, newkey, summary, obj, nth=0):
    ms=list(re.finditer(r'^'+' '*ind+re.escape(key)+r':\n', s, re.M))
    m=ms[nth]; pos=m.end()
    while True:
        nl=s.find('\n',pos); line=s[pos:nl]
        if line.strip() and (len(line)-len(line.lstrip()))<=ind: end=pos; break
        pos=nl+1
    block=' '*ind+newkey+':\n'+' '*(ind+2)+'summary: '+json.dumps(summary, ensure_ascii=False)+'\n'+' '*(ind+2)+'value:\n'+dump(obj, ind+4)
    return s[:end]+block+s[end:]
req={"invoice_date":"2026-10-11","accept_unverified":True,"lines":[{"line_id":"1","hsn":"3004","taxable_value":1000,"supply_type":"intra"}]}
p1=ins_after(p1,'unverifiedNotAccepted',14,'ambiguousNoChoice','3004 without rule_id or condition: needs_input lists both accepted inputs',req)
p1=ins_after(p1,'unverifiedNotAccepted',16,'ambiguousNoChoice','3004 without rule_id or condition: needs_input [rule_id, condition]'+LIVE,live('15b-tax-3004-noinput'))
open(d+'part1.yaml','w').write(p1); open(d+'part2.yaml','w').write(p2); print('r9 ok')
