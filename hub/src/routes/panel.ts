// Desk panel API. Loopback only (the panel is Chromium on the Pi). Every call that acts for a
// person takes the session ID from the fob tap that opened the card.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { localOnly } from "../localOnly";
import type { Panel, Result } from "../panel/panel";

export const SSE_PING_MS = 10_000;

export function send(c: Context, r: Result) {
  if (r.ok) return c.json(r);
  return c.json({ ok: false, reason: r.reason, error: r.reason }, (r.status ?? 200) as 200);
}

export async function body(c: Context): Promise<Record<string, unknown>> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function panelRoutes(panel: Panel, opts: { fakeReader: boolean }) {
  const r = new Hono();
  r.use("/panel/*", localOnly());

  r.get("/panel/stream", (c) =>
    streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const unsub = panel.stream.subscribe((e) => {
        chain = chain.then(() => stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) })).catch(() => {});
      });
      stream.onAbort(unsub);
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ session: panel.view(), screen: panel.screen() }) });
      while (!stream.aborted) {
        await stream.sleep(SSE_PING_MS);
        if (!stream.aborted) chain = chain.then(() => stream.writeSSE({ event: "ping", data: "{}" })).catch(() => {});
      }
      unsub();
    }),
  );

  r.get("/panel/state", (c) => c.json({ session: panel.view(), screen: panel.screen(), devReader: opts.fakeReader, timezone: panel.config.timezone }));

  r.post("/panel/touch", async (c) => send(c, panel.touch((await body(c)).session)));

  r.post("/panel/activity", (c) => {
    panel.markActivity();
    return c.json({ ok: true });
  });

  r.post("/panel/screen", async (c) => {
    const b = await body(c);
    if (typeof b.on !== "boolean") return c.json({ error: 'Body must be {"on": true|false}' }, 400);
    panel.screenReport(b.on);
    return c.json({ ok: true, screen: panel.screen() });
  });

  r.post("/panel/close", async (c) => {
    const s = panel.get((await body(c)).session);
    if (!("ok" in s)) panel.close("closed");
    return c.json({ ok: true });
  });

  r.get("/panel/overview", (c) => {
    const s = panel.get(c.req.query("session"));
    return "ok" in s ? send(c, s) : c.json(panel.overview());
  });

  r.post("/panel/sign", async (c) => {
    const s = panel.get((await body(c)).session, "crew");
    return send(c, "ok" in s ? s : panel.signInOut(s));
  });

  r.get("/panel/kit", (c) => {
    const s = panel.get(c.req.query("session"), "crew");
    return "ok" in s ? send(c, s) : c.json(panel.kitLists(s));
  });

  r.post("/panel/take", async (c) => {
    const b = await body(c);
    const s = panel.get(b.session, "crew");
    return send(c, "ok" in s ? s : panel.take(s, b.kitId));
  });

  r.post("/panel/return", async (c) => {
    const b = await body(c);
    const s = panel.get(b.session, "crew");
    return send(c, "ok" in s ? s : panel.giveBack(s, b.kitId));
  });

  r.get("/panel/boxes", (c) => {
    const s = panel.get(c.req.query("session"), "crew");
    return "ok" in s ? send(c, s) : c.json({ boxes: panel.boxList(s) });
  });

  r.post("/panel/open", async (c) => {
    const b = await body(c);
    const s = panel.get(b.session, "crew");
    return send(c, "ok" in s ? s : panel.openBox(s, b.boxId));
  });

  return r;
}
