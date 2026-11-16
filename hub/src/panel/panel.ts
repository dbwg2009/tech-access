// The desk panel's brain: one in-memory session at a time, opened by a fob tap; crew actions;
// tap-to-confirm and "tap the new fob" capture for admin actions; screen wake / sleep; the 03:00
// automatic sign-out. Everything that happens is logged to `events`. Pure logic + DB: the HTTP
// routes (routes/panel.ts, routes/admin.ts) are thin wrappers.
import type { Database } from "bun:sqlite";
import { adminCheck, decideBoxOpen, decideCrewCard, decideKitTake, effectiveLevel, isAdmin, type Decision } from "../access";
import type { Config } from "../config";
import {
  accessSettings,
  allBoxes,
  allKit,
  getBox,
  getFob,
  getKit,
  getPerson,
  getSetting,
  holderKey,
  holderOf,
  isSignedIn,
  kitOut,
  logEvent,
  setSetting,
  signedIn,
  type BoxRow,
  type EventType,
} from "../data";
import type { BoxLink, BoxStatus } from "../mqtt/boxes";
import { firstName } from "../names";
import type { ReaderStatus } from "../reader/types";
import { readSystem, type SystemInfo } from "../system";
import { localDate } from "../time";
import { normaliseUid } from "../uid";
import type { Fob, Kit, Person } from "../workbook/schema";
import type { PanelStream } from "./stream";

export interface PanelTimings {
  crewMs: number; // crew card closes after this long without a touch (decision: 30 s)
  adminMs: number; // admin menu: 90 s
  confirmMs: number; // tap-to-confirm window: 20 s
  captureMs: number; // "tap the new fob" window
  screenOffMs: number; // screen off after this long with no touch or tap (decision: 5 min)
  autoSignOutHour: number; // local hour for the automatic sign-out (decision: 03:00)
}

export const DEFAULT_TIMINGS: PanelTimings = {
  crewMs: 30_000,
  adminMs: 90_000,
  confirmMs: 20_000,
  captureMs: 30_000,
  screenOffMs: 5 * 60_000,
  autoSignOutHour: 3,
};

export type Ok = { ok: true; message: string } & Record<string, unknown>;
export type No = { ok: false; reason: string; status?: number };
export type Result = Ok | No;
export const ok = (message: string, extra: Record<string, unknown> = {}): Ok => ({ ok: true, message, ...extra });
export const no = (reason: string, status?: number): No => (status ? { ok: false, reason, status } : { ok: false, reason });

export interface Pending {
  id: string;
  action: string;
  label: string; // what the overlay says, e.g. "Turn show mode on"
  params: Record<string, unknown>;
  expiresAt: number;
}

export interface Capture {
  purpose: "enrol" | "day_pass" | "add_fob";
  expiresAt: number;
  /** add_fob: the person the tapped fob goes to. */
  personId?: string;
}

export interface Session {
  id: string;
  kind: "crew" | "admin";
  fobUid: string;
  personId: string | null;
  openedAt: number;
  lastTouch: number;
  pending: Pending | null;
  capture: Capture | null;
  /** The admin editor is open: a fob tap finds that fob's owner instead of opening a new card. */
  find: boolean;
}

/** Runs a confirmed risky action. `confirmUid` is the admin fob that confirmed it. */
export type Confirmer = (s: Session, p: Pending, confirmUid: string) => Result;

export interface PanelDeps {
  db: Database;
  config: Config;
  boxes: BoxLink;
  stream: PanelStream;
  now?: () => Date;
  timings?: Partial<PanelTimings>;
  readerStatus?: () => (ReaderStatus & { kind: string }) | null;
  system?: () => SystemInfo;
  startedAt?: number;
}

/**
 * Decision 2026-11-16 (Daniel): only students and guests (day passes) sign in. Staff and hire techs
 * never do, whatever their fob (an admin fob of a student still can).
 */
export function canSignIn(person: Pick<Person, "type"> | null): boolean {
  return !person || person.type === "Student";
}

