import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { getFlag, getFob, getPerson } from "../src/data";
import { REBOOT_PI, RESTART_HUB } from "../src/panel/admin";
import { LOCAL, setup } from "./harness";
import { T0, UID } from "./seed";

type H = ReturnType<typeof setup>;

const admin = (h: H, uid: string = UID.ritterAdmin) => {
  h.tap(uid);
  return h.sid()!;
};
const confirmEvents = (h: H) => h.events.filter((e) => e.event === "confirm").map((e) => e.data as Record<string, unknown>);
const actions = (h: H) => h.log("admin_action").map((e) => e.detail);

describe("admin menu access", () => {
  test("needs an admin session; a crew card can't use it", async () => {
    const h = setup();
    h.tap(UID.ada);
    expect((await h.req("GET", `/api/admin/menu?session=${h.sid()}`)).status).toBe(403);
    expect((await h.req("GET", "/api/admin/menu?session=nope")).status).toBe(410);
    const s = admin(h);
    expect((await h.req("GET", `/api/admin/menu?session=${s}`)).json).toEqual({ studentsDisabled: false, showMode: false, kitOut: 0 });
  });

  test("loopback only", async () => {
    const h = setup();
    const s = admin(h);
    const res = await h.hub.app.request(`/api/admin/menu?session=${s}`, {}, { requestIP: () => ({ address: "10.102.200.9", family: "IPv4", port: 1 }) });
    expect(res.status).toBe(403);
  });
});

describe("tap to confirm", () => {
  test("show mode: nothing happens until an admin fob taps; logged with both fobs", async () => {
    const h = setup();
    const s = admin(h, UID.ritterAdmin);
    const r = (await h.req("POST", "/api/admin/show-mode", { session: s, on: true })).json;
    expect(r).toMatchObject({ ok: true, confirm: "tap" });
    expect(getFlag(h.db, "show_mode")).toBe(false);
    expect(h.hub.panel.view()?.pending).toMatchObject({ label: "Turn show mode on: every box unlocks" });

    h.tap(UID.ada); // not an admin fob: refused, still waiting, session unchanged
    expect(confirmEvents(h).at(-1)).toMatchObject({ ok: false, reason: "That isn't an admin fob" });
    expect(h.sid()).toBe(s);
    expect(getFlag(h.db, "show_mode")).toBe(false);

    h.tap(UID.danielAdmin); // any Active admin fob confirms
    expect(confirmEvents(h).at(-1)).toMatchObject({ ok: true, message: "Show mode is on. Every box is unlocked" });
    expect(getFlag(h.db, "show_mode")).toBe(true);
    expect(actions(h)).toEqual([{ action: "show_mode_on", openedBy: UID.ritterAdmin, confirmedBy: UID.danielAdmin }]);
    expect(JSON.parse(h.bus.retained.get("box/BOX-01/mode")!).show).toBe(true);
    expect(h.hub.panel.view()?.pending).toBeNull();
  });

  test("the same admin fob can confirm its own action", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    h.tap(UID.ritterAdmin);
    expect(actions(h)[0]).toMatchObject({ openedBy: UID.ritterAdmin, confirmedBy: UID.ritterAdmin });
  });

  test("expires after 20 s: not run; the next admin tap just reopens the menu", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    h.advance(20_000);
    expect(confirmEvents(h).at(-1)).toMatchObject({ ok: false, expired: true });
    h.tap(UID.danielAdmin);
    expect(getFlag(h.db, "show_mode")).toBe(false);
    expect(actions(h)).toEqual([]);
  });

  test("cancel", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    await h.req("POST", "/api/admin/cancel", { session: s });
    h.tap(UID.danielAdmin);
    expect(getFlag(h.db, "show_mode")).toBe(false);
  });

  test("a menu with a confirm pending doesn't time out under the 20 s window", async () => {
    const h = setup();
    const s = admin(h);
    h.advance(85_000);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: false });
    h.advance(15_000);
    expect(h.sid()).toBe(s);
  });
});

