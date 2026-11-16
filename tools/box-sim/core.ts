// Box rules: a line-by-line port of firmware/lib/box_core (C++). Both run the same test
// vectors (firmware/test/vectors/*.json). If you change one, change the other and the vectors.
// Pure: no I/O, no clock. The simulator (sim.ts) feeds inputs and carries out actions.

export const TAP_OPEN_MS = 8000;
export const DEFAULT_CMD_OPEN_S = 8;
export const MAX_CMD_OPEN_S = 30;
export const HEARTBEAT_MS = 30000;
export const DEFAULT_OFFLINE_MIN = 5;
export const MID_TAP_MS = 3000;
export const OTA_VERIFY_MIN = 5;
export const TAP_QUEUE_MAX = 32;
export const MAX_FOBS = 400;

export interface Now {
  mono: number; // ms since boot
  clockSet: boolean;
  utc: number; // Unix ms, when clockSet
}

export type Action =
  | { type: "set_lock"; locked: boolean }
  | { type: "publish"; topic: string; payload: string; retain: boolean; qos: 0 | 1 }
  | { type: "store_fobs"; payload: string }
  | { type: "start_ota"; url: string; sha256: string; size: number; version: string }
  | { type: "mark_valid" }
  | { type: "rollback" };

export interface BootInfo {
  fw: string;
  doorSensor?: boolean;
  storedFobs?: string | null;
  otaPendingVerify?: boolean;
  rolledBackFrom?: string;
  /** Length of a "minute" for the offline and OTA-verify timers. Tests shrink it. Default 60000. */
  minuteMs?: number;
}

interface FobEntry {
  uid: string;
  until: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

/** Same rules as parseIsoUtc in C++: UTC only, optional fraction. */
export function parseIsoUtc(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
  const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
  return Date.UTC(y, mo - 1, d, h, mi, se, ms);
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function lastSundayOneUtc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0)); // last day of `month` (1-based)
  return Date.UTC(year, month - 1, last.getUTCDate() - last.getUTCDay(), 1);
}

/** Local date in Europe/London: BST from 01:00 UTC on the last Sunday of March to the last Sunday of October. */
export function londonDate(utc: number): string {
  const y = new Date(utc).getUTCFullYear();
  const bst = utc >= lastSundayOneUtc(y, 3) && utc < lastSundayOneUtc(y, 10);
  return new Date(utc + (bst ? 3_600_000 : 0)).toISOString().slice(0, 10);
}

