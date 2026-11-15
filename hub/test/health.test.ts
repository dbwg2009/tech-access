import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEFAULTS, parseConfig } from "../src/config";
import { openDb } from "../src/db";

const config = { ...DEFAULTS, dbPath: ":memory:" };

describe("health", () => {
  test("GET /api/health returns version, schema, db and uptime", async () => {
    const app = createApp({ db: openDb(":memory:"), config, startedAt: Date.now() - 5000 });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe("0.1.0");
    expect(body.db).toBe("ok");
    expect(typeof body.schemaVersion).toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  test("503 when the db is broken", async () => {
    const db = openDb(":memory:");
    db.close();
    const res = await createApp({ db, config }).request("/api/health");
    expect(res.status).toBe(503);
  });

  test("GET / serves the static page", async () => {
    const res = await createApp({ db: openDb(":memory:"), config }).request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("tech-access hub");
  });
});

describe("config", () => {
  test("parses TOML and resolves relative db path", () => {
    const c = parseConfig('db_path = "data/x.db"\nhttp_port = 9000\n', "/srv/hub");
    expect(c.dbPath).toBe("/srv/hub/data/x.db");
    expect(c.httpPort).toBe(9000);
    expect(c.timezone).toBe("Europe/London");
  });
  test("rejects a bad port and timezone", () => {
    expect(() => parseConfig("http_port = 0", "/")).toThrow();
    expect(() => parseConfig('timezone = "Mars/Base"', "/")).toThrow();
  });
});
