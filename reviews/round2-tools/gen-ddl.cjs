// Builds the data-model.md §2 SQL blocks from the code: schema.sql (base v2) + every MIGRATIONS step.
// usage: node gen-ddl.cjs <server dir>  -> prints markdown for §2 body
const fs = require('fs'), path = require('path');
const srv = process.argv[2];
const schema = fs.readFileSync(path.join(srv, 'src/db/schema.sql'), 'utf8');
const mig = fs.readFileSync(path.join(srv, 'src/db/migrations.ts'), 'utf8');
const consts = {};
for (const m of mig.matchAll(/const (\w+) = `([\s\S]*?)`;/g)) consts[m[1]] = m[2];
const steps = [...mig.matchAll(/\{ version: (\d+), name: '([^']*)', sql: (\w+) \}/g)].map((m) => ({ v: +m[1], name: m[2], sql: consts[m[3]] }));
const base = (mig.match(/BASE_SCHEMA_VERSION = (\d+)/) || [])[1];
let out = `### 2.1 Base schema (version ${base}): \`server/src/db/schema.sql\`\n\n\`\`\`sql\n${schema.replace(/\s+$/, '')}\n\`\`\`\n`;
for (const s of steps) {
  out += `\n### 2.${s.v - Number(base) + 1} Migration ${s.v} (${s.name}): \`server/src/db/migrations.ts\`\n\n\`\`\`sql\n${s.sql.replace(/^\n+/, '').replace(/\s+$/, '')}\n\`\`\`\n`;
}
process.stdout.write(out);