describe("students", () => {
  test("disable is confirmed; re-enable isn't", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/students", { session: s, disabled: true })).json.confirm).toBe("tap");
    h.tap(UID.ritterAdmin);
    expect(getFlag(h.db, "students_disabled")).toBe(true);
    const r = (await h.req("POST", "/api/admin/students", { session: s, disabled: false })).json;
    expect(r).toMatchObject({ ok: true, message: "Students are enabled again" });
    expect(actions(h).map((a) => [a.action, a.confirmedBy])).toEqual([
      ["students_disabled", UID.ritterAdmin],
      ["students_enabled", null],
    ]);
    // the boxes' cached lists follow
    expect(JSON.parse(h.bus.retained.get("box/BOX-01/fobs")!).fobs.map((f: { uid: string }) => f.uid)).toContain(UID.ada);
  });
});

describe("fob lost / revoked (from a profile: no confirm tap)", () => {
  test("done straight away, Ended = today, panel change recorded, £2 note on the second lost fob", async () => {
    const h = setup();
    h.db.query("INSERT INTO fobs (fob_uid, person_id, role, status, issued, ended) VALUES ('0A0A0A0A', 'P001', 'Standard', 'Lost', '2026-01-01', '2026-02-01')").run();
    const s = admin(h);
    expect((await h.req("GET", `/api/admin/edit/person?session=${s}&id=P001`)).json.lostFobs).toBe(1);
    const r = (await h.req("POST", "/api/admin/fob-status", { session: s, uid: UID.ada, status: "Lost" })).json;
    expect(r).toMatchObject({ ok: true, message: "Fob marked lost. This is their second lost fob: £2 charge", charge: true });
    expect(getFob(h.db, UID.ada)).toMatchObject({ status: "Lost", ended: "2026-11-16" });
    const changes = h.db.query<{ field: string; fob_uid: string }, []>("SELECT field, fob_uid FROM panel_changes ORDER BY id").all();
    expect(changes).toEqual([
      { field: "status", fob_uid: UID.ritterAdmin },
      { field: "ended", fob_uid: UID.ritterAdmin },
    ]);
    expect(actions(h)[0]).toMatchObject({ action: "fob_lost", uid: UID.ada, openedBy: UID.ritterAdmin, confirmedBy: null });
    h.tap(UID.ada);
    expect(h.events.at(-1)).toMatchObject({ event: "denied", data: { reason: "This fob is Lost" } });
    expect(JSON.parse(h.bus.retained.get("box/BOX-01/fobs")!).fobs.map((f: { uid: string }) => f.uid)).not.toContain(UID.ada);
  });

  test("revoke; refuses one that's already revoked", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/fob-status", { session: s, uid: UID.cal, status: "Revoked" })).json.ok).toBe(true);
    expect(getFob(h.db, UID.cal)?.status).toBe("Revoked");
    expect((await h.req("POST", "/api/admin/fob-status", { session: s, uid: UID.cal, status: "Lost" })).json.reason).toBe("That fob is already Revoked");
  });
});

