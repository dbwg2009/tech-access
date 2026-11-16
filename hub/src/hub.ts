// Wires the hub together: database, fob reader, MQTT link, panel, HTTP app, timers.
// server.ts uses it for real; tests use it with a FakeReader and a FakeBus.
import type { Database } from "bun:sqlite";
import { createApp } from "./app";
import type { Config } from "./config";
import type { Bus } from "./mqtt/bus";
import { BoxLink } from "./mqtt/boxes";
import { Firmware } from "./firmware";
import { Admin, type Runner } from "./panel/admin";
import { Editor } from "./panel/editor";
import { Panel, type PanelTimings } from "./panel/panel";
import { PanelStream } from "./panel/stream";
import type { FobReader } from "./reader/types";
import type { SystemInfo } from "./system";

export interface HubDeps {
  db: Database;
  config: Config;
  bus: Bus;
  reader?: FobReader;
  now?: () => Date;
  timings?: Partial<PanelTimings>;
  system?: () => SystemInfo;
  startedAt?: number;
  /** Runs restart / reboot commands. Tests pass a fake. */
  run?: Runner;
  /** Where Backup now writes. Default: backups/ next to the database. */
  backupDir?: string | null;
}

export function buildHub(d: HubDeps) {
  const now = d.now ?? (() => new Date());
  const startedAt = d.startedAt ?? Date.now();
  const stream = new PanelStream();
  const boxes = new BoxLink(d.db, d.bus, now, d.config.timezone);
  const firmware = new Firmware(d.db, d.config.firmwareDir, boxes, d.config.firmwareUrl, now);
  const panel = new Panel({
    db: d.db,
    config: d.config,
    boxes,
    stream,
    now,
    timings: d.timings,
    system: d.system,
    startedAt,
    readerStatus: () => (d.reader ? { kind: d.reader.kind, ...d.reader.status() } : null),
  });
  d.reader?.on("tap", (t) => panel.handleTap(t.uid));
  d.reader?.on("status", () => panel.overviewChanged());

  /** After anything that changes who may open what: republish box lists, refresh the panel. */
  const dataChanged = () => {
    boxes.publishRetained();
    panel.overviewChanged();
  };

  const admin = new Admin(panel, { run: d.run, backupDir: d.backupDir, onDataChanged: () => boxes.publishRetained(), firmware });
  const editor = new Editor(panel, () => boxes.publishRetained());
  const app = createApp({ db: d.db, config: d.config, now, startedAt, reader: d.reader, panel, admin, editor, onDataChanged: dataChanged, boxes, firmware });

  let timers: ReturnType<typeof setInterval>[] = [];
  return {
    app,
    panel,
    admin,
    editor,
    boxes,
    firmware,
    stream,
    dataChanged,
    /** Start the timers: panel tick every second, allowlist check every 5 minutes. */
    start() {
      timers = [setInterval(() => panel.tick(), 1_000), setInterval(() => boxes.tick(), 5 * 60_000)];
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  };
}
