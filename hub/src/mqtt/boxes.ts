// Hub side of the box topics (docs/mqtt.md): commands, show mode, cached allowlists out;
// state and heartbeats in.
import type { Database } from "bun:sqlite";
import { decideBoxOpen } from "../access";
import { accessSettings, allBoxes, allFobs, getPerson, type BoxRow } from "../data";
import type { Bus } from "./bus";

export const OPEN_SECONDS = 8; // how long a box stays unlocked after an open command
export const COMMAND_TTL_MS = 15_000; // a box ignores a command older than this
export const OFFLINE_AFTER_MS = 90_000; // three missed 30 s heartbeats

export type BoxStatus = "locked" | "open" | "offline" | "never_seen";

const ID_RE = /^box\/([^/]+)\/(state|heartbeat)$/;

export class BoxLink {
  private lastAllowlist = new Map<string, string>();
  private readonly changeFns: (() => void)[] = [];

  constructor(
    private readonly db: Database,
    private readonly bus: Bus,
    private readonly now: () => Date = () => new Date(),
    private readonly timezone = "Europe/London",
  ) {
    bus.onMessage((t, p) => this.onMessage(t, p));
    bus.onConnect(() => this.publishRetained(true));
  }

  connected(): boolean {
    return this.bus.connected();
  }

  /** Fires when a box reports state or comes back, so the panel overview can refresh. */
  onChange(fn: () => void): void {
    this.changeFns.push(fn);
  }

  /** Send open / lock. False = broker not connected (nothing sent, nothing queued). */
  command(boxId: string, cmd: "open" | "lock", ref: number | null): boolean {
    const t = this.now();
    const payload: Record<string, unknown> = {
      cmd,
      ts: t.toISOString(),
      expires: new Date(t.getTime() + COMMAND_TTL_MS).toISOString(),
      ref,
    };
    if (cmd === "open") payload.seconds = OPEN_SECONDS;
    return this.bus.publish(`box/${boxId}/cmd`, JSON.stringify(payload), { qos: 1, retain: false });
  }

  /** Retained show-mode flag, one per box. */
  publishMode(): void {
    const show = accessSettings(this.db).showMode === true;
    const ts = this.now().toISOString();
    for (const b of allBoxes(this.db)) this.bus.publish(`box/${b.box_id}/mode`, JSON.stringify({ show, ts }), { retain: true });
  }

  /**
   * Retained cached allowlist per box: the fobs that would open it right now under the normal
   * rules (show mode aside). Day passes carry `until` so a box running on its cache drops them
   * at the end of the day by its own clock. Only republished when the list changes, unless forced.
   */
  publishAllowlists(force = false): void {
    const now = this.now();
    const settings = { ...accessSettings(this.db), showMode: false };
    const fobs = allFobs(this.db).filter((f) => f.status === "Active");
    const people = new Map(fobs.map((f) => [f.person_id, getPerson(this.db, f.person_id)]));
    for (const box of allBoxes(this.db)) {
      const list = fobs
        .filter((f) => decideBoxOpen({ fob: f, person: people.get(f.person_id) ?? null, box, settings, now, timezone: this.timezone }).allow)
        .map((f) => (f.role === "Day pass" ? { uid: f.fob_uid, until: f.issued } : { uid: f.fob_uid }));
      const body = { v: 1, offline_unlock_min: box.offline_unlock_min, fobs: list };
      const key = JSON.stringify(body);
      if (!force && this.lastAllowlist.get(box.box_id) === key) continue;
      if (this.bus.publish(`box/${box.box_id}/fobs`, JSON.stringify({ ...body, ts: now.toISOString() }), { retain: true })) {
        this.lastAllowlist.set(box.box_id, key);
      }
    }
  }

  /** Everything retained: on (re)connect, and after any change to fobs, people, boxes or settings. */
  publishRetained(force = false): void {
    this.publishMode();
    this.publishAllowlists(force);
  }

  status(box: Pick<BoxRow, "last_seen" | "lock_state">): BoxStatus {
    if (!box.last_seen) return "never_seen";
    if (this.now().getTime() - Date.parse(box.last_seen) > OFFLINE_AFTER_MS) return "offline";
    return box.lock_state === "open" ? "open" : "locked";
  }

  private onMessage(topic: string, payload: string): void {
    const m = ID_RE.exec(topic);
    if (!m) return;
    const [, boxId, kind] = m as unknown as [string, string, string];
    const known = this.db.query("SELECT 1 FROM boxes WHERE box_id = ? AND archived_at IS NULL").get(boxId);
    if (!known) return; // a box that isn't in the workbook: ignore
    const ts = this.now().toISOString();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // malformed: ignore rather than crash
    }
    if (kind === "heartbeat") {
      this.db.query("UPDATE boxes SET last_seen = ? WHERE box_id = ?").run(ts, boxId);
    } else {
      const lock = body.lock === "open" ? "open" : body.lock === "locked" ? "locked" : null;
      if (!lock) return;
      this.db.query("UPDATE boxes SET lock_state = ?, lock_state_at = ?, last_seen = ? WHERE box_id = ?").run(lock, ts, ts, boxId);
    }
    for (const f of this.changeFns) f();
  }

  /** Periodic tick: day passes expire at midnight, so recompute (sends only what changed). */
  tick(): void {
    this.publishAllowlists(false);
  }
}
