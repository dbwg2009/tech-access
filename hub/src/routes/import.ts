import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import { localOnly } from "../localOnly";
import { localDate } from "../workbook/normalise";
import { applyBatch, createBatch, getBatch } from "../workbook/batches";
import { exportWorkbook } from "../workbook/export";

const MAX_UPLOAD = 10 * 1024 * 1024;

export function importRoutes(db: Database, config: Config, now: () => Date) {
  const r = new Hono();
  r.use("*", localOnly());

  r.post("/import", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD) return c.json({ error: "File too large (10 MB max)" }, 413);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return c.json({ error: 'Send the .xlsx as multipart field "file"' }, 400);
    if (file.size > MAX_UPLOAD) return c.json({ error: "File too large (10 MB max)" }, 413);
    const preview = createBatch(db, new Uint8Array(await file.arrayBuffer()), file.name || null, now());
    return c.json(preview, 201);
  });

  r.get("/import/:id", (c) => {
    const p = getBatch(db, Number(c.req.param("id")));
    return p ? c.json(p) : c.json({ error: "No such import" }, 404);
  });

  r.post("/import/:id/apply", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { fobUid?: unknown } | null;
    if (!body || typeof body.fobUid !== "string") return c.json({ error: 'Body must be {"fobUid": "..."}' }, 400);
    const res = applyBatch(db, Number(c.req.param("id")), body.fobUid, now(), config.timezone);
    switch (res.kind) {
      case "applied":
      case "already_applied":
        return c.json(res, 200);
      case "not_found":
        return c.json({ ...res, error: "No such import" }, 404);
      case "forbidden":
        return c.json({ ...res, error: res.reason }, 403);
      case "has_errors":
        return c.json({ ...res, error: `Fix the ${res.errorCount} error(s) in the workbook first` }, 422);
      case "superseded":
        return c.json({ ...res, error: "A newer workbook was uploaded; apply that one" }, 409);
      case "stale":
        return c.json({ ...res, error: "The data changed since this preview; upload the workbook again" }, 409);
    }
  });

  r.get("/export.xlsx", (c) => {
    const t = now();
    const buf = exportWorkbook(db, t);
    return c.body(buf as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="tech-access-${localDate(t, config.timezone)}.xlsx"`,
    });
  });

  return r;
}
