// Make a demo database for trying the panel without the workbook or any hardware:
//   bun run scripts/demo-db.ts data/demo.db
// then run the hub with fake_reader = true and the fake_fobs printed at the end. Refuses to
// touch an existing file, so it can't overwrite a real database.
import { existsSync } from "node:fs";
import { openDb } from "../src/db";
import { migrate } from "../src/migrate";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run scripts/demo-db.ts <new-file.db>");
  process.exit(2);
}
if (existsSync(path)) {
  console.error(`${path} already exists; choose a new file name`);
  process.exit(1);
}
const db = openDb(path);
migrate(db);

const people: [string, string, string, number | null, number | null, string | null][] = [
  ["P001", "Ada Lovelace", "Student", 9, 2, "Lighting"],
  ["P002", "Mrs Ritter", "Staff", null, null, null],
  ["P003", "Sam Hire", "Hire tech", null, null, "Lighting + Sound"],
  ["P004", "Cal Newbie", "Student", 7, 1, "Sound"],
  ["P005", "Daniel W", "Student", 12, 4, "Lighting + Sound"],
  ["P006", "Priya Shah", "Student", 8, 3, "Sound"],
];
const p = db.query("INSERT INTO people (person_id, name, type, year, level, specialism, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')");
for (const r of people) p.run(...r);

const b = db.query("INSERT INTO boxes (box_id, name, type, required_level, network, ip_address, location) VALUES (?, ?, ?, ?, ?, ?, ?)");
b.run("BOX-01", "Mic box", "Fixed (PoE)", 2, "Ethernet", "10.102.40.101", "Control room");
b.run("BOX-02", "Cable box", "Fixed (PoE)", 1, "Ethernet", "10.102.40.103", "Control room");
b.run("KEYS-01", "Key cabinet", "Key cabinet", 3, "Ethernet", "10.102.40.102", "Control room");
b.run("CASE-01", "LX case", "Flight case (Wi-Fi)", null, "Wi-Fi", null, "Store");

const k = db.query("INSERT INTO kit (kit_id, item, category, required_level, specialism, box_id, slot) VALUES (?, ?, ?, ?, ?, ?, ?)");
k.run("K001", "Radio mic 1", "Radio mics", 2, "Sound", "BOX-01", "A1");
k.run("K002", "Radio mic 2", "Radio mics", 2, "Sound", "BOX-01", "A2");
k.run("K003", "Nomad key", "Keys", 3, "Any", "KEYS-01", "Hook 1");
k.run("K004", "Haze remote", "Lighting", 3, "Lighting", "KEYS-01", "Hook 2");
k.run("K005", "Par can 1", "Lighting", null, "Lighting", "CASE-01", "");
k.run("K006", "Par can 2", "Lighting", null, "Lighting", "CASE-01", "");
k.run("K007", "Gaffer tape", "Other", null, "Any", null, "");
k.run("K008", "Torch", "Other", null, "Any", null, "");

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const f = db.query("INSERT INTO fobs (fob_uid, person_id, role, status, level, issued) VALUES (?, ?, ?, ?, ?, ?)");
const fobs: [string, string | null, string, string, number | null, string | null][] = [
  ["04A1B2C3D4E501", "P001", "Standard", "Active", null, "2026-09-01"],
  ["04A1B2C3D4E502", "P002", "Admin", "Active", null, "2026-09-01"],
  ["04A1B2C3D4E503", "P003", "Standard", "Active", null, today],
  ["04A1B2C3D4E504", "P004", "Standard", "Active", null, "2026-11-01"],
  ["04A1B2C3D4E505", "P005", "Admin", "Active", null, "2026-09-01"],
  ["04A1B2C3D4E506", "P006", "Standard", "Active", null, "2026-09-01"],
  ["04A1B2C3D4E5A1", null, "Standard", "Spare", null, null],
  ["04A1B2C3D4E5A2", null, "Standard", "Spare", null, null],
];
for (const r of fobs) f.run(...r);
db.close();
console.log(`demo database written to ${path}`);
console.log(`fake_fobs = [${fobs.map((x) => `"${x[0]}"`).join(", ")}]`);
console.log("Ada 01 (L2 Lighting), Mrs Ritter 02 (Admin), Sam 03 (hire tech), Cal 04 (L1 Sound), Daniel 05 (Admin), Priya 06 (L3 Sound), spares A1 A2");