const BOX_STATUS_WORDS: Record<BoxStatus, string> = { locked: "locked", open: "open", offline: "offline", never_seen: "never seen" };

export class Panel {
  readonly db: Database;
  readonly config: Config;
  readonly boxes: BoxLink;
  readonly stream: PanelStream;
  readonly now: () => Date;
  readonly t: PanelTimings;
  readonly startedAt: number;
  private readonly readerStatus: () => (ReaderStatus & { kind: string }) | null;
  private readonly system: () => SystemInfo;
  private session: Session | null = null;
  private screenOn = true;
  private lastActivity: number;
  private readonly confirmers = new Map<string, Confirmer>();
  private captureFn: ((s: Session, uid: string, capture: Capture) => void) | null = null;
  private findFn: ((s: Session, uid: string) => void) | null = null;

  constructor(d: PanelDeps) {
    this.db = d.db;
    this.config = d.config;
    this.boxes = d.boxes;
    this.stream = d.stream;
    this.now = d.now ?? (() => new Date());
    this.t = { ...DEFAULT_TIMINGS, ...d.timings };
    this.readerStatus = d.readerStatus ?? (() => null);
    this.system = d.system ?? (() => readSystem(d.config.dbPath));
    this.startedAt = d.startedAt ?? Date.now();
    this.lastActivity = this.ms();
    this.boxes.onChange(() => this.overviewChanged());
  }

  ms(): number {
    return this.now().getTime();
  }

  iso(): string {
    return this.now().toISOString();
  }

  log(type: EventType, s: Session | null, extra: Omit<Parameters<typeof logEvent>[1], "type" | "ts"> = {}): number {
    return logEvent(this.db, { type, ts: this.iso(), person_id: s?.personId ?? null, fob_uid: s?.fobUid ?? null, ...extra });
  }

  // ---- taps ------------------------------------------------------------------------------------

  /** A fob was read (PN532 or fake). Wakes the screen, then confirms, captures or opens a card. */
  handleTap(rawUid: string): void {
    const u = normaliseUid(rawUid);
    if (!u.ok) return;
    const uid = u.value;
    this.markActivity();
    this.stream.publish("tap", { at: this.iso() });
    const s = this.session;
    const now = this.ms();
    if (s?.pending && now < s.pending.expiresAt) return this.confirmTap(s, s.pending, uid);
    if (s?.capture && now < s.capture.expiresAt && this.captureFn) {
      const fn = this.captureFn;
      const capture = s.capture;
      s.capture = null;
      s.lastTouch = now;
      return fn(s, uid, capture);
    }
    if (s?.kind === "admin" && s.find && this.findFn) {
      s.lastTouch = now;
      return this.findFn(s, uid);
    }
    this.openFor(uid);
  }

  private openFor(uid: string): void {
    const fob = getFob(this.db, uid);
    const person = getPerson(this.db, fob?.person_id ?? null);
    const settings = accessSettings(this.db);
    let d: Decision;
    let kind: Session["kind"];
    if (fob?.role === "Admin") {
      d = adminCheck(fob, person);
      kind = "admin";
    } else {
      d = decideCrewCard(fob, person, settings, this.now(), this.config.timezone);
      kind = "crew";
    }
    if (!d.allow) {
      this.close("replaced");
      logEvent(this.db, { type: "tap_denied", ts: this.iso(), fob_uid: uid, person_id: fob?.person_id ?? null, detail: { reason: d.reason } });
      this.stream.publish("denied", { reason: d.reason, name: person ? firstName(person.name) : null });
      return;
    }
    const now = this.ms();
    this.session = { id: crypto.randomUUID(), kind, fobUid: uid, personId: fob!.person_id, openedAt: now, lastTouch: now, pending: null, capture: null, find: false };
    this.publishSession();
  }

  // ---- sessions --------------------------------------------------------------------------------

  current(): Session | null {
    return this.session;
  }

