import { describe, expect, test } from "bun:test";
import { parseWorkbook } from "../src/workbook/parse";
import { normaliseDate, normaliseUid } from "../src/workbook/normalise";
import { build, good, goodSpec, setCell } from "./fixtures";

const errs = (buf: Uint8Array) => parseWorkbook(buf).errors;
const one = (buf: Uint8Array) => {
  const e = errs(buf);
  expect(e).toHaveLength(1);
  return e[0]!;
};

describe("parseWorkbook: good file", () => {
  const p = parseWorkbook(good());
  test("no errors, all rows", () => {
    expect(p.errors).toEqual([]);
    expect(p.schemaVersion).toBe(1);
    expect(p.rows.people).toHaveLength(4);
    expect(p.rows.fobs).toHaveLength(5);
    expect(p.rows.kit).toHaveLength(3);
    expect(p.rows.boxes).toHaveLength(2);
  });
  test("fob UIDs normalised, dates to ISO from serial, dd/mm/yyyy and ISO text", () => {
    expect(p.rows.fobs.map((f) => f.fob_uid)).toEqual([
      "04A1B2C3D4E5F6",
      "04A1B2C3D4E5F7",
      "AABBCCDD",
      "11223344",
      "DEADBEEF",
    ]);
    expect(p.rows.fobs.map((f) => f.issued)).toEqual(["2026-09-01", "2026-09-01", "2026-11-15", null, "2025-09-02"]);
    expect(p.rows.kit[1]!.tag_uid).toBe("04112233445566");
  });
  test("blanks: nullable -> null, text -> '', offline unlock default 5", () => {
    expect(p.rows.people[1]).toMatchObject({ year: null, level: null, specialism: null, notes: "Head of drama" });
    expect(p.rows.people[2]!.notes).toBe("");
    expect(p.rows.boxes[1]!.offline_unlock_min).toBe(5);
    expect(p.rows.boxes[1]!.ip_address).toBeNull();
  });
  test("unknown columns kept with a warning; (auto) columns ignored", () => {
    expect(p.extraColumns.kit).toEqual(["Colour"]);
    expect(p.rows.kit[0]!.extra).toEqual({ Colour: "Red" });
    expect(p.warnings.some((w) => w.column === "Colour")).toBe(true);
    expect(p.extraColumns.fobs).toEqual([]);
    expect(p.readme[4]).toEqual(["How to use", "Some help text that must survive a round trip."]);
  });
  test("column order and header case don't matter", () => {
    const s = goodSpec();
    s.People = s.People.map((r) => [...r].reverse());
    s.People[0] = s.People[0]!.map((h) => `  ${String(h).toUpperCase()} `);
    const q = parseWorkbook(build(s));
    expect(q.errors).toEqual([]);
    expect(q.rows.people[0]).toMatchObject({ person_id: "P001", name: "Ada Crew", level: 2 });
  });
  test("data stops at the first fully blank row", () => {
    const s = goodSpec();
    s.Boxes.push([null, null], ["BOX-99", "After gap", "Bogus", null, "Nope"]);
    const q = parseWorkbook(build(s));
    expect(q.errors).toEqual([]);
    expect(q.rows.boxes).toHaveLength(2);
  });
  test("enum case is forgiven and stored canonically", () => {
    const s = goodSpec();
    setCell(s.People, 1, "Type", "student");
    expect(parseWorkbook(build(s)).rows.people[0]!.type).toBe("Student");
  });
  test("optional Fobs.Level column may be missing", () => {
    const s = goodSpec();
    const c = s.Fobs[0]!.indexOf("Level");
    s.Fobs = s.Fobs.map((r) => r.filter((_, i) => i !== c));
    const q = parseWorkbook(build(s));
    expect(q.errors).toEqual([]);
    expect(q.rows.fobs[2]!.level).toBeNull();
  });
});

