// Admin menu API: loopback only, and every call needs the session ID of an open admin menu
// (opened by an Active Admin fob tap). Risky actions answer {confirm: "tap"} and run when an
// admin fob taps within 20 s; the result arrives on the panel stream as a `confirm` event.
import { Hono } from "hono";
import { localOnly } from "../localOnly";
import type { Admin } from "../panel/admin";
import type { Panel } from "../panel/panel";
import { body, send } from "./panel";
import { parseResolutions } from "./import";

export function adminRoutes(panel: Panel, admin: Admin) {
  const r = new Hono();
  r.use("/admin/*", localOnly());

  const session = (id: unknown) => panel.get(id, "admin");

  /** POST /admin/<name> {session, ...}: run `fn` with an admin session. */
  const post = (name: string, fn: (s: Exclude<ReturnType<typeof session>, { ok: false }>, b: Record<string, unknown>) => ReturnType<typeof send> | Parameters<typeof send>[1]) =>
    r.post(`/admin/${name}`, async (c) => {
      const b = await body(c);
      const s = session(b.session);
      if ("ok" in s) return send(c, s);
      const out = fn(s, b);
      return out instanceof Response ? out : send(c, out as Parameters<typeof send>[1]);
    });

  const get = (name: string, fn: (q: Record<string, string>) => unknown) =>
    r.get(`/admin/${name}`, (c) => {
      const s = session(c.req.query("session"));
      if ("ok" in s) return send(c, s);
      return c.json(fn(c.req.query()) as object);
    });

  get("menu", () => admin.menu());
  get("status", () => admin.status());
  get("fobs", () => ({ fobs: admin.fobs() }));
  get("people", () => ({ people: admin.people() }));
  get("kit-out", () => ({ kit: admin.kitOutList() }));
  get("end-of-session", () => admin.endOfSessionPreview());
  get("events", (q) => admin.events(q));
  get("event-filters", () => admin.eventFilters());

  post("cancel", (s) => panel.cancelPending(s));
  post("close", (s) => {
    panel.close("closed");
    return { ok: true, message: "Closed" };
  });
  post("students", (s, b) => admin.students(s, b.disabled));
  post("fob-status", (s, b) => admin.fobStatus(s, b.uid, b.status));
  post("enrol/start", (s) => admin.startEnrol(s));
  post("enrol", (s, b) => admin.enrol(s, b));
  post("day-pass/start", (s) => admin.startDayPass(s));
  post("day-pass", (s, b) => admin.dayPass(s, b));
  post("show-mode", (s, b) => admin.showMode(s, b.on));
  post("force-return", (s, b) => admin.forceReturn(s, b.kitId));
  post("end-of-session", (s) => admin.endOfSession(s));
  post("backup", (s) => admin.backup(s));
  post("restart", (s, b) => admin.restart(s, b.what));
  post("import-apply", (s, b) => {
    const res = parseResolutions(b.resolutions);
    if (!res) return { ok: false, reason: 'resolutions must be {"<key>": "panel" | "sheet"}', status: 400 };
    return admin.importApply(s, b.batchId, res);
  });

  return r;
}
