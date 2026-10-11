"""Final docs-vs-code sweep (00c ruling 35).

Usage: python3 -I sweep.py <server dir> <openapi.yaml> <docs dir>

Checks
  1. Every route method+path registered in <server>/src/routes/*.ts and src/app.ts
     appears in openapi.yaml, and every openapi operation is registered in code.
     /metrics (admin listener, Prometheus text) is an intentional openapi exclusion.
  2. Every problem code thrown in code (new AppError('x', ...), problem('x'), and
     literal .../problems/<slug> strings) is in src/lib/problem.ts; every slug in
     problem.ts is in the docs registries (openapi Problem description,
     ui-and-dx.md section 1 table, 07-best-practices.md section 3 table) with the same
     status; every slug the docs name (registries and openapi example `type` URIs)
     exists in code.
Exit status 1 when any gap is found.
"""
import glob, os, re, sys
import yaml

server, oa_path, docs = sys.argv[1:4]
src = os.path.join(server, 'src')
INTENTIONAL_NOT_IN_OPENAPI = {('GET', '/metrics'): 'admin listener, Prometheus text (architecture.md)',
                              ('OPTIONS', '/*'): 'CORS preflight catch-all (SEC-71), not an API operation'}
gaps = []

# ---------------------------------------------------------------- 1. routes
code_routes = {}
files = sorted(glob.glob(os.path.join(src, 'routes', '*.ts'))) + [os.path.join(src, 'app.ts')]
call_re = re.compile(r'\b(?:app|fastify|server|instance)\.(get|post|put|patch|delete|head|options)\s*(?:<|\()')
path_re = re.compile(r"""['"`](/[^'"`\s]*)['"`]""")
route_obj_re = re.compile(r"\.route\(\s*\{(.{0,400}?)\}", re.S)
for f in files:
    text = open(f, encoding='utf-8').read()
    for m in call_re.finditer(text):
        pm = path_re.search(text, m.end(), m.end() + 600)
        if not pm:
            gaps.append(f'CODE? cannot find path for {m.group(0)} in {os.path.relpath(f, server)}')
            continue
        line = text.count('\n', 0, m.start()) + 1
        code_routes[(m.group(1).upper(), pm.group(1))] = f'{os.path.relpath(f, server)}:{line}'
    for m in route_obj_re.finditer(text):
        body = m.group(1)
        meth = re.search(r"method:\s*\[?([^\],]+)", body)
        url = re.search(r"url:\s*['\"](/[^'\"]*)", body)
        if meth and url:
            for mm in re.findall(r"[A-Z]+", meth.group(1)):
                code_routes[(mm, url.group(1))] = os.path.relpath(f, server)

oa = yaml.safe_load(open(oa_path, encoding='utf-8'))
oa_routes = {}
for p, item in oa['paths'].items():
    for meth in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options'):
        if meth in item:
            oa_routes[(meth.upper(), re.sub(r'\{([^}]+)\}', r':\1', p))] = item[meth].get('operationId', '?')

print(f'routes in code: {len(code_routes)}; operations in openapi: {len(oa_routes)}')
for k in sorted(code_routes):
    if k not in oa_routes:
        if k in INTENTIONAL_NOT_IN_OPENAPI:
            print(f'  note: {k[0]} {k[1]} ({code_routes[k]}) not in openapi by design: {INTENTIONAL_NOT_IN_OPENAPI[k]}')
        else:
            gaps.append(f'DOCS: {k[0]} {k[1]} registered at {code_routes[k]} but missing from openapi')
for k in sorted(oa_routes):
    if k not in code_routes:
        gaps.append(f'CODE: openapi {k[0]} {k[1]} ({oa_routes[k]}) is not registered in code')

# ---------------------------------------------------------------- 2. problems
ptext = open(os.path.join(src, 'lib', 'problem.ts'), encoding='utf-8').read()
registry = {m.group(1): (m.group(2), int(m.group(3))) for m in re.finditer(
    r"^\s*([a-z_]+):\s*\{\s*slug:\s*'([a-z-]+)',\s*status:\s*(\d+)", ptext, re.M)}
