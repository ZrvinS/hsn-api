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
NOTE=("Canonical notification_ref (core round 10, enforced at every entry point): after normalisation it must match "
      "`^[1-9][0-9]{0,3}/(19|20)[0-9]{2}-(CT|IT|UTT|Cess)\\(Rate\\)(, Schedule (I|II|III|IV|V|VI|VII))?$`, e.g. \"9/2025-CT(Rate), Schedule IV\". "
      "Normalisation strips zero padding, collapses whitespace and rewrites the long series names (Central Tax (Rate), Integrated Tax (Rate), Union Territory Tax (Rate), (Compensation) Cess (Rate), CT (Rate)) to the short form: "
      "\"09/2025-Central Tax (Rate), Schedule I\" is stored as \"9/2025-CT(Rate), Schedule I\". Anything else → 400 validation-failed, code pattern. The schedule serial goes in schedule_serial, never here.")
DOCURL=("A notification document (ruling 36; core round 10, SA-C5-03): no query string or fragment; the path exactly as written (no `;`, `..`, `//`, `%2e`, `%2f`, `%5c`); "
        "the path is `/view-pdf/<id>[/…]` or a `*.pdf` file, and not a listing/index page (compared on origin plus lower-cased path with repeated slashes collapsed).")
def q(t): return "'"+t.replace("'","''")+"'"
# Source.notification (r9 text) 
p2=rep(p2,"description: 'Canonical notification_ref, e.g. \"9/2025-CT(Rate), Schedule IV\": N/YYYY without zero padding, whitespace collapsed; the seed loader and every proposal input normalise to this form (core round 9; data-model §1).' }",
          "description: "+q(NOTE+" Applies to the seed loader, import-dataset and every proposal input (data-model §1).")+" }")
# RateRuleInput.source
p2=rep(p2,"            notification: { type: string, minLength: 3, maxLength: 300, description: 'Canonical notification_ref, e.g. \"9/2025-CT(Rate), Schedule I\".' }\n            url: { type: string, minLength: 8, maxLength: 2000 }",
          "            notification: { type: string, minLength: 3, maxLength: 300, description: "+q(NOTE+" Failure pointer: /rule/source/notification.")+" }\n            url: { type: string, minLength: 8, maxLength: 2000, description: "+q(DOCURL)+" }")
# verify source
p2=rep(p2,"            url: { type: string, minLength: 8, maxLength: 2000, description: 'Ruling 36: the notification document the reviewer read.' }\n            notification: { type: string, minLength: 3, maxLength: 300, description: 'Ruling 36: canonical notification reference (normalised: N/YYYY without zero padding, whitespace collapsed).' }",
          "            url: { type: string, minLength: 8, maxLength: 2000, description: "+q("Ruling 36: the notification document the reviewer read. "+DOCURL)+" }\n            notification: { type: string, minLength: 3, maxLength: 300, description: "+q("Ruling 36. "+NOTE+" Failure pointer: /source/notification.")+" }")
# meta sources counts
p2=rep(p2,"""            required: [notification, url]
            properties:
              notification: { type: string }
              url: { type: string }
        classifier:""","""            required: [notification, url, rule_count, verified_count]
            properties:
              notification: { type: string }
              url: { type: string }
              rule_count: { type: integer, minimum: 1, description: 'In-force rules citing this notification and URL (core round 10).' }
              verified_count: { type: integer, minimum: 0, description: 'How many of them are verified.' }
        classifier:""")
# feed summary
p2=rep(p2,"        summary: { type: string }\n\n    ChangeFeed:","        summary: { type: string, description: 'Human-readable line. For rule_verified it names the citation as it stands after the approval (core round 10), e.g. \"3004 0% rule verified against 10/2025-CT(Rate)\".' }\n\n    ChangeFeed:")
# Problem errors description
p2=rep(p2,"""          description: 'Every problem found (request validation runs with allErrors since core round 9), one entry per pointer and constraint, at most 50. `detail` gives the total, e.g. "Request validation failed: 3 problems. See errors[]." or "…: 72 problems; the first 50 are in errors[]."'""",
          """          description: 'Every problem found (request validation runs with allErrors since core round 9), one entry per pointer and constraint, at most 50 and at most 12 KiB of JSON, so the problem body stays under 16 KiB. `detail` gives the total, e.g. "Request validation failed: 3 problems. See errors[]." or "…: 72 problems; the first 50 are in errors[]." Before Ajv a structural guard (core round 10, SA-C5-01) refuses an array over its maxItems with one `maxItems` error for that array (its items are not inspected) and a body with more than 50 unknown keys with 50 `additionalProperties` errors. Echoed property names are RFC 6901 escaped (~0, ~1) and cut to 64 characters; each pointer is at most 256 characters.'""")
# tax cost
p1=rep(p1,"        Token cost: 1 + floor(lines/50).\n","        Token cost: 1 + floor(lines/50), charged from the raw `lines` length **before** validation (core round 10, SA-C5-01), so an oversized invalid body still pays for its size (85,000 items cost 1701 tokens and get 429 on a default 600/min key).\n")
# BadRequest examples
s=p1 if "    BadRequest:\n" in p1 else p2
i=s.find("    BadRequest:\n"); a=s.find("          example:\n",i); b=s.find("    AdminBadRequest:",i)
assert i>=0 and a>i and b>a
def ex(key,summ,obj): return "            "+key+":\n              summary: "+json.dumps(summ+LIVE)+"\n              value:\n"+dump(obj,16)
e18e=live('18e-400-unknown'); e18e['errors']=e18e['errors'][:3]
s=s[:a]+"          examples:\n"+ex('threeErrors','Three tax lines without supply_type',live('18c-400-multi'))+ex('maxItems','501 lines: one maxItems error for the array (structural guard, before Ajv)',live('18d-400-maxitems'))+ex('unknownKeys','60 unknown top-level keys: 50 errors, the total in detail (errors trimmed to 3 here)',e18e)+s[b:]
s=rep(s,"(three tax lines without `supply_type`).'","(three tax lines without `supply_type`; 501 lines; 60 unknown keys).'")
if "    BadRequest:\n" in p1: p1=s
else: p2=s
# AdminBadRequest: notification pattern example
s=p1 if "    AdminBadRequest:\n" in p1 else p2
i=s.find("    AdminBadRequest:\n"); b=s.find("    Unauthorized:\n",i)
s=s[:b]+"            notificationPattern:\n              summary: "+json.dumps("Verify with a free-text source.notification"+LIVE)+"\n              value:\n"+dump(live('a22-notification-freetext'),16)+s[b:]
if "    AdminBadRequest:\n" in p1: p1=s
else: p2=s
open(d+'part1.yaml','w').write(p1); open(d+'part2.yaml','w').write(p2); print('r10 ok')
