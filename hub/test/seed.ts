// A small, realistic hub database for panel / admin / MQTT tests, written straight to SQL.
import type { Database } from "bun:sqlite";
import { freshDb } from "./helpers";

export const T0 = new Date("2026-11-16T18:00:00Z"); // a Monday evening, GMT (local date 2026-11-16)

export const UID = {
  ritterAdmin: "04A1B2C3D4E5F6", // Mrs Ritter, Admin
  danielAdmin: "0D0D0D0D", // Daniel, Admin
  ada: "04A1B2C3D4E5F7", // Ada, student Level 2 Lighting
  cal: "CCCCCCCC", // Cal, student Level 1 Sound
  hire: "BBBBBBBB", // hire tech
  dayPass: "AABBCCDD", // guest day pass, Level 2, today
  spare: "11223344", // Spare
  lost: "DEADBEEF", // Ben's lost fob
  unknown: "99999999",
} as const;

export function seedDb(): Database {
  const db = freshDb();
  const p = db.query("INSERT INTO people (person_id, name, type, year, level, specialism, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
  p.run("P001", "Ada Crew", "Student", 9, 2, "Lighting", "Active");
  p.run("P002", "Mrs Ritter", "Staff", null, null, null, "Active");
  p.run("P003", "Hire Person", "Hire tech", null, null, "Lighting + Sound", "Active");
  p.run("P004", "Ben Left", "Student", 11, 1, "Sound", "Left");
  p.run("P005", "Cal Newbie", "Student", 7, 1, "Sound", "Active");
  p.run("P006", "Daniel W", "Student", 12, 4, "Lighting + Sound", "Active");
  const b = db.query("INSERT INTO boxes (box_id, name, type, required_level, network, offline_unlock_min) VALUES (?, ?, ?, ?, ?, ?)");
  b.run("BOX-01", "Mic box", "Fixed (PoE)", 2, "Ethernet", 5);
  b.run("CASE-01", "LX case", "Flight case (Wi-Fi)", null, "Wi-Fi", 10);
  const k = db.query("INSERT INTO kit (kit_id, item, category, required_level, specialism, box_id, slot) VALUES (?, ?, ?, ?, ?, ?, ?)");
  k.run("K001", "Radio mic 1", "Radio mics", 2, "Sound", "BOX-01", "A1");
  k.run("K002", "Nomad key", "Keys", 3, "Any", "BOX-01", "Hook 1");
  k.run("K003", "Par can", "Lighting", null, "Lighting", "CASE-01", "");
  k.run("K004", "Gaffer tape", "Other", null, "Any", null, "");
  const f = db.query("INSERT INTO fobs (fob_uid, person_id, role, status, level, issued, ended) VALUES (?, ?, ?, ?, ?, ?, ?)");
  f.run(UID.ritterAdmin, "P002", "Admin", "Active", null, "2026-09-01", null);
  f.run(UID.danielAdmin, "P006", "Admin", "Active", null, "2026-09-01", null);
  f.run(UID.ada, "P001", "Standard", "Active", null, "2026-09-01", null);
  f.run(UID.cal, "P005", "Standard", "Active", null, "2026-11-01", null);
  f.run(UID.hire, "P003", "Standard", "Active", null, "2026-11-16", null);
  f.run(UID.dayPass, null, "Day pass", "Active", 2, "2026-11-16", null);
  f.run(UID.spare, null, "Standard", "Spare", null, null, null);
  f.run(UID.lost, "P004", "Standard", "Lost", null, "2025-09-02", "2025-10-10");
  return db;
}
