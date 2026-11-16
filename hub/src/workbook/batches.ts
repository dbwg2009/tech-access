import type { Database } from "bun:sqlite";
import { adminCheck } from "../access";
import { firstName } from "../names";
import { markResolved, openChanges } from "../panelChanges";
import { diff, diffRows, type Diff, type Resolution } from "./diff";
import { localDate, normaliseUid } from "./normalise";
import { parseWorkbook, type ParsedWorkbook } from "./parse";
import { SHEETS, type Fob, type Person, type SheetKey } from "./schema";
import { archiveRow, archivedIds, loadRows, upsertRow } from "./store";

export interface Preview {
  batchId: number;
  status: "pending" | "applied" | "superseded";
  fileName: string | null;
  fileHash: string;
  uploadedAt: string;
  canApply: boolean;
  /** Conflicts with panel changes; each needs a choice before apply. */
  conflictCount: number;
  /** First names for Person IDs that appear in conflicts (display only). */
  names: Record<string, string>;
  diff: Diff;
}

interface BatchRow {
  id: number;
  file_hash: string;
  file_name: string | null;
  uploaded_at: string;
  parsed: string;
  preview: string;
  error_count: number;
  status: "pending" | "applied" | "superseded";
  applied_by_fob_uid: string | null;
  applied_at: string | null;
}

