// Small DB helpers shared by the panel, admin and MQTT code: settings, the event log, lookups,
// and the "current state" that is derived from events (who's signed in, who has which kit).
import type { Database } from "bun:sqlite";
import type { AccessSettings } from "./access";
import type { Box, Fob, Kit, Person } from "./workbook/schema";

// ---- settings ----------------------------------------------------------------------------------

export function getSetting(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string, ts = new Date().toISOString()): void {
  db.query(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, ts);
}

export const getFlag = (db: Database, key: string) => getSetting(db, key) === "true";
export const setFlag = (db: Database, key: string, on: boolean, ts?: string) => setSetting(db, key, on ? "true" : "false", ts);

export function accessSettings(db: Database): AccessSettings {
  return { studentsDisabled: getFlag(db, "students_disabled"), showMode: getFlag(db, "show_mode") };
}

// ---- events ------------------------------------------------------------------------------------

export type EventType =
  | "sign_in"
  | "sign_out"
  | "kit_out"
  | "kit_in"
  | "kit_denied"
  | "box_open"
  | "box_denied"
  | "tap_denied"
  | "admin_action"
  | "import_applied"
  | "export"
  | "software_update";

export interface NewEvent {
  type: EventType;
  ts: string;
  person_id?: string | null;
  fob_uid?: string | null;
  box_id?: string | null;
  kit_id?: string | null;
  detail?: Record<string, unknown>;
}

