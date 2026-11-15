import * as XLSX from "xlsx";
import {
  README_SHEET,
  SHEETS,
  WORKBOOK_SCHEMA_VERSION,
  headerKey,
  isAutoHeader,
  type ColumnDef,
  type Extra,
  type RowsBySheet,
  type SheetDef,
  type SheetKey,
} from "./schema";
import {
  cellText,
  isBlank,
  normaliseDate,
  normaliseEnum,
  normaliseInt,
  normaliseIpv4,
  normaliseUid,
  type Result,
} from "./normalise";

export interface Issue {
  severity: "error" | "warning";
  sheet: string;
  row: number | null; // Excel row number (header is row 1)
  column: string | null; // header text
  message: string;
}

export interface ParsedWorkbook {
  schemaVersion: number | null;
  rows: RowsBySheet;
  /** Unknown column headers per sheet, in file order. Kept for export. */
  extraColumns: Record<SheetKey, string[]>;
  /** The `Read me` sheet as an array of rows, written back unchanged on export. */
  readme: (string | number)[][];
  /** Excel row number of each row, by sheet then ID, for later messages. */
  rowNumbers: Record<SheetKey, Record<string, number>>;
  errors: Issue[];
  warnings: Issue[];
}

type Cell = string | number | boolean | Date | null;