export function normaliseUid(s: unknown): string | null {
  if (typeof s !== "string" || ![8, 14, 20].includes(s.length) || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return s.toUpperCase();
}

function parse(payload: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export class Box {
  private out: Action[] = [];
  private fw = "";
  private ip = "";
  private doorSensor = true;
  private minuteMs = 60000;

  private hasList = false;
  private fobs: FobEntry[] = [];
  private offlineMin = DEFAULT_OFFLINE_MIN;

  private brokerUp = false;
  private hubOnline = false;
  private offlineSince = 0;
  private offlineUnlocked = false;

  private showMode = false;
  private openUntil = 0;
  private openWhy = "";
  private isLocked = true;
  private lockKnown = false;
  private whyNow = "";
  private lockedWhy = "";
  private haveRef = false;
  private ref = 0;

  private doorShut = true;
  private doorKnown = false;

  private stateDirty = true;
  private lastHb = 0;
  private tapQueue: string[] = [];
  private lastTap = 0;
  private anyTap = false;

  private otaBusy = false;
  private otaPendingVerify = false;
  private bootMs = 0;
  private otaStatus = "";
  private otaWhy = "";
  private otaVersion = "";

  // ---- read-only views
  get locked(): boolean {
    return this.isLocked;
  }
  get why(): string {
    return this.whyNow;
  }
  get show(): boolean {
    return this.showMode;
  }
  get listStored(): boolean {
    return this.hasList;
  }
  get fobCount(): number {
    return this.fobs.length;
  }
  get hubReachable(): boolean {
    return this.brokerUp && this.hubOnline;
  }
  get updating(): boolean {
    return this.otaBusy;
  }
  get version(): string {
    return this.fw;
  }

  setIp(ip: string): void {
    this.ip = ip;
  }

  take(): Action[] {
    const a = this.out;
    this.out = [];
    return a;
  }

  boot(now: Now, info: BootInfo): void {
    Object.assign(this, new Box());
    this.fw = info.fw;
    this.doorSensor = info.doorSensor ?? true;
    this.minuteMs = info.minuteMs ?? 60000;
    this.otaPendingVerify = info.otaPendingVerify ?? false;
    this.bootMs = now.mono;
    this.offlineSince = now.mono;
    this.lastHb = now.mono;
    if (info.storedFobs != null) this.applyFobs(info.storedFobs);
    if (info.rolledBackFrom) {
      this.otaStatus = "rolled_back";
      this.otaWhy = "new firmware didn't reach the hub";
      this.otaVersion = info.rolledBackFrom;
    }
    this.evaluate(now, true);
  }

  tick(now: Now): void {
    if (this.otaPendingVerify && now.mono - this.bootMs >= OTA_VERIFY_MIN * this.minuteMs) {
      this.otaPendingVerify = false;
      this.out.push({ type: "rollback" });
      return;
    }
    this.evaluate(now);
    if (this.brokerUp && now.mono - this.lastHb >= HEARTBEAT_MS) this.publishHeartbeat(now);
  }

  private evaluate(now: Now, forceState = false): void {
    if (!this.hubReachable && !this.offlineUnlocked && now.mono - this.offlineSince >= this.offlineMin * this.minuteMs) {
      this.offlineUnlocked = true;
    }
    if (this.openUntil && now.mono >= this.openUntil) {
      this.openUntil = 0;
      this.openWhy = "";
    }
    let why = "";
    if (this.showMode) why = "show";
    else if (this.offlineUnlocked) why = "offline";
    else if (!this.hasList) why = "no_list";
    else if (this.openUntil) why = this.openWhy;
    const wantLocked = why === "";
    if (wantLocked) why = this.lockedWhy;
    else this.lockedWhy = "";

    if (!this.lockKnown || wantLocked !== this.isLocked) {
      this.out.push({ type: "set_lock", locked: wantLocked });
      this.isLocked = wantLocked;
      this.lockKnown = true;
      this.whyNow = why;
      this.stateDirty = true;
    } else if (why !== this.whyNow) {
      this.whyNow = why;
      this.stateDirty = true;
    }
    if (forceState) this.stateDirty = true;
    if (this.stateDirty && this.brokerUp) this.publishState(now);
  }

  private publish(topic: string, payload: string, retain: boolean, qos: 0 | 1): void {
    this.out.push({ type: "publish", topic, payload, retain, qos });
  }

  private publishState(now: Now): void {
    const doc: Record<string, unknown> = { lock: this.isLocked ? "locked" : "open" };
    if (this.whyNow) doc.why = this.whyNow;
    if (this.doorSensor && this.doorKnown) doc.door = this.doorShut ? "shut" : "open";
    doc.ts = now.clockSet ? isoUtc(now.utc) : null;
    if (this.haveRef) doc.ref = this.ref;
    doc.fw = this.fw;
    if (this.otaStatus) {
      doc.ota = this.otaStatus;
      if (this.otaVersion) doc.ota_version = this.otaVersion;
      if (this.otaWhy) doc.ota_why = this.otaWhy;
    }
    this.publish("state", JSON.stringify(doc), true, 1);
    this.stateDirty = false;
    this.haveRef = false;
    if (this.otaStatus !== "updating") {
      this.otaStatus = "";
      this.otaWhy = "";
      this.otaVersion = "";
    }
  }

  private publishHeartbeat(now: Now): void {
    const doc: Record<string, unknown> = {
      ts: now.clockSet ? isoUtc(now.utc) : null,
      fw: this.fw,
      uptime_s: Math.floor((now.mono - this.bootMs) / 1000),
    };
    if (this.ip) doc.ip = this.ip;
    this.publish("heartbeat", JSON.stringify(doc), false, 0);
    this.lastHb = now.mono;
    if (this.otaPendingVerify) {
      this.otaPendingVerify = false;
      this.out.push({ type: "mark_valid" });
      this.otaStatus = "updated";
      this.otaVersion = this.fw;
      this.publishState(now);
    }
  }

  private flushTaps(): void {
    for (const p of this.tapQueue) this.publish("tap", p, false, 1);
    this.tapQueue = [];
  }

  private setHubReachable(now: Now, before: boolean): void {
    const after = this.hubReachable;
    if (before && !after) this.offlineSince = now.mono;
    if (after) this.offlineUnlocked = false;
    if (after && !before) this.flushTaps(); // taps made while the hub was away
  }

  broker(now: Now, connected: boolean): void {
    const before = this.hubReachable;
    this.brokerUp = connected;
    if (!connected) this.hubOnline = false;
    this.setHubReachable(now, before);
    if (connected) {
      this.evaluate(now, true);
      this.publishHeartbeat(now);
    } else {
      this.evaluate(now);
    }
  }

  door(now: Now, shut: boolean): void {
    if (this.doorKnown && shut === this.doorShut) return;
    this.doorKnown = true;
    this.doorShut = shut;
    this.stateDirty = true;
    this.evaluate(now);
  }

  tap(now: Now, raw: string): void {
    const uid = normaliseUid(raw);
    if (!uid) return;
    this.lastTap = now.mono;
    this.anyTap = true;
    let result = "deny";
    let reason = "not_listed";
    if (this.showMode) [result, reason] = ["allow", "show"];
    else if (this.offlineUnlocked) [result, reason] = ["allow", "offline"];
    else if (!this.hasList) [result, reason] = ["allow", "no_list"];
    else {
      const f = this.fobs.find((x) => x.uid === uid);
      if (f) {
        if (!f.until) [result, reason] = ["allow", "listed"];
        else if (!now.clockSet) reason = "no_clock";
        else if (londonDate(now.utc) > f.until) reason = "day_pass_expired";
        else [result, reason] = ["allow", "listed"];
      }
      if (reason === "listed") {
        this.openUntil = now.mono + TAP_OPEN_MS;
        this.openWhy = "fob";
      }
    }
    const payload = JSON.stringify({
      uid,
      result,
      reason,
      source: this.hubReachable ? "cached" : "offline",
      ts: now.clockSet ? isoUtc(now.utc) : null,
      fw: this.fw,
    });
    // Only send when the hub is there to log it (a broker with no subscriber drops it).
    if (this.hubReachable) this.publish("tap", payload, false, 1);
    else {
      this.tapQueue.push(payload);
      while (this.tapQueue.length > TAP_QUEUE_MAX) this.tapQueue.shift();
    }
    this.evaluate(now);
  }

  message(now: Now, kind: string, payload: string): void {
    if (kind === "cmd") this.onCmd(now, payload);
    else if (kind === "mode") this.onMode(now, payload);
    else if (kind === "ota") this.onOta(now, payload);
    else if (kind === "fobs") {
      if (this.applyFobs(payload)) this.out.push({ type: "store_fobs", payload });
      this.evaluate(now);
    } else if (kind === "hub") {
      const doc = payload ? parse(payload) : null;
      const online = typeof doc?.online === "boolean" ? doc.online : false;
      const before = this.hubReachable;
      this.hubOnline = online && this.brokerUp;
      this.setHubReachable(now, before);
      this.evaluate(now);
    }
  }

  private applyFobs(payload: string): boolean {
    const doc = parse(payload);
    if (!doc || doc.v !== 1) return false;
    const arr = doc.fobs;
    if (!Array.isArray(arr) || arr.length > MAX_FOBS) return false;
    const list: FobEntry[] = [];
    for (const e of arr as Record<string, unknown>[]) {
      const uid = normaliseUid(e?.uid);
      if (!uid) continue;
      let until = "";
      if (e.until !== undefined && e.until !== null) {
        if (typeof e.until !== "string" || !DATE_RE.test(e.until)) continue;
        until = e.until;
      }
      list.push({ uid, until });
    }
    this.fobs = list;
    this.hasList = true;
    const m = doc.offline_unlock_min;
    this.offlineMin = isInt(m) && m >= 0 ? Math.min(m, 1440) : DEFAULT_OFFLINE_MIN;
    return true;
  }

  private onCmd(now: Now, payload: string): void {
    const doc = parse(payload);
    if (!doc || typeof doc.cmd !== "string") return;
    const cmd = doc.cmd;
    if (cmd !== "open" && cmd !== "lock") return;
    if (now.clockSet) {
      const exp = parseIsoUtc(doc.expires);
      if (exp === null || exp <= now.utc) return;
    }
    this.haveRef = isInt(doc.ref);
    this.ref = this.haveRef ? (doc.ref as number) : 0;
    if (cmd === "open") {
      let s = DEFAULT_CMD_OPEN_S;
      if (isInt(doc.seconds) && doc.seconds > 0) s = doc.seconds;
      if (s > MAX_CMD_OPEN_S) s = MAX_CMD_OPEN_S;
      this.openUntil = now.mono + s * 1000;
      this.openWhy = "cmd";
    } else {
      this.openUntil = 0;
      this.openWhy = "";
      this.lockedWhy = "cmd";
    }
    this.stateDirty = true;
    this.evaluate(now);
  }

  private onMode(now: Now, payload: string): void {
    let show = false;
    if (payload) {
      const doc = parse(payload);
      if (!doc || typeof doc.show !== "boolean") return;
      show = doc.show;
    }
    this.showMode = show;
    this.evaluate(now);
  }

  private otaRefuse(now: Now, why: string, version: string): void {
    if (this.otaBusy) return;
    this.otaStatus = "refused";
    this.otaWhy = why;
    this.otaVersion = version;
    this.stateDirty = true;
    this.evaluate(now);
  }

  private onOta(now: Now, payload: string): void {
    const doc = parse(payload);
    if (!doc) return this.otaRefuse(now, "bad_request", "");
    const version = typeof doc.version === "string" ? doc.version : "";
    const url = typeof doc.url === "string" ? doc.url : "";
    const sha = typeof doc.sha256 === "string" ? doc.sha256 : "";
    const size = isInt(doc.size) ? doc.size : 0;
    if (!version || !url.startsWith("http://") || !/^[0-9a-fA-F]{64}$/.test(sha) || size <= 0) return this.otaRefuse(now, "bad_request", version);
    if (this.otaBusy) return;
    if (now.clockSet) {
      const exp = parseIsoUtc(doc.expires);
      if (exp === null || exp <= now.utc) return this.otaRefuse(now, "expired", version);
    }
    if (version === this.fw) return this.otaRefuse(now, "already_running", version);
    if (this.showMode) return this.otaRefuse(now, "show_mode", version);
    if (!this.isLocked) return this.otaRefuse(now, "unlocked", version);
    if (this.anyTap && now.mono - this.lastTap < MID_TAP_MS) return this.otaRefuse(now, "mid_tap", version);
    this.out.push({ type: "start_ota", url, sha256: sha, size, version });
    this.otaBusy = true;
    this.otaStatus = "updating";
    this.otaWhy = "";
    this.otaVersion = version;
    this.stateDirty = true;
    this.evaluate(now);
  }

  otaResult(now: Now, ok: boolean, why: string): void {
    if (!this.otaBusy) return;
    this.otaBusy = false;
    this.otaStatus = ok ? "rebooting" : "failed";
    this.otaWhy = ok ? "" : why;
    this.stateDirty = true;
    this.evaluate(now);
  }
}

/** Same debounce as the desk reader and the firmware: new fob, or the same one back after 600 ms away. */
export class TapDebouncer {
  static readonly AWAY_MS = 600;
  private present = "";
  private lastSeen = 0;
  private have = false;

  poll(mono: number, uid: string): string | null {
    if (!uid) {
      if (this.have && mono - this.lastSeen >= TapDebouncer.AWAY_MS) this.have = false;
      return null;
    }
    const fresh = !this.have || uid !== this.present || mono - this.lastSeen >= TapDebouncer.AWAY_MS;
    this.present = uid;
    this.have = true;
    this.lastSeen = mono;
    return fresh ? uid : null;
  }
}
