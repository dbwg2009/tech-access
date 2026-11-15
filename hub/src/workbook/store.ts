import type { Database } from "bun:sqlite";
import { SHEET_BY_KEY, type Extra, type RowsBySheet, type SheetKey } from "./schema";

type AnyRow = Record<string, unknown> & { extra: Extra };

function fields(key: SheetKey): string[] {
  return SHEET_BY_KEY[key].columns.map((c) => c.field);
}

/** Current (non-archived) workbook rows from the DB, ordered by ID. */
export function loadRows(db: Database): RowsBySheet {
  const out = { people: [], fobs: [], kit: [], boxes: [] } as unknown as Record<SheetKey, AnyRow[]>;
  for (const key of Object.keys(out) as SheetKey[]) {
    const def = SHEET_BY_KEY[key];
    const rows = db
      .query<Record<string, unknown>, []>(
        `SELECT ${fields(key).join(", ")}, extra FROM ${def.table} WHERE archived_at IS NULL ORDER BY ${def.idField}`,
      )
      .all();
    out[key] = rows.map((r) => ({ ...r, extra: JSON.parse(r.extra as string) as Extra }));
  }
  return out as unknown as RowsBySheet;
}

export function archivedIds(db: Database, key: SheetKey): Set<string> {
  const def = SHEET_BY_KEY[key];
  return new Set(
    db
      .query<{ id: string }, []>(`SELECT ${def.idField} AS id FROM ${def.table} WHERE archived_at IS NOT NULL`)
      .all()
      .map((r) => r.id),
  );
}

/** Insert or update one row and clear archived_at. */
export function upsertRow(db: Database, key: SheetKey, row: AnyRow, now: string): void {
  const def = SHEET_BY_KEY[key];
  const cols = [...fields(key), "extra"];
  const sets = cols.filter((c) => c !== def.idField).map((c) => `${c} = excluded.${c}`);
  db.query(
    `INSERT INTO ${def.table} (${cols.join(", ")}, updated_at, archived_at)
     VALUES (${cols.map(() => "?").join(", ")}, ?, NULL)
     ON CONFLICT (${def.idField}) DO UPDATE SET ${sets.join(", ")}, updated_at = excluded.updated_at, archived_at = NULL`,
  ).run(...(cols.map((c) => (c === "extra" ? JSON.stringify(row.extra ?? {}) : row[c])) as never[]), now);
}

/** Archive a row instead of deleting it. People become Left, fobs Revoked (Ended = today if blank). */
export function archiveRow(db: Database, key: SheetKey, id: string, now: string, today: string): void {
  const def = SHEET_BY_KEY[key];
  const extra =
    key === "people" ? ", status = 'Left'" : key === "fobs" ? ", status = 'Revoked', ended = COALESCE(ended, ?)" : "";
  const args: string[] = key === "fobs" ? [now, now, today, id] : [now, now, id];
  db.query(`UPDATE ${def.table} SET archived_at = ?, updated_at = ?${extra} WHERE ${def.idField} = ?`).run(...args);
}