describe("enrol", () => {
  test("tap Enrol, tap the new fob, add a new person: next P### ID, Level 1, Issued today", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/enrol/start", { session: s })).json.message).toBe("Tap the new fob");
    h.tap("04 11 22 33 44 55 66");
    const cap = h.events.filter((e) => e.event === "captured").at(-1)!.data;
    expect(cap).toEqual({ ok: true, purpose: "enrol", uid: "04112233445566", existing: null });
    expect(h.sid()).toBe(s); // the capture tap didn't replace the menu
    const r = (await h.req("POST", "/api/admin/enrol", { session: s, uid: "04112233445566", person: { name: "Dee New", type: "Student", year: 8, specialism: "Sound" }, role: "Standard" })).json;
    expect(r).toMatchObject({ ok: true, message: "Fob enrolled to Dee", personId: "P007" });
    expect(getPerson(h.db, "P007")).toMatchObject({ name: "Dee New", type: "Student", year: 8, level: 1, specialism: "Sound", status: "Active" });
    expect(getFob(h.db, "04112233445566")).toMatchObject({ person_id: "P007", role: "Standard", status: "Active", issued: "2026-11-16" });
    expect(h.db.query<{ sheet: string; field: string }, []>("SELECT sheet, field FROM panel_changes ORDER BY id").all()).toEqual([
      { sheet: "people", field: "*" },
      { sheet: "fobs", field: "*" },
    ]);
    expect(actions(h)[0]).toMatchObject({ action: "fob_enrolled", uid: "04112233445566", newPerson: true, confirmedBy: null });
    h.tap("04112233445566");
    expect(h.hub.panel.view()).toMatchObject({ kind: "crew", name: "Dee", level: 1 });
  });

  test("a spare fob to an existing person, as an Admin fob", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/enrol/start", { session: s });
    h.tap(UID.spare);
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: true, existing: "Spare" });
    const r = (await h.req("POST", "/api/admin/enrol", { session: s, uid: UID.spare, personId: "P002", role: "Admin", issued: "2026-11-20" })).json;
    expect(r.message).toBe("Fob enrolled to Mrs Ritter");
    expect(getFob(h.db, UID.spare)).toMatchObject({ person_id: "P002", role: "Admin", status: "Active", issued: "2026-11-20" });
  });

  test("refuses lost fobs and fobs already enrolled; person list uses first names", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/enrol/start", { session: s });
    h.tap(UID.lost);
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: false, reason: "That fob is Lost. Lost and revoked fobs are never reused" });
    expect((await h.req("POST", "/api/admin/enrol", { session: s, uid: UID.ada, personId: "P005" })).json.reason).toBe("That fob is already enrolled to Ada");
    expect((await h.req("POST", "/api/admin/enrol", { session: s, uid: "01020304", person: { name: " ", type: "Student", year: 8 } })).json.reason).toBe("Type a name");
    const people = (await h.req("GET", `/api/admin/people?session=${s}`)).json.people.map((p: { name: string }) => p.name);
    expect(people).toEqual(["Ada", "Cal", "Daniel", "Hire", "Mrs Ritter"]); // Ben has left
  });

  test("capture times out", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/enrol/start", { session: s });
    h.advance(30_000);
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: false, reason: "No fob tapped in time" });
    h.tap(UID.ada); // now a normal tap again
    expect(h.hub.panel.view()?.kind).toBe("crew");
  });
});

describe("guest day pass", () => {
  test("tap a Spare fob, enter company / reason and level; works today only; issuer recorded", async () => {
    const h = setup();
    const s = admin(h, UID.ritterAdmin);
    await h.req("POST", "/api/admin/day-pass/start", { session: s });
    h.tap(UID.spare);
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: true, purpose: "day_pass" });
    const r = (await h.req("POST", "/api/admin/day-pass", { session: s, uid: UID.spare, guest: "Acme Lighting, rig check", level: 3 })).json;
    expect(r.message).toBe("Day pass ready: Level 3, today only");
    expect(getFob(h.db, UID.spare)).toMatchObject({
      person_id: null,
      role: "Day pass",
      status: "Active",
      level: 3,
      issued: "2026-11-16",
      notes: "Day pass: Acme Lighting, rig check (issued by Mrs Ritter)",
    });
    expect(actions(h)[0]).toMatchObject({ action: "day_pass_issued", guest: "Acme Lighting, rig check", level: 3, issuedBy: UID.ritterAdmin });
    h.tap(UID.spare);
    expect(h.hub.panel.view()).toMatchObject({ name: "Guest", level: 3 });
    // tomorrow it's expired, and can go to the next guest
    h.setNow(new Date("2026-11-17T10:00:00Z"));
    h.tap(UID.spare);
    expect(h.events.at(-1)).toMatchObject({ event: "denied", data: { reason: "Day pass has expired" } });
    const s2 = admin(h);
    expect((await h.req("POST", "/api/admin/day-pass", { session: s2, uid: UID.spare, guest: "Next guest" })).json.message).toBe("Day pass ready: Level 1, today only");
  });

  test("refuses a fob that isn't spare, and a blank reason", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/day-pass", { session: s, uid: UID.ada, guest: "x" })).json.reason).toBe("That isn't a spare fob");
    expect((await h.req("POST", "/api/admin/day-pass", { session: s, uid: UID.dayPass, guest: "x" })).json.reason).toBe("That day pass is in use today");
    expect((await h.req("POST", "/api/admin/day-pass", { session: s, uid: UID.spare, guest: "  " })).json.reason).toBe("Type the company or reason");
  });
});

