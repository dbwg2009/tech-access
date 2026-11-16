import { describe, expect, test } from "bun:test";
import { getBox, getFob, getKit, getPerson } from "../src/data";
import { LOCAL, setup } from "./harness";
import { UID } from "./seed";

type H = ReturnType<typeof setup>;
const admin = (h: H, uid: string = UID.ritterAdmin) => {
  h.tap(uid);
  return h.sid()!;
};
const actions = (h: H) => h.log("admin_action").map((e) => e.detail);

describe("people", () => {
  test("list: full names, fobs, Left at the bottom, search", async () => {
    const h = setup();
    const s = admin(h);
    const people = (await h.req("GET", `/api/admin/edit/people?session=${s}`)).json.people;
    expect(people.map((p: { name: string }) => p.name)).toEqual(["Ada Crew", "Cal Newbie", "Daniel W", "Hire Person", "Mrs Ritter", "Ben Left"]);
    expect(people[0]).toMatchObject({ person_id: "P001", type: "Student", year: 9, level: 2, specialism: "Lighting", fobs: [{ fob_uid: UID.ada, role: "Standard", status: "Active" }] });
    expect(people.at(-1).fobs).toEqual([]); // Ben's lost fob isn't listed
    const found = (await h.req("GET", `/api/admin/edit/people?session=${s}&q=crew`)).json.people;
    expect(found.map((p: { person_id: string }) => p.person_id)).toEqual(["P001"]);
  });

  test("edit: level change saved, logged, tracked; the card follows", async () => {
    const h = setup();
    const s = admin(h);
    const p = (await h.req("GET", `/api/admin/edit/person?session=${s}&id=P005`)).json.person;
    const r = (await h.req("POST", "/api/admin/edit/person", { session: s, id: "P005", fields: { ...p, level: 3 } })).json;
    expect(r).toMatchObject({ ok: true, message: "Saved", fields: ["level"] });
    expect(getPerson(h.db, "P005")?.level).toBe(3);
    expect(actions(h)[0]).toMatchObject({ action: "edit_person", id: "P005", openedBy: UID.ritterAdmin });
    expect(h.db.query("SELECT sheet, row_id, field, new_value FROM panel_changes").all()).toEqual([{ sheet: "people", row_id: "P005", field: "level", new_value: "3" }]);
    expect((await h.req("POST", "/api/admin/edit/person", { session: s, id: "P005", fields: { ...p, level: 3 } })).json.message).toBe("No change");
    h.tap(UID.cal);
    expect(h.hub.panel.view()?.level).toBe(3);
  });

  test("validation in plain words; staff lose year and level", async () => {
    const h = setup();
    const s = admin(h);
    const p = (await h.req("GET", `/api/admin/edit/person?session=${s}&id=P001`)).json.person;
    expect((await h.req("POST", "/api/admin/edit/person", { session: s, id: "P001", fields: { ...p, level: 5 } })).json.reason).toBe("Level: 5 must be between 1 and 4");
    expect((await h.req("POST", "/api/admin/edit/person", { session: s, id: "P001", fields: { ...p, name: " " } })).json.reason).toBe("Name: is needed");
    expect((await h.req("POST", "/api/admin/edit/person", { session: s, id: "P001", fields: { ...p, type: "Teacher" } })).json.reason).toMatch(/^Type: "Teacher" is not one of/);
    await h.req("POST", "/api/admin/edit/person", { session: s, id: "P001", fields: { ...p, type: "Staff" } });
    expect(getPerson(h.db, "P001")).toMatchObject({ type: "Staff", year: null, level: null });
  });

  test("add a person: next P###, Active", async () => {
    const h = setup();
    const s = admin(h);
    const r = (await h.req("POST", "/api/admin/edit/person", { session: s, fields: { name: "Eve Example", type: "Student", year: 8, level: 1, specialism: "Sound" } })).json;
    expect(r).toMatchObject({ ok: true, id: "P007" });
    expect(getPerson(h.db, "P007")).toMatchObject({ name: "Eve Example", status: "Active", level: 1 });
    expect(actions(h)[0]).toMatchObject({ action: "add_person", id: "P007" });
  });

  test("remove: Left, and their fobs revoked", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/edit/person/leave", { session: s, id: "P001" })).json.message).toBe("Ada Crew marked as left; 1 fob revoked");
    expect(getPerson(h.db, "P001")?.status).toBe("Left");
    expect(getFob(h.db, UID.ada)).toMatchObject({ status: "Revoked", ended: "2026-11-16" });
  });

  test("fob role: Standard -> Admin opens the admin menu next time", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/edit/fob/role", { session: s, uid: UID.hire, role: "Admin" })).json.message).toBe("Fob is now an admin fob");
    h.tap(UID.hire);
    expect(h.hub.panel.view()?.kind).toBe("admin");
    expect((await h.req("POST", "/api/admin/edit/fob/role", { session: h.sid(), uid: UID.dayPass, role: "Admin" })).json.ok).toBe(false);
  });

  test("add fob: tap a new fob on the profile, it's theirs", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/edit/fob/add/start", { session: s, personId: "P005" })).json.message).toBe("Tap the new fob");
    h.tap("0B0B0B0B");
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: true, purpose: "add_fob", uid: "0B0B0B0B", personId: "P005" });
    expect(getFob(h.db, "0B0B0B0B")).toMatchObject({ person_id: "P005", role: "Standard", status: "Active", issued: "2026-11-16" });
    expect(h.sid()).toBe(s);
    await h.req("POST", "/api/admin/edit/fob/add/start", { session: s, personId: "P005" });
    h.tap(UID.lost);
    expect(h.events.filter((e) => e.event === "captured").at(-1)!.data).toMatchObject({ ok: false, purpose: "add_fob" });
  });
});

