// Weeks 5-6, hub side: taps at a box, firmware / door / OTA reports, hub/status, GET /api/boxes,
// firmware upload, update requests (tap to confirm) and GET /fw/<file>.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getBox } from "../src/data";
import { compareVersions } from "../src/firmware";
import { describe as describeEvent } from "../src/panel/admin";
import { LOCAL, setup } from "./harness";
import { T0, UID } from "./seed";

type H = ReturnType<typeof setup>;
const admin = (h: H, uid: string = UID.ritterAdmin) => {
  h.tap(uid);
  return h.sid()!;
};
const confirmEvents = (h: H) => h.events.filter((e) => e.event === "confirm").map((e) => e.data as Record<string, unknown>);
const ip = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1 }) });

/** Something that looks like an ESP32 app image (first byte 0xE9). */
function image(n = 4096, seed = 1): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  b[0] = 0xe9;
  return b;
}

async function upload(h: H, session: string, bytes: Uint8Array<ArrayBuffer>, version: string) {
  const form = new FormData();
  form.set("session", session);
  form.set("version", version);
  form.set("file", new File([bytes], "firmware.bin"));
  const res = await h.hub.app.request("/api/admin/firmware", { method: "POST", body: form }, LOCAL);
  return { status: res.status, json: (await res.json()) as any };
}

/** A box that's online: a heartbeat (with its firmware) and a locked state. */
function online(h: H, id = "BOX-01", fw = "0.1.0") {
  h.bus.deliver(`box/${id}/heartbeat`, { ts: T0.toISOString(), fw, uptime_s: 10, ip: "10.102.40.101" });
  h.bus.deliver(`box/${id}/state`, { lock: "locked", ts: T0.toISOString(), fw });
}

describe("hub/status", () => {
  test("published retained online on every (re)connect", () => {
    const h = setup();
    h.bus.connect();
    const s = h.bus.sent.find((m) => m.topic === "hub/status");
    expect(s).toEqual({ topic: "hub/status", payload: JSON.stringify({ online: true }), retain: true });
  });
});

