#!/bin/sh
# usage: build.sh <server dir> <out data-model.md>
D=$(dirname "$0")
node "$D/gen-ddl.cjs" "$1" > "$D/ddl-sec2.md"
python3 - "$D/data-model.template.md" "$D/ddl-sec2.md" "$2" <<'PY'
import sys
t=open(sys.argv[1]).read(); d=open(sys.argv[2]).read().rstrip()
open(sys.argv[3],'w').write(t.replace('@@DDL@@',d))
PY
