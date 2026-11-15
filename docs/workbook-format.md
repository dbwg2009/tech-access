# Workbook format (schema version 1)

The source-of-truth workbook is a Claude Sheet:
https://claude.ai/artifact/BNeQaFp5dnPPTbkmtVAdqn

Daniel edits it, downloads it as `.xlsx`, and puts it on a USB stick labelled `TECHUPDATE`.
The hub imports it, shows a preview on the desk panel and applies it after an admin fob tap.
The hub can also export its current state in exactly this layout, so the file goes both ways.

The hub's SQLite database is the live truth. The workbook is the editable copy.

## General rules

- Sheets are found by name, columns by header text (trimmed, case-insensitive). Column order must not matter.
- Row 1 is the header. Data runs from row 2 until the first fully blank row.
- Columns whose header ends in `(auto)` are written by the hub on export and ignored on import.
- Unknown extra columns: keep them on export if possible, otherwise warn. Never fail the import for them.
- IDs are the keys. An ID that changes is a delete plus an add, so the preview must make that obvious.
- A row missing from the file is listed in the preview as "to remove" and only removed when the admin tap confirms. Prefer marking (Status = Left / Revoked) over hard deletes.
- Dropdown cells arrive as plain text. Validate against the allowed values below.
- Dates may arrive as Excel serial numbers, JS dates or `dd/mm/yyyy` text. Normalise to ISO `YYYY-MM-DD`.

## Sheet: `Read me`

| Cell | Meaning |
| --- | --- |
| B2 | Schema version. Must be `1`. Refuse the import (clear error on the panel) if it is anything else. |
| B3 | `Exported (auto)`: ISO timestamp the hub writes on export. Ignored on import. |

The rest of the sheet is human help text. Ignore it on import; write it back unchanged on export.

## Sheet: `People`

| Header | Type | Rules |
| --- | --- | --- |
| Person ID | text, required, unique | e.g. `P001`. Key. |
| Name | text, required | |
| Type | enum | `Student`, `Staff`, `Hire tech` |
| Year | integer or blank | School year (7–13). Blank for staff and hire techs. |
| Level | integer 1–4 or blank | Crew ladder level. Blank for staff and hire techs. |
| Specialism | enum or blank | `Lighting`, `Sound`, `Lighting + Sound` |
| Status | enum | `Active`, `Disabled`, `Left` |
| Notes | text | |

## Sheet: `Fobs`

| Header | Type | Rules |
| --- | --- | --- |
| Fob UID | text, required, unique | NTAG UID as hex. Normalise: uppercase, strip spaces, colons and dashes. 4, 7 or 10 bytes. Key. |
| Person ID | text or blank | Must exist in People. Blank allowed only for `Spare` fobs and `Day pass` fobs (guests). |
| Role | enum | `Standard`, `Admin`, `Day pass` |
| Level | integer 1–4 or blank | Optional column. Only used for `Day pass` fobs: the fixed level the pass carries. Blank = 1. Ignored for other roles. |
| Status | enum | `Active`, `Spare`, `Lost`, `Revoked` |
| Issued | date or blank | |
| Ended | date or blank | Set when Lost or Revoked. A Day pass ends at the end of the day it was issued. |
| Notes | text | |
| Name (auto) | export only | Person's name, for humans. |

Fob lifecycle: issued at Level 1; a lost fob is set to Lost (never reused); £2 charge from a person's second lost fob (the hub counts Lost fobs per person and shows it on the panel).

## Sheet: `Kit`

| Header | Type | Rules |
| --- | --- | --- |
| Kit ID | text, required, unique | e.g. `K001`. Key. |
| Item | text, required | |
| Category | enum | `Lighting`, `Sound`, `Radio mics`, `Keys`, `Show network`, `Other` |
| Required level | integer 1–4 or blank | Blank means any active crew member. |
| Specialism | enum or blank | `Any`, `Lighting`, `Sound`. Blank = `Any`. |
| Box ID | text or blank | Must exist in Boxes. Where the item lives. |
| Slot | text | Drawer / hook / position inside the box. |
| Tag UID | text or blank | NFC tag on the item (week 11+). Same normalising as Fob UID. Unique if present. |
| Notes | text | |
| Out with (auto) | export only | Person currently holding it, from the events log. |

Every item has a location (Box ID + Slot) in the data model from day one, ready for per-drawer item recognition later.

## Sheet: `Boxes`

| Header | Type | Rules |
| --- | --- | --- |
| Box ID | text, required, unique | e.g. `BOX-01`. Key. Matches the box firmware's configured ID. |
| Name | text, required | |
| Type | enum | `Fixed (PoE)`, `Flight case (Wi-Fi)`, `Key cabinet` |
| Required level | integer 1–4 or blank | Lowest level that opens the box. Everything inside should need that level or lower: warn (not error) if a Kit row in this box needs a lower level than the box. |
| Network | enum | `Ethernet`, `Wi-Fi` |
| IP address | IPv4 or blank | Static/reserved address on the show network. |
| Location | text | |
| Offline unlock (min) | integer ≥ 0 | Minutes after the Pi becomes unreachable before the box fails open. Default 5. |
| Notes | text | |
| Last seen (auto) | export only | Last MQTT heartbeat. |

## Never in the workbook

Sign-in and kit out/in events stay in the hub database and are viewable by Daniel only.
