import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEFAULTS, parseConfig } from "../src/config";
import { FakeReader } from "../src/reader/fake";
import type { Tap } from "../src/reader/types";
import { freshDb } from "./helpers";

const env = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1234 }) });
const LOCAL = env("127.0.0.1");
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

function setup(fake = true) {
  const reader = new FakeReader(["AAAAAAAA", "04A1B2C3D4E580"]);
  reader.start();
  const app = createApp({ db: freshDb(), config: { ...DEFAULTS, dbPath: ":memory:", fakeReader: fake }, reader: fake ? reader : undefined });
  const taps: Tap[] = [];
  reader.on("tap", (t) => taps.push(t));
  return { app, taps };
}

describe("POST /api/dev/tap (fake reader)", () => {
  test("emits a normalised tap from loopback", async () => {
    const { app, taps } = setup();
    const res = await app.request("/api/dev/tap", post({ uid: "04:a1:b2:c3:d4:e5:80" }), LOCAL);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Tap).uid).toBe("04A1B2C3D4E580");
    expect(taps.map((t) => t.uid)).toEqual(["04A1B2C3D4E580"]);
  });

  test("bad UID -> 400, nothing emitted", async () => {
    const { app, taps } = setup();
    expect((await app.request("/api/dev/tap", post({ uid: "nope" }), LOCAL)).status).toBe(400);
    expect((await app.request("/api/dev/tap", post({}), LOCAL)).status).toBe(400);
    expect(taps).toEqual([]);
  });

  test("loopback only", async () => {
    const { app, taps } = setup();
    expect((await app.request("/api/dev/tap", post({ uid: "AAAAAAAA" }), env("10.102.200.20"))).status).toBe(403);
    expect(taps).toEqual([]);
  });

  test("doesn't exist without the fake reader", async () => {
    const { app } = setup(false);
    expect((await app.request("/api/dev/tap", post({ uid: "AAAAAAAA" }), LOCAL)).status).toBe(404);
  });

  test("tap-next cycles through fake_fobs; fobs lists them", async () => {
    const { app, taps } = setup();
    await app.request("/api/dev/tap-next", { method: "POST" }, LOCAL);
    await app.request("/api/dev/tap-next", { method: "POST" }, LOCAL);
    expect(taps.map((t) => t.uid)).toEqual(["AAAAAAAA", "04A1B2C3D4E580"]);
    expect(await (await app.request("/api/dev/fobs", {}, LOCAL)).json()).toEqual({ fobs: ["AAAAAAAA", "04A1B2C3D4E580"] });
  });

  test("health shows the reader, and stays 200 whatever its state", async () => {
    const { app } = setup();
    const res = await app.request("/api/health", {}, env("10.102.100.101"));
    expect(res.status).toBe(200);
    const h = (await res.json()) as { reader: { kind: string; state: string } };
    expect(h.reader.kind).toBe("fake");
    expect(h.reader.state).toBe("ok");
  });
});

describe("reader config", () => {
  test("defaults", () => {
    const c = parseConfig("", "/tmp");
    expect(c.fakeReader).toBe(false);
    expect(c.readerDevice).toBe("/dev/ttyAMA0");
    expect(c.fakeFobs).toEqual([]);
  });

  test("fake_fobs are normalised; bad ones refused", () => {
    expect(parseConfig('fake_reader = true\nfake_fobs = ["aa:aa:aa:aa"]', "/tmp").fakeFobs).toEqual(["AAAAAAAA"]);
    expect(() => parseConfig('fake_fobs = ["12"]', "/tmp")).toThrow("fake_fobs");
    expect(() => parseConfig("fake_fobs = [12345678]", "/tmp")).toThrow("quoted");
    expect(() => parseConfig('fake_reader = "yes"', "/tmp")).toThrow("true or false");
  });
});
