// Build the desk panel: hub/panel/ (source) -> hub/public/panel/ (served at /panel/).
// Plain TypeScript bundled by Bun.build; no framework, nothing from a CDN. The output is not
// committed: 05-bun-hub.sh runs `bun run build` on the Pi (decision 2026-11-16).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const src = resolve(root, "panel");
const out = resolve(root, "public/panel");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(src, "src/main.ts")],
  outdir: out,
  naming: "app.js",
  target: "browser",
  minify: true,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync(resolve(src, "index.html"), resolve(out, "index.html"));
cpSync(resolve(src, "panel.css"), resolve(out, "panel.css"));
cpSync(resolve(src, "fonts"), resolve(out, "fonts"), { recursive: true });
console.log(`panel built -> ${out}`);
