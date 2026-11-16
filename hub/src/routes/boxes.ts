// Box status for any panel client (the web panel today, the native panel app later), and
// firmware downloads for the boxes themselves.
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { controlOnly } from "../controlOnly";
import { allBoxes, getFob, getPerson } from "../data";
import type { Firmware } from "../firmware";
import { localOnly } from "../localOnly";
import type { BoxLink } from "../mqtt/boxes";
import { firstName } from "../names";

/** GET /api/boxes: loopback only, like the rest of the panel API (no names leave the Pi). */
export function boxRoutes(db: Database, boxes: BoxLink) {
  const r = new Hono();
  r.use("/boxes", localOnly());
  r.get("/boxes", (c) => {
    const taps = boxes.lastTaps();
    const who = (uid: string | null, personId: string | null): string | null => {
      if (personId) return firstName(getPerson(db, personId)?.name ?? personId);
      if (!uid) return null;
      const f = getFob(db, uid);
      return f?.role === "Day pass" ? "a guest" : `fob …${uid.slice(-4)}`;
    };
    return c.json({
      mqtt: boxes.connected(),
      boxes: allBoxes(db).map((b) => {
        const t = taps.get(b.box_id);
        return {
          box_id: b.box_id,
          name: b.name,
          type: b.type,
          location: b.location,
          // locked / open / offline / never_seen (offline = no heartbeat for 90 s)
          status: boxes.status(b),
          lock: b.lock_state,
          lockAt: b.lock_state_at,
          // open / shut / null (no reed switch, or never reported)
          door: b.door_state,
          doorAt: b.door_state_at,
          lastSeen: b.last_seen,
          fw: b.fw,
          lastTap: t ? { ts: t.ts, who: who(t.fob_uid, t.person_id), result: t.result, reason: t.reason, source: t.source } : null,
          ota: b.ota_status ? { status: b.ota_status, version: b.ota_version, why: b.ota_why, at: b.ota_at } : null,
        };
      }),
    });
  });
  return r;
}

/** GET /fw/<file>: read-only, Control subnet only. */
export function firmwareFileRoutes(firmware: Firmware) {
  const r = new Hono();
  r.use("/fw/*", controlOnly());
  r.get("/fw/:file", (c) => {
    const path = firmware.pathFor(c.req.param("file"));
    if (!path) return c.text("Not found", 404);
    const f = Bun.file(path);
    return new Response(f, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(f.size), "Cache-Control": "no-store" } });
  });
  return r;
}
