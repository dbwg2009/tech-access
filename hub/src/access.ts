// Access decisions. Pure: no I/O, no clock, no DB. Callers load the rows and pass `now`.
// Policy sources: docs/brief.md and docs/decisions.md. Reasons are short: they show on the panel.
import { localDate } from "./time";
import type { Box, Fob, Kit, Person } from "./workbook/schema";

export interface AccessSettings {
  studentsDisabled: boolean;
  /** Not used by any rule yet (to be decided with the panel, weeks 3-4). */
  showMode?: boolean;
}

export interface Decision {
  allow: boolean;
  reason: string;
}

type FobIn = Pick<Fob, "fob_uid" | "person_id" | "role" | "status" | "level" | "issued" | "ended">;
type PersonIn = Pick<Person, "person_id" | "name" | "type" | "level" | "specialism" | "status">;

export interface BoxInput {
  /** null = not in the hub (unknown or archived fob). */
  fob: FobIn | null;
  /** The fob's person, or null for a guest day pass / unassigned fob. */
  person: PersonIn | null;
  box: Pick<Box, "box_id" | "name" | "required_level">;
  settings: AccessSettings;
  now: Date;
  timezone?: string;
}

export interface KitInput extends Omit<BoxInput, "box"> {
  kit: Pick<Kit, "kit_id" | "item" | "required_level" | "specialism">;
}

const allow = (reason: string): Decision => ({ allow: true, reason });
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Admin role and Active status. The person check is separate (see adminCheck). */
export function isAdmin(fob: Pick<Fob, "role" | "status"> | null | undefined): boolean {
  return !!fob && fob.role === "Admin" && fob.status === "Active";
}

/** Staff and hire techs have no ladder level and count as Level 4 (decision 2026-11-15). */
const ADULT_LEVEL = 4;

/** Level a fob carries: Day pass = fixed level on the fob (blank = 1); otherwise the person's level. */
export function effectiveLevel(fob: Pick<Fob, "role" | "level">, person: Pick<Person, "type" | "level"> | null): number | null {
  if (fob.role === "Day pass") return fob.level ?? 1;
  if (!person) return null;
  if (person.type !== "Student") return ADULT_LEVEL;
  return person.level;
}

/**
 * Checks common to every decision. Returns a denial, or null to carry on.
 * Order matters: the first failing rule is the reason shown.
 */
function common(fob: FobIn | null, person: PersonIn | null, settings: AccessSettings, now: Date, tz: string): Decision | null {
  if (!fob) return deny("Fob not recognised");
  if (fob.status !== "Active") return deny(`This fob is ${fob.status}`);
  if (fob.person_id !== null) {
    if (!person || person.person_id !== fob.person_id) return deny("Fob's owner not found");
    if (person.status !== "Active") return deny(`${person.name} is ${person.status}`);
  } else if (fob.role !== "Day pass") {
    return deny("Fob isn't assigned to anyone");
  }
  if (fob.role === "Day pass") {
    if (!fob.issued) return deny("Day pass has no issue date");
    const today = localDate(now, tz);
    if (today < fob.issued) return deny("Day pass isn't valid yet");
    if (today > fob.issued || (fob.ended !== null && today > fob.ended)) return deny("Day pass has expired");
  }
  // "Disable all students" blocks students only, and never an Admin fob.
  if (settings.studentsDisabled && person?.type === "Student" && fob.role !== "Admin") {
    return deny("Students are disabled right now");
  }
  return null;
}

function levelCheck(fob: FobIn, person: PersonIn | null, required: number | null): Decision {
  if (fob.role === "Admin") return allow("Admin");
  const have = effectiveLevel(fob, person);
  const need = required ?? 1;
  if (have === null) return deny("No level set, ask a staff member");
  if (have < need) return deny(`Level ${need} needed, you're Level ${have}`);
  return allow(`Level ${have}`);
}

export function decideBoxOpen({ fob, person, box, settings, now, timezone = "Europe/London" }: BoxInput): Decision {
  return common(fob, person, settings, now, timezone) ?? levelCheck(fob!, person, box.required_level);
}

/**
 * Specialism match. Kit `Any` (or blank) matches everyone. A person's `Lighting + Sound` matches
 * both. Admin fobs, staff and hire techs match everything. A guest day pass has no specialism,
 * so it only matches `Any` kit.
 */
export function specialismMatches(kit: Pick<Kit, "specialism">, fob: Pick<Fob, "role">, person: Pick<Person, "type" | "specialism"> | null): boolean {
  if (kit.specialism === null || kit.specialism === "Any") return true;
  if (fob.role === "Admin") return true;
  if (person && person.type !== "Student") return true;
  const s = person?.specialism;
  return s === kit.specialism || s === "Lighting + Sound";
}

export function decideKitTake({ fob, person, kit, settings, now, timezone = "Europe/London" }: KitInput): Decision {
  const c = common(fob, person, settings, now, timezone);
  if (c) return c;
  const lvl = levelCheck(fob!, person, kit.required_level);
  if (!lvl.allow) return lvl;
  if (!specialismMatches(kit, fob!, person)) return deny(`${kit.specialism} crew only`);
  return lvl;
}

/** An Active Admin fob whose person (if any) is Active. Used to apply imports and open the admin menu. */
export function adminCheck(fob: FobIn | null, person: PersonIn | null): Decision {
  if (!fob) return deny("Fob not recognised");
  if (!isAdmin(fob)) return deny(fob.role === "Admin" ? `This fob is ${fob.status}` : "Not an admin fob");
  if (fob.person_id !== null && (!person || person.status !== "Active")) return deny("Admin fob's owner isn't Active");
  return allow("Admin");
}

/**
 * TECHSOFTWARE stick (week 7): Admin fob, or a Standard fob of a Level 3+ student or staff member.
 * Hire techs and day passes can't, whatever their level. "Disable all students" applies.
 */
export function canApplySoftwareUpdate(fob: FobIn | null, person: PersonIn | null, settings: AccessSettings = { studentsDisabled: false }): Decision {
  if (fob && isAdmin(fob)) return adminCheck(fob, person);
  if (!fob) return deny("Fob not recognised");
  if (fob.status !== "Active") return deny(`This fob is ${fob.status}`);
  if (fob.role !== "Standard") return deny("Day passes can't update software");
  if (!person || person.person_id !== fob.person_id) return deny("Fob isn't assigned to anyone");
  if (person.status !== "Active") return deny(`${person.name} is ${person.status}`);
  if (person.type === "Hire tech") return deny("Hire techs can't update software");
  if (settings.studentsDisabled && person.type === "Student") return deny("Students are disabled right now");
  const have = effectiveLevel(fob, person);
  if (have === null || have < 3) return deny(`Level 3 needed, you're ${have === null ? "not levelled" : `Level ${have}`}`);
  return allow(`Level ${have}`);
}
