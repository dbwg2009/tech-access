import { describe, expect, test } from "bun:test";
import {
  adminCheck,
  canApplySoftwareUpdate,
  decideBoxOpen,
  decideKitTake,
  effectiveLevel,
  isAdmin,
  type AccessSettings,
} from "../src/access";
import type { Box, Fob, Kit, Person } from "../src/workbook/schema";

// 15 Nov 2026 is GMT; 1 Jul 2026 is BST.
const NOW = new Date("2026-11-15T18:00:00Z");
const OPEN: AccessSettings = { studentsDisabled: false };
const DISABLED: AccessSettings = { studentsDisabled: true };

const person = (o: Partial<Person> = {}): Person => ({
  person_id: "P001", name: "Ada", type: "Student", year: 9, level: 2, specialism: "Lighting",
  status: "Active", notes: "", extra: {}, ...o,
});
const fob = (o: Partial<Fob> = {}): Fob => ({
  fob_uid: "04A1B2C3D4E5F6", person_id: "P001", role: "Standard", status: "Active", level: null,
  issued: "2026-09-01", ended: null, notes: "", extra: {}, ...o,
});
const box = (required_level: number | null = 2): Pick<Box, "box_id" | "name" | "required_level"> => ({
  box_id: "BOX-01", name: "Mic box", required_level,
});
const kit = (o: Partial<Kit> = {}): Pick<Kit, "kit_id" | "item" | "required_level" | "specialism"> => ({
  kit_id: "K001", item: "Par can", required_level: 1, specialism: "Lighting", ...o,
});

const open = (f: Fob | null, p: Person | null, b = box(), s = OPEN, now = NOW) =>
  decideBoxOpen({ fob: f, person: p, box: b, settings: s, now });
const take = (f: Fob | null, p: Person | null, k = kit(), s = OPEN, now = NOW) =>
  decideKitTake({ fob: f, person: p, kit: k, settings: s, now });

describe("decideBoxOpen", () => {
  test("level >= required", () => {
    expect(open(fob(), person())).toEqual({ allow: true, reason: "Level 2" });
    expect(open(fob(), person({ level: 1 }))).toEqual({ allow: false, reason: "Level 2 needed, you're Level 1" });
    expect(open(fob(), person({ level: 1 }), box(null)).allow).toBe(true);
  });
  test("student with no level is refused", () => {
    expect(open(fob(), person({ level: null }), box(null))).toEqual({ allow: false, reason: "No level set, ask a staff member" });
  });
  test("unknown fob", () => {
    expect(open(null, null)).toEqual({ allow: false, reason: "Fob not recognised" });
  });
  test.each(["Lost", "Revoked", "Spare"] as const)("fob must be Active (%s)", (status) => {
    expect(open(fob({ status }), person())).toEqual({ allow: false, reason: `This fob is ${status}` });
  });
  test.each(["Disabled", "Left"] as const)("person must be Active (%s)", (status) => {
    expect(open(fob(), person({ status }))).toEqual({ allow: false, reason: `Ada is ${status}` });
  });
  test("wrong or missing person row", () => {
    expect(open(fob(), null).allow).toBe(false);
    expect(open(fob(), person({ person_id: "P002" })).allow).toBe(false);
    expect(open(fob({ person_id: null }), null)).toEqual({ allow: false, reason: "Fob isn't assigned to anyone" });
  });
  test("staff and hire techs count as Level 4", () => {
    expect(open(fob(), person({ type: "Staff", level: null }), box(4))).toEqual({ allow: true, reason: "Level 4" });
    expect(open(fob(), person({ type: "Hire tech", level: null }), box(4)).allow).toBe(true);
  });
  test("disable all students: blocks students only, never admin", () => {
    expect(open(fob(), person(), box(), DISABLED)).toEqual({ allow: false, reason: "Students are disabled right now" });
    expect(open(fob(), person({ type: "Staff" }), box(), DISABLED).allow).toBe(true);
    expect(open(fob({ role: "Admin" }), person({ level: 1 }), box(4), DISABLED)).toEqual({ allow: true, reason: "Admin" });
  });
  test("admin opens any box, still needs Active fob and person", () => {
    expect(open(fob({ role: "Admin" }), person({ level: 1 }), box(4)).allow).toBe(true);
    expect(open(fob({ role: "Admin", status: "Revoked" }), person(), box()).allow).toBe(false);
    expect(open(fob({ role: "Admin" }), person({ status: "Left" }), box()).allow).toBe(false);
  });
});