function readSheetAoa(ws: XLSX.WorkSheet): Cell[][] {
  return XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

function normaliseCell(col: ColumnDef, v: Cell): Result<string | number | null> {
  if (isBlank(v)) {
    if (col.required) return { ok: false, error: "is required" };
    if (col.default !== undefined) return { ok: true, value: col.default };
    return { ok: true, value: col.nullable ? null : "" };
  }
  switch (col.type.kind) {
    case "text":
      return { ok: true, value: cellText(v) };
    case "int":
      return normaliseInt(v, col.type.min, col.type.max);
    case "enum":
      return normaliseEnum(v, col.type.values);
    case "date":
      return normaliseDate(v);
    case "uid":
      return normaliseUid(v);
    case "ipv4":
      return normaliseIpv4(v);
  }
}

function parseSheet(
  def: SheetDef,
  ws: XLSX.WorkSheet | undefined,
  out: ParsedWorkbook,
): void {
  const errors = out.errors;
  const err = (row: number | null, column: string | null, message: string) =>
    errors.push({ severity: "error", sheet: def.name, row, column, message });
  if (!ws) {
    err(null, null, `Sheet "${def.name}" is missing`);
    return;
  }
  const aoa = readSheetAoa(ws);
  const header = (aoa[0] ?? []).map((h) => cellText(h));
  const colIndex = new Map<string, number>(); // headerKey -> index
  const extras: { header: string; index: number }[] = [];
  const known = new Set(def.columns.map((c) => headerKey(c.header)));
  header.forEach((h, i) => {
    if (h === "") return;
    const k = headerKey(h);
    if (colIndex.has(k) || extras.some((e) => headerKey(e.header) === k)) {
      err(1, h, `Column "${h}" appears more than once`);
      return;
    }
    if (known.has(k)) colIndex.set(k, i);
    else if (!isAutoHeader(h)) extras.push({ header: h, index: i });
  });
  const missing = def.columns.filter((c) => !c.optionalColumn && !colIndex.has(headerKey(c.header)));
  for (const c of missing) err(1, c.header, `Required column "${c.header}" is missing`);
  if (missing.length) return;
  for (const e of extras) {
    out.warnings.push({
      severity: "warning",
      sheet: def.name,
      row: 1,
      column: e.header,
      message: `Unknown column "${e.header}" is kept but not used`,
    });
  }
  out.extraColumns[def.key] = extras.map((e) => e.header);

  const seen = new Map<string, number>();
  const rows: Record<string, unknown>[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const line = aoa[r] ?? [];
    if (line.every(isBlank)) break; // data ends at the first fully blank row
    const excelRow = r + 1;
    const row: Record<string, unknown> = {};
    let rowOk = true;
    for (const col of def.columns) {
      const idx = colIndex.get(headerKey(col.header));
      const v = idx === undefined ? null : (line[idx] ?? null);
      const res = normaliseCell(col, v);
      if (res.ok) row[col.field] = res.value;
      else {
        rowOk = false;
        err(excelRow, col.header, `${col.header} ${res.error}`);
      }
    }
    const extra: Extra = {};
    for (const e of extras) {
      const v = line[e.index];
      if (!isBlank(v)) extra[e.header] = cellText(v);
    }
    row.extra = extra;
    const id = row[def.idField];
    if (typeof id === "string" && id !== "") {
      const prev = seen.get(id);
      if (prev !== undefined) {
        rowOk = false;
        err(excelRow, def.columns[0]!.header, `${def.columns[0]!.header} ${id} is already used on row ${prev}`);
      } else {
        seen.set(id, excelRow);
      }
    }
    // Record every ID seen (even on rows with errors) so references to it aren't reported twice.
    if (typeof id === "string" && id !== "" && !(id in out.rowNumbers[def.key])) out.rowNumbers[def.key][id] = excelRow;
    if (rowOk) rows.push(row);
  }
  (out.rows[def.key] as unknown[]) = rows;
}

function crossChecks(p: ParsedWorkbook): void {
  const { people, fobs, kit, boxes } = p.rows;
  const rn = p.rowNumbers;
  const err = (sheet: string, row: number | null, column: string, message: string) =>
    p.errors.push({ severity: "error", sheet, row, column, message });
  const warn = (sheet: string, row: number | null, column: string, message: string) =>
    p.warnings.push({ severity: "warning", sheet, row, column, message });

  const peopleIds = new Set(Object.keys(rn.people));
  const boxIds = new Set(Object.keys(rn.boxes));
  const boxById = new Map(boxes.map((b) => [b.box_id, b]));
  // If a sheet couldn't be read at all, don't also report every reference into it.
  const sheetOk = (name: string) => !p.errors.some((e) => e.sheet === name && (e.row === null || e.row === 1));
  const peopleSheetOk = sheetOk("People");
  const boxesSheetOk = sheetOk("Boxes");

  for (const x of people) {
    const row = rn.people[x.person_id] ?? null;
    if (x.type === "Student" && x.level === null) warn("People", row, "Level", `${x.name} is a student with no Level, so they can't open anything`);
    if (x.type !== "Student" && x.level !== null) warn("People", row, "Level", `Level is ignored for ${x.type} (treated as Level 4)`);
  }

  for (const f of fobs) {
    const row = rn.fobs[f.fob_uid] ?? null;
    if (f.person_id === null) {
      if (f.status !== "Spare" && f.role !== "Day pass") {
        err("Fobs", row, "Person ID", `Person ID is required unless the fob is Spare or a Day pass`);
      }
    } else if (peopleSheetOk && !peopleIds.has(f.person_id)) {
      err("Fobs", row, "Person ID", `Person ID ${f.person_id} is not on the People sheet`);
    }
    if (f.level !== null && f.role !== "Day pass") warn("Fobs", row, "Level", `Level is only used for Day pass fobs and is ignored here`);
    if ((f.status === "Lost" || f.status === "Revoked") && f.ended === null) {
      warn("Fobs", row, "Ended", `${f.status} fob has no Ended date`);
    }
  }

  const tags = new Map<string, string>();
  for (const k of kit) {
    const row = rn.kit[k.kit_id] ?? null;
    if (k.box_id !== null) {
      const box = boxById.get(k.box_id);
      if (!box) {
        if (boxesSheetOk && !boxIds.has(k.box_id)) err("Kit", row, "Box ID", `Box ID ${k.box_id} is not on the Boxes sheet`);
      } else if (box.required_level !== null && k.required_level !== null && k.required_level < box.required_level) {
        warn(
          "Kit",
          row,
          "Required level",
          `${k.item} needs Level ${k.required_level} but its box ${box.box_id} needs Level ${box.required_level}`,
        );
      }
    }
    if (k.tag_uid !== null) {
      const other = tags.get(k.tag_uid);
      if (other) err("Kit", row, "Tag UID", `Tag UID ${k.tag_uid} is already used by ${other}`);
      else tags.set(k.tag_uid, k.kit_id);
    }
  }
}

function readReadme(ws: XLSX.WorkSheet): (string | number)[][] {
  return readSheetAoa(ws).map((r) => {
    const row = r.map((c) => (c === null ? "" : typeof c === "number" ? c : cellText(c)));
    while (row.length && row[row.length - 1] === "") row.pop();
    return row;
  });
}

/** Parse an .xlsx buffer into typed rows plus errors and warnings. Never throws on bad content. */
export function parseWorkbook(buffer: ArrayBuffer | Uint8Array): ParsedWorkbook {
  const out: ParsedWorkbook = {
    schemaVersion: null,
    rows: { people: [], fobs: [], kit: [], boxes: [] },
    extraColumns: { people: [], fobs: [], kit: [], boxes: [] },
    readme: [],
    rowNumbers: { people: {}, fobs: {}, kit: {}, boxes: {} },
    errors: [],
    warnings: [],
  };
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false, cellFormula: false, cellHTML: false });
  } catch (e) {
    out.errors.push({ severity: "error", sheet: "", row: null, column: null, message: `Not a readable .xlsx file: ${(e as Error).message}` });
    return out;
  }
  const findSheet = (name: string) => {
    const hit = wb.SheetNames.find((n) => headerKey(n) === headerKey(name));
    return hit === undefined ? undefined : wb.Sheets[hit];
  };

  const readme = findSheet(README_SHEET);
  if (!readme) {
    out.errors.push({ severity: "error", sheet: README_SHEET, row: null, column: null, message: `Sheet "${README_SHEET}" is missing` });
  } else {
    out.readme = readReadme(readme);
    const b2 = readme["B2"]?.v;
    const v = typeof b2 === "number" ? b2 : Number(cellText(b2));
    out.schemaVersion = Number.isFinite(v) && cellText(b2) !== "" ? v : null;
    if (out.schemaVersion !== WORKBOOK_SCHEMA_VERSION) {
      out.errors.push({
        severity: "error",
        sheet: README_SHEET,
        row: 2,
        column: "B",
        message: `Schema version in Read me!B2 is "${cellText(b2)}"; this hub only reads version ${WORKBOOK_SCHEMA_VERSION}`,
      });
      return out; // don't guess at an unknown layout
    }
  }

  for (const def of SHEETS) parseSheet(def, findSheet(def.name), out);
  crossChecks(out);
  // Panel order: sheet tab order, then row.
  const order = [README_SHEET, ...SHEETS.map((d) => d.name)];
  const byPlace = (a: Issue, b: Issue) =>
    order.indexOf(a.sheet) - order.indexOf(b.sheet) || (a.row ?? 0) - (b.row ?? 0);
  out.errors.sort(byPlace);
  out.warnings.sort(byPlace);
  return out;
}