describe("force return", () => {
  test("confirmed; the holder's card shows it returned; log says who did it", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" });
    const s = admin(h, UID.ritterAdmin);
    expect((await h.req("GET", `/api/admin/kit-out?session=${s}`)).json.kit).toEqual([{ kit_id: "K004", item: "Gaffer tape", holder: "Ada", since: T0.toISOString() }]);
    expect((await h.req("POST", "/api/admin/force-return", { session: s, kitId: "K004" })).json.confirm).toBe("tap");
    h.tap(UID.danielAdmin);
    const kitIn = h.log("kit_in")[0]!;
    expect(kitIn).toMatchObject({ person_id: "P001", fob_uid: UID.ada, kit_id: "K004", detail: { forced: true, by: UID.danielAdmin } });
    expect(actions(h)[0]).toMatchObject({ action: "force_return", openedBy: UID.ritterAdmin, confirmedBy: UID.danielAdmin });
    h.tap(UID.ada);
    expect(h.hub.panel.view()?.kitOut).toEqual([]);
    const log = (await h.req("GET", `/api/admin/events?session=${admin(h)}&type=kit_in`)).json.events;
    expect(log[0].text).toBe("Gaffer tape returned for Ada by Daniel");
  });
});

describe("end of session", () => {
  test("lists kit out and open boxes, locks every box, turns show mode off, signs nobody out", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" });
    h.bus.deliver("box/BOX-01/state", { lock: "open" });
    const s = admin(h);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    h.tap(UID.ritterAdmin);
    const pre = (await h.req("GET", `/api/admin/end-of-session?session=${s}`)).json;
    expect(pre).toEqual({ kitOut: [{ kit_id: "K004", item: "Gaffer tape", holder: "Ada", since: T0.toISOString() }], boxesOpen: [{ box_id: "BOX-01", name: "Mic box", lock: "open", door: null }], showMode: true });
    const r = (await h.req("POST", "/api/admin/end-of-session", { session: s })).json;
    expect(r.message).toBe("Locking 2 boxes. Show mode is off");
    expect(getFlag(h.db, "show_mode")).toBe(false);
    const locks = h.bus.sent.filter((m) => m.topic.endsWith("/cmd")).map((m) => [m.topic, JSON.parse(m.payload).cmd]);
    expect(locks).toEqual([
      ["box/CASE-01/cmd", "lock"],
      ["box/BOX-01/cmd", "lock"],
    ]);
    expect(JSON.parse(h.bus.retained.get("box/BOX-01/mode")!).show).toBe(false);
    expect(actions(h).at(-1)).toMatchObject({ action: "end_of_session", kitOut: ["K004"], boxesOpen: ["BOX-01"], showModeWasOn: true });
    expect(h.log("sign_out")).toEqual([]);
  });
});

describe("backup now", () => {
  test("writes a snapshot, keeps the newest 14, logs it", async () => {
    const h = setup();
    const s = admin(h);
    const dir = h.hub.admin.backupDir()!;
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 14; i++) writeFileSync(`${dir}/tech-access-202601${String(i).padStart(2, "0")}-120000.db`, "old");
    const r = (await h.req("POST", "/api/admin/backup", { session: s })).json;
    expect(r.ok).toBe(true);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(14);
    expect(files.at(-1)).toBe("tech-access-20261116-180000.db");
    expect(files[0]).toBe("tech-access-20260102-120000.db");
    expect(actions(h)[0]).toMatchObject({ action: "backup", confirmedBy: null });
    expect((await h.req("GET", `/api/admin/status?session=${s}`)).json.lastBackup).toEndWith("tech-access-20261116-180000.db");
  });
});

describe("hub status, restart, reboot", () => {
  test("status has version, uptime, disk, temperature, MQTT, reader", async () => {
    const h = setup();
    const st = (await h.req("GET", `/api/admin/status?session=${admin(h)}`)).json;
    expect(st).toMatchObject({ version: expect.any(String), schemaVersion: 3, tempC: 48.5, diskFreeMB: 200000, mqtt: true, reader: { state: "ok" } });
    expect(typeof st.uptimeSeconds).toBe("number");
  });

  test("restart hub and reboot Pi are confirmed, logged, then run the polkit-allowed commands", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/restart", { session: s, what: "hub" });
    expect(h.ran).toEqual([]);
    h.tap(UID.danielAdmin);
    expect(h.ran).toEqual([RESTART_HUB]);
    await h.req("POST", "/api/admin/restart", { session: s, what: "pi" });
    h.tap(UID.ritterAdmin);
    expect(h.ran).toEqual([RESTART_HUB, REBOOT_PI]);
    expect(RESTART_HUB).toEqual(["systemctl", "--no-ask-password", "restart", "tech-access-hub.service"]);
    expect(actions(h).map((a) => [a.action, a.confirmedBy])).toEqual([
      ["restart_hub", UID.danielAdmin],
      ["reboot_pi", UID.ritterAdmin],
    ]);
  });
});