describe("day pass", () => {
  const guest = (o: Partial<Fob> = {}) => fob({ role: "Day pass", person_id: null, level: 2, issued: "2026-11-15", ...o });
  test("fixed level on the fob, blank = 1", () => {
    expect(open(guest(), null, box(2))).toEqual({ allow: true, reason: "Level 2" });
    expect(open(guest({ level: null }), null, box(2))).toEqual({ allow: false, reason: "Level 2 needed, you're Level 1" });
  });
  test("carries its own level, not the holder's", () => {
    expect(effectiveLevel(guest({ level: 1 }), person({ level: 4 }))).toBe(1);
    expect(open(guest({ person_id: "P001", level: 1 }), person({ level: 4 }), box(2)).allow).toBe(false);
  });
  test("expires at the end of the issue day, Europe/London", () => {
    expect(open(guest(), null, box(1), OPEN, new Date("2026-11-15T23:59:59Z")).allow).toBe(true);
    expect(open(guest(), null, box(1), OPEN, new Date("2026-11-16T00:00:00Z"))).toEqual({ allow: false, reason: "Day pass has expired" });
    // BST: 23:30 UTC on 1 July is already 2 July in London.
    const summer = guest({ issued: "2026-07-01" });
    expect(open(summer, null, box(1), OPEN, new Date("2026-07-01T22:59:00Z")).allow).toBe(true);
    expect(open(summer, null, box(1), OPEN, new Date("2026-07-01T23:00:00Z")).allow).toBe(false);
  });
  test("not valid before its day; needs an issue date", () => {
    expect(open(guest({ issued: "2026-11-16" }), null, box(1))).toEqual({ allow: false, reason: "Day pass isn't valid yet" });
    expect(open(guest({ issued: null }), null, box(1))).toEqual({ allow: false, reason: "Day pass has no issue date" });
  });
  test("guest pass isn't blocked by disable students; a student's pass is", () => {
    expect(open(guest(), null, box(1), DISABLED).allow).toBe(true);
    expect(open(guest({ person_id: "P001" }), person(), box(1), DISABLED).allow).toBe(false);
  });
});

describe("decideKitTake", () => {
  test("specialism: Any and blank match everyone", () => {
    expect(take(fob(), person({ specialism: "Sound" }), kit({ specialism: "Any" })).allow).toBe(true);
    expect(take(fob(), person({ specialism: null }), kit({ specialism: null })).allow).toBe(true);
  });
  test("specialism must match; Lighting + Sound matches both", () => {
    expect(take(fob(), person({ specialism: "Sound" }))).toEqual({ allow: false, reason: "Lighting crew only" });
    expect(take(fob(), person({ specialism: null })).allow).toBe(false);
    expect(take(fob(), person({ specialism: "Lighting + Sound" })).allow).toBe(true);
    expect(take(fob(), person({ specialism: "Lighting + Sound" }), kit({ specialism: "Sound" })).allow).toBe(true);
  });
  test("level is checked before specialism", () => {
    expect(take(fob(), person({ level: 1, specialism: "Sound" }), kit({ required_level: 3 }))).toEqual({
      allow: false,
      reason: "Level 3 needed, you're Level 1",
    });
  });
  test("staff, hire techs and admin match any specialism", () => {
    expect(take(fob(), person({ type: "Staff", specialism: null }), kit({ specialism: "Sound" })).allow).toBe(true);
    expect(take(fob(), person({ type: "Hire tech", specialism: null }), kit({ specialism: "Sound", required_level: 4 })).allow).toBe(true);
    expect(take(fob({ role: "Admin" }), person({ specialism: null }), kit({ specialism: "Sound" })).allow).toBe(true);
  });
  test("guest day pass only takes Any kit", () => {
    const g = fob({ role: "Day pass", person_id: null, level: 4, issued: "2026-11-15" });
    expect(take(g, null, kit({ specialism: "Lighting" })).allow).toBe(false);
    expect(take(g, null, kit({ specialism: "Any" })).allow).toBe(true);
  });
  test("common rules apply too", () => {
    expect(take(fob({ status: "Lost" }), person()).allow).toBe(false);
    expect(take(fob(), person(), kit(), DISABLED).reason).toBe("Students are disabled right now");
  });
});