describe("find by scanning a fob", () => {
  test("in the editor a tap finds the owner instead of opening a new card", async () => {
    const h = setup();
    const s = admin(h);
    await h.req("POST", "/api/admin/edit/find", { session: s, on: true });
    const found = () => h.events.filter((e) => e.event === "found").at(-1)!.data;
    h.tap(UID.cal);
    expect(found()).toEqual({ ok: true, kind: "person", id: "P005", uid: UID.cal });
    expect(h.sid()).toBe(s);
    h.tap(UID.spare);
    expect(found()).toEqual({ ok: true, kind: "spare", uid: UID.spare });
    h.tap(UID.unknown);
    expect(found()).toMatchObject({ ok: false, reason: "Fob …9999 isn't in the hub. Open a person and use Add fob" });
    await h.req("POST", "/api/admin/edit/find", { session: s, on: false });
    h.tap(UID.cal);
    expect(h.hub.panel.view()?.name).toBe("Cal");
  });
});

describe("kit", () => {
  test("add (next K###), edit with a box, validation", async () => {
    const h = setup();
    const s = admin(h);
    const add = (await h.req("POST", "/api/admin/edit/kit", { session: s, fields: { item: "Radio mic 2", category: "Radio mics", required_level: 2, specialism: "Sound", box_id: "BOX-01", slot: "A2" } })).json;
    expect(add).toMatchObject({ ok: true, id: "K005" });
    expect(getKit(h.db, "K005")).toMatchObject({ item: "Radio mic 2", box_id: "BOX-01", slot: "A2" });
    expect((await h.req("POST", "/api/admin/edit/kit", { session: s, id: "K005", fields: { item: "Radio mic 2", category: "Radio mics", box_id: "NOPE" } })).json.reason).toBe("Box: that box doesn't exist");
    expect((await h.req("POST", "/api/admin/edit/kit", { session: s, id: "K005", fields: { item: "Radio mic 2", category: "Mics" } })).json.reason).toMatch(/^Category:/);
    const list = (await h.req("GET", `/api/admin/edit/kit?session=${s}`)).json.kit;
    expect(list.find((k: { kit_id: string }) => k.kit_id === "K005")).toMatchObject({ box: "Mic box", out: false });
  });

  test("remove: refused while out; archived otherwise and gone from lists", async () => {
    const h = setup();
    h.tap(UID.ada);
    await h.req("POST", "/api/panel/take", { session: h.sid(), kitId: "K004" });
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/edit/kit/remove", { session: s, id: "K004" })).json.reason).toBe("Gaffer tape is out. Return it first");
    expect((await h.req("POST", "/api/admin/edit/kit/remove", { session: s, id: "K003" })).json.message).toBe("Par can removed");
    expect(getKit(h.db, "K003")).toBeNull();
    expect((await h.req("GET", `/api/admin/edit/kit?session=${s}`)).json.kit.map((k: { kit_id: string }) => k.kit_id)).not.toContain("K003");
  });
});

