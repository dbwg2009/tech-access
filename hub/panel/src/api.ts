// Hub API calls. Every call is to the hub on the same origin (loopback on the Pi).
export interface ApiResult {
  ok: boolean;
  message?: string;
  reason?: string;
  confirm?: "tap";
  [k: string]: unknown;
}

export async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  return (await r.json()) as T;
}

export async function post(path: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as ApiResult;
  } catch {
    return { ok: false, reason: "The hub isn't answering. Try again in a moment" };
  }
}

export async function upload(path: string, file: File): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(path, { method: "POST", body: form });
  return (await r.json()) as Record<string, unknown>;
}

/** Live events from GET /api/panel/stream. EventSource reconnects by itself. */
export function stream(on: Record<string, (data: any) => void>, onOpen: () => void): EventSource {
  const es = new EventSource("/api/panel/stream");
  let lost = false;
  for (const [name, fn] of Object.entries(on)) {
    es.addEventListener(name, (e) => {
      // Back after the hub was away (restart or update): reload, so a new panel build is used.
      if (name === "hello" && lost) return location.reload();
      fn(JSON.parse((e as MessageEvent).data));
    });
  }
  es.addEventListener("open", onOpen);
  es.addEventListener("error", () => (lost = true));
  return es;
}
