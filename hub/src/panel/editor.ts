// Admin editor: people (with their fobs), kit, boxes and spare / guest fobs, edited on the panel
// (decisions 2026-11-16: the panel is the main copy; the workbook is the backup and bulk tool).
// Every save is validated with the workbook's own column rules, logged as an `admin_action`
// and recorded in panel_changes, so an import can't silently undo it. No confirm taps.
import type { Database } from "bun:sqlite";
import { allBoxes, allFobs, allKit, allPeople, getBox, getFob, getKit, getPerson, holderOf, logEvent, lostFobCount } from "../data";
import { insertRow, updateRow } from "../panelChanges";
import { localDate } from "../time";
import { normaliseCell } from "../workbook/parse";
import { SHEET_BY_KEY, type SheetKey } from "../workbook/schema";
import { archiveRow } from "../workbook/store";
import { no, ok, type Panel, type Result, type Session } from "./panel";

type Fields = Record<string, unknown>;

/** Which form fields each editor sheet accepts (DB column names). IDs are never edited. */
const EDITABLE: Record<"people" | "kit" | "boxes", string[]> = {
  people: ["name", "type", "year", "level", "specialism", "status", "notes"],
  kit: ["item", "category", "required_level", "specialism", "box_id", "slot", "notes"],
  boxes: ["name", "type", "required_level", "network", "ip_address", "location", "offline_unlock_min", "notes"],
};

export class Editor {
  private readonly db: Database;

  constructor(
    private readonly panel: Panel,
    private readonly onDataChanged: () => void = () => {},
  ) {
    this.db = panel.db;
    panel.setFindHandler((s, uid) => this.found(s, uid));
  }

  private changed(): void {
    this.onDataChanged();
    this.panel.overviewChanged();
  }

  private action(s: Session, action: string, detail: Record<string, unknown>, extra: { person_id?: string | null; kit_id?: string | null; box_id?: string | null } = {}): number {
    return logEvent(this.db, {
      type: "admin_action",
      ts: this.panel.iso(),
      person_id: extra.person_id !== undefined ? extra.person_id : s.personId,
      fob_uid: s.fobUid,
      kit_id: extra.kit_id ?? null,
      box_id: extra.box_id ?? null,
      detail: { action, openedBy: s.fobUid, confirmedBy: null, ...detail },
    });
  }

  /**
   * Validate form fields with the workbook's column rules. Returns the DB values, or the first
   * problem in plain words ("Level: 5 must be between 1 and 4").
   */
  private validate(sheet: "people" | "kit" | "boxes", fields: Fields): { ok: true; row: Fields } | { ok: false; reason: string } {
    const def = SHEET_BY_KEY[sheet];
    const row: Fields = {};
    for (const f of EDITABLE[sheet]) {
      const col = def.columns.find((c) => c.field === f)!;
      const raw = fields[f];
      const v = raw === undefined || raw === null ? null : typeof raw === "number" ? raw : String(raw);
      const r = normaliseCell(col, v as never);
      if (!r.ok) return { ok: false, reason: `${col.header}: ${r.error.replace(/^is required$/, "is needed")}` };
      row[f] = r.value;
    }
    if (sheet === "people" && row.type !== "Student") {
      // Staff and hire techs have no school year or ladder level (workbook format).
      row.year = null;
      row.level = null;
    }
    if (sheet === "kit" && row.box_id !== null && !getBox(this.db, row.box_id as string)) return { ok: false, reason: "Box: that box doesn't exist" };
    return { ok: true, row };
  }

