// Fob / tag UID rules, shared by the workbook importer and the fob readers (docs/workbook-format.md).

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T>(error: string): Result<T> => ({ ok: false, error });

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** NTAG UID: uppercase hex, strip spaces/colons/dashes, 4, 7 or 10 bytes. */
export function normaliseUid(v: unknown): Result<string> {
  const s = cellText(v).replace(/[\s:-]/g, "").toUpperCase();
  if (!/^[0-9A-F]*$/.test(s)) return fail(`"${cellText(v)}" is not hex`);
  if (![8, 14, 20].includes(s.length)) {
    const hint =
      typeof v === "number" ? " (the cell is a number: format the column as text so leading zeros survive)" : "";
    return fail(`"${cellText(v)}" is ${s.length} hex digits; a UID is 4, 7 or 10 bytes (8, 14 or 20 digits)${hint}`);
  }
  return ok(s);
}

/** UID bytes as read from a card -> normalised hex (same rules as the workbook). */
export function uidFromBytes(bytes: ArrayLike<number>): Result<string> {
  return normaliseUid(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}
