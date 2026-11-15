// Access decisions. Pure: no I/O. Extended in step 4.
import type { Fob } from "./workbook/schema";

export function isAdmin(fob: Pick<Fob, "role" | "status"> | null | undefined): boolean {
  return !!fob && fob.role === "Admin" && fob.status === "Active";
}