describe("taps at the box", () => {
  test("allow -> box_open and deny -> box_denied, with source, reason and the person", () => {
    const h = setup();
    h.bus.deliver("box/BOX-01/tap", { uid: UID.ada, result: "allow", reason: "listed", source: "cached", ts: T0.toISOString(), fw: "0.1.0" });
    h.bus.deliver("box/BOX-01/tap", { uid: UID.unknown, result: "deny", reason: "not_listed", source: "cached", ts: T0.toISOString(), fw: "0.1.0" });
    const open = h.log("box_open");
    const denied = h.log("box_denied");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ box_id: "BOX-01", fob_uid: UID.ada, person_id: "P001", detail: { via: "box", reason: "listed", source: "cached", fw: "0.1.0" } });
    expect(denied[0]).toMatchObject({ box_id: "BOX-01", fob_uid: UID.unknown, person_id: null, detail: { via: "box", reason: "not_listed" } });
  });

  test("a QoS 1 redelivery is logged once; unknown boxes and junk are ignored", () => {
    const h = setup();
    const tap = { uid: UID.ada, result: "allow", reason: "listed", source: "cached", ts: T0.toISOString(), fw: "0.1.0" };
    h.bus.deliver("box/BOX-01/tap", tap);
    h.bus.deliver("box/BOX-01/tap", tap);
    h.bus.deliver("box/BOX-99/tap", tap);
    h.bus.deliver("box/BOX-01/tap", "{nope");
    h.bus.deliver("box/BOX-01/tap", { uid: "XYZ", result: "allow" });
    h.bus.deliver("box/BOX-01/tap", { uid: UID.ada, result: "maybe" });
    expect(h.log("box_open")).toHaveLength(1);
  });

  test("a tap queued while the hub was away is logged at the box's time", () => {
    const h = setup();
    const earlier = new Date(T0.getTime() - 10 * 60_000).toISOString();
    h.bus.deliver("box/BOX-01/tap", { uid: UID.ada, result: "allow", reason: "offline", source: "offline", ts: earlier, fw: "0.1.0" });
    const ev = h.db.query<{ ts: string }, []>("SELECT ts FROM events WHERE type = 'box_open'").get()!;
    expect(ev.ts).toBe(earlier);
    // A box clock far in the future (not set right) falls back to the hub's time.
    h.bus.deliver("box/BOX-01/tap", { uid: UID.cal, result: "deny", reason: "not_listed", source: "cached", ts: "2030-01-01T00:00:00.000Z" });
    expect(h.db.query<{ ts: string }, []>("SELECT ts FROM events WHERE type = 'box_denied'").get()!.ts).toBe(T0.toISOString());
  });

  test("the event log says it happened at the box, in plain words", () => {
    const fobName = () => null;
    expect(describeEvent("box_open", "Ada", "Mic box", null, { via: "box", reason: "listed", source: "cached" }, fobName)).toBe("Ada opened Mic box at the box");
    expect(describeEvent("box_open", "Ada", "Mic box", null, { via: "box", reason: "listed", source: "offline" }, fobName)).toBe(
      "Ada opened Mic box at the box (hub was unreachable, the box used its saved list)",
    );
    expect(describeEvent("box_open", "Ada", "Mic box", null, { via: "box", reason: "offline", source: "offline" }, fobName)).toBe(
      "Ada tapped Mic box at the box (hub unreachable, box was unlocked)",
    );
    expect(describeEvent("box_denied", "Cal", "Mic box", null, { via: "box", reason: "not_listed", source: "cached" }, fobName)).toBe(
      "Cal couldn't open Mic box at the box: not allowed on this box",
    );
    expect(describeEvent("software_update", null, "Mic box", null, { stage: "refused", version: "0.2.0", why: "unlocked" }, fobName)).toBe(
      "Mic box refused update 0.2.0: box was unlocked",
    );
  });
});

describe("box reports", () => {
  test("heartbeat and state store the firmware version; state stores the door", () => {
    const h = setup();
    h.bus.deliver("box/BOX-01/heartbeat", { ts: T0.toISOString(), fw: "0.1.0", uptime_s: 5 });
    expect(getBox(h.db, "BOX-01")).toMatchObject({ fw: "0.1.0", last_seen: T0.toISOString() });
    h.bus.deliver("box/BOX-01/state", { lock: "locked", door: "open", ts: T0.toISOString(), fw: "0.1.1" });
    expect(getBox(h.db, "BOX-01")).toMatchObject({ fw: "0.1.1", door_state: "open", lock_state: "locked" });
    h.bus.deliver("box/BOX-01/state", { lock: "locked", ts: T0.toISOString(), fw: "0.1.1" }); // no door field: keep the last
    expect(getBox(h.db, "BOX-01")!.door_state).toBe("open");
  });

  test("the broker's last will doesn't count as the box being alive", () => {
    const h = setup();
    h.bus.deliver("box/BOX-01/state", { lock: "open", why: "offline" });
    expect(getBox(h.db, "BOX-01")).toMatchObject({ lock_state: "open", last_seen: null });
  });

  test("ota reports are stored and logged once, even when the retained state comes again", () => {
    const h = setup();
    const st = { lock: "locked", ts: T0.toISOString(), fw: "0.1.0", ota: "refused", ota_version: "0.2.0", ota_why: "unlocked" };
    h.bus.deliver("box/BOX-01/state", st);
    h.bus.deliver("box/BOX-01/state", st);
    expect(getBox(h.db, "BOX-01")).toMatchObject({ ota_status: "refused", ota_version: "0.2.0", ota_why: "unlocked" });
    expect(h.log("software_update").map((e) => e.detail)).toEqual([{ target: "box", stage: "refused", version: "0.2.0", why: "unlocked", fw: "0.1.0" }]);
  });

  test("End of session lists a locked box whose door is open", async () => {
    const h = setup();
    online(h);
    h.bus.deliver("box/BOX-01/state", { lock: "locked", door: "open", ts: T0.toISOString(), fw: "0.1.0" });
    const s = admin(h);
    const pre = (await h.req("GET", `/api/admin/end-of-session?session=${s}`)).json;
    expect(pre.boxesOpen).toEqual([{ box_id: "BOX-01", name: "Mic box", lock: "locked", door: "open" }]);
  });
});

