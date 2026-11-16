// Box simulator: one or more pretend lock boxes that speak the docs/mqtt.md contract with the
// firmware's own rules (core.ts, a port of firmware/lib/box_core, checked against the same test
// vectors). It's Daniel's test tool and the reference behaviour for the real box.
//
//   bun run sim.ts --boxes BOX-01,BOX-02 [--url mqtt://127.0.0.1:1883] [--password-file pw.txt]
//
// Then type commands (help for the list): tap BOX-01 04A1B2C3D4E5F6, drop BOX-01, back BOX-01,
// door BOX-01 open, power BOX-01 off, ota BOX-01 broken, status, quit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import mqtt, { type MqttClient } from "mqtt";
import { Box, type Action, type Now } from "./core";

export const WILL = JSON.stringify({ lock: "open", why: "offline" });

export interface SimOptions {
  id: string;
  url: string;
  password?: string;
  fw?: string;
  doorSensor?: boolean;
  /** Length of a "minute" for the offline and OTA-verify timers. Tests shrink it. */
  minuteMs?: number;
  /** false = pretend NTP never answered. */
  clockSet?: boolean;
  /** How long "flashing" takes before the reboot. */
  flashMs?: number;
  log?: (msg: string) => void;
}

type Listener = (box: SimBox) => void;

export class SimBox {
  readonly id: string;
  private core = new Box();
  private client: MqttClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootAt = 0;
  private flash: string | null = null; // the fobs list "in flash": survives reboots and power cuts
  private fw: string;
  private netUp = true;
  private powered = false;
  private listeners: Listener[] = [];
  /** "ok": an update installs and boots. "broken": the new image never reaches MQTT, so it rolls back. */
  otaMode: "ok" | "broken" = "ok";
  private otaInFlight: { version: string; previous: string } | null = null;
  private brokenBoot = false;
  readonly log: (msg: string) => void;
  /** Every lock change, for tests and the console. */
  readonly lockHistory: { locked: boolean; why: string; at: number }[] = [];
  validMarked = 0;

  constructor(private readonly o: SimOptions) {
    this.id = o.id;
    this.fw = o.fw ?? "0.1.0";
    this.log = o.log ?? ((m) => console.log(`[${o.id}] ${m}`));
  }

