// Changes made on the panel to workbook rows (people, fobs), recorded per field until the next
// export, so an import can't silently undo them (decision 2026-11-16). Every write the admin menu
// makes to a workbook table goes through here.
import type { Database } from "bun:sqlite";
import { SHEET_BY_KEY, type SheetKey } from "./workbook/schema";

export interface PanelChange {
  id: number;
  ts: string;
  sheet: SheetKey;
  row_id: string;
  field: string; // DB column, or "*" = row created on the panel
  old_value: unknown;
  new_value: unknown;
  fob_uid: string;
  event_id: number | null;
}

interface Ctx {
  fobUid: string;
  eventId: number;
  ts: string;
}

const enc = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

function record(db: Database, sheet: SheetKey, rowId: string, field: string, oldV: unknown, newV: unknown, c: Ctx): void {
  db.query(
    "INSERT INTO panel_changes (ts, sheet, row_id, field, old_value, new_value, fob_uid, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(c.ts, sheet, rowId, field, enc(oldV), enc(newV), c.fobUid, c.eventId);
}

/** Insert a new workbook row and record it as created on the panel. */
export function insertRow(db: Database, sheet: SheetKey, row: Record<string, unknown>, c: Ctx): void {
  const def = SHEET_BY_KEY[sheet];
  const cols = def.columns.map((x) => x.field).filter((f) => row[f] !== undefined);
  db.query(`INSERT INTO ${def.table} (${cols.join(", ")}, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?)`).run(
    ...(cols.map((f) => row[f]) as never[]),
    c.ts,
  );
  record(db, sheet, row[def.idField] as string, "*", null, row, c);
}

/** Update fields of an existing row; records one change per field that actually changes. */
export function updateRow(db: Database, sheet: SheetKey, id: string, patch: Record<string, unknown>, c: Ctx): string[] {
  const def = SHEET_BY_KEY[sheet];
  const allowed = new Set(def.columns.map((x) => x.field));
  const old = db.query<Record<string, unknown>, [string]>(`SELECT * FROM ${def.table} WHERE ${def.idField} = ?`).get(id);
  if (!old) throw new Error(`${sheet} ${id} not found`);
  const changed = Object.keys(patch).filter((f) => {
    if (!allowed.has(f) || f === def.idField) throw new Error(`can't change ${sheet}.${f} from the panel`);
    return (old[f] ?? null) !== (patch[f] ?? null);
  });
  if (!changed.length) return [];
  db.query(`UPDATE ${def.table} SET ${changed.map((f) => `${f} = ?`).join(", ")}, updated_at = ?, archived_at = NULL WHERE ${def.idField} = ?`).run(
    ...(changed.map((f) => patch[f] ?? null) as never[]),
    c.ts,
    id,
  );
  for (const f of changed) record(db, sheet, id, f, old[f] ?? null, patch[f] ?? null, c);
  return changed;
}

/** Panel changes not yet exported and not overridden by an import. */
export function openChanges(db: Database): PanelChange[] {
  return db
    .query<PanelChange & { old_value: string | null; new_value: string | null }, []>(
      "SELECT * FROM panel_changes WHERE exported_at IS NULL AND resolved_at IS NULL ORDER BY id",
    )
    .all()
    .map((r) => ({ ...r, old_value: r.old_value === null ? null : JSON.parse(r.old_value), new_value: r.new_value === null ? null : JSON.parse(r.new_value) }));
}

export function markExported(db: Database, ts: string): number {
  return db.query("UPDATE panel_changes SET exported_at = ? WHERE exported_at IS NULL AND resolved_at IS NULL").run(ts).changes;
}

/** "Use sheet" chosen for a conflict: those panel changes no longer protect the row/field. */
export function markResolved(db: Database, sheet: SheetKey, rowId: string, field: string | null, ts: string): void {
  if (field === null) {
    db.query("UPDATE panel_changes SET resolved_at = ? WHERE sheet = ? AND row_id = ? AND exported_at IS NULL AND resolved_at IS NULL").run(ts, sheet, rowId);
  } else {
    db.query(
      "UPDATE panel_changes SET resolved_at = ? WHERE sheet = ? AND row_id = ? AND field IN (?, '*') AND exported_at IS NULL AND resolved_at IS NULL",
    ).run(ts, sheet, rowId, field);
  }
}