export function sha256(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

function toPreview(db: Database, b: BatchRow): Preview {
  const d = JSON.parse(b.preview) as Diff;
  const names: Record<string, string> = {};
  for (const c of d.conflicts ?? []) {
    const pid = c.sheet === "people" ? c.id : c.sheet === "fobs" ? c.label : null;
    if (!pid) continue;
    const n = db.query<{ name: string }, [string]>("SELECT name FROM people WHERE person_id = ?").get(pid)?.name;
    if (n) names[pid] = firstName(n);
  }
  return {
    batchId: b.id,
    status: b.status,
    fileName: b.file_name,
    fileHash: b.file_hash,
    uploadedAt: b.uploaded_at,
    canApply: b.status === "pending" && d.errors.length === 0,
    conflictCount: (d.conflicts ?? []).length,
    names,
    diff: d,
  };
}

/** Parse an uploaded workbook, store it as a pending batch, return the preview. Older pending batches are superseded. */
export function createBatch(db: Database, file: Uint8Array, fileName: string | null, now = new Date()): Preview {
  const parsed = parseWorkbook(file);
  const d = diff(parsed, db);
  const ts = now.toISOString();
  const row = db.transaction(() => {
    db.query("UPDATE import_batches SET status = 'superseded' WHERE status = 'pending'").run();
    return db
      .query<BatchRow, [string, string | null, string, string, string, number]>(
        `INSERT INTO import_batches (file_hash, file_name, uploaded_at, parsed, preview, error_count)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(sha256(file), fileName, ts, JSON.stringify(parsed), JSON.stringify(d), d.errors.length)!;
  })();
  return toPreview(db, row);
}

export function getBatch(db: Database, id: number): Preview | null {
  const b = db.query<BatchRow, [number]>("SELECT * FROM import_batches WHERE id = ?").get(id);
  return b ? toPreview(db, b) : null;
}

export type ApplyResult =
  | { kind: "applied"; batchId: number; counts: Diff["counts"]; eventId: number; bootstrap: boolean }
  | { kind: "already_applied"; batchId: number; appliedAt: string }
  | { kind: "not_found" }
  | { kind: "superseded" }
  | { kind: "has_errors"; errorCount: number }
  | { kind: "stale" }
  | { kind: "unresolved"; keys: string[] }
  | { kind: "forbidden"; reason: string };

/**
 * Find the fob that may authorise an import. Normally an Active Admin fob already in the DB.
 * Bootstrap: when the DB has no Active Admin fob at all (first import), an Active Admin fob
 * listed in the workbook being applied is accepted, provided its person (if any) is Active.
 */
function authorise(
  db: Database,
  parsed: ParsedWorkbook,
  fobUid: string,
): { ok: true; fob: Fob; bootstrap: boolean } | { ok: false; reason: string } {
  const dbFob = db
    .query<Fob & { extra: string }, [string]>("SELECT * FROM fobs WHERE fob_uid = ? AND archived_at IS NULL")
    .get(fobUid);
  if (dbFob) {
    const person = dbFob.person_id
      ? db.query<Person, [string]>("SELECT * FROM people WHERE person_id = ? AND archived_at IS NULL").get(dbFob.person_id)
      : null;
    const d = adminCheck(dbFob, person);
    return d.allow ? { ok: true, fob: dbFob, bootstrap: false } : { ok: false, reason: d.reason };
  }
  const anyAdmin = db
    .query("SELECT 1 FROM fobs WHERE role = 'Admin' AND status = 'Active' AND archived_at IS NULL LIMIT 1")
    .get();
  if (anyAdmin) return { ok: false, reason: "Unknown fob" };
  const f = parsed.rows.fobs.find((x) => x.fob_uid === fobUid);
  if (!f) return { ok: false, reason: "No admin fob is set up yet; tap an Active Admin fob from this workbook" };
  const p = f.person_id ? (parsed.rows.people.find((x) => x.person_id === f.person_id) ?? null) : null;
  const d = adminCheck(f, p);
  return d.allow ? { ok: true, fob: f, bootstrap: true } : { ok: false, reason: d.reason };
}

/** Apply a pending batch in one transaction. Idempotent: a second apply of the same batch is a no-op. */
export function applyBatch(
  db: Database,
  batchId: number,
  rawFobUid: string,
  now = new Date(),
  timezone = "Europe/London",
  resolutions: Record<string, Resolution> = {},
): ApplyResult {
  const uid = normaliseUid(rawFobUid);
  if (!uid.ok) return { kind: "forbidden", reason: `Bad fob UID: ${uid.error}` };
  const ts = now.toISOString();
  const today = localDate(now, timezone);

  return db.transaction((): ApplyResult => {
    const b = db.query<BatchRow, [number]>("SELECT * FROM import_batches WHERE id = ?").get(batchId);
    if (!b) return { kind: "not_found" };
    if (b.status === "applied") return { kind: "already_applied", batchId, appliedAt: b.applied_at! };
    if (b.status === "superseded") return { kind: "superseded" };
    if (b.error_count > 0) return { kind: "has_errors", errorCount: b.error_count };

    const parsed = JSON.parse(b.parsed) as ParsedWorkbook;
    const preview = JSON.parse(b.preview) as Diff;
    const current = loadRows(db);
    const fresh = diffRows(parsed, current, (k) => archivedIds(db, k), openChanges(db));
    if (
      JSON.stringify(fresh.sheets) !== JSON.stringify(preview.sheets) ||
      JSON.stringify(fresh.conflicts) !== JSON.stringify(preview.conflicts ?? [])
    ) {
      return { kind: "stale" };
    }

    const auth = authorise(db, parsed, uid.value);
    if (!auth.ok) return { kind: "forbidden", reason: auth.reason };

    // Panel changes since the last export: every conflict needs an explicit choice.
    const unresolved = fresh.conflicts.filter((c) => resolutions[c.key] !== "panel" && resolutions[c.key] !== "sheet").map((c) => c.key);
    if (unresolved.length) return { kind: "unresolved", keys: unresolved };
    const keepRemovals = new Set<string>();
    for (const c of fresh.conflicts) {
      const def = SHEETS.find((d) => d.key === c.sheet)!;
      if (resolutions[c.key] === "sheet") {
        markResolved(db, c.sheet, c.id, c.kind === "removal" ? null : def.columns.find((x) => x.header === c.column)!.field, ts);
        continue;
      }
      // "panel": keep the hub's value.
      if (c.kind === "removal") {
        keepRemovals.add(`${c.sheet}/${c.id}`);
        continue;
      }
      const field = def.columns.find((x) => x.header === c.column)!.field;
      const row = (parsed.rows[c.sheet] as unknown as Record<string, unknown>[]).find((r) => r[def.idField] === c.id);
      const cur = (current[c.sheet] as unknown as Record<string, unknown>[]).find((r) => r[def.idField] === c.id);
      if (row && cur) row[field] = cur[field];
    }

    // Parents before children, then archive children before parents.
    const order: SheetKey[] = ["boxes", "people", "kit", "fobs"];
    for (const key of order) {
      const changed = new Set([...fresh.sheets[key].adds.map((a) => a.id), ...fresh.sheets[key].changes.map((c) => c.id)]);
      const def = SHEETS.find((s) => s.key === key)!;
      for (const row of parsed.rows[key] as unknown as Record<string, unknown>[]) {
        if (changed.has(row[def.idField] as string)) upsertRow(db, key, row as never, ts);
      }
    }
    for (const key of [...order].reverse()) {
      for (const r of fresh.sheets[key].removals) if (!keepRemovals.has(`${key}/${r.id}`)) archiveRow(db, key, r.id, ts, today);
    }

    const setting = db.query(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    setting.run("workbook_readme", JSON.stringify(parsed.readme), ts);
    setting.run("workbook_extra_columns", JSON.stringify(parsed.extraColumns), ts);

    const ev = db
      .query<{ id: number }, [string, string | null, string, string]>(
        "INSERT INTO events (ts, type, person_id, fob_uid, detail) VALUES (?, 'import_applied', ?, ?, ?) RETURNING id",
      )
      .get(
        ts,
        auth.fob.person_id,
        uid.value,
        JSON.stringify({ batchId, fileHash: b.file_hash, fileName: b.file_name, counts: fresh.counts, bootstrap: auth.bootstrap, resolutions }),
      )!;
    db.query("UPDATE import_batches SET status = 'applied', applied_by_fob_uid = ?, applied_at = ? WHERE id = ?").run(
      uid.value,
      ts,
      batchId,
    );
    return { kind: "applied", batchId, counts: fresh.counts, eventId: ev.id, bootstrap: auth.bootstrap };
  }).immediate();
}
