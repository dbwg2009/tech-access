import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, schemaVersion } from "../src/db";
import { loadMigrations, migrate } from "../src/migrate";
import { freshDb } from "./helpers";

describe("migrations", () => {
  test("apply once, record in schema_migrations, idempotent on restart", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual(loadMigrations().map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    expect(schemaVersion(db)).toBe(loadMigrations().length);
  });

  test("a failing migration rolls back and is not recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE b (x INTEGER); SELECT nope FROM nowhere;");
    const db = openDb(":memory:");
    expect(() => migrate(db, loadMigrations(dir))).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeNull();
  });

  test("gaps in numbering are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "003_c.sql"), "SELECT 1;");
    expect(() => loadMigrations(dir)).toThrow(/expected version 2/);
  });

  test("WAL and foreign keys are on (file db)", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "db-")), "t.db"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  });
});

describe("constraints", () => {
  const person = "INSERT INTO people (person_id, name, type, status) VALUES (?, ?, ?, ?)";

  test("enums are the exact workbook text", () => {
    const db = freshDb();
    db.query(person).run("P001", "Ada", "Hire tech", "Active");
    expect(() => db.query(person).run("P002", "Bob", "hire tech", "Active")).toThrow(/CHECK/);
    expect(() => db.query(person).run("P003", "Cy", "Student", "Gone")).toThrow(/CHECK/);
  });

  test("fob UID must be normalised hex of 4/7/10 bytes", () => {
    const db = freshDb();
    const fob = "INSERT INTO fobs (fob_uid, role, status) VALUES (?, 'Standard', 'Spare')";
    db.query(fob).run("04A1B2C3D4E5F6");
    expect(() => db.query(fob).run("04a1b2c3d4e5f7")).toThrow(/CHECK/);
    expect(() => db.query(fob).run("04A1B2")).toThrow(/CHECK/);
  });

  test("blank Person ID only for Spare or Day pass", () => {
    const db = freshDb();
    const fob = "INSERT INTO fobs (fob_uid, role, status) VALUES (?, ?, ?)";
    db.query(fob).run("AABBCCDD", "Day pass", "Active");
    expect(() => db.query(fob).run("AABBCCDE", "Standard", "Active")).toThrow(/CHECK/);
  });

  test("foreign keys enforced: kit box, fob person", () => {
    const db = freshDb();
    expect(() =>
      db.query("INSERT INTO kit (kit_id, item, category, box_id) VALUES ('K1', 'Mic', 'Sound', 'NOPE')").run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.query("INSERT INTO fobs (fob_uid, person_id, role, status) VALUES ('AABBCCDD', 'P9', 'Standard', 'Active')").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  test("events are append-only", () => {
    const db = freshDb();
    db.query("INSERT INTO events (type, fob_uid, detail) VALUES ('box_denied', 'DEADBEEF', '{\"reason\":\"x\"}')").run();
    expect(() => db.run("UPDATE events SET type = 'box_open'")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM events")).toThrow(/append-only/);
    expect(() => db.query("INSERT INTO events (type) VALUES ('party')").run()).toThrow(/CHECK/);
  });

  test("settings seeded", () => {
    const rows = freshDb().query<{ key: string; value: string }, []>("SELECT key, value FROM settings ORDER BY key").all();
    expect(rows).toEqual([
      { key: "show_mode", value: "false" },
      { key: "students_disabled", value: "false" },
    ]);
  });
});
