import type { MiddlewareHandler } from "hono";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface RequestIpSource {
  requestIP?: (req: Request) => { address: string } | null;
}

/**
 * Admin routes: only from the Pi itself (the panel runs in Chromium on the Pi).
 * TODO(week 8): proper auth (session from an admin fob tap / Stage Door) when the iPad door
 * station and Stage Door move onto the hub. Loopback-only is not enough once other clients exist.
 */
export function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    const server = c.env as RequestIpSource | undefined;
    const addr = server?.requestIP?.(c.req.raw)?.address;
    if (!addr || !LOOPBACK.has(addr)) {
      return c.json({ error: "Admin actions are only allowed from the desk panel" }, 403);
    }
    await next();
  };
}