  /** Look up an open session by ID and count the call as a touch. */
  get(id: unknown, kind?: Session["kind"]): Session | No {
    const s = this.session;
    if (!s || typeof id !== "string" || s.id !== id) return no("This card has closed. Tap your fob again.", 410);
    if (kind && s.kind !== kind) return no(kind === "admin" ? "Admin fob needed" : "Crew card needed", 403);
    s.lastTouch = this.ms();
    this.markActivity();
    return s;
  }

  close(why: "closed" | "timeout" | "replaced" = "closed"): void {
    if (!this.session) return;
    this.session = null;
    this.stream.publish("session", { session: null, why });
  }

  touch(id: unknown): Result {
    const s = this.get(id);
    return "ok" in s ? s : ok("ok");
  }

  publishSession(): void {
    this.stream.publish("session", { session: this.view() });
  }

  /** What the page shows for the open session. */
  view(): Record<string, unknown> | null {
    const s = this.session;
    if (!s) return null;
    const fob = getFob(this.db, s.fobUid);
    const person = getPerson(this.db, s.personId);
    const timeout = s.kind === "admin" ? this.t.adminMs : this.t.crewMs;
    const base = {
      id: s.id,
      kind: s.kind,
      name: person ? firstName(person.name) : "Guest",
      expiresAt: new Date(s.lastTouch + timeout).toISOString(),
      timeoutMs: timeout,
      pending: s.pending ? { id: s.pending.id, label: s.pending.label, expiresAt: new Date(s.pending.expiresAt).toISOString() } : null,
      capture: s.capture ? { purpose: s.capture.purpose, expiresAt: new Date(s.capture.expiresAt).toISOString() } : null,
    };
    const key = holderKey(s.personId, s.fobUid);
    return {
      ...base,
      guest: !person,
      level: fob ? effectiveLevel(fob, person) : null,
      specialism: person?.specialism ?? null,
      type: person?.type ?? "Guest",
      canSignIn: canSignIn(person),
      signedIn: isSignedIn(this.db, key),
      kitOut: this.kitOutFor(key).map((k) => ({ kit_id: k.kit_id, item: k.item })),
    };
  }

  private kitOutFor(key: string): Kit[] {
    const mine = new Set(kitOut(this.db).filter((k) => k.key === key).map((k) => k.kit_id));
    return allKit(this.db).filter((k) => mine.has(k.kit_id));
  }

  // ---- confirm and capture (used by the admin actions) ----------------------------------------

  registerConfirmer(action: string, fn: Confirmer): void {
    this.confirmers.set(action, fn);
  }

  setCaptureHandler(fn: (s: Session, uid: string, capture: Capture) => void): void {
    this.captureFn = fn;
  }

  setFindHandler(fn: (s: Session, uid: string) => void): void {
    this.findFn = fn;
  }

  /** A risky action: don't run it yet, wait for an admin fob tap within `confirmMs`. */
  requestConfirm(s: Session, action: string, label: string, params: Record<string, unknown> = {}): Result {
    if (!this.confirmers.has(action)) return no(`Unknown action ${action}`, 400);
    s.capture = null;
    s.pending = { id: crypto.randomUUID(), action, label, params, expiresAt: this.ms() + this.t.confirmMs };
    this.publishSession();
    return ok("Tap an admin fob to confirm", { confirm: "tap", confirmId: s.pending.id, expiresAt: new Date(s.pending.expiresAt).toISOString() });
  }

  cancelPending(s: Session): Result {
    s.pending = null;
    s.capture = null;
    this.publishSession();
    return ok("Cancelled");
  }

  startCapture(s: Session, purpose: Capture["purpose"], personId?: string): Result {
    s.pending = null;
    s.capture = { purpose, expiresAt: this.ms() + this.t.captureMs, ...(personId ? { personId } : {}) };
    this.publishSession();
    return ok(purpose === "day_pass" ? "Tap a spare fob" : "Tap the new fob");
  }

