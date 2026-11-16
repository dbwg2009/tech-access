import type { MiddlewareHandler } from "hono";

interface RequestIpSource {
  requestIP?: (req: Request) => { address: string } | null;
}

/** Control subnet 10.102.0.0/16 (decision 2026-11-15), plus loopback for the Pi itself. */
export function isControlOrLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (v4 === "127.0.0.1" || addr === "::1") return true;
  return /^10\.102\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Firmware downloads: only boxes on the Control subnet (and the Pi) may fetch them. */
export function controlOnly(): MiddlewareHandler {
  return async (c, next) => {
    const addr = (c.env as RequestIpSource | undefined)?.requestIP?.(c.req.raw)?.address;
    if (!isControlOrLoopback(addr)) return c.text("Forbidden", 403);
    await next();
  };
}
