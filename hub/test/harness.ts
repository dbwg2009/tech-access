// Test harness: a whole hub (seeded DB, fake reader, fake MQTT, controllable clock) driven over HTTP.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config";
import { buildHub } from "../src/hub";
import { FakeBus } from "../src/mqtt/bus";
import type { PanelEvent } from "../src/panel/stream";
import { FakeReader } from "../src/reader/fake";
import { seedDb, T0 } from "./seed";

export const LOCAL = { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }) };

export function setup(at = T0) {
  const db = seedDb();
  const ran: string[][] = [];
  const bus = new FakeBus();
  const reader = new FakeReader();
  reader.start();
  let now = at.getTime();
  const hub = buildHub({
    db,
    config: { ...DEFAULTS, dbPath: ":memory:", fakeReader: true },
    bus,
    reader,
    now: () => new Date(now),
    system: () => ({ tempC: 48.5, diskFreeMB: 200_000, diskTotalMB: 250_000 }),
    run: (argv) => ran.push(argv),
    backupDir: join(mkdtempSync(join(tmpdir(), "ta-backup-")), "backups"),
  });
  const events: PanelEvent[] = [];
  hub.stream.subscribe((e) => events.push(e));
  const req = async (method: string, path: string, b?: unknown) => {
    const res = await hub.app.request(
      path,
      b === undefined ? { method } : { method, body: JSON.stringify(b), headers: { "Content-Type": "application/json" } },
      LOCAL,
    );
    return { status: res.status, json: (await res.json()) as any };
  };
  const tap = (uid: string) => reader.tap(uid);
  const sid = () => hub.panel.current()?.id;
  const log = (type?: string) =>
    db
      .query<{ type: string; person_id: string | null; fob_uid: string | null; box_id: string | null; kit_id: string | null; detail: string }, []>(
        "SELECT * FROM events ORDER BY id",
      )
      .all()
      .filter((e) => !type || e.type === type)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
  const advance = (ms: number) => {
    now += ms;
    hub.panel.tick();
  };
  return { db, bus, reader, hub, events, ran, req, tap, sid, log, advance, setNow: (d: Date) => (now = d.getTime()) };
}