  // ---- views
  get locked(): boolean {
    return this.core.locked;
  }
  get why(): string {
    return this.core.why;
  }
  get version(): string {
    return this.fw;
  }
  get show(): boolean {
    return this.core.show;
  }
  get hasList(): boolean {
    return this.core.listStored;
  }
  get hubReachable(): boolean {
    return this.core.hubReachable;
  }
  get connected(): boolean {
    return this.client?.connected === true;
  }
  get isPowered(): boolean {
    return this.powered;
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private now(): Now {
    return { mono: performance.now() - this.bootAt, clockSet: this.o.clockSet ?? true, utc: Date.now() };
  }

  /** Power on: boot the rules from "flash", connect, start the timers. */
  start(boot: { otaPendingVerify?: boolean; rolledBackFrom?: string } = {}): void {
    this.powered = true;
    this.bootAt = performance.now();
    this.core = new Box();
    this.core.setIp("127.0.0.1");
    this.core.boot(this.now(), {
      fw: this.fw,
      doorSensor: this.o.doorSensor ?? true,
      storedFobs: this.flash,
      otaPendingVerify: boot.otaPendingVerify ?? false,
      rolledBackFrom: boot.rolledBackFrom ?? "",
      minuteMs: this.o.minuteMs,
    });
    this.apply();
    this.log(`booted firmware ${this.fw}${boot.otaPendingVerify ? " (new, waiting to reach the hub)" : ""}`);
    if (this.netUp && !this.brokenBoot) this.connect();
    this.timer = setInterval(() => {
      this.core.tick(this.now());
      this.apply();
    }, 50);
  }

  private connect(): void {
    if (this.client) return;
    const c = mqtt.connect(this.o.url, {
      clientId: this.id,
      username: this.id,
      password: this.o.password,
      clean: true,
      reconnectPeriod: 1000,
      connectTimeout: 3000,
      keepalive: 15,
      will: { topic: `box/${this.id}/state`, payload: Buffer.from(WILL), qos: 1, retain: true },
    });
    this.client = c;
    // Events from a client we've already dropped (unplugged, rebooted) must not reach the new boot.
    c.on("connect", () => {
      if (this.client !== c) return;
      this.wasUp = true;
      const subs = ["cmd", "mode", "fobs", "ota"].map((k) => `box/${this.id}/${k}`).concat("hub/status");
      c.subscribe(subs, { qos: 1 }, (err) => {
        if (this.client !== c) return;
        if (err) {
          this.log(`subscribe failed: ${err.message}`);
          return;
        }
        this.log("connected");
        this.core.broker(this.now(), true);
        this.apply();
      });
    });
    c.on("close", () => {
      if (this.client !== c) return;
      if (this.wasUp) this.log("disconnected");
      this.wasUp = false;
      this.core.broker(this.now(), false);
      this.apply();
    });
    c.on("error", (e) => this.log(`mqtt: ${e.message}`));
    c.on("message", (topic, payload) => {
      if (this.client !== c) return;
      const kind = topic === "hub/status" ? "hub" : topic.slice(`box/${this.id}/`.length);
      this.core.message(this.now(), kind, payload.toString("utf8"));
      this.apply();
    });
  }
  private wasUp = false;

  /** Drop the connection the way a pulled cable does (no clean disconnect: the broker sends the will). */
  private disconnect(): void {
    const c = this.client;
    this.client = null;
    if (!c) return;
    (c as unknown as { stream?: { destroy(): void } }).stream?.destroy();
    c.end(true);
    this.core.broker(this.now(), false);
    this.apply();
  }

  private apply(): void {
    for (let guard = 0; guard < 8; guard++) {
      const actions = this.core.take();
      if (!actions.length) return;
      for (const a of actions) this.do(a);
    }
  }

  private do(a: Action): void {
    switch (a.type) {
      case "set_lock":
        this.lockHistory.push({ locked: a.locked, why: this.core.why, at: Date.now() });
        this.log(a.locked ? "LOCKED" : `UNLOCKED (${this.core.why || "?"})`);
        for (const f of this.listeners) f(this);
        break;
      case "publish":
        if (this.client?.connected) this.client.publish(`box/${this.id}/${a.topic}`, a.payload, { qos: a.qos, retain: a.retain });
        if (a.topic === "state") for (const f of this.listeners) f(this);
        break;
      case "store_fobs":
        this.flash = a.payload;
        break;
      case "start_ota":
        void this.runOta(a);
        break;
      case "mark_valid":
        this.validMarked++;
        this.log(`firmware ${this.fw} marked valid`);
        break;
      case "rollback":
        this.log(`firmware ${this.fw} never reached the hub: rolling back`);
        this.reboot(this.otaInFlight?.previous ?? this.fw, { rolledBackFrom: this.fw });
        break;
    }
  }

  /** Download, check size and sha256, "flash", reboot. */
  private async runOta(a: Extract<Action, { type: "start_ota" }>): Promise<void> {
    this.log(`updating to ${a.version} from ${a.url}`);
    let why = "";
    try {
      const res = await fetch(a.url);
      if (res.status !== 200) why = `http_${res.status}`;
      else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length !== a.size) why = "size_mismatch";
        else if (createHash("sha256").update(bytes).digest("hex") !== a.sha256.toLowerCase()) why = "sha256_mismatch";
      }
    } catch {
      why = "http_-1";
    }
    if (!this.powered) return;
    this.core.otaResult(this.now(), !why, why);
    this.apply();
    if (why) {
      this.log(`update failed: ${why}`);
      return;
    }
    const previous = this.fw;
    this.otaInFlight = { version: a.version, previous };
    await Bun.sleep(this.o.flashMs ?? 300);
    this.brokenBoot = this.otaMode === "broken";
    this.reboot(a.version, { otaPendingVerify: true });
  }

  private reboot(fw: string, boot: { otaPendingVerify?: boolean; rolledBackFrom?: string }): void {
    this.powerOff(false);
    if (boot.rolledBackFrom) {
      this.brokenBoot = false;
      this.otaInFlight = null;
    }
    this.fw = fw;
    this.start(boot);
  }

  // ---- things a person (or a test) can do to a box

  tap(uid: string): void {
    if (!this.powered) return;
    this.log(`tap ${uid}`);
    this.core.tap(this.now(), uid);
    this.apply();
  }

  door(shut: boolean): void {
    if (!this.powered) return;
    this.core.door(this.now(), shut);
    this.apply();
  }

  /** Unplug the network cable. */
  dropNetwork(): void {
    this.netUp = false;
    this.disconnect();
    this.log("network unplugged");
  }

  /** Plug it back in. */
  restoreNetwork(): void {
    this.netUp = true;
    this.log("network back");
    if (this.powered && !this.brokenBoot) this.connect();
  }

  /** Power cut: the maglock loses power, so the box is open (fail open). */
  powerOff(say = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disconnect();
    this.powered = false;
    if (say) {
      this.log("POWER OFF (maglock unpowered = open)");
      for (const f of this.listeners) f(this);
    }
  }

  powerOn(): void {
    if (!this.powered) this.start();
  }

  stop(): void {
    this.powerOff(false);
  }

  /** Wait until pred() is true (tests). */
  async waitFor(pred: (b: SimBox) => boolean, ms = 5000, what = "condition"): Promise<void> {
    const end = Date.now() + ms;
    while (!pred(this)) {
      if (Date.now() > end) throw new Error(`${this.id}: timed out waiting for ${what} (locked=${this.locked}, why=${this.why}, fw=${this.fw})`);
      await Bun.sleep(20);
    }
  }

  status(): string {
    if (!this.powered) return `${this.id}: POWER OFF (open)`;
    return `${this.id}: ${this.locked ? "locked" : `open (${this.why})`}, fw ${this.fw}, ${this.connected ? "connected" : "not connected"}, hub ${this.hubReachable ? "reachable" : "unreachable"}, ${this.hasList ? "fob list stored" : "no fob list"}${this.show ? ", show mode" : ""}${this.core.updating ? ", updating" : ""}`;
  }
}

