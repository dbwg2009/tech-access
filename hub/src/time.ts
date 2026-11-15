/** Calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(now: Date, timezone = "Europe/London"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}
