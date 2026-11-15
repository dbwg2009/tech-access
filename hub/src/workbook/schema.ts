// Workbook layout, schema version 1. Single source for parse, diff, apply and export.
// See docs/workbook-format.md.

export const WORKBOOK_SCHEMA_VERSION = 1;
export const README_SHEET = "Read me";

export const PERSON_TYPES = ["Student", "Staff", "Hire tech"] as const;
export const PERSON_SPECIALISMS = ["Lighting", "Sound", "Lighting + Sound"] as const;
export const PERSON_STATUSES = ["Active", "Disabled", "Left"] as const;
export const FOB_ROLES = ["Standard", "Admin", "Day pass"] as const;
export const FOB_STATUSES = ["Active", "Spare", "Lost", "Revoked"] as const;
export const KIT_CATEGORIES = ["Lighting", "Sound", "Radio mics", "Keys", "Show network", "Other"] as const;
export const KIT_SPECIALISMS = ["Any", "Lighting", "Sound"] as const;
export const BOX_TYPES = ["Fixed (PoE)", "Flight case (Wi-Fi)", "Key cabinet"] as const;
export const BOX_NETWORKS = ["Ethernet", "Wi-Fi"] as const;

export type PersonType = (typeof PERSON_TYPES)[number];
export type PersonSpecialism = (typeof PERSON_SPECIALISMS)[number];
export type PersonStatus = (typeof PERSON_STATUSES)[number];
export type FobRole = (typeof FOB_ROLES)[number];
export type FobStatus = (typeof FOB_STATUSES)[number];
export type KitCategory = (typeof KIT_CATEGORIES)[number];
export type KitSpecialism = (typeof KIT_SPECIALISMS)[number];
export type BoxType = (typeof BOX_TYPES)[number];
export type BoxNetwork = (typeof BOX_NETWORKS)[number];

/** Unknown workbook columns for one row: header text -> cell value as text. */
export type Extra = Record<string, string>;

export interface Person {
  person_id: string;
  name: string;
  type: PersonType;
  year: number | null;
  level: number | null;
  specialism: PersonSpecialism | null;
  status: PersonStatus;
  notes: string;
  extra: Extra;
}

export interface Fob {
  fob_uid: string;
  person_id: string | null;
  role: FobRole;
  status: FobStatus;
  level: number | null;
  issued: string | null;
  ended: string | null;
  notes: string;
  extra: Extra;
}

export interface Kit {
  kit_id: string;
  item: string;
  category: KitCategory;
  required_level: number | null;
  specialism: KitSpecialism | null;
  box_id: string | null;
  slot: string;
  tag_uid: string | null;
  notes: string;
  extra: Extra;
}

export interface Box {
  box_id: string;
  name: string;
  type: BoxType;
  required_level: number | null;
  network: BoxNetwork;
  ip_address: string | null;
  location: string;
  offline_unlock_min: number;
  notes: string;
  extra: Extra;
}

export type SheetKey = "people" | "fobs" | "kit" | "boxes";
export interface RowsBySheet {
  people: Person[];
  fobs: Fob[];
  kit: Kit[];
  boxes: Box[];
}

export type FieldType =
  | { kind: "text" } // blank -> "" unless nullable
  | { kind: "int"; min: number; max?: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "date" }
  | { kind: "uid" }
  | { kind: "ipv4" };

export interface ColumnDef {
  header: string;
  field: string; // DB column name
  type: FieldType;
  required?: boolean; // value must be present
  nullable?: boolean; // blank stored as NULL (else "" for text)
  default?: number; // blank -> this value (ints)
  optionalColumn?: boolean; // header may be missing from the sheet
}

export interface SheetDef {
  key: SheetKey;
  name: string; // sheet tab name
  table: SheetKey;
  idField: string;
  /** Field used to spot an ID change (removal + add with the same value). */
  labelField: string;
  columns: ColumnDef[];
  /** Export-only columns, in position order. `after` = header they follow. */
  autoColumns: { header: string; after: string }[];
}

const level = { kind: "int", min: 1, max: 4 } as const;

