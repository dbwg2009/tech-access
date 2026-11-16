import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { migrate } from "./migrate";
import { FakeReader } from "./reader/fake";
import type { FobReader } from "./reader/types";
import { VERSION } from "./version";

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
// Desk fob reader. Step 1 (weeks 3-4): fake reader for development; the PN532 UART transport
// is added once the serial approach is agreed.
let reader: FobReader | undefined;
if (config.fakeReader) {
  reader = new FakeReader(config.fakeFobs);
  console.log("fob reader: FAKE (development). Tap with POST /api/dev/tap");
}
reader?.on("tap", (t) => console.log(`tap ${t.uid}`));
reader?.on("status", (s) => console.log(`fob reader: ${s.detail}`));
reader?.on("error", (e) => console.error(`fob reader: ${e.message}`));
reader?.start();

const app = createApp({ db, config, reader });

const server = Bun.serve({ port: config.httpPort, hostname: config.httpHost, fetch: app.fetch });
console.log(`tech-access hub ${VERSION} on http://${server.hostname}:${server.port} (db ${config.dbPath})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    void reader?.stop();
    db.close();
    process.exit(0);
  });
}