  private nextId(table: string, idField: string, prefix: string, pad: number): string {
    let max = 0;
    const re = new RegExp(`^${prefix}(\\d+)$`);
    for (const r of this.db.query<{ id: string }, []>(`SELECT ${idField} AS id FROM ${table}`).all()) {
      const m = re.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${String(max + 1).padStart(pad, "0")}`;
  }

  /** Create (no id) or update a row; returns the ID. */
  private save(s: Session, sheet: "people" | "kit" | "boxes", id: unknown, fields: unknown): Result {
    if (!fields || typeof fields !== "object") return no("fields missing", 400);
    const creating = id === undefined || id === null || id === "";
    const input = { ...(fields as Fields) };
    if (creating && sheet === "people" && (input.status === undefined || input.status === null || input.status === "")) input.status = "Active";
    const v = this.validate(sheet, input);
    if (!v.ok) return no(v.reason);
    const def = SHEET_BY_KEY[sheet];
    const ts = this.panel.iso();
    const word = { people: "person", kit: "kit", boxes: "box" }[sheet];
    let newId: string;
    if (creating) {
      newId =
        sheet === "people" ? this.nextId("people", "person_id", "P", 3) : sheet === "kit" ? this.nextId("kit", "kit_id", "K", 3) : this.nextId("boxes", "box_id", "BOX-", 2);
      this.db.transaction(() => {
        const ev = this.action(s, `add_${word}`, { id: newId }, this.subject(sheet, newId));
        const base: Fields = { [def.idField]: newId, ...v.row };
        insertRow(this.db, sheet as SheetKey, base, { fobUid: s.fobUid, eventId: ev, ts });
      })();
      this.changed();
      return ok("Added", { id: newId });
    }
    if (typeof id !== "string") return no("id must be text", 400);
    const exists = this.db.query(`SELECT 1 FROM ${def.table} WHERE ${def.idField} = ? AND archived_at IS NULL`).get(id);
    if (!exists) return no("That row isn't there any more", 404);
    let fieldsChanged: string[] = [];
    this.db.transaction(() => {
      const ev = this.action(s, `edit_${word}`, { id }, this.subject(sheet, id));
      fieldsChanged = updateRow(this.db, sheet as SheetKey, id, v.row, { fobUid: s.fobUid, eventId: ev, ts });
      if (!fieldsChanged.length) throw new NoChange();
    })();
    this.changed();
    return ok("Saved", { id, fields: fieldsChanged });
  }

  private subject(sheet: string, id: string): { person_id?: string | null; kit_id?: string | null; box_id?: string | null } {
    return sheet === "people" ? { person_id: id } : sheet === "kit" ? { kit_id: id } : { box_id: id };
  }

  // ---- people --------------------------------------------------------------------------------

  people(q: unknown): Record<string, unknown>[] {
    const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
    const fobs = allFobs(this.db);
    return allPeople(this.db)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.person_id.toLowerCase() === needle)
      .sort((a, b) => Number(a.status === "Left") - Number(b.status === "Left") || a.name.localeCompare(b.name))
      .map((p) => ({
        person_id: p.person_id,
        name: p.name,
        type: p.type,
        year: p.year,
        level: p.level,
        specialism: p.specialism,
        status: p.status,
        fobs: fobs.filter((f) => f.person_id === p.person_id && (f.status === "Active" || f.status === "Spare")).map((f) => ({ fob_uid: f.fob_uid, role: f.role, status: f.status })),
      }));
  }

  person(id: unknown): Record<string, unknown> | null {
    const p = typeof id === "string" ? getPerson(this.db, id) : null;
    if (!p) return null;
    const fobs = allFobs(this.db).filter((f) => f.person_id === p.person_id);
    const order = { Active: 0, Spare: 1, Lost: 2, Revoked: 3 } as const;
    return {
      person: { person_id: p.person_id, name: p.name, type: p.type, year: p.year, level: p.level, specialism: p.specialism, status: p.status, notes: p.notes },
      fobs: fobs
        .sort((a, b) => order[a.status] - order[b.status] || (b.issued ?? "").localeCompare(a.issued ?? ""))
        .map((f) => ({ fob_uid: f.fob_uid, role: f.role, status: f.status, issued: f.issued, ended: f.ended })),
      lostFobs: lostFobCount(this.db, p.person_id),
    };
  }

  savePerson(s: Session, id: unknown, fields: unknown): Result {
    return this.saveSafe(() => this.save(s, "people", id, fields));
  }

  /** "Remove" a person: Status Left and every Active / Spare fob of theirs Revoked. Kept, not archived. */
  removePerson(s: Session, id: unknown): Result {
    const p = typeof id === "string" ? getPerson(this.db, id) : null;
    if (!p) return no("Person not found", 404);
    const fobs = allFobs(this.db).filter((f) => f.person_id === p.person_id && (f.status === "Active" || f.status === "Spare"));
    const today = localDate(this.panel.now(), this.panel.config.timezone);
    this.db.transaction(() => {
      const ev = this.action(s, "person_left", { id: p.person_id, fobsRevoked: fobs.map((f) => f.fob_uid) }, { person_id: p.person_id });
      const ctx = { fobUid: s.fobUid, eventId: ev, ts: this.panel.iso() };
      updateRow(this.db, "people", p.person_id, { status: "Left" }, ctx);
      for (const f of fobs) updateRow(this.db, "fobs", f.fob_uid, { status: "Revoked", ended: f.ended ?? today }, ctx);
    })();
    this.changed();
    return ok(`${p.name} marked as left${fobs.length ? `; ${fobs.length} fob${fobs.length === 1 ? "" : "s"} revoked` : ""}`);
  }

  /** Standard <-> Admin. */
  fobRole(s: Session, uid: unknown, role: unknown): Result {
    if (role !== "Standard" && role !== "Admin") return no('role must be "Standard" or "Admin"', 400);
    const f = typeof uid === "string" ? getFob(this.db, uid) : null;
    if (!f) return no("Fob not found", 404);
    if (!f.person_id || f.role === "Day pass") return no("Only a person's own fob can be Standard or Admin");
    if (f.role === role) return ok("No change");
    this.db.transaction(() => {
      const ev = this.action(s, "fob_role", { uid: f.fob_uid, from: f.role, to: role }, { person_id: f.person_id });
      updateRow(this.db, "fobs", f.fob_uid, { role }, { fobUid: s.fobUid, eventId: ev, ts: this.panel.iso() });
    })();
    this.changed();
    return ok(role === "Admin" ? "Fob is now an admin fob" : "Fob is now a standard fob");
  }

  private saveSafe(fn: () => Result): Result {
    try {
      return fn();
    } catch (e) {
      if (e instanceof NoChange) return ok("No change");
      const m = (e as Error).message;
      if (/UNIQUE/i.test(m)) return no("That's already used by another row");
      if (/CHECK|constraint/i.test(m)) return no("That value isn't allowed");
      throw e;
    }
  }

  // ---- kit -----------------------------------------------------------------------------------

  kit(): Record<string, unknown>[] {
    const boxes = new Map(allBoxes(this.db).map((b) => [b.box_id, b.name]));
    return allKit(this.db).map((k) => ({
      kit_id: k.kit_id,
      item: k.item,
      category: k.category,
      required_level: k.required_level,
      specialism: k.specialism,
      box_id: k.box_id,
      box: k.box_id ? (boxes.get(k.box_id) ?? k.box_id) : null,
      slot: k.slot,
      notes: k.notes,
      out: !!holderOf(this.db, k.kit_id),
    }));
  }

  saveKit(s: Session, id: unknown, fields: unknown): Result {
    return this.saveSafe(() => this.save(s, "kit", id, fields));
  }

  removeKit(s: Session, id: unknown): Result {
    const k = typeof id === "string" ? getKit(this.db, id) : null;
    if (!k) return no("Item not found", 404);
    if (holderOf(this.db, k.kit_id)) return no(`${k.item} is out. Return it first`);
    this.archive(s, "kit", k.kit_id, "remove_kit", { kit_id: k.kit_id });
    return ok(`${k.item} removed`);
  }

  // ---- boxes ---------------------------------------------------------------------------------

  boxes(): Record<string, unknown>[] {
    const counts = new Map<string, number>();
    for (const k of allKit(this.db)) if (k.box_id) counts.set(k.box_id, (counts.get(k.box_id) ?? 0) + 1);
    return allBoxes(this.db).map((b) => ({
      box_id: b.box_id,
      name: b.name,
      type: b.type,
      required_level: b.required_level,
      network: b.network,
      ip_address: b.ip_address,
      location: b.location,
      offline_unlock_min: b.offline_unlock_min,
      notes: b.notes,
      kitCount: counts.get(b.box_id) ?? 0,
      status: this.panel.boxes.status(b),
    }));
  }

  saveBox(s: Session, id: unknown, fields: unknown): Result {
    return this.saveSafe(() => this.save(s, "boxes", id, fields));
  }

  removeBox(s: Session, id: unknown): Result {
    const b = typeof id === "string" ? getBox(this.db, id) : null;
    if (!b) return no("Box not found", 404);
    const inside = allKit(this.db).filter((k) => k.box_id === b.box_id).length;
    if (inside) return no(`${inside} item${inside === 1 ? "" : "s"} still live in ${b.name}. Move or remove them first`);
    this.archive(s, "boxes", b.box_id, "remove_box", { box_id: b.box_id });
    return ok(`${b.name} removed`);
  }

  /** Archive like an import does, and remember it as a panel change (field "archived"). */
  private archive(s: Session, sheet: "kit" | "boxes", id: string, action: string, subject: { kit_id?: string; box_id?: string }): void {
    const ts = this.panel.iso();
    this.db.transaction(() => {
      const ev = this.action(s, action, { id }, subject);
      archiveRow(this.db, sheet, id, ts, localDate(this.panel.now(), this.panel.config.timezone));
      this.db
        .query("INSERT INTO panel_changes (ts, sheet, row_id, field, old_value, new_value, fob_uid, event_id) VALUES (?, ?, ?, 'archived', 'false', 'true', ?, ?)")
        .run(ts, sheet, id, s.fobUid, ev);
    })();
    this.changed();
  }

  // ---- spare and guest fobs ------------------------------------------------------------------

  spares(): Record<string, unknown>[] {
    const today = localDate(this.panel.now(), this.panel.config.timezone);
    return allFobs(this.db)
      .filter((f) => f.person_id === null && (f.status === "Spare" || f.status === "Active"))
      .map((f) => ({
        fob_uid: f.fob_uid,
        role: f.role,
        status: f.status,
        level: f.level,
        issued: f.issued,
        notes: f.notes,
        state: f.status === "Spare" ? "spare" : f.role === "Day pass" && f.issued === today ? "day pass today" : "old day pass",
      }));
  }

  // ---- find by scanning a fob ----------------------------------------------------------------

  setFind(s: Session, on: unknown): Result {
    s.find = on === true;
    return ok(s.find ? "Tap a fob to find its owner" : "ok");
  }

  private found(s: Session, uid: string): void {
    const f = getFob(this.db, uid);
    const stream = this.panel.stream;
    if (!f) return stream.publish("found", { ok: false, uid, reason: `Fob …${uid.slice(-4)} isn't in the hub. Open a person and use Add fob` });
    if (f.person_id) return stream.publish("found", { ok: true, kind: "person", id: f.person_id, uid });
    stream.publish("found", { ok: true, kind: "spare", uid });
  }
}

class NoChange extends Error {}
