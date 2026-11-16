// Update box firmware through the hub's API, the same path an admin uses: an admin fob opens the
// admin menu, the image is uploaded, "Update boxes" is asked for and confirmed with a second
// admin fob tap. Until the native panel app has a button for it, run this on the Pi:
//
//   cd /opt/tech-access/hub && bun run scripts/update-boxes.ts --file /path/to/firmware.bin --version 0.2.0
//
// and tap an admin fob on the desk reader when it says so (twice). Options:
//   --boxes all | BOX-01,BOX-02     which boxes (default all)
//   --hub http://127.0.0.1:8080     the hub (must be loopback: admin routes are local only)
//   --dev-tap <admin UID>           development only (fake_reader = true): tap for you
// Without --file (dev only) it makes a fake image, which the box simulator accepts.
import { readFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const hub = opt("hub", "http://127.0.0.1:8080")!;
const version = opt("version");
const devTap = opt("dev-tap");
const boxesArg = opt("boxes", "all")!;
const file = opt("file");
if (!version || (!file && !devTap)) {
  console.error("usage: bun run scripts/update-boxes.ts --version 0.2.0 --file firmware.bin [--boxes all|BOX-01,BOX-02] [--hub url] [--dev-tap UID]");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(hub + path, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const json = (await res.json().catch(() => ({}))) as any;
  if (res.status >= 400 || json.ok === false) throw new Error(`${method} ${path}: ${res.status} ${json.reason ?? json.error ?? ""}`);
  return json;
}

async function tap(prompt: string): Promise<void> {
  if (devTap) {
    await call("POST", "/api/dev/tap", { uid: devTap });
    return;
  }
  console.log(prompt);
}

/** Wait for an admin session to be open on the panel. */
async function adminSession(): Promise<string> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const s = (await call("GET", "/api/panel/state")).session;
    if (s?.kind === "admin") return s.id as string;
    await Bun.sleep(300);
  }
  throw new Error("No admin fob was tapped within a minute");
}

let bytes: Uint8Array<ArrayBuffer>;
if (file) bytes = new Uint8Array(readFileSync(file));
else {
  bytes = new Uint8Array(64 * 1024);
  crypto.getRandomValues(bytes);
  bytes[0] = 0xe9; // ESP32 image magic, so the hub accepts it (simulator only)
}

await tap("Tap an admin fob on the desk reader to open the admin menu…");
const session = await adminSession();

const form = new FormData();
form.set("session", session);
form.set("version", version);
form.set("file", new File([bytes], "firmware.bin"));
const up = (await (await fetch(`${hub}/api/admin/firmware`, { method: "POST", body: form })).json()) as any;
if (!up.ok) throw new Error(`upload: ${up.reason}`);
console.log(up.message);

const boxes = boxesArg === "all" ? "all" : boxesArg.split(",");
const req = await call("POST", "/api/admin/firmware/update", { session, boxes, version });
await tap(`${req.message}: tap an admin fob again to confirm (within 20 s)…`);
// Wait for the confirmation to be used up (confirmed, refused or timed out).
for (let i = 0; i < 100; i++) {
  const s = (await call("GET", "/api/panel/state")).session;
  if (!s?.pending) break;
  await Bun.sleep(250);
}

// Watch the boxes report back (Ctrl+C to stop watching; the update carries on).
const want = (b: any) => boxes === "all" || boxes.includes(b.box_id);
const end = Date.now() + 120_000;
let last = "";
while (Date.now() < end) {
  const list = ((await call("GET", "/api/boxes")).boxes as any[]).filter(want);
  const line = list.map((b) => `${b.box_id}: ${b.fw ?? "?"}${b.ota ? ` ${b.ota.status}${b.ota.why ? ` (${b.ota.why})` : ""}` : ""}`).join(" | ");
  if (line !== last) console.log(line);
  last = line;
  const done = list.every((b) => !b.ota || b.ota.version !== version || ["updated", "refused", "failed", "rolled_back"].includes(b.ota.status) || b.status !== "locked");
  if (done && list.some((b) => b.ota?.version === version)) break;
  if (!list.some((b) => b.ota?.version === version) && Date.now() > end - 110_000) {
    console.log("No box was asked to update (not confirmed, or every box was skipped: see Admin → Event log).");
    break;
  }
  await Bun.sleep(500);
}
await call("POST", "/api/admin/close", { session }).catch(() => {});