  private confirmTap(s: Session, p: Pending, uid: string): void {
    const fob = getFob(this.db, uid);
    const d = adminCheck(fob, getPerson(this.db, fob?.person_id ?? null));
    s.lastTouch = this.ms();
    if (!d.allow) {
      // Keep waiting: the right fob may still come within the window.
      this.stream.publish("confirm", { id: p.id, ok: false, reason: d.reason === "Not an admin fob" ? "That isn't an admin fob" : d.reason });
      return;
    }
    s.pending = null;
    const fn = this.confirmers.get(p.action)!;
    let r: Result;
    try {
      r = fn(s, p, uid);
    } catch (e) {
      r = no(`Failed: ${(e as Error).message}`);
    }
    this.stream.publish("confirm", { id: p.id, ...r });
    if (this.session === s) this.publishSession();
    this.overviewChanged();
  }

  // ---- crew actions ----------------------------------------------------------------------------

  /** Fob + person as they are now (a card may be open while an import changes things). */
  private who(s: Session): { fob: Fob | null; person: Person | null } {
    const fob = getFob(this.db, s.fobUid);
    return { fob, person: getPerson(this.db, fob?.person_id ?? null) };
  }

  private recheck(s: Session): No | null {
    const { fob, person } = this.who(s);
    const d = s.kind === "admin" ? adminCheck(fob, person) : decideCrewCard(fob, person, accessSettings(this.db), this.now(), this.config.timezone);
    return d.allow ? null : no(d.reason, 403);
  }

  signInOut(s: Session): Result {
    const bad = this.recheck(s);
    if (bad) return bad;
    if (!canSignIn(getPerson(this.db, s.personId))) return no("Staff and hire techs don't sign in");
    const key = holderKey(s.personId, s.fobUid);
    const type = isSignedIn(this.db, key) ? "sign_out" : "sign_in";
    this.log(type, s);
    this.publishSession();
    this.overviewChanged();
    return ok(type === "sign_in" ? "Signed in" : "Signed out", { signedIn: type === "sign_in" });
  }

  private boxDecision(s: Session, box: BoxRow): Decision {
    const { fob, person } = this.who(s);
    return decideBoxOpen({ fob, person, box, settings: accessSettings(this.db), now: this.now(), timezone: this.config.timezone });
  }

  /** Kit the person can take (in, and cleared) and kit they have out. */
  kitLists(s: Session): { take: Record<string, unknown>[]; mine: Record<string, unknown>[] } {
    const { fob, person } = this.who(s);
    const settings = accessSettings(this.db);
    const out = new Map(kitOut(this.db).map((k) => [k.kit_id, k]));
    const key = holderKey(s.personId, s.fobUid);
    const boxes = new Map(allBoxes(this.db).map((b) => [b.box_id, b]));
    const row = (k: Kit) => ({ kit_id: k.kit_id, item: k.item, category: k.category, box: k.box_id ? (boxes.get(k.box_id)?.name ?? k.box_id) : null, slot: k.slot });
    const take = allKit(this.db).filter(
      (k) => !out.has(k.kit_id) && decideKitTake({ fob, person, kit: k, settings, now: this.now(), timezone: this.config.timezone }).allow,
    );
    const mine = allKit(this.db).filter((k) => out.get(k.kit_id)?.key === key);
    return { take: take.map(row), mine: mine.map(row) };
  }

  /** Open a box on someone's behalf: log box_open, send the command, say what happened. */
  private sendOpen(s: Session | null, box: BoxRow, via: string, kitId: string | null = null): string {
    const status = this.boxes.status(box);
    const connected = this.boxes.connected();
    const ev = this.log("box_open", s, { box_id: box.box_id, kit_id: kitId, detail: { via, status, mqtt: connected } });
    const sent = this.boxes.command(box.box_id, "open", ev);
    if (!sent || status === "offline" || status === "never_seen") return `${box.name} is offline. Ask a staff member to open it`;
    return `${box.name} is opening`;
  }

