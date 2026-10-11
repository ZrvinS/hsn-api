import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BASE_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

export const SCHEMA_VERSION = MIGRATIONS.reduce((v, m) => Math.max(v, m.version), BASE_SCHEMA_VERSION);

function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/schema.sql when run via tsx; dist/db/schema.sql (copied by `npm run build`) or ../../src/db when built.
  const candidates = [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'db', 'schema.sql')];
  for (const c of candidates) if (existsSync(c)) return readFileSync(c, 'utf8');
  throw new Error('schema.sql not found');
}

function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
}

/** Open the read-write connection (admin writes, migrations). Extension loading stays disabled. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: false });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  applyPragmas(db);
  return db;
}

/** Tables the cache writer may write (SEC-91); api_keys only its last_used_at column. */
export const CACHE_WRITER_TABLES = ['products', 'idempotency_keys'] as const;

/**
 * Open the cache-writer connection (SEC-91, SA-D-13): request-path writes (product cache, API key
 * last_used_at, idempotency rows) go through it. node:sqlite has no authorizer, so per-connection TEMP
 * triggers refuse every other write: INSERT/UPDATE/DELETE on any other table, and any api_keys change other
 * than last_used_at. Call after migrate(); tables added later are covered from the next open.
 */
export function openCacheDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: false });
  applyPragmas(db);
  const tables = db.prepare(`SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; sql: string }[];
  const virtual = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const refuse = (n: string) => `SELECT RAISE(ABORT, 'cache-writer connection: writes to ${n.replace(/'/g, '')} are not allowed')`;
  const ddl: string[] = [];
  for (const { name, sql } of tables) {
    if (/^CREATE VIRTUAL TABLE/i.test(sql) || virtual.some((v) => name.startsWith(`${v}_`))) continue; // FTS: fed only by hsn_codes triggers
    if ((CACHE_WRITER_TABLES as readonly string[]).includes(name)) continue;
    if (name === 'api_keys') {
      const cols = (db.prepare(`PRAGMA main.table_info(api_keys)`).all() as { name: string }[]).map((c) => c.name).filter((c) => c !== 'last_used_at');
      ddl.push(`CREATE TEMP TRIGGER cw_api_keys_u BEFORE UPDATE OF ${cols.map(q).join(', ')} ON main.api_keys BEGIN ${refuse(name)}; END;`);
      ddl.push(`CREATE TEMP TRIGGER cw_api_keys_i BEFORE INSERT ON main.api_keys BEGIN ${refuse(name)}; END;`);
      ddl.push(`CREATE TEMP TRIGGER cw_api_keys_d BEFORE DELETE ON main.api_keys BEGIN ${refuse(name)}; END;`);
      continue;
    }
    for (const [op, tag] of [['INSERT', 'i'], ['UPDATE', 'u'], ['DELETE', 'd']] as const) {
      ddl.push(`CREATE TEMP TRIGGER ${q(`cw_${name}_${tag}`)} BEFORE ${op} ON main.${q(name)} BEGIN ${refuse(name)}; END;`);
    }
  }
  db.exec(ddl.join('\n'));
  return db;
}

/** Open a read-only connection for request handling (SEC-42). */
export function openReadDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  applyPragmas(db);
  db.exec('PRAGMA query_only=ON;');
  return db;
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!t) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Apply migrations inside one transaction; refuse to run on a newer schema than we know.
 * Empty database: schema.sql (version 2 base) then every step. Version >= 2: only the missing steps.
 */
export function migrate(db: DatabaseSync, nowIso: string = new Date().toISOString()): number {
  const v = currentSchemaVersion(db);
  if (v > SCHEMA_VERSION) throw new Error(`Database schema version ${v} is newer than this build (${SCHEMA_VERSION}); refusing to start`);
  if (v === SCHEMA_VERSION) return v;
  if (v !== 0 && v < BASE_SCHEMA_VERSION) {
    // Pre-release: schema 1 databases are not upgraded in place (no production data exists yet).
    throw new Error(`Database schema version ${v} predates ${BASE_SCHEMA_VERSION}; re-create it with npm run seed (pre-release, no in-place upgrade)`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (v === 0) {
      db.exec(schemaSql());
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(BASE_SCHEMA_VERSION, nowIso);
    }
    const from = v === 0 ? BASE_SCHEMA_VERSION : v;
    for (const step of MIGRATIONS) {
      if (step.version <= from) continue;
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(step.version, nowIso);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return SCHEMA_VERSION;
}