describe("admin and software update", () => {
  test("isAdmin", () => {
    expect(isAdmin(fob({ role: "Admin" }))).toBe(true);
    expect(isAdmin(fob({ role: "Admin", status: "Lost" }))).toBe(false);
    expect(isAdmin(fob())).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
  test("adminCheck needs an Active owner", () => {
    expect(adminCheck(fob({ role: "Admin" }), person({ status: "Disabled" })).allow).toBe(false);
    expect(adminCheck(fob({ role: "Admin" }), person()).allow).toBe(true);
  });
  test("canApplySoftwareUpdate: Level 3+ student or staff, or admin", () => {
    expect(canApplySoftwareUpdate(fob(), person({ level: 3 })).allow).toBe(true);
    expect(canApplySoftwareUpdate(fob(), person({ level: 2 }))).toEqual({ allow: false, reason: "Level 3 needed, you're Level 2" });
    expect(canApplySoftwareUpdate(fob(), person({ type: "Staff", level: null })).allow).toBe(true);
    expect(canApplySoftwareUpdate(fob({ role: "Admin" }), person({ level: 1 })).allow).toBe(true);
  });
  test("canApplySoftwareUpdate: not hire techs, day passes, inactive, or disabled students", () => {
    expect(canApplySoftwareUpdate(fob(), person({ type: "Hire tech" })).allow).toBe(false);
    expect(canApplySoftwareUpdate(fob({ role: "Day pass", level: 4, issued: "2026-11-15" }), person()).allow).toBe(false);
    expect(canApplySoftwareUpdate(fob({ status: "Revoked" }), person({ level: 4 })).allow).toBe(false);
    expect(canApplySoftwareUpdate(fob(), person({ level: 4 }), DISABLED).allow).toBe(false);
    expect(canApplySoftwareUpdate(null, null).allow).toBe(false);
  });
});

describe("show mode (decision 2026-11-16)", () => {
  const SHOW: AccessSettings = { studentsDisabled: false, showMode: true };
  test("any box opens with no fob at all", () => {
    expect(open(null, null, box(4), SHOW)).toEqual({ allow: true, reason: "Show mode" });
  });
  test("overrides level, fob status and disable-all-students for boxes", () => {
    expect(open(fob(), person({ level: 1 }), box(4), SHOW).allow).toBe(true);
    expect(open(fob({ status: "Lost" }), person(), box(4), SHOW).allow).toBe(true);
    expect(open(fob(), person(), box(4), { studentsDisabled: true, showMode: true }).allow).toBe(true);
  });
  test("does not affect kit: Take kit still needs clearance", () => {
    expect(take(fob(), person({ level: 1 }), kit({ required_level: 3 }), SHOW).allow).toBe(false);
    expect(take(null, null, kit(), SHOW).allow).toBe(false);
  });
  test("off by default: normal rules", () => {
    expect(open(null, null, box(1), { studentsDisabled: false, showMode: false }).allow).toBe(false);
  });
});

import { decideCrewCard } from "../src/access";
import { firstName } from "../src/names";

describe("crew card and names", () => {
  test("decideCrewCard uses the shared checks only", () => {
    expect(decideCrewCard(fob(), person({ level: 1 }), OPEN, NOW)).toEqual({ allow: true, reason: "OK" });
    expect(decideCrewCard(fob(), person(), DISABLED, NOW)).toEqual({ allow: false, reason: "Students are disabled right now" });
    expect(decideCrewCard(fob({ status: "Lost" }), person(), OPEN, NOW).reason).toBe("This fob is Lost");
    expect(decideCrewCard(null, null, OPEN, NOW).reason).toBe("Fob not recognised");
  });
  test("deny reasons use first names", () => {
    expect(open(fob(), person({ name: "Ada Lovelace", status: "Disabled" })).reason).toBe("Ada is Disabled");
  });
  test("firstName: first word, or title + surname for staff", () => {
    expect(firstName("Ada Lovelace")).toBe("Ada");
    expect(firstName("Mrs Ritter")).toBe("Mrs Ritter");
    expect(firstName("Mr. John Smith")).toBe("Mr. Smith");
    expect(firstName("Dr")).toBe("Dr");
    expect(firstName("  ")).toBe("");
    expect(firstName(null)).toBe("");
  });
});