describe("boxes", () => {
  test("add (next BOX-##), all fields, IP validated", async () => {
    const h = setup();
    const s = admin(h);
    const fields = { name: "Key cabinet", type: "Key cabinet", required_level: 3, network: "Ethernet", ip_address: "10.102.40.102", location: "Control room", offline_unlock_min: 5 };
    expect((await h.req("POST", "/api/admin/edit/box", { session: s, fields })).json.id).toBe("BOX-02");
    expect(getBox(h.db, "BOX-02")).toMatchObject({ name: "Key cabinet", ip_address: "10.102.40.102", required_level: 3 });
    expect((await h.req("POST", "/api/admin/edit/box", { session: s, id: "BOX-02", fields: { ...fields, ip_address: "10.102.40" } })).json.reason).toBe('IP address: "10.102.40" is not an IPv4 address');
    // a new box gets its retained cached list and mode
    expect(h.bus.retained.has("box/BOX-02/fobs")).toBe(true);
  });

  test("remove refused while kit lives in it", async () => {
    const h = setup();
    const s = admin(h);
    expect((await h.req("POST", "/api/admin/edit/box/remove", { session: s, id: "BOX-01" })).json.reason).toBe("2 items still live in Mic box. Move or remove them first");
    await h.req("POST", "/api/admin/edit/kit/remove", { session: s, id: "K003" });
    expect((await h.req("POST", "/api/admin/edit/box/remove", { session: s, id: "CASE-01" })).json.ok).toBe(true);
  });
});

describe("spare and guest fobs", () => {
  test("lists spares and day passes", async () => {
    const h = setup();
    const s = admin(h);
    const fobs = (await h.req("GET", `/api/admin/edit/spares?session=${s}`)).json.fobs;
    expect(fobs.map((f: { fob_uid: string; state: string }) => [f.fob_uid, f.state])).toEqual([
      [UID.spare, "spare"],
      [UID.dayPass, "day pass today"],
    ]);
  });
});

describe("import after removing on the panel", () => {
  test("an older sheet that brings back a removed item is a conflict (restore)", async () => {
    const h = setup();
    const older = new Uint8Array(await (await h.hub.app.request("/api/export.xlsx", {}, LOCAL)).arrayBuffer());
    const s = admin(h);
    await h.req("POST", "/api/admin/edit/kit/remove", { session: s, id: "K003" });
    h.hub.panel.close();
    const form = new FormData();
    form.append("file", new File([older as Uint8Array<ArrayBuffer>], "old.xlsx"));
    const p = (await (await h.hub.app.request("/api/import", { method: "POST", body: form }, LOCAL)).json()) as { batchId: number; diff: { conflicts: { key: string; kind: string }[] } };
    expect(p.diff.conflicts.map((c) => [c.key, c.kind])).toEqual([["kit/K003/*", "restore"]]);
    const apply = (res: Record<string, string>) => h.req("POST", `/api/import/${p.batchId}/apply`, { fobUid: UID.ritterAdmin, resolutions: res });
    expect((await apply({})).status).toBe(409);
    expect((await apply({ "kit/K003/*": "panel" })).status).toBe(200);
    expect(getKit(h.db, "K003")).toBeNull();
  });
});
