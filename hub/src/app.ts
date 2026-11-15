import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { Config } from "./config";
import { schemaVersion } from "./db";
import { VERSION } from "./version";

export interface AppDeps {
  db: Database;
  config: Config;
  startedAt?: number;
}

const PUBLIC_DIR = resolve(import.meta.dir, "../public");

export function createApp({ db, config, startedAt = Date.now() }: AppDeps) {
  const app = new Hono();

  app.get("/api/health", (c) => {
    let dbStatus = "ok";
    let schema: number | null = null;
    try {
      db.query("SELECT 1").get();
      schema = schemaVersion(db);
    } catch (e) {
      dbStatus = `error: ${(e as Error).message}`;
    }
    return c.json(
      {
        name: "tech-access hub",
        version: VERSION,
        schemaVersion: schema,
        db: dbStatus,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        timezone: config.timezone,
        now: new Date().toISOString(),
      },
      dbStatus === "ok" ? 200 : 503,
    );
  });

  app.use("/*", serveStatic({ root: PUBLIC_DIR, rewriteRequestPath: (p) => p }));

  return app;
}
