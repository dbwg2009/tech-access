// Box firmware: store images, serve them to boxes, and ask boxes to update (OTA).
// Decisions 2026-11-16 (weeks 5-6): an admin chooses when boxes update (tap to confirm); a box
// refuses while unlocked, in show mode or mid-tap and says why in its state.
//
// requestUpdate() is the one entry point for "update boxes". The admin API calls it today; the
// TECHSOFTWARE stick (week 7) will call addImage() + requestUpdate() with via: "usb".
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allBoxes, getBox, logEvent } from "./data";
import type { BoxLink } from "./mqtt/boxes";

/** One OTA app slot in firmware/partitions.csv (0x1C0000). An image must fit in it. */
export const MAX_IMAGE_BYTES = 0x1c0000;
/** A box ignores an update request older than this (its clock vs `expires`). */
export const OTA_TTL_MS = 5 * 60_000;
/** ESP32 app images start with this byte (esp_image_header_t.magic). */
const ESP_IMAGE_MAGIC = 0xe9;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,16})?$/;
export const FILE_RE = /^box-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,16})?\.bin$/;

export interface FirmwareRow {
  version: string;
  file: string;
  sha256: string;
  size: number;
  uploaded_at: string;
  uploaded_by: string | null;
  source: "panel" | "usb" | "api";
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string; status?: number };

export interface UpdateRequest {
  /** Firmware version to install. Default: the newest stored. */
  version?: string;
  /** Box IDs, or "all". */
  boxes: string[] | "all";
  /** Fob that confirmed it (admin tap, or the TECHSOFTWARE fob tap in week 7). */
  by: string | null;
  via: "panel" | "usb" | "api";
}

export interface UpdateResult {
  version: string;
  sent: string[];
  skipped: { box_id: string; reason: string }[];
}

/** Compare dotted versions numerically ("0.10.0" > "0.9.1"); suffixes sort after the plain release. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return a.localeCompare(b);
}

export class Firmware {
  constructor(
    private readonly db: Database,
    private readonly dir: string,
    private readonly boxes: BoxLink,
    /** Where boxes download from, e.g. http://10.102.40.10:8080 (the Pi's Control address). */
    private readonly baseUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): FirmwareRow[] {
    return this.db.query<FirmwareRow, []>("SELECT * FROM firmware").all().sort((a, b) => compareVersions(b.version, a.version));
  }

  get(version: string): FirmwareRow | null {
    return this.db.query<FirmwareRow, [string]>("SELECT * FROM firmware WHERE version = ?").get(version);
  }

  /** Path of a stored image for GET /fw/<file>, or null. */
  pathFor(file: string): string | null {
    if (!FILE_RE.test(file)) return null;
    const row = this.db.query<{ file: string }, [string]>("SELECT file FROM firmware WHERE file = ?").get(file);
    if (!row) return null;
    const p = join(this.dir, row.file);
    return existsSync(p) ? p : null;
  }

  /** Store a firmware image. Same version again with different bytes is refused (bump the version). */
  addImage(bytes: Uint8Array, version: string, by: string | null, source: FirmwareRow["source"]): Outcome<FirmwareRow> {
    if (!VERSION_RE.test(version)) return { ok: false, reason: "Version must look like 0.2.0", status: 400 };
    if (bytes.length < 256) return { ok: false, reason: "That file is too small to be box firmware", status: 400 };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: `Too big for a box (${bytes.length} bytes, max ${MAX_IMAGE_BYTES})`, status: 400 };
    if (bytes[0] !== ESP_IMAGE_MAGIC) return { ok: false, reason: "Not an ESP32 firmware image (use firmware.bin from the build)", status: 400 };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.get(version);
    if (existing) {
      if (existing.sha256 === sha256) return { ok: true, value: existing };
      return { ok: false, reason: `Version ${version} is already stored with different contents. Bump the version`, status: 409 };
    }
    const file = `box-${version}.bin`;
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${file}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(this.dir, file));
    const row: FirmwareRow = { version, file, sha256, size: bytes.length, uploaded_at: this.now().toISOString(), uploaded_by: by, source };
    this.db
      .query("INSERT INTO firmware (version, file, sha256, size, uploaded_at, uploaded_by, source) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.version, row.file, row.sha256, row.size, row.uploaded_at, row.uploaded_by, row.source);
    logEvent(this.db, {
      type: "software_update",
      ts: row.uploaded_at,
      fob_uid: by,
      detail: { target: "box", stage: "uploaded", version, sha256, size: row.size, via: source },
    });
    return { ok: true, value: row };
  }

  /** Remove a stored image (not the one a request may be in flight for: that's on the caller). */
  remove(version: string): boolean {
    const row = this.get(version);
    if (!row) return false;
    rmSync(join(this.dir, row.file), { force: true });
    this.db.query("DELETE FROM firmware WHERE version = ?").run(version);
    return true;
  }

  /**
   * Ask boxes to update. Boxes that can't be asked are skipped with a reason; each box then
   * reports in its state (updating / refused / failed / rebooting / updated / rolled_back),
   * which BoxLink logs as software_update events.
   */
  requestUpdate(req: UpdateRequest): Outcome<UpdateResult> {
    const fw = req.version ? this.get(req.version) : (this.list()[0] ?? null);
    if (!fw) return { ok: false, reason: req.version ? `No firmware ${req.version} stored` : "No firmware uploaded yet", status: 404 };
    if (!this.boxes.connected()) return { ok: false, reason: "The hub isn't connected to MQTT, so no box can be reached", status: 503 };
    const targets = req.boxes === "all" ? allBoxes(this.db) : req.boxes.map((id) => getBox(this.db, id) ?? ({ box_id: id, missing: true } as const));
    const sent: string[] = [];
    const skipped: { box_id: string; reason: string }[] = [];
    const t = this.now();
    const expires = new Date(t.getTime() + OTA_TTL_MS).toISOString();
    for (const b of targets) {
      if ("missing" in b) {
        skipped.push({ box_id: b.box_id, reason: "not in the box list" });
        continue;
      }
      const status = this.boxes.status(b);
      if (status === "never_seen" || status === "offline") {
        skipped.push({ box_id: b.box_id, reason: status === "offline" ? "offline" : "never seen" });
        continue;
      }
      if (b.fw === fw.version) {
        skipped.push({ box_id: b.box_id, reason: `already on ${fw.version}` });
        continue;
      }
      const url = `${this.baseUrl.replace(/\/+$/, "")}/fw/${fw.file}`;
      if (!this.boxes.ota(b.box_id, { version: fw.version, url, sha256: fw.sha256, size: fw.size, expires })) {
        skipped.push({ box_id: b.box_id, reason: "MQTT not connected" });
        continue;
      }
      this.boxes.markRequested(b.box_id, fw.version);
      sent.push(b.box_id);
    }
    // One event per box, so the event log's box filter shows each box's update history.
    for (const id of sent) {
      logEvent(this.db, { type: "software_update", ts: t.toISOString(), fob_uid: req.by, box_id: id, detail: { target: "box", stage: "requested", version: fw.version, via: req.via } });
    }
    for (const sk of skipped) {
      logEvent(this.db, {
        type: "software_update",
        ts: t.toISOString(),
        fob_uid: req.by,
        box_id: sk.box_id,
        detail: { target: "box", stage: "skipped", version: fw.version, via: req.via, why: sk.reason },
      });
    }
    return { ok: true, value: { version: fw.version, sent, skipped } };
  }
}
