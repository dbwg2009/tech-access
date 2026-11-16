// Hub health numbers for the overview and Hub status screens. Every read is best-effort: on a PC
// without the Pi's thermal sensor the temperature is simply null.
import { readFileSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

export interface SystemInfo {
  tempC: number | null;
  diskFreeMB: number | null;
  diskTotalMB: number | null;
}

export function readSystem(dbPath: string): SystemInfo {
  let tempC: number | null = null;
  try {
    tempC = Math.round(Number(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim()) / 100) / 10;
    if (!Number.isFinite(tempC)) tempC = null;
  } catch {
    // not a Pi
  }
  let diskFreeMB: number | null = null;
  let diskTotalMB: number | null = null;
  try {
    const s = statfsSync(dbPath === ":memory:" ? "." : dirname(dbPath));
    diskFreeMB = Math.round((s.bavail * s.bsize) / 1e6);
    diskTotalMB = Math.round((s.blocks * s.bsize) / 1e6);
  } catch {
    // ignore
  }
  return { tempC, diskFreeMB, diskTotalMB };
}
