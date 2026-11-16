// Hub side of the box topics (docs/mqtt.md): commands, show mode, cached allowlists, OTA and
// hub/status out; state, heartbeats and taps in.
import type { Database } from "bun:sqlite";
import { decideBoxOpen } from "../access";
import { accessSettings, allBoxes, allFobs, getFob, getPerson, logEvent, type BoxRow } from "../data";
import { normaliseUid } from "../uid";
import type { Bus } from "./bus";

export const OPEN_SECONDS = 8; // how long a box stays unlocked after an open command
export const COMMAND_TTL_MS = 15_000; // a box ignores a command older than this
export const OFFLINE_AFTER_MS = 90_000; // three missed 30 s heartbeats
export const HUB_STATUS_TOPIC = "hub/status";
export const HUB_ONLINE = JSON.stringify({ online: true });
export const HUB_OFFLINE = JSON.stringify({ online: false });

export type BoxStatus = "locked" | "open" | "offline" | "never_seen";

/** `ota` values a box reports in state (docs/mqtt.md). "requested" is the hub's own. */
export const OTA_STATUSES = ["updating", "refused", "failed", "rebooting", "updated", "rolled_back"] as const;
export type OtaStatus = (typeof OTA_STATUSES)[number] | "requested";

/** `reason` values in box/<id>/tap and the words the event log uses for them. */
export const TAP_REASON_WORDS: Record<string, string> = {
  listed: "allowed",
  not_listed: "not allowed on this box",
  day_pass_expired: "day pass has expired",
  no_clock: "the box's clock isn't set yet",
  no_list: "box had no fob list yet, so it was unlocked",
  show: "show mode, box was unlocked",
  offline: "hub unreachable, box was unlocked",
};

export interface OtaRequest {
  version: string;
  url: string;
  sha256: string;
  size: number;
  expires: string;
}

const TOPIC_RE = /^box\/([^/]+)\/(state|heartbeat|tap)$/;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,32}$/;

export class BoxLink {
  private lastAllowlist = new Map<string, string>();
  private readonly changeFns: (() => void)[] = [];
  /** QoS 1 can deliver a tap twice; remember the last few so each is logged once. */
  private readonly recentTaps: string[] = [];

  constructor(
    private readonly db: Database,
    private readonly bus: Bus,
    private readonly now: () => Date = () => new Date(),
    private readonly timezone = "Europe/London",
  ) {
    bus.onMessage((t, p) => this.onMessage(t, p));
    bus.onConnect(() => {
      // Boxes count the hub as reachable only while this says online (the broker's last will
      // for the hub says offline). Decision 2026-11-16.
      bus.publish(HUB_STATUS_TOPIC, HUB_ONLINE, { retain: true, qos: 1 });
      this.publishRetained(true);
    });
  }

  connected(): boolean {
    return this.bus.connected();
  }

  /** Fires when a box reports state, a tap or comes back, so the panel overview can refresh. */
  onChange(fn: () => void): void {
    this.changeFns.push(fn);
  }

