import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { applyBatch, createBatch } from "../src/workbook/batches";
import { diff } from "../src/workbook/diff";
import { exportWorkbook } from "../src/workbook/export";
import { parseWorkbook } from "../src/workbook/parse";
import { ADMIN_UID, STUDENT_UID, build, good, goodSpec, setCell } from "./fixtures";
import { freshDb } from "./helpers";

const NOW = new Date("2026-11-15T18:00:00Z");

function seeded(): Database {
  const db = freshDb();
  const p = createBatch(db, good(), "tracker.xlsx", NOW);
  expect(applyBatch(db, p.batchId, ADMIN_UID, NOW)).toMatchObject({ kind: "applied", bootstrap: true });
  return db;
}

const events = (db: Database, type: string) =>
  db.query<{ detail: string; fob_uid: string; person_id: string }, [string]>("SELECT * FROM events WHERE type = ?").all(type);

describe("diff", () => {
  test("first import: everything is an add", () => {
    const d = diff(parseWorkbook(good()), freshDb());
    expect(d.counts).toEqual({
      people: { adds: 4, changes: 0, removals: 0 },
      fobs: { adds: 5, changes: 0, removals: 0 },
      kit: { adds: 3, changes: 0, removals: 0 },
      boxes: { adds: 2, changes: 0, removals: 0 },
    });
  });

  test("same file again: empty", () => {
    expect(diff(parseWorkbook(good()), seeded()).empty).toBe(true);
  });

  test("field-level changes, old -> new", () => {
    const s = goodSpec();
    setCell(s.People, 1, "Level", 3);
    setCell(s.Kit, 1, "Colour", "Blue");
    const d = diff(parseWorkbook(build(s)), seeded());
    expect(d.sheets.people.changes).toEqual([{ id: "P001", row: 2, fields: [{ column: "Level", old: 2, new: 3 }] }]);
    expect(d.sheets.kit.changes[0]!.fields).toEqual([{ column: "Colour", old: "Red", new: "Blue" }]);
  });

  test("rows missing from the file are removals; an ID change is flagged", () => {
    const s = goodSpec();
    s.Kit.splice(3, 1); // drop K003
    setCell(s.Kit, 1, "Kit ID", "K010"); // K001 renamed
    const d = diff(parseWorkbook(build(s)), seeded());
    expect(d.sheets.kit.removals.map((r) => r.id).sort()).toEqual(["K001", "K003"]);
    expect(d.sheets.kit.adds).toMatchObject([{ id: "K010", looksLikeIdChangeOf: "K001" }]);
    expect(d.warnings.some((w) => w.message.includes("looks like K001"))).toBe(true);
  });
});