describe("parseWorkbook: errors (sheet, row, column)", () => {
  test("schema version must be 1", () => {
    const s = goodSpec();
    s.readme[1] = ["Schema version", 2];
    expect(one(build(s))).toMatchObject({ sheet: "Read me", row: 2, column: "B" });
  });
  test("missing Read me sheet", () => {
    expect(errs(build(goodSpec(), ["readme"]))[0]).toMatchObject({ sheet: "Read me", row: null });
  });
  test("missing sheet", () => {
    expect(errs(build(goodSpec(), ["Boxes"]))[0]).toMatchObject({ sheet: "Boxes", message: expect.stringContaining("missing") });
  });
  test("missing required column", () => {
    const s = goodSpec();
    s.People[0]![s.People[0]!.indexOf("Status")] = "State";
    expect(errs(build(s))[0]).toMatchObject({ sheet: "People", row: 1, column: "Status" });
  });
  test("bad enum", () => {
    const s = goodSpec();
    setCell(s.Kit, 1, "Category", "Video");
    expect(one(build(s))).toMatchObject({ sheet: "Kit", row: 2, column: "Category" });
  });
  test("duplicate ID", () => {
    const s = goodSpec();
    setCell(s.Kit, 3, "Kit ID", "K001");
    expect(one(build(s))).toMatchObject({ sheet: "Kit", row: 4, column: "Kit ID", message: expect.stringContaining("row 2") });
  });
  test("duplicate fob UID after normalising", () => {
    const s = goodSpec();
    setCell(s.Fobs, 4, "Fob UID", "aa:bb:cc:dd");
    expect(one(build(s))).toMatchObject({ sheet: "Fobs", row: 5, column: "Fob UID" });
  });
  test("fob UID wrong length / not hex / numeric cell", () => {
    for (const bad of ["AABBCC", "ZZBBCCDD", 4123456]) {
      const s = goodSpec();
      setCell(s.Fobs, 4, "Fob UID", bad);
      expect(one(build(s))).toMatchObject({ sheet: "Fobs", row: 5, column: "Fob UID" });
    }
  });
  test("unknown Person ID reference", () => {
    const s = goodSpec();
    setCell(s.Fobs, 2, "Person ID", "P999");
    expect(one(build(s))).toMatchObject({ sheet: "Fobs", row: 3, column: "Person ID" });
  });
  test("blank Person ID on an active Standard fob", () => {
    const s = goodSpec();
    setCell(s.Fobs, 2, "Person ID", null);
    expect(one(build(s))).toMatchObject({ sheet: "Fobs", row: 3, column: "Person ID" });
  });
  test("unknown Box ID reference", () => {
    const s = goodSpec();
    setCell(s.Kit, 3, "Box ID", "BOX-77");
    expect(one(build(s))).toMatchObject({ sheet: "Kit", row: 4, column: "Box ID" });
  });
  test("levels 1-4", () => {
    for (const bad of [0, 5, 2.5, "two"]) {
      const s = goodSpec();
      setCell(s.People, 1, "Level", bad);
      expect(one(build(s))).toMatchObject({ sheet: "People", row: 2, column: "Level" });
    }
  });
  test("required value blank", () => {
    const s = goodSpec();
    setCell(s.Boxes, 1, "Name", "  ");
    expect(one(build(s))).toMatchObject({ sheet: "Boxes", row: 2, column: "Name" });
  });
  test("bad IP, bad date, duplicate tag UID", () => {
    const s = goodSpec();
    setCell(s.Boxes, 1, "IP address", "10.102.40.300");
    setCell(s.Fobs, 1, "Issued", "31/02/2026");
    setCell(s.Kit, 1, "Tag UID", "04112233445566");
    const e = errs(build(s));
    expect(e.map((x) => [x.sheet, x.column])).toEqual([
      ["Fobs", "Issued"],
      ["Kit", "Tag UID"],
      ["Boxes", "IP address"],
    ]);
  });
  test("not an xlsx at all", () => {
    expect(errs(new TextEncoder().encode("hello"))[0]!.message).toContain("Read me");
  });
});

describe("parseWorkbook: warnings", () => {
  test("kit needing a lower level than its box", () => {
    const s = goodSpec();
    setCell(s.Kit, 1, "Required level", 1);
    const p = parseWorkbook(build(s));
    expect(p.errors).toEqual([]);
    expect(p.warnings.find((w) => w.column === "Required level")).toMatchObject({ sheet: "Kit", row: 2 });
  });
  test("Lost fob without Ended", () => {
    const s = goodSpec();
    setCell(s.Fobs, 5, "Ended", null);
    expect(parseWorkbook(build(s)).warnings.find((w) => w.column === "Ended")).toMatchObject({ row: 6 });
  });
});

describe("normalisers", () => {
  test("UID", () => {
    expect(normaliseUid(" 04-a1:b2 c3d4e5f6 ")).toEqual({ ok: true, value: "04A1B2C3D4E5F6" });
    expect(normaliseUid("0102030405060708090A").ok).toBe(true);
  });
  test("dates", () => {
    expect(normaliseDate(new Date("2026-03-29T23:30:00Z"))).toEqual({ ok: true, value: "2026-03-30" }); // BST
    expect(normaliseDate("5/1/2027")).toEqual({ ok: true, value: "2027-01-05" });
    expect(normaliseDate("2027-13-01").ok).toBe(false);
  });
});
