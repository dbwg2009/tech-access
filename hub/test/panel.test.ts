import { describe, expect, test } from "bun:test";
import { setFlag } from "../src/data";
import { LOCAL, setup } from "./harness";
import { T0, UID } from "./seed";

describe("taps open sessions", () => {
  test("crew tap opens a card: first name, level + specialism, nothing out", async () => {
    const h = setup();
    h.tap(UID.ada);
    const s = (await h.req("GET", "/api/panel/state")).json.session;
    expect(s).toMatchObject({ kind: "crew", name: "Ada", level: 2, specialism: "Lighting", signedIn: false, kitOut: [], guest: false });
    expect(h.events.some((e) => e.event === "tap")).toBe(true);
    expect(h.events.some((e) => e.event === "session")).toBe(true);
  });

  test("admin tap opens the admin menu", () => {
    const h = setup();
    h.tap(UID.ritterAdmin);
    expect(h.hub.panel.view()).toMatchObject({ kind: "admin", name: "Mrs Ritter" });
  });

  test.each([
    [UID.unknown, "Fob not recognised"],
    [UID.lost, "This fob is Lost"],
    [UID.spare, "This fob is Spare"],
  ])("refused fob %s: denial screen with the reason, tap_denied logged", (uid, reason) => {
    const h = setup();
    h.tap(uid);
    expect(h.hub.panel.current()).toBeNull();
    expect(h.events.find((e) => e.event === "denied")?.data).toMatchObject({ reason });
    expect(h.log("tap_denied")).toEqual([expect.objectContaining({ fob_uid: uid, detail: { reason } })]);
  });

  test("students disabled: students refused, staff and admins fine", () => {
    const h = setup();
    setFlag(h.db, "students_disabled", true);
    h.tap(UID.ada);
    expect(h.events.find((e) => e.event === "denied")?.data).toMatchObject({ reason: "Students are disabled right now", name: "Ada" });
    h.tap(UID.hire);
    expect(h.hub.panel.view()?.kind).toBe("crew");
    h.tap(UID.danielAdmin); // a student, but an Admin fob
    expect(h.hub.panel.view()?.kind).toBe("admin");
  });

  test("a new tap replaces the open card", () => {
    const h = setup();
    h.tap(UID.ada);
    const first = h.sid();
    h.tap(UID.cal);
    expect(h.sid()).not.toBe(first);
    expect(h.hub.panel.view()?.name).toBe("Cal");
  });

  test("guest day pass: card says Guest, its own level", () => {
    const h = setup();
    h.tap(UID.dayPass);
    expect(h.hub.panel.view()).toMatchObject({ name: "Guest", guest: true, level: 2 });
  });
});

describe("session timeout", () => {
  test("crew card closes 30 s after the last touch; a touch keeps it open", async () => {
    const h = setup();
    h.tap(UID.ada);
    const id = h.sid();
    h.advance(20_000);
    expect((await h.req("POST", "/api/panel/touch", { session: id })).status).toBe(200);
    h.advance(20_000);
    expect(h.sid()).toBe(id);
    h.advance(10_000);
    expect(h.sid()).toBeUndefined();
    expect(h.events.at(-1)).toEqual({ event: "session", data: { session: null, why: "timeout" } });
    expect((await h.req("POST", "/api/panel/sign", { session: id })).status).toBe(410);
  });

  test("admin menu closes after 90 s", () => {
    const h = setup();
    h.tap(UID.ritterAdmin);
    h.advance(89_000);
    expect(h.sid()).toBeDefined();
    h.advance(1_000);
    expect(h.sid()).toBeUndefined();
  });
});

