import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { normaliseUid } from "./uid";

export interface Config {
  dbPath: string;
  httpPort: number;
  httpHost: string;
  mqttUrl: string;
  mqttUsername: string;
  usbMountRoot: string;
  timezone: string;
  /** Development only: no PN532; taps come from POST /api/dev/tap and the panel's dev key. */
  fakeReader: boolean;
  /** Serial device of the desk PN532 (HSU). Pi 5: GPIO14/15 = UART0 = /dev/ttyAMA0. */
  readerDevice: string;
  /** UIDs the panel's dev key cycles through (fake reader only). */
  fakeFobs: string[];
  /** Box firmware images (GET /fw/<file>). On the Pi: /var/lib/tech-access/firmware. */
  firmwareDir: string;
  /** Base URL boxes download firmware from: the Pi's Control-subnet address. */
  firmwareUrl: string;
}

export const DEFAULTS: Config = {
  dbPath: "data/tech-access.db",
  httpPort: 8080,
  httpHost: "0.0.0.0",
  mqttUrl: "mqtt://127.0.0.1:1883",
  mqttUsername: "hub",
  usbMountRoot: "/media",
  timezone: "Europe/London",
  fakeReader: false,
  readerDevice: "/dev/ttyAMA0",
  fakeFobs: [],
  firmwareDir: "data/firmware",
  firmwareUrl: "http://10.102.40.10:8080",
};

function str(v: unknown, key: string, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.trim() === "") throw new Error(`config: ${key} must be a non-empty string`);
  return v;
}

function bool(v: unknown, key: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`config: ${key} must be true or false`);
  return v;
}

function uidList(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`config: ${key} must be a list of fob UIDs`);
  return v.map((x) => {
    const r = normaliseUid(x);
    if (typeof x !== "string" || !r.ok) throw new Error(`config: ${key}: ${r.ok ? "UIDs must be quoted strings" : r.error}`);
    return r.value;
  });
}

/** Parse TOML text into a Config. Relative db_path resolves against baseDir. */
export function parseConfig(text: string, baseDir: string): Config {
  const raw = Bun.TOML.parse(text) as Record<string, unknown>;
  const port = raw.http_port ?? DEFAULTS.httpPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("config: http_port must be an integer 1-65535");
  }
  const dbPath = str(raw.db_path, "db_path", DEFAULTS.dbPath);
  const firmwareDir = str(raw.firmware_dir, "firmware_dir", DEFAULTS.firmwareDir);
  const firmwareUrl = str(raw.firmware_url, "firmware_url", DEFAULTS.firmwareUrl);
  if (!/^http:\/\/[^/]+(:\d+)?\/?$/.test(firmwareUrl)) throw new Error("config: firmware_url must look like http://10.102.40.10:8080");
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
    fakeReader: bool(raw.fake_reader, "fake_reader", DEFAULTS.fakeReader),
    readerDevice: str(raw.reader_device, "reader_device", DEFAULTS.readerDevice),
    fakeFobs: uidList(raw.fake_fobs, "fake_fobs"),
    firmwareDir: isAbsolute(firmwareDir) ? firmwareDir : resolve(baseDir, firmwareDir),
    firmwareUrl,
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
