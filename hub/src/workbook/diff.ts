import type { Database } from "bun:sqlite";
import { openChanges, type PanelChange } from "../panelChanges";
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

/**
 * An import that would overwrite or remove a change made on the panel since the last export
 * (decision 2026-11-16). The admin must choose "panel" (keep the hub's value, the default on
 * screen) or "sheet" (use the workbook) for each one before apply.
 */
export interface Conflict {
  /** `${sheet}/${id}/${column header}` for a field, `${sheet}/${id}/*` for a removal. */
  key: string;
  sheet: SheetKey;
  sheetName: string;
  id: string;
  label: string | null;
  kind: "change" | "removal";
  column: string | null;
  /** Value on the hub now (set on the panel). For a removal, null. */
  panel: string | number | null;
  /** Value in the workbook. For a removal, null (the row is missing). */
  sheetValue: string | number | null;
  changedAt: string;
  byFob: string;
}

export type Resolution = "panel" | "sheet";

export interface Diff {
  sheets: Record<SheetKey, SheetDiff>;
  conflicts: Conflict[];
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
  return diffRows(parsed, loadRows(db), (k) => archivedIds(db, k), openChanges(db));
}

export function diffRows(
  parsed: ParsedWorkbook,
  current: RowsBySheet,
  archived: (k: SheetKey) => Set<string>,
  panelChanges: PanelChange[] = [],
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
  return { sheets, conflicts: findConflicts(sheets, panelChanges, current), counts, errors: parsed.errors, warnings, empty };
}

function findConflicts(sheets: Record<SheetKey, SheetDiff>, changes: PanelChange[], current: RowsBySheet): Conflict[] {
  if (!changes.length) return [];
  const out: Conflict[] = [];
  for (const def of SHEETS) {
    const mine = changes.filter((c) => c.sheet === def.key);
    if (!mine.length) continue;
    const label = (id: string) => {
      const row = (current[def.key] as unknown as Record<string, unknown>[]).find((r) => r[def.idField] === id);
      return row ? (norm(row[def.labelField]) as string | null) : null;
    };
    const latest = (hits: PanelChange[]) => hits[hits.length - 1]!;
    for (const ch of sheets[def.key].changes) {
      for (const f of ch.fields) {
        const col = def.columns.find((c) => c.header === f.column);
        if (!col) continue; // extra columns are never changed on the panel
        const hits = mine.filter((c) => c.row_id === ch.id && (c.field === col.field || c.field === "*"));
        if (!hits.length) continue;
        out.push({
          key: `${def.key}/${ch.id}/${f.column}`,
          sheet: def.key,
          sheetName: def.name,
          id: ch.id,
          label: label(ch.id),
          kind: "change",
          column: f.column,
          panel: f.old,
          sheetValue: f.new,
          changedAt: latest(hits).ts,
          byFob: latest(hits).fob_uid,
        });
      }
    }
    for (const r of sheets[def.key].removals) {
      const hits = mine.filter((c) => c.row_id === r.id);
      if (!hits.length) continue;
      out.push({
        key: `${def.key}/${r.id}/*`,
        sheet: def.key,
        sheetName: def.name,
        id: r.id,
        label: r.label,
        kind: "removal",
        column: null,
        panel: null,
        sheetValue: null,
        changedAt: latest(hits).ts,
        byFob: latest(hits).fob_uid,
      });
    }
  }
  return out;
}