describe("event log", () => {
  test("newest first, first names, filters, paging", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/sign", { session: h.sid() });
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K003" });
    h.tap(UID.unknown);
    const s = admin(h);
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    h.tap(UID.danielAdmin);
    const all = (await h.req("GET", `/api/admin/events?session=${s}`)).json;
    expect(all.events.map((e: { text: string }) => e.text)).toEqual([
      "Mrs Ritter turned show mode on (confirmed by Daniel)",
      "Panel refused fob …9999: Fob not recognised",
      "LX case opened for Ada (take kit)",
      "Ada took Par can",
      "Ada signed in",
    ]);
    expect(all).toMatchObject({ page: 1, pages: 1, total: 5 });
    const ada = (await h.req("GET", `/api/admin/events?session=${s}&person=P001`)).json.events;
    expect(ada).toHaveLength(3);
    expect((await h.req("GET", `/api/admin/events?session=${s}&box=CASE-01`)).json.events).toHaveLength(2); // kit_out + box_open
    expect((await h.req("GET", `/api/admin/events?session=${s}&kit=K003`)).json.events).toHaveLength(2);
    expect((await h.req("GET", `/api/admin/events?session=${s}&type=sign_in`)).json.events).toHaveLength(1);
    for (let i = 0; i < 45; i++) h.hub.panel.log("sign_in", null, { person_id: "P005" });
    const p2 = (await h.req("GET", `/api/admin/events?session=${s}&page=2`)).json;
    expect(p2).toMatchObject({ page: 2, pages: 2, total: 50 });
    expect(p2.events).toHaveLength(10);
    const f = (await h.req("GET", `/api/admin/event-filters?session=${s}`)).json;
    expect(f.people.map((p: { name: string }) => p.name)).toContain("Mrs Ritter");
  });
});

