import type { Database } from "bun:sqlite";
import { isAdmin } from "../access";
import { diff, diffRows, type Diff } from "./diff";
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

function toPreview(b: BatchRow): Preview {
  const d = JSON.parse(b.preview) as Diff;
  return {
    batchId: b.id,
    status: b.status,
    fileName: b.file_name,
    fileHash: b.file_hash,
    uploadedAt: b.uploaded_at,
    canApply: b.status === "pending" && d.errors.length === 0,
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
  return toPreview(row);
}

export function getBatch(db: Database, id: number): Preview | null {
  const b = db.query<BatchRow, [number]>("SELECT * FROM import_batches WHERE id = ?").get(id);
  return b ? toPreview(b) : null;
}

export type ApplyResult =
  | { kind: "applied"; batchId: number; counts: Diff["counts"]; eventId: number; bootstrap: boolean }
  | { kind: "already_applied"; batchId: number; appliedAt: string }
  | { kind: "not_found" }
  | { kind: "superseded" }
  | { kind: "has_errors"; errorCount: number }
  | { kind: "stale" }
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
    return isAdmin(dbFob) ? { ok: true, fob: dbFob, bootstrap: false } : { ok: false, reason: "That fob isn't an active admin fob" };
  }
  const anyAdmin = db
    .query("SELECT 1 FROM fobs WHERE role = 'Admin' AND status = 'Active' AND archived_at IS NULL LIMIT 1")
    .get();
  if (anyAdmin) return { ok: false, reason: "Unknown fob" };
  const f = parsed.rows.fobs.find((x) => x.fob_uid === fobUid);
  if (!f || !isAdmin(f)) return { ok: false, reason: "No admin fob is set up yet; tap an Active Admin fob from this workbook" };
  const p: Person | undefined = f.person_id ? parsed.rows.people.find((x) => x.person_id === f.person_id) : undefined;
  if (f.person_id && p?.status !== "Active") return { ok: false, reason: "That admin fob's person isn't Active" };
  return { ok: true, fob: f, bootstrap: true };
}

/** Apply a pending batch in one transaction. Idempotent: a second apply of the same batch is a no-op. */
export function applyBatch(db: Database, batchId: number, rawFobUid: string, now = new Date(), timezone = "Europe/London"): ApplyResult {
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
    const fresh = diffRows(parsed, loadRows(db), (k) => archivedIds(db, k));
    if (JSON.stringify(fresh.sheets) !== JSON.stringify(preview.sheets)) return { kind: "stale" };

    const auth = authorise(db, parsed, uid.value);
    if (!auth.ok) return { kind: "forbidden", reason: auth.reason };

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
      for (const r of fresh.sheets[key].removals) archiveRow(db, key, r.id, ts, today);
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
        JSON.stringify({ batchId, fileHash: b.file_hash, fileName: b.file_name, counts: fresh.counts, bootstrap: auth.bootstrap }),
      )!;
    db.query("UPDATE import_batches SET status = 'applied', applied_by_fob_uid = ?, applied_at = ? WHERE id = ?").run(
      uid.value,
      ts,
      batchId,
    );
    return { kind: "applied", batchId, counts: fresh.counts, eventId: ev.id, bootstrap: auth.bootstrap };
  }).immediate();
}