describe("GET /api/boxes", () => {
  test("status, last seen, firmware, door and last tap for every box", async () => {
    const h = setup();
    online(h);
    h.bus.deliver("box/BOX-01/tap", { uid: UID.ada, result: "allow", reason: "listed", source: "cached", ts: T0.toISOString(), fw: "0.1.0" });
    const r = await h.req("GET", "/api/boxes");
    expect(r.status).toBe(200);
    expect(r.json.mqtt).toBe(true);
    const b = r.json.boxes.find((x: any) => x.box_id === "BOX-01");
    expect(b).toMatchObject({
      name: "Mic box",
      status: "locked",
      lock: "locked",
      lastSeen: T0.toISOString(),
      fw: "0.1.0",
      door: null,
      lastTap: { ts: T0.toISOString(), who: "Ada", result: "allow", reason: "listed", source: "cached" },
      ota: null,
    });
    expect(r.json.boxes.find((x: any) => x.box_id === "CASE-01")).toMatchObject({ status: "never_seen", lastTap: null });
  });

  test("loopback only", async () => {
    const h = setup();
    const res = await h.hub.app.request("/api/boxes", {}, ip("10.102.40.50"));
    expect(res.status).toBe(403);
  });
});

describe("firmware", () => {
  test("upload stores the image and logs it; bad files are refused", async () => {
    const h = setup();
    const s = admin(h);
    const bytes = image();
    const r = await upload(h, s, bytes, "0.2.0");
    expect(r.json).toMatchObject({ ok: true, firmware: { version: "0.2.0", size: 4096, sha256: createHash("sha256").update(bytes).digest("hex") } });
    expect(h.log("software_update").at(-1)!.detail).toMatchObject({ stage: "uploaded", version: "0.2.0", via: "panel" });
    expect((await upload(h, s, bytes, "0.2.0")).json.ok).toBe(true); // same bytes again: fine
    expect((await upload(h, s, image(4096, 7), "0.2.0")).json.reason).toContain("Bump the version");
    const notEsp = image();
    notEsp[0] = 0x7f;
    expect((await upload(h, s, notEsp, "0.3.0")).json.reason).toContain("Not an ESP32 firmware image");
    expect((await upload(h, s, image(), "latest")).json.reason).toContain("Version must look like");
    expect((await upload(h, "nope", image(), "0.4.0")).json.ok).toBe(false);
  });

  test("GET /fw/<file>: Control subnet and loopback only, read-only, unknown files 404", async () => {
    const h = setup();
    const s = admin(h);
    const bytes = image();
    await upload(h, s, bytes, "0.2.0");
    const ok = await h.hub.app.request("/fw/box-0.2.0.bin", {}, ip("10.102.40.101"));
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);
    expect((await h.hub.app.request("/fw/box-0.2.0.bin", {}, ip("::ffff:10.102.40.101"))).status).toBe(200);
    expect((await h.hub.app.request("/fw/box-0.2.0.bin", {}, ip("10.101.1.1"))).status).toBe(403); // LX subnet
    expect((await h.hub.app.request("/fw/box-0.2.0.bin", {}, ip("192.168.1.5"))).status).toBe(403);
    expect((await h.hub.app.request("/fw/box-9.9.9.bin", {}, LOCAL)).status).toBe(404);
    expect((await h.hub.app.request("/fw/..%2Fdb.bin", {}, LOCAL)).status).toBe(404);
    expect((await h.hub.app.request("/fw/box-0.2.0.bin", { method: "PUT", body: "x" }, LOCAL)).status).toBe(404);
  });

  test("update needs a confirm tap, then publishes ota to online boxes and skips the rest", async () => {
    const h = setup();
    online(h, "BOX-01", "0.1.0");
    const s = admin(h);
    const bytes = image();
    await upload(h, s, bytes, "0.2.0");
    const before = h.bus.sent.length;
    const r = (await h.req("POST", "/api/admin/firmware/update", { session: s, boxes: "all" })).json;
    expect(r).toMatchObject({ ok: true, confirm: "tap" });
    expect(h.bus.sent.length).toBe(before); // nothing until the tap
    h.tap(UID.danielAdmin);
    const done = confirmEvents(h).at(-1)!;
    expect(done).toMatchObject({ ok: true, version: "0.2.0", sent: ["BOX-01"], skipped: [{ box_id: "CASE-01", reason: "never seen" }] });
    const ota = h.bus.sent.find((m) => m.topic === "box/BOX-01/ota")!;
    expect(ota.retain).toBe(false);
    const body = JSON.parse(ota.payload);
    expect(body).toEqual({
      version: "0.2.0",
      url: "http://10.102.40.10:8080/fw/box-0.2.0.bin",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: 4096,
      expires: new Date(T0.getTime() + 5 * 60_000).toISOString(),
    });
    expect(getBox(h.db, "BOX-01")).toMatchObject({ ota_status: "requested", ota_version: "0.2.0" });
    const logged = h.log("software_update").filter((e) => e.detail.stage === "requested" || e.detail.stage === "skipped");
    expect(logged.map((e) => [e.box_id, e.detail.stage, e.fob_uid])).toEqual([
      ["BOX-01", "requested", UID.danielAdmin],
      ["CASE-01", "skipped", UID.danielAdmin],
    ]);
    expect(h.log("admin_action").at(-1)!.detail).toMatchObject({ action: "firmware_update", confirmedBy: UID.danielAdmin, version: "0.2.0" });
  });

  test("a box already on the version is skipped; asking for unknown firmware is refused", async () => {
    const h = setup();
    online(h, "BOX-01", "0.2.0");
    const s = admin(h);
    await upload(h, s, image(), "0.2.0");
    await h.req("POST", "/api/admin/firmware/update", { session: s, boxes: ["BOX-01"] });
    h.tap(UID.ritterAdmin);
    expect(confirmEvents(h).at(-1)).toMatchObject({ ok: true, sent: [], skipped: [{ box_id: "BOX-01", reason: "already on 0.2.0" }] });
    expect((await h.req("POST", "/api/admin/firmware/update", { session: s, boxes: "all", version: "9.9.9" })).json.reason).toBe("No firmware 9.9.9 stored");
    expect((await h.req("POST", "/api/admin/firmware/update", { session: s, boxes: [] })).json.ok).toBe(false);
  });

  test("the update function refuses when MQTT is down (nothing is queued)", async () => {
    const h = setup();
    online(h);
    const s = admin(h);
    await upload(h, s, image(), "0.2.0");
    h.bus.isConnected = false;
    const r = h.hub.firmware.requestUpdate({ boxes: "all", by: UID.ritterAdmin, via: "usb" });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  test("GET /api/admin/firmware lists images newest first and each box's firmware", async () => {
    const h = setup();
    online(h);
    const s = admin(h);
    await upload(h, s, image(4096, 1), "0.9.0");
    await upload(h, s, image(4096, 2), "0.10.0");
    const r = (await h.req("GET", `/api/admin/firmware?session=${s}`)).json;
    expect(r.images.map((i: any) => i.version)).toEqual(["0.10.0", "0.9.0"]);
    expect(r.boxes.find((b: any) => b.box_id === "BOX-01")).toMatchObject({ fw: "0.1.0", status: "locked" });
  });

  test("version order", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });
});
