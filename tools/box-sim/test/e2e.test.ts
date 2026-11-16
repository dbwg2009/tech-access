// End to end: a real Mosquitto (with the Pi's own ACL file and per-box passwords), the real hub
// (buildHub + MqttJsBus + HTTP) and two simulated boxes. Covers the weeks 5-6 definition of done:
// panel open -> unlock -> lock again; tap at the box -> event; show mode; End of session; OTA
// (and a broken update that rolls back); hub down -> offline unlock; hub back -> locks again.
//
// Needs `mosquitto` and `mosquitto_passwd` (set MOSQUITTO_DIR if they aren't on PATH). Without
// them the test is skipped and says so, like the hub's pty test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync, type Subprocess } from "bun";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../../../hub/src/config";
import { getBox } from "../../../hub/src/data";
import { buildHub } from "../../../hub/src/hub";
import { MqttJsBus } from "../../../hub/src/mqtt/bus";
import { FakeReader } from "../../../hub/src/reader/fake";
import { seedDb, UID } from "../../../hub/test/seed";
import { SimBox } from "../sim";

const REPO = resolve(import.meta.dir, "../../..");
const MINUTE_MS = 100; // the boxes' "minute": offline unlock after 5 of them = 0.5 s

function findTool(name: string): string | null {
  const dirs = [process.env.MOSQUITTO_DIR, "/usr/sbin", "/usr/bin", "/usr/local/sbin", "/usr/local/bin", "/opt/homebrew/sbin", "/opt/homebrew/bin", "C:\\Program Files\\mosquitto"];
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const d of dirs) {
    if (!d) continue;
    for (const f of [join(d, name), join(d, `${name}.exe`)]) if (existsSync(f)) return f;
  }
  return null;
}

const MOSQUITTO = findTool("mosquitto");
const PASSWD = findTool("mosquitto_passwd");
const haveBroker = !!(MOSQUITTO && PASSWD);
if (!haveBroker) console.warn("e2e: mosquitto / mosquitto_passwd not found, skipping (install Mosquitto or set MOSQUITTO_DIR)");

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** A fake ESP32 app image: first byte 0xE9. */
function image(seed: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(8192);
  for (let i = 0; i < b.length; i++) b[i] = (i * 13 + seed) & 0xff;
  b[0] = 0xe9;
  return b;
}

