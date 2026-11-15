import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Open the database with WAL and foreign keys on. Migrations are applied separately. */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

export function schemaVersion(db: Database): number {
  const t = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!t) return 0;
  const row = db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}
