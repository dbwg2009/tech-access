import * as XLSX from "xlsx";
import { localDate } from "../time";
import { cellText, fail, normaliseUid, ok, type Result } from "../uid";

export { localDate };

export { cellText, normaliseUid, type Result };

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export function normaliseInt(v: unknown, min: number, max?: number): Result<number> {
  const n = typeof v === "number" ? v : Number(cellText(v));
  if (!Number.isInteger(n)) return fail(`"${cellText(v)}" is not a whole number`);
  if (n < min || (max !== undefined && n > max)) {
    return fail(max === undefined ? `${n} must be ${min} or more` : `${n} must be between ${min} and ${max}`);
  }
  return ok(n);
}

/** Case-insensitive match against allowed values; returns the canonical text. */
export function normaliseEnum(v: unknown, values: readonly string[]): Result<string> {
  const s = cellText(v).replace(/\s+/g, " ");
  const hit = values.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit ? ok(hit) : fail(`"${s}" is not one of: ${values.join(", ")}`);
}

function isoDate(y: number, m: number, d: number): Result<string> {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return fail(`${d}/${m}/${y} is not a real date`);
  }
  return ok(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

/** Excel serial, JS Date, `dd/mm/yyyy` or `yyyy-mm-dd` text -> `YYYY-MM-DD`. */
export function normaliseDate(v: unknown, timezone = "Europe/London"): Result<string> {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return fail("invalid date");
    return ok(localDate(v, timezone));
  }
  if (typeof v === "number") {
    const c = XLSX.SSF.parse_date_code(v);
    if (!c || !Number.isFinite(v) || v < 1) return fail(`${v} is not a date`);
    return isoDate(c.y, c.m, c.d);
  }
  const s = cellText(v);
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return fail(`"${s}" is not a date (use dd/mm/yyyy)`);
}

export function normaliseIpv4(v: unknown): Result<string> {
  const s = cellText(v);
  const parts = s.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return ok(parts.map(Number).join("."));
  }
  return fail(`"${s}" is not an IPv4 address`);
}


/** YYYY-MM-DD -> Excel serial (1900 date system). */
export function dateToSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}
