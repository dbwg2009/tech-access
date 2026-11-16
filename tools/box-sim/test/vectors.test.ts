// Runs firmware/test/vectors/*.json against the simulator's rules (core.ts), exactly as the
// firmware's native tests run them against box_core. Format: firmware/test/vectors/README.md.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Box, parseIsoUtc, type Action, type Now } from "../core";

const DIR = join(import.meta.dir, "../../../firmware/test/vectors");

type Json = Record<string, unknown>;

function run(defaults: Json, c: Json): string[] {
  const errors: string[] = [];
  const boot = { ...defaults, ...((c.boot as Json) ?? {}) };
  const box = new Box();
  let clock0 = 0;
  const now: Now = { mono: 0, clockSet: false, utc: 0 };
  if (typeof boot.clock === "string") {
    clock0 = parseIsoUtc(boot.clock)!;
    now.clockSet = true;
    now.utc = clock0;
  }
  const fobs = boot.fobs === null || boot.fobs === undefined ? null : typeof boot.fobs === "string" ? boot.fobs : JSON.stringify(boot.fobs);
  box.boot({ ...now }, {
    fw: (boot.fw as string) ?? "0.1.0",
    doorSensor: (boot.door_sensor as boolean) ?? true,
    storedFobs: fobs,
    otaPendingVerify: (boot.ota_pending_verify as boolean) ?? false,
    rolledBackFrom: (boot.rolled_back_from as string) ?? "",
  });
  let window: Action[] = box.take();
  (c.steps as Json[]).forEach((s, i) => {
    const where = `${c.name} / step ${i}`;
    const fail = (m: string) => errors.push(`${where}: ${m}`);
    now.mono = s.at as number;
    if (now.clockSet) now.utc = clock0 + now.mono;
    box.tick({ ...now });
    if (s.broker !== undefined) box.broker({ ...now }, s.broker as boolean);
    else if (s.msg !== undefined) {
      const p = s.payload;
      box.message({ ...now }, s.msg as string, p === null || p === undefined ? "" : typeof p === "string" ? p : JSON.stringify(p));
    } else if (s.tap !== undefined) box.tap({ ...now }, s.tap as string);
    else if (s.door !== undefined) box.door({ ...now }, s.door === "shut");
    else if (s.ntp !== undefined) {
      const t = parseIsoUtc(s.ntp)!;
      clock0 = t - now.mono;
      now.clockSet = true;
      now.utc = t;
    } else if (s.ota_result !== undefined) {
      const r = s.ota_result as Json;
      box.otaResult({ ...now }, r.ok as boolean, (r.why as string) ?? "");
    }
    window.push(...box.take());

    const e = s.expect as Json | undefined;
    if (e) {
      if (e.lock !== undefined && e.lock !== (box.locked ? "locked" : "open")) fail(`lock is ${box.locked ? "locked" : "open"}, expected ${e.lock}`);
      if (e.why !== undefined && e.why !== box.why) fail(`why is '${box.why}', expected '${e.why}'`);
    }
    for (const want of (s.publish as Json[]) ?? []) {
      const sent = window.filter((a) => a.type === "publish" && a.topic === want.topic) as Extract<Action, { type: "publish" }>[];
      const hit = sent.some((a) => {
        const got = JSON.parse(a.payload) as Json;
        const match = Object.entries((want.match as Json) ?? {}).every(([k, v]) => (v === "*" ? k in got : k in got && JSON.stringify(got[k]) === JSON.stringify(v)));
        const absent = ((want.absent as string[]) ?? []).every((k) => !(k in got));
        return match && absent;
      });
      if (!hit) fail(`no ${want.topic} message matching ${JSON.stringify(want)}; sent: ${sent.map((a) => a.payload).join(" | ") || "(none)"}`);
    }
    for (const t of (s.no_publish as string[]) ?? []) {
      for (const a of window) if (a.type === "publish" && a.topic === t) fail(`unexpected publish on ${t}: ${a.payload}`);
    }
    for (const t of (s.actions as string[]) ?? []) if (!window.some((a) => a.type === t)) fail(`expected action ${t}`);
    for (const t of (s.no_actions as string[]) ?? []) if (window.some((a) => a.type === t)) fail(`unexpected action ${t}`);
    window = [];
  });
  return errors;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

test("vector files exist", () => {
  expect(files.length).toBeGreaterThanOrEqual(10);
});

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { defaults?: { boot?: Json }; cases: Json[] };
  describe(file, () => {
    for (const c of doc.cases) {
      test(c.name as string, () => {
        expect(run(doc.defaults?.boot ?? {}, c)).toEqual([]);
      });
    }
  });
}
