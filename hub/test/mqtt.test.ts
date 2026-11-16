import { describe, expect, test } from "bun:test";
import { FakeBus, MqttJsBus } from "../src/mqtt/bus";
import { BoxLink, OFFLINE_AFTER_MS } from "../src/mqtt/boxes";
import { setFlag } from "../src/data";
import { seedDb, T0, UID } from "./seed";

describe("MqttJsBus with no broker", () => {
  test("constructs, stays quiet, refuses to publish, closes", async () => {
    const logs: string[] = [];
    const bus = new MqttJsBus({ url: "mqtt://127.0.0.1:1", username: "hub", log: (m) => logs.push(m) });
    await Bun.sleep(300);
    expect(bus.connected()).toBe(false);
    expect(bus.publish("box/BOX-01/cmd", "{}")).toBe(false);
    await bus.close();
    expect(logs.length).toBeLessThanOrEqual(2); // one line per distinct problem, not a flood
  });
});

describe("BoxLink", () => {
  function setup(at = T0) {
    const db = seedDb();
    const bus = new FakeBus();
    let now = at;
    const link = new BoxLink(db, bus, () => now);
    return { db, bus, link, setNow: (d: Date) => (now = d) };
  }

  test("open command carries seconds, expiry and ref; nothing is sent while disconnected", () => {
    const { bus, link } = setup();
    expect(link.command("BOX-01", "open", 7)).toBe(true);
    const m = JSON.parse(bus.sent.at(-1)!.payload);
    expect(bus.sent.at(-1)!.topic).toBe("box/BOX-01/cmd");
    expect(m).toMatchObject({ cmd: "open", seconds: 8, ref: 7, ts: T0.toISOString() });
    expect(Date.parse(m.expires) - T0.getTime()).toBe(15_000);
    bus.isConnected = false;
    expect(link.command("BOX-01", "open", 8)).toBe(false);
    expect(bus.sent.length).toBe(1);
  });

  test("on connect: retained mode and allowlists for every box", () => {
    const { bus } = setup();
    bus.connect();
    expect(JSON.parse(bus.retained.get("box/BOX-01/mode")!)).toMatchObject({ show: false });
    const fobs = JSON.parse(bus.retained.get("box/BOX-01/fobs")!);
    // BOX-01 needs Level 2: admin, staff, the Level 2 student; not the Level 1 student or the spare.
    expect(fobs.fobs.map((f: { uid: string }) => f.uid).sort()).toEqual(
      [UID.ritterAdmin, UID.danielAdmin, UID.ada, UID.hire, UID.dayPass].sort(),
    );
    expect(fobs.fobs.find((f: { uid: string }) => f.uid === "AABBCCDD").until).toBe("2026-11-16");
    expect(fobs.offline_unlock_min).toBe(5);
  });

  test("allowlists only republish when they change; disable-all-students drops students", () => {
    const { db, bus, link } = setup();
    link.publishAllowlists();
    const n = bus.sent.length;
    link.publishAllowlists();
    expect(bus.sent.length).toBe(n);
    setFlag(db, "students_disabled", true);
    link.publishAllowlists();
    const fobs = JSON.parse(bus.retained.get("box/BOX-01/fobs")!).fobs.map((f: { uid: string }) => f.uid);
    expect(fobs).not.toContain("04A1B2C3D4E5F7");
    expect(fobs).toContain("04A1B2C3D4E5F6");
  });

  test("show mode flag goes out retained", () => {
    const { db, bus, link } = setup();
    setFlag(db, "show_mode", true);
    link.publishMode();
    expect(JSON.parse(bus.retained.get("box/CASE-01/mode")!).show).toBe(true);
  });

  test("state and heartbeat update the box; status locked / open / offline / never seen", () => {
    const { db, bus, link, setNow } = setup();
    const box = () => db.query<{ last_seen: string | null; lock_state: "open" | "locked" | null }, []>("SELECT last_seen, lock_state FROM boxes WHERE box_id = 'BOX-01'").get()!;
    expect(link.status(box())).toBe("never_seen");
    bus.deliver("box/BOX-01/heartbeat", { ts: T0.toISOString() });
    expect(link.status(box())).toBe("locked");
    bus.deliver("box/BOX-01/state", { lock: "open" });
    expect(link.status(box())).toBe("open");
    setNow(new Date(T0.getTime() + OFFLINE_AFTER_MS + 1000));
    expect(link.status(box())).toBe("offline");
  });

  test("junk is ignored: unknown box, bad JSON, bad lock value", () => {
    const { db, bus } = setup();
    bus.deliver("box/NOPE/heartbeat", {});
    bus.deliver("box/BOX-01/state", "not json");
    bus.deliver("box/BOX-01/state", { lock: "ajar" });
    expect(db.query("SELECT 1 FROM boxes WHERE last_seen IS NOT NULL").get()).toBeNull();
  });
});