  take(s: Session, kitId: unknown): Result {
    const bad = this.recheck(s);
    if (bad) return bad;
    const kit = typeof kitId === "string" ? getKit(this.db, kitId) : null;
    if (!kit) return no("That item isn't in the list any more", 404);
    const deny = (reason: string, detail: Record<string, unknown> = {}) => {
      this.log("kit_denied", s, { kit_id: kit.kit_id, box_id: kit.box_id, detail: { action: "take", reason, ...detail } });
      return no(reason);
    };
    const holder = holderOf(this.db, kit.kit_id);
    if (holder) return deny(`${kit.item} is already out with ${this.holderName(holder.person_id)}`);
    const { fob, person } = this.who(s);
    const d = decideKitTake({ fob, person, kit, settings: accessSettings(this.db), now: this.now(), timezone: this.config.timezone });
    if (!d.allow) return deny(d.reason);
    // Decision 2026-11-16: Take kit also opens the item's box; refuse if they can't open it.
    const box = kit.box_id ? getBox(this.db, kit.box_id) : null;
    if (box) {
      const bd = this.boxDecision(s, box);
      if (!bd.allow) return deny(`${box.name}: ${bd.reason}`, { box: bd.reason });
    }
    this.log("kit_out", s, { kit_id: kit.kit_id, box_id: kit.box_id });
    const msg = box ? this.sendOpen(s, box, "take", kit.kit_id) : null;
    this.publishSession();
    this.overviewChanged();
    return ok(msg ? `${kit.item} is yours. ${msg}` : `${kit.item} is yours`);
  }

  giveBack(s: Session, kitId: unknown): Result {
    const bad = this.recheck(s);
    if (bad) return bad;
    const kit = typeof kitId === "string" ? getKit(this.db, kitId) : null;
    if (!kit) return no("That item isn't in the list any more", 404);
    const holder = holderOf(this.db, kit.kit_id);
    if (!holder || holder.key !== holderKey(s.personId, s.fobUid)) {
      const reason = holder ? `${kit.item} is out with ${this.holderName(holder.person_id)}` : `${kit.item} isn't out`;
      this.log("kit_denied", s, { kit_id: kit.kit_id, box_id: kit.box_id, detail: { action: "return", reason } });
      return no(reason);
    }
    this.log("kit_in", s, { kit_id: kit.kit_id, box_id: kit.box_id });
    // Return opens the item's box too if they're cleared for it (same rule as Take).
    const box = kit.box_id ? getBox(this.db, kit.box_id) : null;
    let msg = "";
    if (box) msg = this.boxDecision(s, box).allow ? this.sendOpen(s, box, "return", kit.kit_id) : `Ask a staff member to open ${box.name}`;
    this.publishSession();
    this.overviewChanged();
    return ok(`${kit.item} returned${msg ? `. ${msg}` : ""}`);
  }

  boxList(s: Session): Record<string, unknown>[] {
    return allBoxes(this.db)
      .filter((b) => this.boxDecision(s, b).allow)
      .map((b) => ({ box_id: b.box_id, name: b.name, location: b.location, status: this.boxes.status(b) }));
  }

  openBox(s: Session, boxId: unknown): Result {
    const bad = this.recheck(s);
    if (bad) return bad;
    const box = typeof boxId === "string" ? getBox(this.db, boxId) : null;
    if (!box) return no("That box isn't in the list any more", 404);
    const d = this.boxDecision(s, box);
    if (!d.allow) {
      this.log("box_denied", s, { box_id: box.box_id, detail: { reason: d.reason, via: "panel" } });
      return no(d.reason);
    }
    const msg = this.sendOpen(s, box, "panel");
    this.overviewChanged();
    return ok(msg);
  }

  holderName(personId: string | null): string {
    return personId ? firstName(getPerson(this.db, personId)?.name ?? personId) : "a guest";
  }

  // ---- overview --------------------------------------------------------------------------------