// ---------------------------------------------------------------- CLI

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = "true";
    }
  }
  return out;
}

const HELP = `commands:
  tap <BOX> <UID>          tap a fob at the box (e.g. tap BOX-01 04A1B2C3D4E5F6)
  door <BOX> open|shut     reed switch
  drop <BOX>|all           unplug the network cable
  back <BOX>|all           plug it back in
  power <BOX> off|on       power cut / power back
  ota <BOX> ok|broken      how the next update behaves (broken = rolls back)
  status                   every box
  quit`;

async function main(): Promise<void> {
  const a = args(Bun.argv.slice(2));
  if (!a.boxes || a.help) {
    console.log(`usage: bun run sim.ts --boxes BOX-01,BOX-02 [--url mqtt://127.0.0.1:1883] [--password <pw> | --password-file <file>]
                  [--fw 0.1.0] [--minute-ms 60000] [--no-door]

--password-file: one line per box, BOX-01=password (or a single password for all).
Passwords come from pi/mqtt-add-box.sh on the Pi; a local dev broker can allow anonymous logins.

${HELP}`);
    process.exit(a.help ? 0 : 1);
  }
  const passwords = new Map<string, string>();
  if (a["password-file"]) {
    const text = readFileSync(a["password-file"], "utf8").trim();
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+)=(.*)$/.exec(line.trim());
      if (m) passwords.set(m[1]!, m[2]!);
      else if (line.trim()) passwords.set("*", line.trim());
    }
  }
  const ids = a.boxes.split(",").map((s) => s.trim()).filter(Boolean);
  const sims = new Map<string, SimBox>();
  for (const id of ids) {
    const s = new SimBox({
      id,
      url: a.url ?? "mqtt://127.0.0.1:1883",
      password: passwords.get(id) ?? passwords.get("*") ?? a.password,
      fw: a.fw,
      minuteMs: a["minute-ms"] ? Number(a["minute-ms"]) : undefined,
      doorSensor: a["no-door"] !== "true",
    });
    sims.set(id, s);
    s.start();
    s.door(true);
  }
  console.log(`${ids.length} simulated box${ids.length === 1 ? "" : "es"}. Type help for commands.`);
  const pick = (id: string | undefined): SimBox[] => {
    if (id === "all") return [...sims.values()];
    const s = id ? sims.get(id) : undefined;
    if (!s) console.log(`no box ${id ?? ""} (have ${ids.join(", ")})`);
    return s ? [s] : [];
  };
  for await (const line of console) {
    const [cmd, id, arg] = line.trim().split(/\s+/);
    if (!cmd) continue;
    if (cmd === "quit" || cmd === "exit") break;
    else if (cmd === "help") console.log(HELP);
    else if (cmd === "status") for (const s of sims.values()) console.log(s.status());
    else if (cmd === "tap" && arg) pick(id).forEach((s) => s.tap(arg));
    else if (cmd === "door" && (arg === "open" || arg === "shut")) pick(id).forEach((s) => s.door(arg === "shut"));
    else if (cmd === "drop") pick(id).forEach((s) => s.dropNetwork());
    else if (cmd === "back") pick(id).forEach((s) => s.restoreNetwork());
    else if (cmd === "power" && arg === "off") pick(id).forEach((s) => s.powerOff());
    else if (cmd === "power" && arg === "on") pick(id).forEach((s) => s.powerOn());
    else if (cmd === "ota" && (arg === "ok" || arg === "broken")) pick(id).forEach((s) => (s.otaMode = arg));
    else console.log("?? (type help)");
  }
  for (const s of sims.values()) s.stop();
  process.exit(0);
}

if (import.meta.main) await main();
