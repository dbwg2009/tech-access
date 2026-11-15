import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  dbPath: string;
  httpPort: number;
  httpHost: string;
  mqttUrl: string;
  mqttUsername: string;
  usbMountRoot: string;
  timezone: string;
}

export const DEFAULTS: Config = {
  dbPath: "data/tech-access.db",
  httpPort: 8080,
  httpHost: "0.0.0.0",
  mqttUrl: "mqtt://127.0.0.1:1883",
  mqttUsername: "hub",
  usbMountRoot: "/media",
  timezone: "Europe/London",
};

function str(v: unknown, key: string, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.trim() === "") throw new Error(`config: ${key} must be a non-empty string`);
  return v;
}

/** Parse TOML text into a Config. Relative db_path resolves against baseDir. */
export function parseConfig(text: string, baseDir: string): Config {
  const raw = Bun.TOML.parse(text) as Record<string, unknown>;
  const port = raw.http_port ?? DEFAULTS.httpPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("config: http_port must be an integer 1-65535");
  }
  const dbPath = str(raw.db_path, "db_path", DEFAULTS.dbPath);
  const timezone = str(raw.timezone, "timezone", DEFAULTS.timezone);
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    throw new Error(`config: unknown timezone ${timezone}`);
  }
  return {
    dbPath: dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : resolve(baseDir, dbPath),
    httpPort: port,
    httpHost: str(raw.http_host, "http_host", DEFAULTS.httpHost),
    mqttUrl: str(raw.mqtt_url, "mqtt_url", DEFAULTS.mqttUrl),
    mqttUsername: str(raw.mqtt_username, "mqtt_username", DEFAULTS.mqttUsername),
    usbMountRoot: str(raw.usb_mount_root, "usb_mount_root", DEFAULTS.usbMountRoot),
    timezone,
  };
}

/** Load from TECH_ACCESS_CONFIG, else hub/config.toml, else hub/config.example.toml. */
export function loadConfig(path = process.env.TECH_ACCESS_CONFIG): Config {
  const hubDir = resolve(import.meta.dir, "..");
  const candidates = path ? [path] : [resolve(hubDir, "config.toml"), resolve(hubDir, "config.example.toml")];
  for (const p of candidates) {
    if (existsSync(p)) return parseConfig(readFileSync(p, "utf8"), dirname(p));
  }
  throw new Error(`config: none found (tried ${candidates.join(", ")})`);
}