slug_status = {s: st for s, st in registry.values()}
print(f'problem codes in problem.ts: {len(registry)}')

used = {}
for f in glob.glob(os.path.join(src, '**', '*.ts'), recursive=True):
    text = open(f, encoding='utf-8').read()
    rel = os.path.relpath(f, server)
    for m in re.finditer(r"new AppError\(\s*'([a-z_]+)'", text):
        used.setdefault(('code', m.group(1)), rel)
    for m in re.finditer(r"\bproblem\(\s*'([a-z_]+)'", text):
        used.setdefault(('code', m.group(1)), rel)
    if not rel.endswith(os.path.join('lib', 'problem.ts')):
        for m in re.finditer(r"PROBLEMS\.([a-z_]+)", text):
            used.setdefault(('code', m.group(1)), rel)
        for m in re.finditer(r"'([a-z]+(?:_[a-z]+)+|[a-z]+)'", text):
            if m.group(1) in registry:
                used.setdefault(('code', m.group(1)), rel)
    for m in re.finditer(r"problems/([a-z][a-z-]*[a-z])", text):
        used.setdefault(('slug', m.group(1)), rel)
for (kind, v), rel in sorted(used.items()):
    if kind == 'code' and v not in registry:
        gaps.append(f'CODE: problem code {v!r} used in {rel} is not in problem.ts')
    if kind == 'slug' and v not in slug_status:
        gaps.append(f'CODE: problem slug {v!r} hard-coded in {rel} is not in problem.ts')
unused = sorted(c for c in registry if ('code', c) not in used)
if unused:
    for c in unused:
        gaps.append(f'CODE: problem.ts has {c} ({registry[c][0]}, {registry[c][1]}) but nothing in src raises it')

def registry_from_openapi():
    desc = oa['components']['schemas']['Problem']['description']
    return {m.group(1): int(m.group(2)) for m in re.finditer(r'([a-z][a-z-]*[a-z]) \((\d{3})[;,)]', desc)}

def registry_from_uidx():
    t = open(os.path.join(docs, 'design', 'ui-and-dx.md'), encoding='utf-8').read()
    return {m.group(1): int(m.group(2)) for m in re.finditer(r'^\| `([a-z-]+)` \| (\d{3}) \|', t, re.M)}

def registry_from_bp():
    t = open(os.path.join(docs, '07-best-practices.md'), encoding='utf-8').read()
    sec = t.split('## 3.', 1)[1].split('\n## ', 1)[0]
    out = {}
    for m in re.finditer(r'^\| (\d{3}) \| (.+) \|$', sec, re.M):
        for s in re.findall(r'`([a-z][a-z-]*)`', m.group(2)):
            out[s] = int(m.group(1))
    return out

for name, reg in (('openapi Problem', registry_from_openapi()), ('ui-and-dx.md §1', registry_from_uidx()),
                  ('07-best-practices.md §3', registry_from_bp())):
    print(f'{name}: {len(reg)} slugs')
    for s, st in sorted(slug_status.items()):
        if s not in reg:
            gaps.append(f'DOCS: {s} ({st}) missing from {name}')
        elif reg[s] != st:
            gaps.append(f'DOCS: {s} is {reg[s]} in {name} but {st} in code')
    for s in sorted(set(reg) - set(slug_status)):
        gaps.append(f'DOCS: {name} lists {s}, which code does not have')

ex_slugs = set(re.findall(r'hsn-api\.example/problems/([a-z][a-z-]*[a-z])', open(oa_path, encoding='utf-8').read()))
for s in sorted(ex_slugs - set(slug_status)):
    gaps.append(f'DOCS: openapi example uses problem type {s}, which code does not have')

print()
if gaps:
    print(f'{len(gaps)} gap(s):')
    for g in gaps:
        print('  ' + g)
    sys.exit(1)
print('0 gaps')