describe.skipIf(!haveBroker)("end to end: hub + Mosquitto + two simulated boxes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ta-e2e-"));
  const pw = { hub: "hub-secret-1", "BOX-01": "box01-secret", "BOX-02": "box02-secret" } as Record<string, string>;
  let broker: Subprocess;
  let mqttPort = 0;
  let httpPort = 0;
  const db = seedDb();
  db.query("INSERT INTO boxes (box_id, name, type, required_level, network, offline_unlock_min) VALUES ('BOX-02', 'Cable box', 'Fixed (PoE)', 1, 'Ethernet', 5)").run();
  const reader = new FakeReader();
  let bus: MqttJsBus;
  let hub: ReturnType<typeof buildHub>;
  let server: ReturnType<typeof Bun.serve>;
  let box1: SimBox;
  let box2: SimBox;
  const logs: string[] = [];

  const req = async (method: string, path: string, b?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, b === undefined ? { method } : { method, body: JSON.stringify(b), headers: { "Content-Type": "application/json" } });
    return (await res.json()) as any;
  };
  const sid = () => hub.panel.current()?.id;
  const events = (type: string) =>
    db.query<{ box_id: string; fob_uid: string; detail: string }, [string]>("SELECT box_id, fob_uid, detail FROM events WHERE type = ? ORDER BY id").all(type).map((e) => ({ ...e, detail: JSON.parse(e.detail) }));

  function startHub(): void {
    bus = new MqttJsBus({ url: `mqtt://127.0.0.1:${mqttPort}`, username: "hub", password: pw.hub, clientId: `hub-e2e-${Date.now()}`, log: (m) => logs.push(m) });
    hub = buildHub({
      db,
      config: { ...DEFAULTS, dbPath: ":memory:", fakeReader: true, firmwareDir: join(dir, "firmware"), firmwareUrl: `http://127.0.0.1:${httpPort}` },
      bus,
      reader,
      system: () => ({ tempC: 40, diskFreeMB: 1000, diskTotalMB: 2000 }),
      run: () => {},
      backupDir: null,
    });
    hub.start();
    server?.stop(true);
    server = Bun.serve({ port: httpPort, hostname: "127.0.0.1", fetch: (r, s) => hub.app.fetch(r, s) });
  }

  beforeAll(async () => {
    mqttPort = await freePort();
    httpPort = await freePort();
    const passwd = join(dir, "passwd");
    writeFileSync(passwd, "");
    for (const [u, p] of Object.entries(pw)) {
      const r = spawnSync([PASSWD!, "-b", passwd, u, p]);
      if (r.exitCode !== 0) throw new Error(`mosquitto_passwd failed: ${r.stderr.toString()}`);
    }
    // The Pi's real ACL: boxes only see box/<own id>/# and may read hub/status.
    const acl = join(dir, "acl");
    writeFileSync(acl, readFileSync(join(REPO, "pi/mosquitto/tech-access.acl"), "utf8"));
    const conf = join(dir, "mosquitto.conf");
    chmodSync(passwd, 0o600);
    chmodSync(acl, 0o600);
    const lines = [`listener ${mqttPort} 127.0.0.1`, "allow_anonymous false", `password_file ${passwd}`, `acl_file ${acl}`, "persistence false", "log_dest none"];
    // Started as root (e.g. in a container), Mosquitto would switch to the "mosquitto" user and
    // couldn't read these temp files. Stay as whoever runs the test.
    if (process.getuid?.() === 0) lines.push("user root");
    writeFileSync(conf, lines.join("\n") + "\n");
    broker = Bun.spawn([MOSQUITTO!, "-c", conf], { stdout: "ignore", stderr: "pipe" });
    // Wait until Mosquitto accepts connections.
    const end = Date.now() + 5000;
    for (;;) {
      const ok = await Bun.connect({ hostname: "127.0.0.1", port: mqttPort, socket: { data() {} } }).then(
        (sock) => (sock.end(), true),
        () => false,
      );
      if (ok) break;
      if (Date.now() > end) throw new Error(`mosquitto didn't start: ${await new Response(broker.stderr as ReadableStream).text()}`);
      await Bun.sleep(50);
    }
    reader.start();
    startHub();
    await until(() => bus.connected(), 5000, "hub connected to Mosquitto");
    const mk = (id: string) => new SimBox({ id, url: `mqtt://127.0.0.1:${mqttPort}`, password: pw[id], minuteMs: MINUTE_MS, flashMs: 100, log: (m) => logs.push(`[${id}] ${m}`) });
    box1 = mk("BOX-01");
    box2 = mk("BOX-02");
    box1.start();
    box2.start();
  }, 15_000);

  afterAll(async () => {
    box1?.stop();
    box2?.stop();
    hub?.stop();
    server?.stop(true);
    await bus?.close();
    broker?.kill();
    await reader.stop();
  });

  test("boxes connect, get their fob lists and lock; the hub sees their firmware", async () => {
    for (const b of [box1, box2]) {
      await b.waitFor((x) => x.connected && x.hasList && x.hubReachable && x.locked, 5000, "connected, list stored, locked");
    }
    await until(() => getBox(db, "BOX-01")?.fw === "0.1.0" && getBox(db, "BOX-02")?.fw === "0.1.0", 3000, "fw stored");
    const api = await req("GET", "/api/boxes");
    expect(api.boxes.find((b: any) => b.box_id === "BOX-01")).toMatchObject({ status: "locked", fw: "0.1.0" });
  });

  test("the ACL keeps a box to its own topics", async () => {
    // BOX-01 trying to publish as BOX-02 is dropped by the broker, so the hub never logs it.
    const mqtt = (await import("mqtt")).default;
    const rogue = await mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, { clientId: "rogue", username: "BOX-01", password: pw["BOX-01"] });
    await rogue.publishAsync("box/BOX-02/tap", JSON.stringify({ uid: UID.ada, result: "allow", reason: "listed", source: "cached", ts: new Date().toISOString() }), { qos: 1 });
    await Bun.sleep(300);
    await rogue.endAsync();
    expect(events("box_open").filter((e) => e.box_id === "BOX-02")).toHaveLength(0);
  });

  test("panel open -> box unlocks -> locks again after 8 s", async () => {
    reader.tap(UID.ada);
    const r = await req("POST", "/api/panel/open", { session: sid(), boxId: "BOX-01" });
    expect(r.ok).toBe(true);
    await box1.waitFor((b) => !b.locked && b.why === "cmd", 3000, "unlocked by cmd");
    await until(() => getBox(db, "BOX-01")?.lock_state === "open", 2000, "hub sees open");
    await box1.waitFor((b) => b.locked, 10_000, "locked again");
    await until(() => getBox(db, "BOX-01")?.lock_state === "locked", 2000, "hub sees locked");
    expect(box2.locked).toBe(true);
    await req("POST", "/api/panel/close", { session: sid() });
  }, 20_000);

  test("taps at the box are checked locally and logged by the hub", async () => {
    box1.tap(UID.ada); // Level 2 on a Level 2 box: on the list
    expect(box1.locked).toBe(false); // straight away, no round trip
    box1.tap(UID.cal); // Level 1: not on BOX-01's list
    await until(() => events("box_denied").some((e) => e.fob_uid === UID.cal && e.detail.via === "box"), 3000, "box_denied logged");
    const open = events("box_open").filter((e) => e.detail.via === "box");
    expect(open.at(-1)).toMatchObject({ box_id: "BOX-01", fob_uid: UID.ada, detail: { reason: "listed", source: "cached" } });
    const api = await req("GET", "/api/boxes");
    expect(api.boxes.find((b: any) => b.box_id === "BOX-01").lastTap).toMatchObject({ who: "Cal", result: "deny", reason: "not_listed" });
    await box1.waitFor((b) => b.locked, 10_000, "locked after the tap");
  }, 20_000);

  test("show mode unlocks every box; End of session locks them all and turns it off", async () => {
    reader.tap(UID.ritterAdmin);
    const s = sid();
    expect((await req("POST", "/api/admin/show-mode", { session: s, on: true })).confirm).toBe("tap");
    reader.tap(UID.danielAdmin);
    await box1.waitFor((b) => !b.locked && b.why === "show", 3000, "show");
    await box2.waitFor((b) => !b.locked && b.why === "show", 3000, "show");
    const r = await req("POST", "/api/admin/end-of-session", { session: s });
    expect(r.ok).toBe(true);
    await box1.waitFor((b) => b.locked && !b.show, 3000, "locked after End of session");
    await box2.waitFor((b) => b.locked && !b.show, 3000, "locked after End of session");
    await req("POST", "/api/admin/close", { session: s });
  });

  test("OTA: upload, update both (tap to confirm); boxes download, check, reboot and report", async () => {
    reader.tap(UID.ritterAdmin);
    const s = sid()!;
    const form = new FormData();
    form.set("session", s);
    form.set("version", "0.2.0");
    form.set("file", new File([image(2)], "firmware.bin"));
    const up = (await (await fetch(`http://127.0.0.1:${httpPort}/api/admin/firmware`, { method: "POST", body: form })).json()) as any;
    expect(up.ok).toBe(true);
    expect((await req("POST", "/api/admin/firmware/update", { session: s, boxes: "all" })).confirm).toBe("tap");
    reader.tap(UID.danielAdmin);
    await box1.waitFor((b) => b.version === "0.2.0" && b.connected && b.validMarked > 0, 8000, "box1 on 0.2.0");
    await box2.waitFor((b) => b.version === "0.2.0" && b.connected && b.validMarked > 0, 8000, "box2 on 0.2.0");
    await until(() => getBox(db, "BOX-01")?.fw === "0.2.0" && getBox(db, "BOX-02")?.ota_status === "updated", 3000, "hub sees 0.2.0");
    const stages = events("software_update").filter((e) => e.box_id === "BOX-01").map((e) => e.detail.stage);
    expect(stages).toEqual(["requested", "updating", "rebooting", "updated"]);
    // Boxes came back locked, with their lists from flash.
    expect(box1.locked && box2.locked).toBe(true);
    await req("POST", "/api/admin/close", { session: s });
  }, 20_000);

  test("a box refuses an update while unlocked, and says why", async () => {
    reader.tap(UID.ritterAdmin);
    const s = sid()!;
    const form = new FormData();
    form.set("session", s);
    form.set("version", "0.3.0");
    form.set("file", new File([image(3)], "firmware.bin"));
    await fetch(`http://127.0.0.1:${httpPort}/api/admin/firmware`, { method: "POST", body: form });
    box2.tap(UID.cal); // Level 1 on a Level 1 box: opens
    expect(box2.locked).toBe(false);
    await Bun.sleep(3100); // past the mid-tap window, still inside the 8 s
    await req("POST", "/api/admin/firmware/update", { session: s, boxes: ["BOX-02"], version: "0.3.0" });
    reader.tap(UID.danielAdmin);
    await until(() => getBox(db, "BOX-02")?.ota_status === "refused", 3000, "refused");
    expect(getBox(db, "BOX-02")).toMatchObject({ ota_why: "unlocked", fw: "0.2.0" });
    await box2.waitFor((b) => b.locked, 10_000, "locked again");
    await req("POST", "/api/admin/close", { session: s });
  }, 20_000);

  test("a broken update (new firmware never reaches the hub) rolls back and is reported", async () => {
    reader.tap(UID.ritterAdmin);
    const s = sid()!;
    box2.otaMode = "broken";
    await req("POST", "/api/admin/firmware/update", { session: s, boxes: ["BOX-02"], version: "0.3.0" });
    reader.tap(UID.danielAdmin);
    await until(() => getBox(db, "BOX-02")?.ota_status === "rolled_back", 8000, "rolled back");
    expect(box2.version).toBe("0.2.0");
    expect(getBox(db, "BOX-02")).toMatchObject({ fw: "0.2.0", ota_version: "0.3.0" });
    await box2.waitFor((b) => b.locked && b.connected, 3000, "back and locked");
    box2.otaMode = "ok";
    await req("POST", "/api/admin/close", { session: s });
  }, 20_000);

  test("hub down -> boxes unlock after offline_unlock_min (why offline); hub back -> they lock again", async () => {
    await bus.crash(); // like a hub crash: no clean disconnect, the broker sends hub/status offline
    hub.stop();
    for (const b of [box1, box2]) expect(b.locked).toBe(true);
    await box1.waitFor((b) => !b.hubReachable, 3000, "box1 sees the hub gone");
    // Taps still work from the cached list before the timeout...
    box1.tap(UID.ada);
    expect(box1.locked).toBe(false);
    await box1.waitFor((b) => !b.locked && b.why === "offline", 3000, "offline unlock");
    await box2.waitFor((b) => !b.locked && b.why === "offline", 3000, "offline unlock");
    // Hub restarts (same database).
    startHub();
    await until(() => bus.connected(), 5000, "hub back");
    // (box1 may still be inside the 8 s from the tap above: that's right, it then locks.)
    await box1.waitFor((b) => b.locked && b.hubReachable, 10_000, "box1 locked again");
    await box2.waitFor((b) => b.locked && b.hubReachable, 5000, "box2 locked again");
    // The tap made while the hub was away arrives and is logged with source "offline".
    expect(events("box_open").filter((e) => e.detail.via === "box").at(-1)).toMatchObject({ fob_uid: UID.ada, detail: { source: "offline" } });
  }, 30_000);

  test("unplugging one box: the hub marks it open (last will); plugging it back in locks it", async () => {
    box2.dropNetwork();
    await until(() => getBox(db, "BOX-02")?.lock_state === "open", 3000, "will -> open");
    await box2.waitFor((b) => !b.locked && b.why === "offline", 3000, "box2 offline unlock");
    box2.restoreNetwork();
    await box2.waitFor((b) => b.locked && b.hubReachable, 5000, "box2 back");
    await until(() => getBox(db, "BOX-02")?.lock_state === "locked", 3000, "hub sees locked");
  }, 20_000);
});
