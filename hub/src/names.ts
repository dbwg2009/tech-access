// The panel shows first names only (decision 2026-11-16). Staff are written "Mrs Ritter" in the
// workbook; their first word is a title, so keep title + surname, the way students address them.
const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "sir", "prof"]);

export function firstName(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (TITLES.has(words[0]!.toLowerCase().replace(/\.$/, "")) && words.length > 1) return `${words[0]} ${words[words.length - 1]}`;
  return words[0]!;
}
