import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { migrate } from "../src/migrate";

export function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}