describe("crew actions", () => {
  test("sign in, then sign out: events and overview", async () => {
    const h = setup();
    h.tap(UID.ada);
    expect((await h.req("POST", "/api/panel/sign", { session: h.sid() })).json).toMatchObject({ ok: true, message: "Signed in" });
    expect(h.hub.panel.view()?.signedIn).toBe(true);
    const ov = (await h.req("GET", `/api/panel/overview?session=${h.sid()}`)).json;
    expect(ov.signedIn).toEqual([{ name: "Ada", since: T0.toISOString() }]);
    expect((await h.req("POST", "/api/panel/sign", { session: h.sid() })).json.message).toBe("Signed out");
    expect(h.log().map((e) => e.type)).toEqual(["sign_in", "sign_out"]);
    expect(h.log("sign_in")[0]).toMatchObject({ person_id: "P001", fob_uid: UID.ada });
  });

  test("overview needs an open session", async () => {
    const h = setup();
    expect((await h.req("GET", "/api/panel/overview?session=nope")).status).toBe(410);
  });

  test("kit lists: only kit that's in and cleared (decideKitTake)", async () => {
    const h = setup();
    h.tap(UID.ada); // Level 2 Lighting
    const lists = (await h.req("GET", `/api/panel/kit?session=${h.sid()}`)).json;
    expect(lists.take.map((k: { kit_id: string }) => k.kit_id).sort()).toEqual(["K003", "K004"]); // not Sound, not Level 3
    expect(lists.mine).toEqual([]);
  });

  test("take: kit_out + box_open + MQTT open; the box shows offline until week 5", async () => {
    const h = setup();
    h.tap(UID.ada);
    const r = (await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K003" })).json;
    expect(r).toMatchObject({ ok: true, message: "Par can is yours. LX case is offline. Ask a staff member to open it" });
    expect(h.log().map((e) => e.type)).toEqual(["kit_out", "box_open"]);
    expect(h.log("box_open")[0]).toMatchObject({ box_id: "CASE-01", kit_id: "K003", detail: { via: "take", status: "never_seen", mqtt: true } });
    const cmd = h.bus.sent.find((m) => m.topic === "box/CASE-01/cmd")!;
    expect(JSON.parse(cmd.payload)).toMatchObject({ cmd: "open", ref: expect.any(Number) });
    expect(h.hub.panel.view()?.kitOut).toEqual([{ kit_id: "K003", item: "Par can" }]);
    const ov = (await h.req("GET", `/api/panel/overview?session=${h.sid()}`)).json;
    expect(ov.kitOut).toEqual([{ kit_id: "K003", item: "Par can", holder: "Ada", since: T0.toISOString() }]);
  });

  test("take with no box: just kit_out", async () => {
    const h = setup();
    h.tap(UID.ada);
    expect((await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" })).json.message).toBe("Gaffer tape is yours");
    expect(h.log().map((e) => e.type)).toEqual(["kit_out"]);
  });

  test("an item that's out can't be taken (logged)", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" });
    h.tap(UID.hire);
    const r = (await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" })).json;
    expect(r).toEqual({ ok: false, reason: "Gaffer tape is already out with Ada", error: "Gaffer tape is already out with Ada" });
    expect(h.log("kit_denied")[0]).toMatchObject({ person_id: "P003", kit_id: "K004", detail: { action: "take" } });
  });

  test("not cleared for the kit: refused and logged", async () => {
    const h = setup();
    h.tap(UID.ada);
    const r = (await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K002" })).json;
    expect(r.reason).toBe("Level 3 needed, you're Level 2");
    expect(h.log("kit_denied")).toHaveLength(1);
  });

  test("cleared for the kit but not its box: refused with the box's reason", async () => {
    const h = setup();
    h.db.query("INSERT INTO kit (kit_id, item, category, required_level, specialism, box_id) VALUES ('K005', 'Mic clip', 'Sound', 1, 'Sound', 'BOX-01')").run();
    h.tap(UID.cal); // Level 1 Sound; BOX-01 needs Level 2
    const r = (await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K005" })).json;
    expect(r.reason).toBe("Mic box: Level 2 needed, you're Level 1");
    expect(h.log().map((e) => e.type)).toEqual(["kit_denied"]);
    expect(h.bus.sent.some((m) => m.topic.endsWith("/cmd"))).toBe(false);
  });

  test("return: own kit only; opens its box if cleared", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K003" });
    h.tap(UID.cal);
    const notMine = (await h.req("POST", "/api/panel/return", { session: h.sid(), kitId: "K003" })).json;
    expect(notMine.reason).toBe("Par can is out with Ada");
    h.tap(UID.ada);
    const mine = (await h.req("GET", `/api/panel/kit?session=${h.sid()}`)).json.mine;
    expect(mine.map((k: { kit_id: string }) => k.kit_id)).toEqual(["K003"]);
    const r = (await h.req("POST", "/api/panel/return", { session: h.sid(), kitId: "K003" })).json;
    expect(r.message).toBe("Par can returned. LX case is offline. Ask a staff member to open it");
    expect(h.log().map((e) => e.type)).toEqual(["kit_out", "box_open", "kit_denied", "kit_in", "box_open"]);
    expect(h.hub.panel.view()?.kitOut).toEqual([]);
  });

  test("open a box: list is only cleared boxes; a denied open is logged", async () => {
    const h = setup();
    h.tap(UID.cal); // Level 1
    const list = (await h.req("GET", `/api/panel/boxes?session=${h.sid()}`)).json.boxes;
    expect(list).toEqual([{ box_id: "CASE-01", name: "LX case", location: "", status: "never_seen" }]);
    expect((await h.req("POST", "/api/panel/open", { session: h.sid(), boxId: "BOX-01" })).json.reason).toBe("Level 2 needed, you're Level 1");
    expect((await h.req("POST", "/api/panel/open", { session: h.sid(), boxId: "CASE-01" })).json.ok).toBe(true);
    expect(h.log().map((e) => [e.type, e.box_id])).toEqual([
      ["box_denied", "BOX-01"],
      ["box_open", "CASE-01"],
    ]);
  });

  test("box that's online and reporting: 'is opening'", async () => {
    const h = setup();
    h.bus.deliver("box/CASE-01/heartbeat", {});
    h.tap(UID.cal);
    expect((await h.req("POST", "/api/panel/open", { session: h.sid(), boxId: "CASE-01" })).json.message).toBe("LX case is opening");
  });

  test("no broker: nothing sent, the panel says offline, the event still records it", async () => {
    const h = setup();
    h.bus.isConnected = false;
    h.bus.deliver("box/CASE-01/heartbeat", {});
    h.tap(UID.cal);
    expect((await h.req("POST", "/api/panel/open", { session: h.sid(), boxId: "CASE-01" })).json.message).toBe("LX case is offline. Ask a staff member to open it");
    expect(h.log("box_open")[0]!.detail).toMatchObject({ mqtt: false });
  });

  test("show mode: any box opens for anyone with a card", async () => {
    const h = setup();
    setFlag(h.db, "show_mode", true);
    h.tap(UID.cal);
    const list = (await h.req("GET", `/api/panel/boxes?session=${h.sid()}`)).json.boxes;
    expect(list.map((b: { box_id: string }) => b.box_id).sort()).toEqual(["BOX-01", "CASE-01"]);
  });

  test("a guest's sign-in and kit are keyed by their fob", async () => {
    const h = setup();
    h.tap(UID.dayPass);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" });
    expect(h.hub.panel.view()).toMatchObject({ signedIn: true, kitOut: [{ kit_id: "K004", item: "Gaffer tape" }] });
    const ov = (await h.req("GET", `/api/panel/overview?session=${h.sid()}`)).json;
    expect(ov.signedIn[0].name).toBe("a guest");
    expect(ov.kitOut[0].holder).toBe("a guest");
  });

  test("a card can't act after its fob is changed (e.g. by an import)", async () => {
    const h = setup();
    h.tap(UID.ada);
    h.db.query("UPDATE fobs SET status = 'Lost' WHERE fob_uid = ?").run(UID.ada);
    expect((await h.req("POST", "/api/panel/sign", { session: h.sid() })).json.reason).toBe("This fob is Lost");
  });

  test("crew routes refuse an admin session and vice versa", async () => {
    const h = setup();
    h.tap(UID.ritterAdmin);
    expect((await h.req("POST", "/api/panel/sign", { session: h.sid() })).status).toBe(403);
  });
});

describe("overview and health", () => {
  test("box status, flags and hub health", async () => {
    const h = setup();
    h.bus.deliver("box/BOX-01/state", { lock: "locked" });
    h.tap(UID.ada);
    const ov = (await h.req("GET", `/api/panel/overview?session=${h.sid()}`)).json;
    expect(ov.boxes).toEqual([
      { box_id: "CASE-01", name: "LX case", status: "never_seen", statusText: "never seen", lastSeen: null },
      { box_id: "BOX-01", name: "Mic box", status: "locked", statusText: "locked", lastSeen: T0.toISOString() },
    ]);
    expect(ov.health).toEqual({ tempC: 48.5, diskFreeMB: 200000, diskTotalMB: 250000, mqtt: true, reader: { state: "ok", detail: "fake reader (development)" } });
    expect(ov.showMode).toBe(false);
  });
});

describe("03:00 automatic sign-out", () => {
  test("signs out everyone once, logged as auto; not again the same day", async () => {
    const h = setup(new Date("2026-11-16T22:00:00Z"));
    h.hub.panel.autoSignOut(); // after 03:00 on the 16th: runs (nobody in yet) and records the date
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    h.tap(UID.dayPass);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    h.setNow(new Date("2026-11-17T02:59:00Z"));
    h.hub.panel.tick();
    expect(h.log("sign_out")).toHaveLength(0);
    h.setNow(new Date("2026-11-17T03:00:00Z"));
    h.hub.panel.tick();
    expect(h.log("sign_out").map((e) => [e.person_id, e.fob_uid, e.detail])).toEqual([
      ["P001", UID.ada, { auto: true }],
      [null, UID.dayPass, { auto: true }],
    ]);
    h.setNow(new Date("2026-11-17T09:00:00Z"));
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    h.hub.panel.tick();
    expect(h.log("sign_out")).toHaveLength(2);
  });

  test("uses local time (BST in summer: 03:00 BST = 02:00 UTC)", () => {
    const h = setup(new Date("2026-07-01T01:59:00Z"));
    expect(h.hub.panel.autoSignOut()).toBe(0);
    expect(h.db.query("SELECT value FROM settings WHERE key = 'auto_signout_date'").get()).toBeNull();
    h.setNow(new Date("2026-07-01T02:00:00Z"));
    h.hub.panel.autoSignOut();
    expect(h.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'auto_signout_date'").get()?.value).toBe("2026-07-01");
  });
});

describe("screen", () => {
  test("off after 5 min with nobody using it; a fob tap wakes it", () => {
    const h = setup();
    h.advance(4 * 60_000);
    expect(h.hub.panel.screen().on).toBe(true);
    h.advance(60_000);
    expect(h.hub.panel.screen().on).toBe(false);
    expect(h.events.at(-1)).toEqual({ event: "screen", data: { on: false, why: "idle" } });
    h.tap(UID.ada);
    expect(h.hub.panel.screen().on).toBe(true);
    expect(h.events.find((e) => e.event === "screen" && (e.data as { on: boolean }).on)).toBeDefined();
  });

  test("an open card keeps the screen on; the kiosk reports real on/off", async () => {
    const h = setup();
    h.tap(UID.ritterAdmin);
    h.advance(80_000);
    await h.req("POST", "/api/panel/touch", { session: h.sid() });
    h.advance(80_000);
    expect(h.hub.panel.screen().on).toBe(true);
    await h.req("POST", "/api/panel/screen", { on: false });
    expect(h.hub.panel.screen().on).toBe(false);
    expect((await h.req("POST", "/api/panel/screen", { on: "x" })).status).toBe(400);
  });
});

describe("event stream", () => {
  test("GET /api/panel/stream sends hello, then live events", async () => {
    const h = setup();
    const res = await h.hub.app.request("/api/panel/stream", {}, LOCAL);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const rd = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await rd.read()).value);
    expect(text).toContain("event: hello");
    h.tap(UID.ada);
    while (!text.includes("event: session")) text += dec.decode((await rd.read()).value);
    expect(text).toContain("event: tap");
    await rd.cancel();
  });

  test("stream is loopback only", async () => {
    const h = setup();
    const res = await h.hub.app.request("/api/panel/stream", {}, { requestIP: () => ({ address: "10.102.200.20", family: "IPv4", port: 1 }) });
    expect(res.status).toBe(403);
  });
});