describe("import vs panel changes (round trips)", () => {
  async function exportFile(h: H): Promise<Uint8Array> {
    const res = await h.hub.app.request("/api/export.xlsx", {}, LOCAL);
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }
  async function upload(h: H, file: Uint8Array) {
    const form = new FormData();
    form.append("file", new File([file as Uint8Array<ArrayBuffer>], "tracker.xlsx"));
    const res = await h.hub.app.request("/api/import", { method: "POST", body: form }, LOCAL);
    return (await res.json()) as { batchId: number; conflictCount: number; diff: { conflicts: { key: string; panel: unknown; sheetValue: unknown; kind: string }[]; empty: boolean } };
  }
  const apply = (h: H, id: number, resolutions?: Record<string, string>) =>
    h.req("POST", `/api/import/${id}/apply`, { fobUid: UID.ritterAdmin, resolutions });
  async function markAdaLost(h: H) {
    const s = admin(h);
    await h.req("POST", "/api/admin/fob-status", { session: s, uid: UID.ada, status: "Lost" });
    h.tap(UID.ritterAdmin);
    h.hub.panel.close();
  }

  test("(a) panel change, then an older sheet imported -> conflict; apply refuses until chosen; keep panel keeps it", async () => {
    const h = setup();
    const older = await exportFile(h);
    await markAdaLost(h);
    const p = await upload(h, older);
    expect(p.conflictCount).toBe(2);
    expect(p.diff.conflicts.map((c) => [c.key, c.panel, c.sheetValue])).toEqual([
      [`fobs/${UID.ada}/Status`, "Lost", "Active"],
      [`fobs/${UID.ada}/Ended`, "2026-11-16", null],
    ]);
    const refused = await apply(h, p.batchId);
    expect(refused.status).toBe(409);
    expect(refused.json.kind).toBe("unresolved");
    expect((await apply(h, p.batchId, { [`fobs/${UID.ada}/Status`]: "panel" })).json.keys).toEqual([`fobs/${UID.ada}/Ended`]);
    const done = await apply(h, p.batchId, { [`fobs/${UID.ada}/Status`]: "panel", [`fobs/${UID.ada}/Ended`]: "panel" });
    expect(done.status).toBe(200);
    expect(getFob(h.db, UID.ada)).toMatchObject({ status: "Lost", ended: "2026-11-16" });
    // still not exported, so the same old sheet still conflicts
    expect((await upload(h, older)).conflictCount).toBe(2);
  });

  test("(a') use sheet: the workbook wins and the panel change stops protecting the field", async () => {
    const h = setup();
    const older = await exportFile(h);
    await markAdaLost(h);
    const p = await upload(h, older);
    await apply(h, p.batchId, { [`fobs/${UID.ada}/Status`]: "sheet", [`fobs/${UID.ada}/Ended`]: "sheet" });
    expect(getFob(h.db, UID.ada)).toMatchObject({ status: "Active", ended: null });
    const again = await upload(h, older);
    expect(again.conflictCount).toBe(0);
    expect(again.diff.empty).toBe(true);
  });

  test("(b) panel change, then export, then that file imported -> no conflict", async () => {
    const h = setup();
    await markAdaLost(h);
    const exported = await exportFile(h);
    const p = await upload(h, exported);
    expect(p.conflictCount).toBe(0);
    expect(p.diff.empty).toBe(true);
    expect(h.db.query("SELECT COUNT(*) AS n FROM panel_changes WHERE exported_at IS NULL").get()).toEqual({ n: 0 });
    // and an older file now just shows normal changes, not conflicts
  });

  test("a person and fob added on the panel are removal conflicts for an older sheet", async () => {
    const h = setup();
    const older = await exportFile(h);
    const s = admin(h);
    await h.req("POST", "/api/admin/enrol", { session: s, uid: "01020304", person: { name: "Dee New", type: "Staff" } });
    h.hub.panel.close();
    const p = await upload(h, older);
    expect(p.diff.conflicts.map((c) => [c.key, c.kind])).toEqual([
      ["people/P007/*", "removal"],
      ["fobs/01020304/*", "removal"],
    ]);
    await apply(h, p.batchId, { "people/P007/*": "panel", "fobs/01020304/*": "panel" });
    expect(getPerson(h.db, "P007")?.name).toBe("Dee New");
    expect(getFob(h.db, "01020304")?.status).toBe("Active");
  });

  test("apply from the panel goes through tap-to-confirm with the resolutions", async () => {
    const h = setup();
    const older = await exportFile(h);
    await markAdaLost(h);
    const p = await upload(h, older);
    const s = admin(h, UID.danielAdmin);
    const res = { [`fobs/${UID.ada}/Status`]: "panel", [`fobs/${UID.ada}/Ended`]: "panel" };
    expect((await h.req("POST", "/api/admin/import-apply", { session: s, batchId: p.batchId, resolutions: res })).json.confirm).toBe("tap");
    h.tap(UID.ritterAdmin);
    expect(confirmEvents(h).at(-1)).toMatchObject({ ok: true, message: "Workbook applied" });
    const ev = h.log("import_applied")[0]!;
    expect(ev).toMatchObject({ fob_uid: UID.ritterAdmin, detail: { resolutions: res } });
  });
});

describe("event log wording for admin actions", () => {
  test("names the admin who acted and the person it was about", async () => {
    const h = setup();
    const s = admin(h, UID.ritterAdmin);
    await h.req("POST", "/api/admin/fob-status", { session: s, uid: UID.cal, status: "Lost" });
    await h.req("POST", "/api/admin/enrol", { session: s, uid: "01020304", personId: "P001" });
    await h.req("POST", "/api/admin/show-mode", { session: s, on: true });
    h.tap(UID.danielAdmin);
    const texts = (await h.req("GET", `/api/admin/events?session=${s}`)).json.events.map((e: { text: string }) => e.text);
    expect(texts).toEqual([
      "Mrs Ritter turned show mode on (confirmed by Daniel)",
      "Mrs Ritter enrolled a fob for Ada",
      "Mrs Ritter marked Cal's fob lost",
    ]);
  });
});