describe("apply", () => {
  test("bootstrap first import, logs import_applied with counts", () => {
    const db = seeded();
    expect(db.query("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 4 });
    const [ev] = events(db, "import_applied");
    expect(ev!.fob_uid).toBe(ADMIN_UID);
    expect(ev!.person_id).toBe("P002");
    expect(JSON.parse(ev!.detail)).toMatchObject({ bootstrap: true, counts: { people: { adds: 4 } } });
  });

  test("second apply of the same batch is a no-op", () => {
    const db = freshDb();
    const p = createBatch(db, good(), null, NOW);
    applyBatch(db, p.batchId, ADMIN_UID, NOW);
    expect(applyBatch(db, p.batchId, ADMIN_UID, NOW)).toMatchObject({ kind: "already_applied" });
    expect(events(db, "import_applied")).toHaveLength(1);
  });

  test("only an Active Admin fob can apply", () => {
    const db = seeded();
    const s = goodSpec();
    setCell(s.People, 1, "Notes", "x");
    const p = createBatch(db, build(s), null, NOW);
    expect(applyBatch(db, p.batchId, STUDENT_UID, NOW)).toMatchObject({ kind: "forbidden" });
    expect(applyBatch(db, p.batchId, "CAFEBABE", NOW)).toMatchObject({ kind: "forbidden", reason: "Unknown fob" });
    expect(applyBatch(db, p.batchId, "nonsense", NOW)).toMatchObject({ kind: "forbidden" });
    expect(applyBatch(db, p.batchId, "04:a1:b2:c3:d4:e5:f6", NOW)).toMatchObject({ kind: "applied", bootstrap: false });
  });

  test("bootstrap refuses a non-admin fob from the file", () => {
    const db = freshDb();
    const p = createBatch(db, good(), null, NOW);
    expect(applyBatch(db, p.batchId, STUDENT_UID, NOW)).toMatchObject({ kind: "forbidden" });
    expect(db.query("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 0 });
  });

  test("refuses to apply a file with errors", () => {
    const db = seeded();
    const s = goodSpec();
    setCell(s.Kit, 1, "Category", "Video");
    const p = createBatch(db, build(s), null, NOW);
    expect(p.canApply).toBe(false);
    expect(applyBatch(db, p.batchId, ADMIN_UID, NOW)).toMatchObject({ kind: "has_errors", errorCount: 1 });
  });

  test("removals archive rows: people -> Left, fobs -> Revoked with Ended", () => {
    const db = seeded();
    const s = goodSpec();
    s.People.splice(4, 1); // P004
    s.Fobs.splice(5, 1); // DEADBEEF (P004's)
    s.Kit.splice(3, 1); // K003
    const p = createBatch(db, build(s), null, NOW);
    expect(p.diff.counts.people.removals).toBe(1);
    expect(applyBatch(db, p.batchId, ADMIN_UID, NOW).kind).toBe("applied");
    expect(db.query("SELECT status, archived_at IS NOT NULL AS a FROM people WHERE person_id = 'P004'").get()).toEqual({ status: "Left", a: 1 });
    expect(db.query("SELECT status, ended FROM fobs WHERE fob_uid = 'DEADBEEF'").get()).toEqual({ status: "Revoked", ended: "2025-10-10" });
    expect(db.query("SELECT archived_at IS NOT NULL AS a FROM kit WHERE kit_id = 'K003'").get()).toEqual({ a: 1 });
    // Same file again: nothing left to do. Original file: archived rows come back as adds.
    expect(diff(parseWorkbook(build(s)), db).empty).toBe(true);
    const back = diff(parseWorkbook(good()), db);
    expect(back.sheets.people.adds).toMatchObject([{ id: "P004", restores: true }]);
  });

  test("a newer upload supersedes an older pending one", () => {
    const db = seeded();
    const a = createBatch(db, good(), null, NOW);
    createBatch(db, good(), null, NOW);
    expect(applyBatch(db, a.batchId, ADMIN_UID, NOW)).toEqual({ kind: "superseded" });
  });

  test("a stale preview is refused", () => {
    const db = seeded();
    const s = goodSpec();
    setCell(s.People, 1, "Notes", "changed");
    const p = createBatch(db, build(s), null, NOW);
    db.run("UPDATE people SET notes = 'edited elsewhere' WHERE person_id = 'P001'");
    expect(applyBatch(db, p.batchId, ADMIN_UID, NOW)).toEqual({ kind: "stale" });
  });
});

describe("export", () => {
  test("round trip: export -> import -> diff is empty", () => {
    const db = seeded();
    db.query("INSERT INTO events (type, person_id, kit_id) VALUES ('kit_out', 'P001', 'K001')").run();
    db.run("UPDATE boxes SET last_seen = '2026-11-15T17:59:00Z' WHERE box_id = 'BOX-01'");
    const file = exportWorkbook(db, NOW);
    const p = parseWorkbook(file);
    expect(p.errors).toEqual([]);
    const d = diff(p, db);
    expect(d.empty).toBe(true);
    expect(d.counts.kit).toEqual({ adds: 0, changes: 0, removals: 0 });
  });

  test("layout: Read me kept with B2/B3, auto columns filled, extra columns kept", async () => {
    const XLSX = await import("xlsx");
    const db = seeded();
    db.query("INSERT INTO events (type, person_id, kit_id) VALUES ('kit_out', 'P001', 'K001')").run();
    const wb = XLSX.read(exportWorkbook(db, NOW));
    expect(wb.SheetNames).toEqual(["Read me", "People", "Fobs", "Kit", "Boxes"]);
    const rm = wb.Sheets["Read me"]!;
    expect(rm["B2"]!.v).toBe(1);
    expect(rm["B3"]!.v).toBe(NOW.toISOString());
    expect(rm["B5"]!.v).toBe("Some help text that must survive a round trip.");
    const kit = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Kit"]!);
    expect(Object.keys(kit[0]!)).toContain("Out with (auto)");
    expect(kit[0]).toMatchObject({ "Kit ID": "K001", "Out with (auto)": "Ada Crew", Colour: "Red" });
    const fobs = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Fobs"]!, { header: 1 });
    expect(fobs[0]).toEqual(["Fob UID", "Person ID", "Role", "Level", "Status", "Issued", "Ended", "Notes", "Name (auto)"]);
    expect(wb.Sheets["Boxes"]!["J1"]!.v).toBe("Last seen (auto)");
    expect(events(db, "export")).toHaveLength(1);
  });

  test("export of an empty hub is a valid workbook", () => {
    const p = parseWorkbook(exportWorkbook(freshDb(), NOW));
    expect(p.errors).toEqual([]);
    expect(p.schemaVersion).toBe(1);
  });
});
