// Development routes for the fake reader. They only exist when `fake_reader = true`, and only
// answer on loopback, like the other admin routes.
import { Hono } from "hono";
import { localOnly } from "../localOnly";
import { FakeReader } from "../reader/fake";
import type { FobReader } from "../reader/types";

export function devRoutes(reader: FobReader | undefined) {
  const r = new Hono();
  if (!(reader instanceof FakeReader)) return r; // no routes: falls through to 404

  r.use("*", localOnly());

  r.post("/dev/tap", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { uid?: unknown } | null;
    if (!body || typeof body.uid !== "string") return c.json({ error: 'Body must be {"uid": "..."}' }, 400);
    try {
      return c.json(reader.tap(body.uid));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  r.post("/dev/tap-next", (c) => {
    try {
      return c.json(reader.tapNext());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  r.get("/dev/fobs", (c) => c.json({ fobs: reader.list() }));

  return r;
}
