"""Validate openapi.yaml: YAML parses, every $ref resolves, every example validates (Draft 2020-12)."""
import sys, yaml, json
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

path = sys.argv[1]
doc = yaml.safe_load(open(path))
assert doc['openapi'].startswith('3.1'), 'not 3.1'
URI = 'urn:openapi'
reg = Registry().with_resource(URI, Resource(contents=doc, specification=DRAFT202012))

def ptr(ref):
    assert ref.startswith('#/'), ref
    node = doc
    for part in ref[2:].split('/'):
        part = part.replace('~1', '/').replace('~0', '~')
        node = node[part]
    return node

refs = []
def walk(n, where):
    if isinstance(n, dict):
        if '$ref' in n and isinstance(n['$ref'], str):
            refs.append((n['$ref'], where))
        for k, v in n.items():
            walk(v, where + '/' + str(k))
    elif isinstance(n, list):
        for i, v in enumerate(n):
            walk(v, where + '/' + str(i))
walk(doc, '')
bad = []
for r, w in refs:
    try: ptr(r)
    except Exception: bad.append((r, w))
print(f'refs: {len(refs)} total, {len(bad)} unresolved')
for b in bad: print('  UNRESOLVED', b)

# check schemas themselves are valid 2020-12
for name, s in doc['components']['schemas'].items():
    Draft202012Validator.check_schema(s)

def deref(o):
    while isinstance(o, dict) and '$ref' in o:
        o = ptr(o['$ref'])
    return o

def validate(schema, value, label):
    v = Draft202012Validator({'$ref': URI + '#' + schema['$ref'][1:]} if '$ref' in schema else schema,
                             registry=reg, format_checker=FormatChecker())
    errs = sorted(v.iter_errors(value), key=lambda e: list(e.path))
    return [f'{label}: {"/".join(map(str, e.absolute_path))}: {e.message[:200]}' for e in errs]

# wrap inline schemas so their internal refs resolve against the doc
def as_schema(s):
    if '$ref' in s: return s
    return {'$id': 'urn:inline', **json.loads(json.dumps(s).replace('"#/components', '"urn:openapi#/components'))}

n = 0; failures = []
def check_media(mt, label):
    global n
    mt = deref(mt)
    schema = mt.get('schema')
    if schema is None: return
    s = as_schema(schema)
    if 'example' in mt:
        n += 1; failures.extend(validate(s, mt['example'], label + ' example'))
    for ek, ev in (mt.get('examples') or {}).items():
        ev = deref(ev)
        n += 1; failures.extend(validate(s, ev['value'], f'{label} examples.{ek}'))

for p, item in doc['paths'].items():
    for m, op in item.items():
        if m not in ('get', 'post', 'put', 'patch', 'delete'): continue
        for prm in op.get('parameters', []):
            prm = deref(prm)
            if 'example' in prm:
                n += 1; failures.extend(validate(as_schema(prm['schema']), prm['example'], f'{m.upper()} {p} param {prm["name"]}'))
        rb = op.get('requestBody')
        if rb:
            for ct, mt in deref(rb)['content'].items():
                check_media(mt, f'{m.upper()} {p} request {ct}')
        for code, resp in op['responses'].items():
            resp = deref(resp)
            for ct, mt in (resp.get('content') or {}).items():
                check_media(mt, f'{m.upper()} {p} {code} {ct}')
for name, resp in doc['components']['responses'].items():
    for ct, mt in (resp.get('content') or {}).items():
        check_media(mt, f'components.responses.{name} {ct}')
for name, h in doc['components']['headers'].items():
    if 'example' in h:
        n += 1; failures.extend(validate(as_schema(h['schema']), h['example'], f'header {name}'))

print(f'examples validated: {n}, failures: {len(failures)}')
for f in failures: print('  FAIL', f)
ops = sum(1 for p in doc['paths'].values() for m in p if m in ('get','post','delete','put','patch'))
print(f'paths: {len(doc["paths"])}, operations: {ops}, schemas: {len(doc["components"]["schemas"])}')
sys.exit(1 if bad or failures else 0)