  private changed(): void {
    for (const f of this.changeFns) f();
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

  /** Ask a box to update its firmware (box/<id>/ota, not retained). False = broker not connected. */
  ota(boxId: string, req: OtaRequest): boolean {
    return this.bus.publish(`box/${boxId}/ota`, JSON.stringify(req), { qos: 1, retain: false });
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

  /** Record that the hub asked a box to update (shown until the box answers). */
  markRequested(boxId: string, version: string): void {
    this.db
      .query("UPDATE boxes SET ota_status = 'requested', ota_version = ?, ota_why = NULL, ota_at = ? WHERE box_id = ?")
      .run(version, this.now().toISOString(), boxId);
    this.changed();
  }

  private onMessage(topic: string, payload: string): void {
    const m = TOPIC_RE.exec(topic);
    if (!m) return;
    const [, boxId, kind] = m as unknown as [string, string, string];
    const known = this.db.query("SELECT 1 FROM boxes WHERE box_id = ? AND archived_at IS NULL").get(boxId);
    if (!known) return; // a box that isn't in the workbook: ignore
    const ts = this.now().toISOString();
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      body = parsed as Record<string, unknown>;
    } catch {
      return; // malformed: ignore rather than crash
    }
    const fw = typeof body.fw === "string" && VERSION_RE.test(body.fw) ? body.fw : null;
    if (kind === "heartbeat") {
      this.db.query("UPDATE boxes SET last_seen = ?, fw = coalesce(?, fw) WHERE box_id = ?").run(ts, fw, boxId);
    } else if (kind === "state") {
      const lock = body.lock === "open" ? "open" : body.lock === "locked" ? "locked" : null;
      if (!lock) return;
      const door = body.door === "open" || body.door === "shut" ? body.door : null;
      // The last will ({"lock":"open","why":"offline"}) is the broker speaking for a box that
      // dropped off: it isn't a sign of life, so it doesn't touch last_seen.
      const alive = body.why !== "offline" || fw !== null;
      this.db
        .query(
          `UPDATE boxes SET lock_state = ?, lock_state_at = ?, last_seen = CASE WHEN ? THEN ? ELSE last_seen END,
             fw = coalesce(?, fw),
             door_state = coalesce(?, door_state), door_state_at = CASE WHEN ? IS NULL THEN door_state_at ELSE ? END
           WHERE box_id = ?`,
        )
        .run(lock, ts, alive ? 1 : 0, ts, fw, door, door, ts, boxId);
      this.onOtaReport(boxId, body, ts);
    } else {
      this.onTap(boxId, body, ts);
    }
    this.changed();
  }

  /** `ota` in state: store it, and log each new report once as a software_update event. */
  private onOtaReport(boxId: string, body: Record<string, unknown>, ts: string): void {
    const status = body.ota;
    if (typeof status !== "string" || !(OTA_STATUSES as readonly string[]).includes(status)) return;
    const version = typeof body.ota_version === "string" ? body.ota_version.slice(0, 32) : null;
    const why = typeof body.ota_why === "string" ? body.ota_why.slice(0, 120) : null;
    const at = typeof body.ts === "string" ? body.ts : ts;
    const prev = this.db
      .query<{ ota_status: string | null; ota_version: string | null; ota_why: string | null; ota_at: string | null }, [string]>(
        "SELECT ota_status, ota_version, ota_why, ota_at FROM boxes WHERE box_id = ?",
      )
      .get(boxId);
    // State is retained, so the same report comes again when the hub reconnects.
    if (prev && prev.ota_status === status && prev.ota_version === version && prev.ota_why === why && prev.ota_at === at) return;
    this.db.query("UPDATE boxes SET ota_status = ?, ota_version = ?, ota_why = ?, ota_at = ? WHERE box_id = ?").run(status, version, why, at, boxId);
    logEvent(this.db, {
      type: "software_update",
      ts,
      box_id: boxId,
      detail: { target: "box", stage: status, version, why, fw: typeof body.fw === "string" ? body.fw : null },
    });
  }

  /** box/<id>/tap: a fob checked by the box itself against its cached list. */
  private onTap(boxId: string, body: Record<string, unknown>, ts: string): void {
    const uid = normaliseUid(body.uid);
    if (!uid.ok || (body.result !== "allow" && body.result !== "deny")) return;
    const key = `${boxId}|${uid.value}|${String(body.ts)}|${String(body.result)}`;
    if (this.recentTaps.includes(key)) return;
    this.recentTaps.push(key);
    if (this.recentTaps.length > 64) this.recentTaps.shift();
    // A tap queued while the hub was away happened earlier: log it at the box's time if that's sane.
    const boxTs = typeof body.ts === "string" && !Number.isNaN(Date.parse(body.ts)) ? body.ts : null;
    const nowMs = this.now().getTime();
    const when = boxTs && Date.parse(boxTs) <= nowMs + 60_000 && Date.parse(boxTs) > nowMs - 7 * 86_400_000 ? new Date(Date.parse(boxTs)).toISOString() : ts;
    const fob = getFob(this.db, uid.value);
    logEvent(this.db, {
      type: body.result === "allow" ? "box_open" : "box_denied",
      ts: when,
      fob_uid: uid.value,
      person_id: fob?.person_id ?? null,
      box_id: boxId,
      detail: {
        via: "box",
        reason: typeof body.reason === "string" ? body.reason : null,
        source: body.source === "offline" ? "offline" : "cached",
        fw: typeof body.fw === "string" ? body.fw : null,
        boxTs,
        received: ts,
      },
    });
  }

  /** Latest tap at each box (box_open / box_denied with via "box"). */
  lastTaps(): Map<string, { ts: string; fob_uid: string | null; person_id: string | null; result: "allow" | "deny"; reason: string | null; source: string | null }> {
    const rows = this.db
      .query<{ box_id: string; ts: string; type: string; fob_uid: string | null; person_id: string | null; detail: string }, []>(
        `SELECT e.box_id, e.ts, e.type, e.fob_uid, e.person_id, e.detail FROM events e
         JOIN (SELECT box_id, max(id) AS id FROM events
               WHERE type IN ('box_open', 'box_denied') AND json_extract(detail, '$.via') = 'box' GROUP BY box_id) l ON l.id = e.id`,
      )
      .all();
    return new Map(
      rows.map((r) => {
        const d = JSON.parse(r.detail) as Record<string, unknown>;
        return [
          r.box_id,
          {
            ts: r.ts,
            fob_uid: r.fob_uid,
            person_id: r.person_id,
            result: r.type === "box_open" ? "allow" : "deny",
            reason: (d.reason as string) ?? null,
            source: (d.source as string) ?? null,
          },
        ] as const;
      }),
    );
  }

  /** Periodic tick: day passes expire at midnight, so recompute (sends only what changed). */
  tick(): void {
    this.publishAllowlists(false);
  }
}