export const SHEETS: readonly SheetDef[] = [
  {
    key: "people",
    name: "People",
    table: "people",
    idField: "person_id",
    labelField: "name",
    columns: [
      { header: "Person ID", field: "person_id", type: { kind: "text" }, required: true },
      { header: "Name", field: "name", type: { kind: "text" }, required: true },
      { header: "Type", field: "type", type: { kind: "enum", values: PERSON_TYPES }, required: true },
      { header: "Year", field: "year", type: { kind: "int", min: 7, max: 13 }, nullable: true },
      { header: "Level", field: "level", type: level, nullable: true },
      { header: "Specialism", field: "specialism", type: { kind: "enum", values: PERSON_SPECIALISMS }, nullable: true },
      { header: "Status", field: "status", type: { kind: "enum", values: PERSON_STATUSES }, required: true },
      { header: "Notes", field: "notes", type: { kind: "text" } },
    ],
    autoColumns: [],
  },
  {
    key: "fobs",
    name: "Fobs",
    table: "fobs",
    idField: "fob_uid",
    labelField: "person_id",
    columns: [
      { header: "Fob UID", field: "fob_uid", type: { kind: "uid" }, required: true },
      { header: "Person ID", field: "person_id", type: { kind: "text" }, nullable: true },
      { header: "Role", field: "role", type: { kind: "enum", values: FOB_ROLES }, required: true },
      { header: "Level", field: "level", type: level, nullable: true, optionalColumn: true },
      { header: "Status", field: "status", type: { kind: "enum", values: FOB_STATUSES }, required: true },
      { header: "Issued", field: "issued", type: { kind: "date" }, nullable: true },
      { header: "Ended", field: "ended", type: { kind: "date" }, nullable: true },
      { header: "Notes", field: "notes", type: { kind: "text" } },
    ],
    autoColumns: [{ header: "Name (auto)", after: "Notes" }],
  },
  {
    key: "kit",
    name: "Kit",
    table: "kit",
    idField: "kit_id",
    labelField: "item",
    columns: [
      { header: "Kit ID", field: "kit_id", type: { kind: "text" }, required: true },
      { header: "Item", field: "item", type: { kind: "text" }, required: true },
      { header: "Category", field: "category", type: { kind: "enum", values: KIT_CATEGORIES }, required: true },
      { header: "Required level", field: "required_level", type: level, nullable: true },
      { header: "Specialism", field: "specialism", type: { kind: "enum", values: KIT_SPECIALISMS }, nullable: true },
      { header: "Box ID", field: "box_id", type: { kind: "text" }, nullable: true },
      { header: "Slot", field: "slot", type: { kind: "text" } },
      { header: "Tag UID", field: "tag_uid", type: { kind: "uid" }, nullable: true },
      { header: "Notes", field: "notes", type: { kind: "text" } },
    ],
    autoColumns: [{ header: "Out with (auto)", after: "Notes" }],
  },
  {
    key: "boxes",
    name: "Boxes",
    table: "boxes",
    idField: "box_id",
    labelField: "name",
    columns: [
      { header: "Box ID", field: "box_id", type: { kind: "text" }, required: true },
      { header: "Name", field: "name", type: { kind: "text" }, required: true },
      { header: "Type", field: "type", type: { kind: "enum", values: BOX_TYPES }, required: true },
      { header: "Required level", field: "required_level", type: level, nullable: true },
      { header: "Network", field: "network", type: { kind: "enum", values: BOX_NETWORKS }, required: true },
      { header: "IP address", field: "ip_address", type: { kind: "ipv4" }, nullable: true },
      { header: "Location", field: "location", type: { kind: "text" } },
      { header: "Offline unlock (min)", field: "offline_unlock_min", type: { kind: "int", min: 0 }, default: 5 },
      { header: "Notes", field: "notes", type: { kind: "text" } },
    ],
    autoColumns: [{ header: "Last seen (auto)", after: "Notes" }],
  },
];

export const SHEET_BY_KEY: Record<SheetKey, SheetDef> = Object.fromEntries(SHEETS.map((s) => [s.key, s])) as Record<
  SheetKey,
  SheetDef
>;

/** Header comparison key: trimmed, case-insensitive, inner whitespace collapsed. */
export function headerKey(h: string): string {
  return h.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isAutoHeader(h: string): boolean {
  return /\(auto\)\s*$/i.test(h.trim());
}

/** Default `Read me` sheet, used on export when no workbook has been imported yet. */
export const DEFAULT_README: (string | number)[][] = [
  ["tech-access workbook", ""],
  ["Schema version", WORKBOOK_SCHEMA_VERSION],
  ["Exported (auto)", ""],
  [],
  ["How to use", "Edit People, Fobs, Kit and Boxes. Download as .xlsx, copy to a USB stick labelled TECHUPDATE."],
  ["", "The hub shows a preview on the desk panel. Tap an admin fob to apply."],
  ["", "Columns ending in (auto) are filled by the hub and ignored on import."],
  ["", "A row you delete here is shown as 'to remove' and only removed when an admin confirms."],
];
