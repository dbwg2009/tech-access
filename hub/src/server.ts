import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { migrate } from "./migrate";
import { VERSION } from "./version";

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
const app = createApp({ db, config });

const server = Bun.serve({ port: config.httpPort, hostname: config.httpHost, fetch: app.fetch });
console.log(`tech-access hub ${VERSION} on http://${server.hostname}:${server.port} (db ${config.dbPath})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    db.close();
    process.exit(0);
  });
}