  overview(): Record<string, unknown> {
    const kit = new Map(allKit(this.db).map((k) => [k.kit_id, k]));
    const settings = accessSettings(this.db);
    const sys = this.system();
    const reader = this.readerStatus();
    return {
      signedIn: signedIn(this.db).map((x) => ({ name: this.holderName(x.person_id), since: x.since })),
      boxes: allBoxes(this.db).map((b) => {
        const status = this.boxes.status(b);
        return { box_id: b.box_id, name: b.name, status, statusText: BOX_STATUS_WORDS[status], lastSeen: b.last_seen, door: b.door_state };
      }),
      kitOut: kitOut(this.db).map((o) => ({ kit_id: o.kit_id, item: kit.get(o.kit_id)?.item ?? o.kit_id, holder: this.holderName(o.person_id), since: o.since })),
      showMode: settings.showMode === true,
      studentsDisabled: settings.studentsDisabled,
      health: {
        tempC: sys.tempC,
        diskFreeMB: sys.diskFreeMB,
        diskTotalMB: sys.diskTotalMB,
        mqtt: this.boxes.connected(),
        reader: reader ? { state: reader.state, detail: reader.detail } : null,
      },
    };
  }

  overviewChanged(): void {
    this.stream.publish("overview", {});
  }

  // ---- screen ----------------------------------------------------------------------------------

  /** A touch on the page (with or without a session): keeps the screen on. */
  markActivity(): void {
    this.lastActivity = this.ms();
    if (!this.screenOn) {
      this.screenOn = true;
      this.stream.publish("screen", { on: true, why: "activity" });
    }
  }

  /** Reported by the kiosk (swayidle / screen helper) when the display actually goes on or off. */
  screenReport(on: boolean): void {
    if (on === this.screenOn) return;
    this.screenOn = on;
    if (on) this.lastActivity = this.ms();
    this.stream.publish("screen", { on, why: "kiosk" });
  }

  screen(): { on: boolean; lastActivity: string } {
    return { on: this.screenOn, lastActivity: new Date(this.lastActivity).toISOString() };
  }

  // ---- timers ----------------------------------------------------------------------------------

  /** Call about once a second. Closes idle sessions and expired confirms, sleeps the screen, 03:00 sign-out. */
  tick(): void {
    const now = this.ms();
    const s = this.session;
    if (s) {
      if (s.pending && now >= s.pending.expiresAt) {
        this.stream.publish("confirm", { id: s.pending.id, ok: false, reason: "Not confirmed in time", expired: true });
        s.pending = null;
        this.publishSession();
      }
      if (s.capture && now >= s.capture.expiresAt) {
        s.capture = null;
        this.stream.publish("captured", { ok: false, reason: "No fob tapped in time" });
        this.publishSession();
      }
      const limit = s.kind === "admin" ? this.t.adminMs : this.t.crewMs;
      if (!s.pending && !s.capture && now - s.lastTouch >= limit) this.close("timeout");
    }
    if (this.screenOn && !this.session && now - this.lastActivity >= this.t.screenOffMs) {
      this.screenOn = false;
      this.stream.publish("screen", { on: false, why: "idle" });
    }
    this.autoSignOut();
  }

  /** Decision 2026-11-16: everyone still signed in is signed out at 03:00 local time, once a day. */
  autoSignOut(): number {
    const now = this.now();
    const today = localDate(now, this.config.timezone);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: this.config.timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (hour < this.t.autoSignOutHour || getSetting(this.db, "auto_signout_date") === today) return 0;
    const who = signedIn(this.db);
    this.db.transaction(() => {
      for (const x of who) logEvent(this.db, { type: "sign_out", ts: now.toISOString(), person_id: x.person_id, fob_uid: x.fob_uid, detail: { auto: true } });
      setSetting(this.db, "auto_signout_date", today, now.toISOString());
    })();
    if (who.length) this.overviewChanged();
    return who.length;
  }

  // ---- hub status (admin) ----------------------------------------------------------------------

  isAdminFob(uid: string): boolean {
    return isAdmin(getFob(this.db, uid));
  }
}
