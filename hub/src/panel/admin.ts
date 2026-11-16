// Admin menu actions (decisions 2026-11-16). An Active Admin fob opens the menu; risky actions
// wait for a second tap of any Active Admin fob (Panel.requestConfirm). Every action is logged
// as `admin_action` with the fob that opened the menu (`openedBy`) and, for risky ones, the fob
// that confirmed it (`confirmedBy`). Changes to workbook rows go through panelChanges so an
// import can't silently undo them.
import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  allBoxes,
  allFobs,
  allPeople,
  getFlag,
  getFob,
  getKit,
  getPerson,
  holderOf,
  kitOut,
  logEvent,
  lostFobCount,
  setFlag,
} from "../data";
import { schemaVersion } from "../db";
import { firstName } from "../names";
import { insertRow, updateRow } from "../panelChanges";
import { localDate } from "../time";
import { normaliseUid } from "../uid";
import { VERSION } from "../version";
import { applyBatch } from "../workbook/batches";
import type { Resolution } from "../workbook/diff";
import { PERSON_SPECIALISMS, PERSON_TYPES, type Fob } from "../workbook/schema";
import { no, ok, type Panel, type Pending, type Result, type Session } from "./panel";

export type Runner = (argv: string[]) => void;

/** Restart / reboot: polkit (pi/polkit) allows exactly these two for the hub user. */
export const RESTART_HUB = ["systemctl", "--no-ask-password", "restart", "tech-access-hub.service"];
export const REBOOT_PI = ["systemctl", "--no-ask-password", "reboot"];

const defaultRunner: Runner = (argv) => {
  // Give the HTTP response time to reach the panel first.
  setTimeout(() => {
    try {
      const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
      void p.exited.then(async (code) => {
        if (code !== 0) console.error(`${argv.join(" ")} failed (${code}): ${(await new Response(p.stderr).text()).trim()}`);
      });
    } catch (e) {
      console.error(`${argv.join(" ")}: ${(e as Error).message}`);
    }
  }, 1_000);
};

export const BACKUPS_KEPT = 14;
const PAGE_SIZE = 40;

export class Admin {
  private readonly db: Database;

  constructor(
    private readonly panel: Panel,
    private readonly opts: { run?: Runner; backupDir?: string | null; onDataChanged?: () => void } = {},
  ) {
    this.db = panel.db;
    panel.registerConfirmer("students_disabled", (s, p, uid) => this.doStudents(s, true, uid));
    panel.registerConfirmer("fob_status", (s, p, uid) => this.doFobStatus(s, p, uid));
    panel.registerConfirmer("show_mode", (s, p, uid) => this.doShowMode(s, p.params.on === true, uid));
    panel.registerConfirmer("force_return", (s, p, uid) => this.doForceReturn(s, p, uid));
    panel.registerConfirmer("restart", (s, p, uid) => this.doRestart(s, p, uid));
    panel.registerConfirmer("import_apply", (s, p, uid) => this.doImport(s, p, uid));
    panel.setCaptureHandler((s, uid, purpose) => this.onCaptured(s, purpose, uid));
  }

  private changed(): void {
    this.opts.onDataChanged?.();
    this.panel.overviewChanged();
  }

  /** Log an admin_action. person = the person whose fob opened the menu. */
  private action(s: Session, action: string, confirmedBy: string | null, detail: Record<string, unknown> = {}, extra: { box_id?: string | null; kit_id?: string | null; person_id?: string | null } = {}): number {
    return logEvent(this.db, {
      type: "admin_action",
      ts: this.panel.iso(),
      person_id: extra.person_id !== undefined ? extra.person_id : s.personId,
      fob_uid: s.fobUid,
      box_id: extra.box_id ?? null,
      kit_id: extra.kit_id ?? null,
      detail: { action, openedBy: s.fobUid, confirmedBy, ...detail },
    });
  }

  private today(): string {
    return localDate(this.panel.now(), this.panel.config.timezone);
  }

