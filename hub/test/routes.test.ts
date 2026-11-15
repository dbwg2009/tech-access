import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEFAULTS } from "../src/config";
import { ADMIN_UID, good } from "./fixtures";
import { freshDb } from "./helpers";

const env = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1234 }) });
const LOCAL = env("127.0.0.1");

function app() {
  return createApp({ db: freshDb(), config: { ...DEFAULTS, dbPath: ":memory:" }, now: () => new Date("2026-11-15T18:00:00Z") });
}

function upload(a: ReturnType<typeof app>, e = LOCAL) {
  const form = new FormData();
  form.append("file", new File([good()], "tracker.xlsx"));
  return a.request("/api/import", { method: "POST", body: form }, e);
}

describe("import/export routes", () => {
  test("admin routes refuse anything but loopback", async () => {
    const a = app();
    expect((await upload(a, env("10.102.100.101"))).status).toBe(403);
    expect((await a.request("/api/export.xlsx", {}, env("10.102.200.50"))).status).toBe(403);
    expect((await a.request("/api/export.xlsx", {})).status).toBe(403); // no connection info
  });

  test("health stays open to the network", async () => {
    expect((await app().request("/api/health", {}, env("10.102.100.101"))).status).toBe(200);
  });

  test("upload -> preview -> apply -> second apply no-op -> export", async () => {
    const a = app();
    const res = await upload(a);
    expect(res.status).toBe(201);
    const preview = (await res.json()) as { batchId: number; canApply: boolean; diff: { counts: { people: { adds: number } } } };
    expect(preview.canApply).toBe(true);
    expect(preview.diff.counts.people.adds).toBe(4);

    const apply = (uid: unknown) =>
      a.request(`/api/import/${preview.batchId}/apply`, { method: "POST", body: JSON.stringify({ fobUid: uid }), headers: { "content-type": "application/json" } }, LOCAL);
    expect((await apply("AABBCCDD")).status).toBe(403); // day pass, not admin
    expect((await apply(42)).status).toBe(400);
    const ok = await apply(ADMIN_UID);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: "applied" });
    expect(await (await apply(ADMIN_UID)).json()).toMatchObject({ kind: "already_applied" });

    const ex = await a.request("/api/export.xlsx", {}, LOCAL);
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toContain("tech-access-2026-11-15.xlsx");
    expect((await ex.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  test("bad upload", async () => {
    const r = await app().request("/api/import", { method: "POST", body: new FormData() }, LOCAL);
    expect(r.status).toBe(400);
  });

  test("unknown import id", async () => {
    expect((await app().request("/api/import/99", {}, LOCAL)).status).toBe(404);
  });

  test("static: no path traversal", async () => {
    expect((await app().request("/../package.json")).status).toBe(404);
    expect((await app().request("/%2e%2e/package.json")).status).toBe(404);
  });
});