export function logEvent(db: Database, e: NewEvent): number {
  return db
    .query<{ id: number }, [string, string, string | null, string | null, string | null, string | null, string]>(
      "INSERT INTO events (ts, type, person_id, fob_uid, box_id, kit_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(e.ts, e.type, e.person_id ?? null, e.fob_uid ?? null, e.box_id ?? null, e.kit_id ?? null, JSON.stringify(e.detail ?? {}))!.id;
}

// ---- lookups (archived rows don't count) -------------------------------------------------------

type Row<T> = Omit<T, "extra"> & { extra: string };

export function getFob(db: Database, uid: string): Fob | null {
  const r = db.query<Row<Fob>, [string]>("SELECT * FROM fobs WHERE fob_uid = ? AND archived_at IS NULL").get(uid);
  return r ? { ...r, extra: JSON.parse(r.extra) } : null;
}

export function getPerson(db: Database, id: string | null): Person | null {
  if (!id) return null;
  const r = db.query<Row<Person>, [string]>("SELECT * FROM people WHERE person_id = ? AND archived_at IS NULL").get(id);
  return r ? { ...r, extra: JSON.parse(r.extra) } : null;
}

export function getKit(db: Database, id: string): Kit | null {
  const r = db.query<Row<Kit>, [string]>("SELECT * FROM kit WHERE kit_id = ? AND archived_at IS NULL").get(id);
  return r ? { ...r, extra: JSON.parse(r.extra) } : null;
}

export interface BoxRow extends Box {
  last_seen: string | null;
  lock_state: "locked" | "open" | null;
  lock_state_at: string | null;
  /** Firmware version from the last heartbeat or state. */
  fw: string | null;
  /** Reed switch: null = never reported (or no switch fitted). */
  door_state: "open" | "shut" | null;
  door_state_at: string | null;
  /** Latest firmware update status (see docs/mqtt.md, `ota` in state). */
  ota_status: string | null;
  ota_version: string | null;
  ota_why: string | null;
  ota_at: string | null;
}

export function getBox(db: Database, id: string): BoxRow | null {
  const r = db.query<Row<BoxRow>, [string]>("SELECT * FROM boxes WHERE box_id = ? AND archived_at IS NULL").get(id);
  return r ? { ...r, extra: JSON.parse(r.extra) } : null;
}

export function allKit(db: Database): Kit[] {
  return db
    .query<Row<Kit>, []>("SELECT * FROM kit WHERE archived_at IS NULL ORDER BY item, kit_id")
    .all()
    .map((r) => ({ ...r, extra: JSON.parse(r.extra) }));
}

export function allBoxes(db: Database): BoxRow[] {
  return db
    .query<Row<BoxRow>, []>("SELECT * FROM boxes WHERE archived_at IS NULL ORDER BY name, box_id")
    .all()
    .map((r) => ({ ...r, extra: JSON.parse(r.extra) }));
}

export function allPeople(db: Database): Person[] {
  return db
    .query<Row<Person>, []>("SELECT * FROM people WHERE archived_at IS NULL ORDER BY name, person_id")
    .all()
    .map((r) => ({ ...r, extra: JSON.parse(r.extra) }));
}

export function allFobs(db: Database): Fob[] {
  return db
    .query<Row<Fob>, []>("SELECT * FROM fobs WHERE archived_at IS NULL ORDER BY fob_uid")
    .all()
    .map((r) => ({ ...r, extra: JSON.parse(r.extra) }));
}

// ---- derived state -----------------------------------------------------------------------------

/**
 * Who a sign / kit event belongs to: the person, or for a guest day pass (no person) the fob.
 * Stored as "P001" or "fob:AABBCCDD".
 */
export function holderKey(personId: string | null, fobUid: string): string {
  return personId ?? `fob:${fobUid}`;
}

export interface SignedIn {
  key: string;
  person_id: string | null;
  fob_uid: string | null;
  since: string;
}

/** Everyone whose latest sign event is sign_in. */
export function signedIn(db: Database): SignedIn[] {
  return db
    .query<SignedIn, []>(
      `SELECT k AS key, person_id, fob_uid, ts AS since FROM (
         SELECT COALESCE(person_id, 'fob:' || fob_uid) AS k, person_id, fob_uid, ts, type,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(person_id, 'fob:' || fob_uid) ORDER BY id DESC) AS rn
           FROM events WHERE type IN ('sign_in', 'sign_out'))
       WHERE rn = 1 AND type = 'sign_in' ORDER BY ts`,
    )
    .all();
}

export function isSignedIn(db: Database, key: string): boolean {
  const r = db
    .query<{ type: string }, [string]>(
      "SELECT type FROM events WHERE type IN ('sign_in', 'sign_out') AND COALESCE(person_id, 'fob:' || fob_uid) = ? ORDER BY id DESC LIMIT 1",
    )
    .get(key);
  return r?.type === "sign_in";
}

export interface KitOut {
  kit_id: string;
  key: string;
  person_id: string | null;
  fob_uid: string | null;
  since: string;
}

/** Every item whose latest kit_out / kit_in event is kit_out, with who has it. */
export function kitOut(db: Database): KitOut[] {
  return db
    .query<KitOut, []>(
      `SELECT e.kit_id, COALESCE(e.person_id, 'fob:' || e.fob_uid) AS key, e.person_id, e.fob_uid, e.ts AS since
         FROM events e
         JOIN (SELECT kit_id, MAX(id) AS id FROM events WHERE type IN ('kit_out', 'kit_in') AND kit_id IS NOT NULL GROUP BY kit_id) last
           ON last.id = e.id
        WHERE e.type = 'kit_out' ORDER BY e.ts`,
    )
    .all();
}

export function holderOf(db: Database, kitId: string): KitOut | null {
  const r = db
    .query<KitOut & { type: string }, [string]>(
      `SELECT kit_id, type, COALESCE(person_id, 'fob:' || fob_uid) AS key, person_id, fob_uid, ts AS since
         FROM events WHERE type IN ('kit_out', 'kit_in') AND kit_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(kitId);
  return r && r.type === "kit_out" ? { kit_id: r.kit_id, key: r.key, person_id: r.person_id, fob_uid: r.fob_uid, since: r.since } : null;
}

/** Lost fobs per person: the £2 charge applies from the second (workbook-format.md). */
export function lostFobCount(db: Database, personId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM fobs WHERE person_id = ? AND status = 'Lost'").get(personId)!.n;
}