  menu(): Record<string, unknown> {
    return {
      studentsDisabled: getFlag(this.db, "students_disabled"),
      showMode: getFlag(this.db, "show_mode"),
      kitOut: kitOut(this.db).length,
    };
  }

  // ---- students ----------------------------------------------------------------------------------

  /** Disabling is risky (tap to confirm); re-enabling isn't. */
  students(s: Session, disabled: unknown): Result {
    if (typeof disabled !== "boolean") return no("disabled must be true or false", 400);
    if (disabled) return this.panel.requestConfirm(s, "students_disabled", "Disable all students");
    return this.doStudents(s, false, null);
  }

  private doStudents(s: Session, disabled: boolean, confirmedBy: string | null): Result {
    setFlag(this.db, "students_disabled", disabled, this.panel.iso());
    this.action(s, disabled ? "students_disabled" : "students_enabled", confirmedBy);
    this.changed();
    return ok(disabled ? "Students are disabled" : "Students are enabled again");
  }

  // ---- fobs: list, lost / revoke ------------------------------------------------------------------

  fobs(): Record<string, unknown>[] {
    const people = new Map(allPeople(this.db).map((p) => [p.person_id, p]));
    return allFobs(this.db)
      .filter((f) => f.status === "Active" || f.status === "Spare")
      .map((f) => {
        const p = f.person_id ? people.get(f.person_id) : undefined;
        return {
          fob_uid: f.fob_uid,
          name: p ? firstName(p.name) : f.role === "Day pass" ? "Guest" : "Nobody",
          person_id: f.person_id,
          role: f.role,
          status: f.status,
          issued: f.issued,
          lostBefore: f.person_id ? lostFobCount(this.db, f.person_id) : 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  fobStatus(s: Session, uid: unknown, status: unknown): Result {
    if (status !== "Lost" && status !== "Revoked") return no('status must be "Lost" or "Revoked"', 400);
    const fob = typeof uid === "string" ? getFob(this.db, uid) : null;
    if (!fob) return no("Fob not found", 404);
    if (fob.status === "Lost" || fob.status === "Revoked") return no(`That fob is already ${fob.status}`);
    const who = fob.person_id ? firstName(getPerson(this.db, fob.person_id)?.name) : "spare";
    return this.panel.requestConfirm(s, "fob_status", `Mark ${who}'s fob ${status === "Lost" ? "lost" : "revoked"}`, { uid: fob.fob_uid, status });
  }

  private doFobStatus(s: Session, p: Pending, confirmedBy: string): Result {
    const uid = p.params.uid as string;
    const status = p.params.status as "Lost" | "Revoked";
    const fob = getFob(this.db, uid);
    if (!fob) return no("Fob not found");
    let charge = false;
    this.db.transaction(() => {
      const ev = this.action(s, status === "Lost" ? "fob_lost" : "fob_revoked", confirmedBy, { uid, was: fob.status }, { person_id: fob.person_id });
      updateRow(this.db, "fobs", uid, { status, ended: fob.ended ?? this.today() }, { fobUid: confirmedBy, eventId: ev, ts: this.panel.iso() });
      // £2 from a person's second lost fob (workbook-format.md).
      charge = status === "Lost" && !!fob.person_id && lostFobCount(this.db, fob.person_id) >= 2;
    })();
    this.changed();
    return ok(`Fob marked ${status.toLowerCase()}${charge ? ". This is their second lost fob: £2 charge" : ""}`, { charge });
  }

  // ---- capture: enrol and day pass ----------------------------------------------------------------

  startEnrol(s: Session): Result {
    return this.panel.startCapture(s, "enrol");
  }

  startDayPass(s: Session): Result {
    return this.panel.startCapture(s, "day_pass");
  }

  /** What can be done with a tapped fob for this purpose. Null = fine. */
  private captureProblem(purpose: "enrol" | "day_pass", fob: Fob | null): string | null {
    if (purpose === "enrol") {
      if (!fob || fob.status === "Spare") return null;
      if (fob.status === "Lost" || fob.status === "Revoked") return `That fob is ${fob.status}. Lost and revoked fobs are never reused`;
      return `That fob is already enrolled${fob.person_id ? ` to ${firstName(getPerson(this.db, fob.person_id)?.name)}` : ""}`;
    }
    if (!fob) return "That fob isn't in the hub. Enrol it as a spare first";
    if (fob.status === "Spare") return null;
    // An expired day pass can be handed to the next guest.
    if (fob.role === "Day pass" && fob.status === "Active" && fob.issued !== null && fob.issued < this.today()) return null;
    return fob.role === "Day pass" && fob.issued === this.today() ? "That day pass is in use today" : "That isn't a spare fob";
  }

  /** Called by Panel.handleTap via the capture handler (see constructor). */
  onCaptured(s: Session, purpose: "enrol" | "day_pass", uid: string): void {
    const fob = getFob(this.db, uid);
    const problem = this.captureProblem(purpose, fob);
    this.panel.stream.publish("captured", problem ? { ok: false, purpose, reason: problem } : { ok: true, purpose, uid, existing: fob ? fob.status : null });
    this.panel.publishSession();
  }

  people(): Record<string, unknown>[] {
    return allPeople(this.db)
      .filter((p) => p.status !== "Left")
      .map((p) => ({ person_id: p.person_id, name: firstName(p.name), type: p.type, year: p.year, level: p.level, status: p.status }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.person_id.localeCompare(b.person_id));
  }

  private nextPersonId(): string {
    const ids = this.db.query<{ person_id: string }, []>("SELECT person_id FROM people").all();
    let max = 0;
    for (const { person_id } of ids) {
      const m = /^P(\d+)$/.exec(person_id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `P${String(max + 1).padStart(3, "0")}`;
  }

  enrol(s: Session, b: Record<string, unknown>): Result {
    const u = normaliseUid(b.uid);
    if (!u.ok) return no(u.error, 400);
    const uid = u.value;
    const existing = getFob(this.db, uid);
    const archived = this.db.query("SELECT 1 FROM fobs WHERE fob_uid = ? AND archived_at IS NOT NULL").get(uid);
    if (archived) return no("That fob was removed by an import. Lost and revoked fobs are never reused");
    const problem = this.captureProblem("enrol", existing);
    if (problem) return no(problem);
    const role = b.role ?? "Standard";
    if (role !== "Standard" && role !== "Admin") return no('role must be "Standard" or "Admin"', 400);
    const issued = typeof b.issued === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.issued) ? b.issued : this.today();

    let personId: string;
    let newPerson: Record<string, unknown> | null = null;
    if (typeof b.personId === "string") {
      const p = getPerson(this.db, b.personId);
      if (!p) return no("Person not found", 404);
      if (p.status === "Left") return no(`${firstName(p.name)} has left`);
      personId = p.person_id;
    } else if (b.person && typeof b.person === "object") {
      const np = b.person as Record<string, unknown>;
      const name = typeof np.name === "string" ? np.name.trim().replace(/\s+/g, " ") : "";
      if (!name) return no("Type a name", 400);
      if (!PERSON_TYPES.includes(np.type as never)) return no("Choose Student, Staff or Hire tech", 400);
      const student = np.type === "Student";
      const year = student ? Number(np.year) : null;
      if (student && !(Number.isInteger(year) && year! >= 7 && year! <= 13)) return no("Choose a year (7–13)", 400);
      // Fobs are issued at Level 1 (brief); staff and hire techs have no level.
      const level = student ? (np.level === undefined || np.level === null ? 1 : Number(np.level)) : null;
      if (student && !(Number.isInteger(level) && level! >= 1 && level! <= 4)) return no("Level must be 1–4", 400);
      const specialism = np.specialism === null || np.specialism === undefined || np.specialism === "" ? null : np.specialism;
      if (specialism !== null && !PERSON_SPECIALISMS.includes(specialism as never)) return no("Unknown specialism", 400);
      personId = this.nextPersonId();
      newPerson = { person_id: personId, name, type: np.type, year, level, specialism, status: "Active", notes: "" };
    } else {
      return no("Pick a person or add a new one", 400);
    }

    const ts = this.panel.iso();
    this.db.transaction(() => {
      const ev = this.action(s, "fob_enrolled", null, { uid, role, issued, newPerson: newPerson !== null }, { person_id: personId });
      const ctx = { fobUid: s.fobUid, eventId: ev, ts };
      if (newPerson) insertRow(this.db, "people", newPerson, ctx);
      const fob = { person_id: personId, role, status: "Active", level: null, issued, ended: null };
      if (existing) updateRow(this.db, "fobs", uid, fob, ctx);
      else insertRow(this.db, "fobs", { fob_uid: uid, ...fob, notes: "" }, ctx);
    })();
    this.changed();
    const who = firstName((newPerson?.name as string) ?? getPerson(this.db, personId)?.name);
    return ok(`Fob enrolled to ${who}`, { personId, uid });
  }

  dayPass(s: Session, b: Record<string, unknown>): Result {
    const u = normaliseUid(b.uid);
    if (!u.ok) return no(u.error, 400);
    const fob = getFob(this.db, u.value);
    const problem = this.captureProblem("day_pass", fob);
    if (problem) return no(problem);
    const guest = typeof b.guest === "string" ? b.guest.trim().replace(/\s+/g, " ") : "";
    if (!guest) return no("Type the company or reason", 400);
    if (guest.length > 120) return no("Keep it under 120 characters", 400);
    const level = b.level === undefined || b.level === null ? 1 : Number(b.level);
    if (!(Number.isInteger(level) && level >= 1 && level <= 4)) return no("Level must be 1–4", 400);
    const issuer = firstName(getPerson(this.db, s.personId)?.name) || "admin";
    // Decision 2026-11-16: company / reason and issuer go in Notes, so they export cleanly with
    // no new workbook column; the admin_action event keeps them as fields too.
    const notes = `Day pass: ${guest} (issued by ${issuer})`;
    this.db.transaction(() => {
      const ev = this.action(s, "day_pass_issued", null, { uid: u.value, guest, level, issuedBy: s.fobUid }, { person_id: s.personId });
      updateRow(
        this.db,
        "fobs",
        u.value,
        { person_id: null, role: "Day pass", status: "Active", level, issued: this.today(), ended: null, notes },
        { fobUid: s.fobUid, eventId: ev, ts: this.panel.iso() },
      );
    })();
    this.changed();
    return ok(`Day pass ready: Level ${level}, today only`);
  }

  // ---- show mode ---------------------------------------------------------------------------------

  showMode(s: Session, on: unknown): Result {
    if (typeof on !== "boolean") return no("on must be true or false", 400);
    return this.panel.requestConfirm(s, "show_mode", on ? "Turn show mode on: every box unlocks" : "Turn show mode off: boxes lock again", { on });
  }

  private doShowMode(s: Session, on: boolean, confirmedBy: string | null): Result {
    setFlag(this.db, "show_mode", on, this.panel.iso());
    this.action(s, on ? "show_mode_on" : "show_mode_off", confirmedBy);
    this.panel.boxes.publishMode();
    this.changed();
    return ok(on ? "Show mode is on. Every box is unlocked" : "Show mode is off");
  }

  // ---- kit ---------------------------------------------------------------------------------------

  kitOutList(): Record<string, unknown>[] {
    return kitOut(this.db).map((o) => ({ kit_id: o.kit_id, item: getKit(this.db, o.kit_id)?.item ?? o.kit_id, holder: this.panel.holderName(o.person_id), since: o.since }));
  }

  forceReturn(s: Session, kitId: unknown): Result {
    const kit = typeof kitId === "string" ? getKit(this.db, kitId) : null;
    if (!kit) return no("Item not found", 404);
    const h = holderOf(this.db, kit.kit_id);
    if (!h) return no(`${kit.item} isn't out`);
    return this.panel.requestConfirm(s, "force_return", `Return ${kit.item} (out with ${this.panel.holderName(h.person_id)})`, { kitId: kit.kit_id });
  }

  private doForceReturn(s: Session, p: Pending, confirmedBy: string): Result {
    const kit = getKit(this.db, p.params.kitId as string);
    const h = kit ? holderOf(this.db, kit.kit_id) : null;
    if (!kit || !h) return no("That item isn't out any more");
    this.db.transaction(() => {
      const ev = this.action(s, "force_return", confirmedBy, { holder: h.key }, { kit_id: kit.kit_id });
      // The kit_in is the holder's (so their card is right), marked as forced by the admin.
      logEvent(this.db, {
        type: "kit_in",
        ts: this.panel.iso(),
        person_id: h.person_id,
        fob_uid: h.fob_uid,
        kit_id: kit.kit_id,
        box_id: kit.box_id,
        detail: { forced: true, by: confirmedBy, adminEvent: ev },
      });
    })();
    this.changed();
    return ok(`${kit.item} marked as returned`);
  }

  // ---- end of session ----------------------------------------------------------------------------

  endOfSessionPreview(): Record<string, unknown> {
    return {
      kitOut: this.kitOutList(),
      boxesOpen: allBoxes(this.db)
        .filter((b) => this.panel.boxes.status(b) === "open")
        .map((b) => ({ box_id: b.box_id, name: b.name })),
      showMode: getFlag(this.db, "show_mode"),
    };
  }

  /** Lists what's out / open, locks every box and turns show mode off. Doesn't sign anyone out. */
  endOfSession(s: Session): Result {
    const before = this.endOfSessionPreview();
    const ev = this.action(s, "end_of_session", null, {
      kitOut: (before.kitOut as { kit_id: string }[]).map((k) => k.kit_id),
      boxesOpen: (before.boxesOpen as { box_id: string }[]).map((b) => b.box_id),
      showModeWasOn: before.showMode,
    });
    setFlag(this.db, "show_mode", false, this.panel.iso());
    this.panel.boxes.publishMode();
    let sent = 0;
    const boxes = allBoxes(this.db);
    for (const b of boxes) if (this.panel.boxes.command(b.box_id, "lock", ev)) sent++;
    this.changed();
    const offline = boxes.length - sent;
    return ok(
      `Locking ${boxes.length} box${boxes.length === 1 ? "" : "es"}. Show mode is off${offline ? `. ${offline} couldn't be reached` : ""}`,
      before,
    );
  }

  // ---- backup ------------------------------------------------------------------------------------

  backupDir(): string | null {
    if (this.opts.backupDir !== undefined) return this.opts.backupDir;
    return this.panel.config.dbPath === ":memory:" ? null : join(dirname(this.panel.config.dbPath), "backups");
  }

  /** Decision 2026-11-16: a consistent snapshot on the Pi's SSD until TECHBACKUP (week 7). */
  backup(s: Session): Result {
    const dir = this.backupDir();
    if (!dir) return no("No database file to back up (running in memory)");
    mkdirSync(dir, { recursive: true });
    const stamp = this.panel.iso().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const file = join(dir, `tech-access-${stamp}.db`);
    try {
      this.db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    } catch (e) {
      return no(`Backup failed: ${(e as Error).message}`);
    }
    const all = readdirSync(dir).filter((f) => /^tech-access-\d{8}-\d{6}\.db$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
    const size = statSync(file).size;
    this.action(s, "backup", null, { file, bytes: size });
    return ok(`Backup saved (${Math.max(1, Math.round(size / 1024))} KB). Keeping the newest ${BACKUPS_KEPT}`, { file });
  }

  lastBackup(): string | null {
    const dir = this.backupDir();
    if (!dir) return null;
    try {
      const all = readdirSync(dir).filter((f) => /^tech-access-\d{8}-\d{6}\.db$/.test(f)).sort();
      return all.length ? join(dir, all[all.length - 1]!) : null;
    } catch {
      return null;
    }
  }

  // ---- hub status, restart -----------------------------------------------------------------------

  status(): Record<string, unknown> {
    const o = this.panel.overview() as { health: Record<string, unknown> };
    return {
      version: VERSION,
      schemaVersion: schemaVersion(this.db),
      uptimeSeconds: Math.round((Date.now() - this.panel.startedAt) / 1000),
      now: this.panel.iso(),
      ...o.health,
      lastBackup: this.lastBackup(),
      showMode: getFlag(this.db, "show_mode"),
      studentsDisabled: getFlag(this.db, "students_disabled"),
    };
  }

  restart(s: Session, what: unknown): Result {
    if (what !== "hub" && what !== "pi") return no('what must be "hub" or "pi"', 400);
    return this.panel.requestConfirm(s, "restart", what === "hub" ? "Restart the hub (back in about 10 seconds)" : "Reboot the Pi (back in about a minute)", { what });
  }

  private doRestart(s: Session, p: Pending, confirmedBy: string): Result {
    const what = p.params.what as "hub" | "pi";
    this.action(s, what === "hub" ? "restart_hub" : "reboot_pi", confirmedBy);
    (this.opts.run ?? defaultRunner)(what === "hub" ? RESTART_HUB : REBOOT_PI);
    return ok(what === "hub" ? "Restarting the hub…" : "Rebooting the Pi…");
  }

  // ---- import (TECHUPDATE preview, fed from an upload for now) -----------------------------------

  importApply(s: Session, batchId: unknown, resolutions: Record<string, Resolution>): Result {
    if (typeof batchId !== "number") return no("batchId must be a number", 400);
    return this.panel.requestConfirm(s, "import_apply", "Apply the workbook", { batchId, resolutions });
  }

  private doImport(s: Session, p: Pending, confirmedBy: string): Result {
    const r = applyBatch(this.db, p.params.batchId as number, confirmedBy, this.panel.now(), this.panel.config.timezone, p.params.resolutions as Record<string, Resolution>);
    switch (r.kind) {
      case "applied":
        this.changed();
        return ok("Workbook applied", { counts: r.counts });
      case "already_applied":
        return ok("Already applied");
      case "unresolved":
        return no(`Choose "keep panel" or "use sheet" for ${r.keys.length} conflict(s) first`);
      case "stale":
        return no("The data changed since this preview. Load the workbook again");
      case "superseded":
        return no("A newer workbook was loaded. Use that one");
      case "has_errors":
        return no(`Fix the ${r.errorCount} error(s) in the workbook first`);
      case "not_found":
        return no("That workbook isn't loaded any more");
      case "forbidden":
        return no(r.reason);
    }
  }

  // ---- event log ---------------------------------------------------------------------------------

  events(q: { page?: unknown; person?: unknown; box?: unknown; kit?: unknown; type?: unknown }): Record<string, unknown> {
    const where: string[] = [];
    const args: string[] = [];
    const add = (sql: string, v: unknown) => {
      if (typeof v === "string" && v !== "") {
        where.push(sql);
        args.push(v);
      }
    };
    add("e.person_id = ?", q.person);
    add("e.box_id = ?", q.box);
    add("e.kit_id = ?", q.kit);
    add("e.type = ?", q.type);
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM events e ${w}`).get(...args)!.n;
    const rows = this.db
      .query<
        { id: number; ts: string; type: string; person_id: string | null; fob_uid: string | null; box_id: string | null; kit_id: string | null; detail: string; pname: string | null; bname: string | null; kitem: string | null },
        (string | number)[]
      >(
        `SELECT e.*, p.name AS pname, b.name AS bname, k.item AS kitem FROM events e
           LEFT JOIN people p ON p.person_id = e.person_id
           LEFT JOIN boxes b ON b.box_id = e.box_id
           LEFT JOIN kit k ON k.kit_id = e.kit_id
         ${w} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const fobNames = new Map<string, string>();
    const nameOfFob = (uid: unknown): string | null => {
      if (typeof uid !== "string") return null;
      if (!fobNames.has(uid)) {
        const f = this.db.query<{ name: string | null; role: string }, [string]>("SELECT p.name, f.role FROM fobs f LEFT JOIN people p ON p.person_id = f.person_id WHERE f.fob_uid = ?").get(uid);
        fobNames.set(uid, f?.name ? firstName(f.name) : f?.role === "Day pass" ? "a guest" : `fob …${uid.slice(-4)}`);
      }
      return fobNames.get(uid)!;
    };
    return {
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
      events: rows.map((r) => {
        const detail = JSON.parse(r.detail) as Record<string, unknown>;
        const who = r.pname ? firstName(r.pname) : r.fob_uid ? nameOfFob(r.fob_uid) : null;
        return {
          id: r.id,
          ts: r.ts,
          type: r.type,
          who,
          box: r.bname ?? r.box_id,
          kit: r.kitem ?? r.kit_id,
          text: describe(r.type, who, r.bname ?? r.box_id, r.kitem ?? r.kit_id, detail, nameOfFob),
          detail,
        };
      }),
    };
  }

  /** Filter choices for the event log screen. */
  eventFilters(): Record<string, unknown> {
    return {
      people: allPeople(this.db).map((p) => ({ id: p.person_id, name: firstName(p.name) })),
      boxes: allBoxes(this.db).map((b) => ({ id: b.box_id, name: b.name })),
      kit: this.db.query<{ id: string; name: string }, []>("SELECT kit_id AS id, item AS name FROM kit WHERE archived_at IS NULL ORDER BY item").all(),
      types: ["sign_in", "sign_out", "kit_out", "kit_in", "kit_denied", "box_open", "box_denied", "tap_denied", "admin_action", "import_applied", "export"],
    };
  }
}

const ACTION_WORDS: Record<string, string> = {
  students_disabled: "disabled all students",
  students_enabled: "re-enabled students",
  fob_lost: "marked a fob lost",
  fob_revoked: "revoked a fob",
  fob_enrolled: "enrolled a fob",
  day_pass_issued: "issued a day pass",
  show_mode_on: "turned show mode on",
  show_mode_off: "turned show mode off",
  force_return: "force-returned",
  end_of_session: "ended the session",
  backup: "made a backup",
  restart_hub: "restarted the hub",
  reboot_pi: "rebooted the Pi",
};

/** One plain line per event for the log screen. */
export function describe(
  type: string,
  who: string | null,
  box: string | null,
  kit: string | null,
  d: Record<string, unknown>,
  fobName: (uid: unknown) => string | null,
): string {
  const w = who ?? "Someone";
  const reason = typeof d.reason === "string" ? `: ${d.reason}` : "";
  switch (type) {
    case "sign_in":
      return `${w} signed in`;
    case "sign_out":
      return d.auto ? `${w} signed out automatically (03:00)` : `${w} signed out`;
    case "kit_out":
      return `${w} took ${kit}`;
    case "kit_in":
      return d.forced ? `${kit} returned for ${w} by ${fobName(d.by) ?? "an admin"}` : `${w} returned ${kit}`;
    case "kit_denied":
      return `${w} couldn't ${d.action === "return" ? "return" : "take"} ${kit}${reason}`;
    case "box_open":
      return `${box} opened for ${w}${d.via === "take" || d.via === "return" ? ` (${d.via} kit)` : ""}`;
    case "box_denied":
      return `${w} couldn't open ${box}${reason}`;
    case "tap_denied":
      return `Panel refused ${w}${reason}`;
    case "admin_action": {
      const what = ACTION_WORDS[d.action as string] ?? String(d.action);
      const conf = d.confirmedBy && d.confirmedBy !== d.openedBy ? ` (confirmed by ${fobName(d.confirmedBy)})` : "";
      return `${w} ${what}${kit ? ` ${kit}` : ""}${conf}`;
    }
    case "import_applied":
      return `${w} applied a workbook`;
    case "export":
      return "Workbook exported";
    default:
      return `${type} ${w}`;
  }
}

