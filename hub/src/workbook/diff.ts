import type { Database } from "bun:sqlite";
import type { Issue, ParsedWorkbook } from "./parse";
import { SHEETS, type Extra, type RowsBySheet, type SheetKey } from "./schema";
import { archivedIds, loadRows } from "./store";

export interface FieldChange {
  column: string; // header text
  old: string | number | null;
  new: string | number | null;
}

export interface RowAdd {
  id: string;
  row: number | null; // Excel row
  values: Record<string, unknown>;
  /** The ID was removed by an earlier import and comes back. */
  restores: boolean;
  /** A row being removed in this same import has the same name/item: probably an ID change. */
  looksLikeIdChangeOf: string | null;
}

export interface RowChange {
  id: string;
  row: number | null;
  fields: FieldChange[];
}

export interface RowRemoval {
  id: string;
  label: string | null;
}

export interface SheetDiff {
  adds: RowAdd[];
  changes: RowChange[];
  removals: RowRemoval[];
}

export interface Diff {
  sheets: Record<SheetKey, SheetDiff>;
  counts: Record<SheetKey, { adds: number; changes: number; removals: number }>;
  errors: Issue[];
  warnings: Issue[];
  empty: boolean;
}

type Row = Record<string, unknown> & { extra: Extra };

const norm = (v: unknown): string | number | null => (v === undefined || v === "" ? null : (v as string | number | null));

function compare(def: (typeof SHEETS)[number], oldRow: Row, newRow: Row): FieldChange[] {
  const out: FieldChange[] = [];
  for (const c of def.columns) {
    const a = norm(oldRow[c.field]);
    const b = norm(newRow[c.field]);
    if (a !== b) out.push({ column: c.header, old: a, new: b });
  }
  const keys = new Set([...Object.keys(oldRow.extra), ...Object.keys(newRow.extra)]);
  for (const k of keys) {
    const a = norm(oldRow.extra[k]);
    const b = norm(newRow.extra[k]);
    if (a !== b) out.push({ column: k, old: a, new: b });
  }
  return out;
}

/** Compare a parsed workbook with the DB. Rows missing from the file are removals. Pure read. */
export function diff(parsed: ParsedWorkbook, db: Database): Diff {
  return diffRows(parsed, loadRows(db), (k) => archivedIds(db, k));
}

export function diffRows(
  parsed: ParsedWorkbook,
  current: RowsBySheet,
  archived: (k: SheetKey) => Set<string>,
): Diff {
  const sheets = {} as Record<SheetKey, SheetDiff>;
  const counts = {} as Diff["counts"];
  for (const def of SHEETS) {
    const id = (r: Row) => r[def.idField] as string;
    const oldRows = current[def.key] as unknown as Row[];
    const newRows = parsed.rows[def.key] as unknown as Row[];
    const oldById = new Map(oldRows.map((r) => [id(r), r]));
    const newIds = new Set(newRows.map(id));
    const gone = archived(def.key);
    const sd: SheetDiff = { adds: [], changes: [], removals: [] };
    for (const r of oldRows) {
      if (!newIds.has(id(r))) sd.removals.push({ id: id(r), label: norm(r[def.labelField]) as string | null });
    }
    for (const r of newRows) {
      const old = oldById.get(id(r));
      const rowNo = parsed.rowNumbers[def.key][id(r)] ?? null;
      if (!old) {
        const label = norm(r[def.labelField]);
        const twin =
          label === null
            ? undefined
            : sd.removals.find((x) => x.label !== null && String(x.label).toLowerCase() === String(label).toLowerCase());
        const values: Record<string, unknown> = {};
        for (const c of def.columns) values[c.header] = norm(r[c.field]);
        Object.assign(values, r.extra);
        sd.adds.push({ id: id(r), row: rowNo, values, restores: gone.has(id(r)), looksLikeIdChangeOf: twin?.id ?? null });
      } else {
        const fields = compare(def, old, r);
        if (fields.length) sd.changes.push({ id: id(r), row: rowNo, fields });
      }
    }
    sheets[def.key] = sd;
    counts[def.key] = { adds: sd.adds.length, changes: sd.changes.length, removals: sd.removals.length };
  }
  const warnings = [...parsed.warnings];
  for (const def of SHEETS) {
    for (const a of sheets[def.key].adds) {
      if (a.looksLikeIdChangeOf) {
        warnings.push({
          severity: "warning",
          sheet: def.name,
          row: a.row,
          column: def.columns[0]!.header,
          message: `${a.id} looks like ${a.looksLikeIdChangeOf} with a new ID. That removes ${a.looksLikeIdChangeOf} and adds ${a.id}`,
        });
      }
    }
  }
  const empty = Object.values(counts).every((c) => c.adds + c.changes + c.removals === 0);
  return { sheets, counts, errors: parsed.errors, warnings, empty };
}
