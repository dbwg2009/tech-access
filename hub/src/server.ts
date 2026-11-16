import { loadConfig } from "./config";
import { openDb } from "./db";
import { buildHub } from "./hub";
import { migrate } from "./migrate";
import { MqttJsBus } from "./mqtt/bus";
import { FakeReader } from "./reader/fake";
import { Pn532UartReader } from "./reader/pn532Reader";
import type { FobReader } from "./reader/types";
import { UartTransport } from "./reader/uart";
import { VERSION } from "./version";

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

// Desk fob reader: the PN532 on the Pi's UART, or the fake reader in development. Either way a
// missing or broken reader only shows in /api/health; the hub carries on.
let reader: FobReader;
if (config.fakeReader) {
  reader = new FakeReader(config.fakeFobs);
  console.log("fob reader: FAKE (development). Tap with POST /api/dev/tap or the panel's dev key");
} else {
  reader = new Pn532UartReader(new UartTransport(config.readerDevice));
}
reader.on("tap", (t) => console.log(`tap ${t.uid}`));
reader.on("status", (s) => console.log(`fob reader: ${s.detail}${s.firmware ? ` (${s.firmware})` : ""}`));
reader.on("error", (e) => console.error(`fob reader: ${e.message}`));

// MQTT: connects in the background and retries quietly; the hub works without it.
const bus = new MqttJsBus({ url: config.mqttUrl, username: config.mqttUsername, password: process.env.TECH_ACCESS_MQTT_PASSWORD });

const hub = buildHub({ db, config, bus, reader });
reader.start();
hub.start();

// idleTimeout: the panel's event stream sends a ping every 10 s, so 30 s is plenty.
const server = Bun.serve({ port: config.httpPort, hostname: config.httpHost, fetch: hub.app.fetch, idleTimeout: 30 });
console.log(`tech-access hub ${VERSION} on http://${server.hostname}:${server.port} (db ${config.dbPath})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hub.stop();
    server.stop();
    void reader.stop();
    // Tell the boxes the hub is going (hub/status offline), but never wait long for it.
    void Promise.race([bus.close(), Bun.sleep(1_500)]).finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
