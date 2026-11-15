import type { Database } from "bun:sqlite";
import * as XLSX from "xlsx";
import { dateToSerial } from "./normalise";
import { DEFAULT_README, README_SHEET, SHEETS, WORKBOOK_SCHEMA_VERSION, type SheetKey } from "./schema";
import { loadRows } from "./store";

type CellOut = XLSX.CellObject | null;

// Register the date format at 164, the first ID reserved for custom formats. Left alone, SheetJS
// picks an ID in 50-81, which East Asian Excel reads as its own built-in formats.
const DATE_FORMAT = "dd/mm/yyyy";
XLSX.SSF.load(DATE_FORMAT, 164);

function setting<T>(db: Database, key: string, fallback: T): T {
  const r = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return fallback;
  }
}

/** Who has each kit item out right now, from the latest kit_out / kit_in event. */
function outWith(db: Database): Map<string, string> {
  const rows = db
    .query<{ kit_id: string; type: string; person_id: string | null; name: string | null }, []>(
      `SELECT e.kit_id, e.type, e.person_id, p.name
         FROM events e
         JOIN (SELECT kit_id, MAX(id) AS id FROM events WHERE type IN ('kit_out', 'kit_in') AND kit_id IS NOT NULL GROUP BY kit_id) last
           ON last.id = e.id
         LEFT JOIN people p ON p.person_id = e.person_id`,
    )
    .all();
  const m = new Map<string, string>();
  for (const r of rows) if (r.type === "kit_out") m.set(r.kit_id, r.name ?? r.person_id ?? "Unknown");
  return m;
}

function cell(v: unknown, kind: string): CellOut {
  if (v === null || v === undefined || v === "") return null;
  if (kind === "date" && typeof v === "string") return { t: "n", v: dateToSerial(v), z: DATE_FORMAT };
  if (typeof v === "number") return { t: "n", v };
  // Text cells for everything else, so UIDs like 04123456 keep their leading zero.
  return { t: "s", v: String(v) };
}

function sheetFromCells(rows: CellOut[][]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxC = 0;
  rows.forEach((r, ri) => {
    r.forEach((c, ci) => {
      if (c) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = c;
      maxC = Math.max(maxC, ci);
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: maxC } });
  return ws;
}

/** Export the current DB in exactly the workbook layout. */
export function exportWorkbook(db: Database, now = new Date()): Uint8Array {
  const data = loadRows(db);
  const extraCols = setting<Partial<Record<SheetKey, string[]>>>(db, "workbook_extra_columns", {});
  const readme = setting<(string | number)[][]>(db, "workbook_readme", DEFAULT_README).map((r) => [...r]);
  while (readme.length < 3) readme.push([]);
  readme[1]![1] = WORKBOOK_SCHEMA_VERSION;
  readme[2]![1] = now.toISOString();
  if (!readme[1]![0]) readme[1]![0] = "Schema version";
  if (!readme[2]![0]) readme[2]![0] = "Exported (auto)";

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromCells(readme.map((r) => r.map((v, i) => (i === 1 && typeof v === "number" ? { t: "n", v } : cell(v, "text"))))),
    README_SHEET,
  );

  const names = new Map(data.people.map((p) => [p.person_id, p.name]));
  const out = outWith(db);
  const lastSeen = new Map(
    db
      .query<{ box_id: string; last_seen: string | null }, []>("SELECT box_id, last_seen FROM boxes WHERE archived_at IS NULL")
      .all()
      .map((r) => [r.box_id, r.last_seen]),
  );

  for (const def of SHEETS) {
    const rows = data[def.key] as unknown as (Record<string, unknown> & { extra: Record<string, string> })[];
    // Extra columns: last imported order, then any others found on rows.
    const extras = [...(extraCols[def.key] ?? [])];
    for (const r of rows) for (const k of Object.keys(r.extra)) if (!extras.includes(k)) extras.push(k);

    type Col = { header: string; get: (r: (typeof rows)[number]) => CellOut };
    const cols: Col[] = [];
    for (const c of def.columns) {
      cols.push({ header: c.header, get: (r) => cell(r[c.field], c.type.kind) });
      for (const a of def.autoColumns.filter((x) => x.after === c.header)) {
        const get: Col["get"] =
          a.header === "Name (auto)"
            ? (r) => cell(r.person_id ? names.get(r.person_id as string) : null, "text")
            : a.header === "Out with (auto)"
              ? (r) => cell(out.get(r.kit_id as string), "text")
              : (r) => cell(lastSeen.get(r.box_id as string), "text");
        cols.push({ header: a.header, get });
      }
    }
    for (const e of extras) cols.push({ header: e, get: (r) => cell(r.extra[e], "text") });

    const sorted = [...rows].sort((a, b) =>
      String(a[def.idField]).localeCompare(String(b[def.idField]), "en", { numeric: true }),
    );
    const grid: CellOut[][] = [cols.map((c) => ({ t: "s", v: c.header }) as CellOut), ...sorted.map((r) => cols.map((c) => c.get(r)))];
    const ws = sheetFromCells(grid);
    ws["!cols"] = cols.map((c) => ({ wch: Math.max(10, c.header.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }

  db.query("INSERT INTO events (ts, type, detail) VALUES (?, 'export', ?)").run(
    now.toISOString(),
    JSON.stringify({ counts: Object.fromEntries(SHEETS.map((d) => [d.key, data[d.key].length])) }),
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Uint8Array;
}
