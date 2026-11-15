import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "../migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    out.push({ version: Number(m[1]), name: m[2]!, sql: readFileSync(resolve(dir, file), "utf8") });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations: expected version ${i + 1}, found ${m.version} (${m.name})`);
  });
  return out;
}

/** Apply pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: Database, migrations = loadMigrations()): number[] {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`);
  const done = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
    })();
    applied.push(m.version);
  }
  const fk = db.query("PRAGMA foreign_key_check").all();
  if (fk.length) throw new Error(`migrations: foreign key check failed: ${JSON.stringify(fk)}`);
  return applied;
}
