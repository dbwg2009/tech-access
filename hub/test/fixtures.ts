// Fixture workbooks built in code, so tests never depend on a binary file.
import * as XLSX from "xlsx";

export type Grid = (string | number | null)[][];

export interface WorkbookSpec {
  readme: Grid;
  People: Grid;
  Fobs: Grid;
  Kit: Grid;
  Boxes: Grid;
}

export function goodSpec(): WorkbookSpec {
  return {
    readme: [
      ["tech-access workbook"],
      ["Schema version", 1],
      ["Exported (auto)", ""],
      [],
      ["How to use", "Some help text that must survive a round trip."],
    ],
    People: [
      ["Person ID", "Name", "Type", "Year", "Level", "Specialism", "Status", "Notes"],
      ["P001", "Ada Crew", "Student", 9, 2, "Lighting", "Active", ""],
      ["P002", "Mrs Ritter", "Staff", null, null, null, "Active", "Head of drama"],
      ["P003", "Hire Person", "Hire tech", null, null, "Lighting + Sound", "Active", null],
      ["P004", "Ben Left", "Student", 11, 1, "Sound", "Left", null],
    ],
    Fobs: [
      ["Fob UID", "Person ID", "Role", "Level", "Status", "Issued", "Ended", "Notes", "Name (auto)"],
      ["04A1B2C3D4E5F6", "P002", "Admin", null, "Active", 46266, null, "", "ignored"], // serial = 2026-09-01
      ["04:a1:b2:c3:d4:e5:f7", "P001", "Standard", null, "Active", "01/09/2026", null, "", null],
      ["AABBCCDD", null, "Day pass", 2, "Active", "2026-11-15", null, "Guest LX", null],
      ["11 22 33 44", null, "Standard", null, "Spare", null, null, "", null],
      ["DEADBEEF", "P004", "Standard", null, "Lost", "02/09/2025", "10/10/2025", "", null],
    ],
    Kit: [
      ["Kit ID", "Item", "Category", "Required level", "Specialism", "Box ID", "Slot", "Tag UID", "Notes", "Out with (auto)", "Colour"],
      ["K001", "Radio mic 1", "Radio mics", 2, "Sound", "BOX-01", "A1", null, "", null, "Red"],
      ["K002", "Nomad key", "Keys", 3, "Any", "BOX-01", "Hook 1", "04-11-22-33-44-55-66", "", null, null],
      ["K003", "Par can", "Lighting", null, null, "CASE-01", "", null, "", null, null],
    ],
    Boxes: [
      ["Box ID", "Name", "Type", "Required level", "Network", "IP address", "Location", "Offline unlock (min)", "Notes", "Last seen (auto)"],
      ["BOX-01", "Mic box", "Fixed (PoE)", 2, "Ethernet", "10.102.40.101", "Control room", 5, "", null],
      ["CASE-01", "LX case", "Flight case (Wi-Fi)", null, "Wi-Fi", null, "Store", null, "", null],
    ],
  };
}

export function build(spec: WorkbookSpec, omit: (keyof WorkbookSpec)[] = []): Uint8Array {
  const wb = XLSX.utils.book_new();
  const names: Record<keyof WorkbookSpec, string> = { readme: "Read me", People: "People", Fobs: "Fobs", Kit: "Kit", Boxes: "Boxes" };
  for (const k of Object.keys(names) as (keyof WorkbookSpec)[]) {
    if (omit.includes(k)) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(spec[k]), names[k]);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

export const good = () => build(goodSpec());

/** Set a cell by header name on a data row (1-based data row index). */
export function setCell(grid: Grid, dataRow: number, header: string, value: string | number | null): void {
  const c = grid[0]!.indexOf(header);
  if (c < 0) throw new Error(`no header ${header}`);
  grid[dataRow]![c] = value;
}

export const ADMIN_UID = "04A1B2C3D4E5F6";
export const STUDENT_UID = "04A1B2C3D4E5F7";
