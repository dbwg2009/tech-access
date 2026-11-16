import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { extname, resolve, sep } from "node:path";
import type { Config } from "./config";
import { schemaVersion } from "./db";
import type { FobReader } from "./reader/types";
import type { Panel } from "./panel/panel";
import { devRoutes } from "./routes/dev";
import { panelRoutes } from "./routes/panel";
import { importRoutes } from "./routes/import";
import { VERSION } from "./version";

export interface AppDeps {
  db: Database;
  config: Config;
  startedAt?: number;
  now?: () => Date;
  /** Desk fob reader. Optional so tests that don't care about it can leave it out. */
  reader?: FobReader;
  /** Desk panel (sessions, crew and admin actions). Optional for import-only tests. */
  panel?: Panel;
  /** Called after an import is applied, so box allowlists and the panel refresh. */
  onDataChanged?: () => void;
}

const PUBLIC_DIR = resolve(import.meta.dir, "../public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function createApp({ db, config, startedAt = Date.now(), now = () => new Date(), reader, panel, onDataChanged }: AppDeps) {
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
        // A missing reader doesn't make the hub unhealthy: boxes and the API still work.
        reader: reader ? { kind: reader.kind, ...reader.status() } : null,
      },
      dbStatus === "ok" ? 200 : 503,
    );
  });

  app.route("/api", importRoutes(db, config, now, onDataChanged));
  app.route("/api", devRoutes(reader));
  if (panel) app.route("/api", panelRoutes(panel, { fakeReader: config.fakeReader }));
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // Local static files only. No CDN.
  app.get("/*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    const path = resolve(PUBLIC_DIR, "." + (rel.endsWith("/") ? rel + "index.html" : rel));
    if (path !== PUBLIC_DIR && !path.startsWith(PUBLIC_DIR + sep)) return c.notFound();
    const file = Bun.file(path);
    if (!(await file.exists())) return c.notFound();
    return new Response(file, { headers: { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" } });
  });

  return app;
}
