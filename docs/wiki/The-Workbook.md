# 5. The workbook

[← Show network](Show-Network.md) · [Home](Home.md) · Next: [Day to day →](Day-to-Day.md)

People, fobs, kit and boxes are edited in a spreadsheet: the source-of-truth Claude Sheet linked
in the [brief](../brief.md). The hub's database is the live copy. A workbook goes in through an
**import with a preview** that an admin fob confirms, and comes out through an **export** in
exactly the same layout, so the file goes both ways.

The full column rules are in [workbook-format.md](../workbook-format.md). In short:

| Sheet | Key | What it holds |
| --- | --- | --- |
| `Read me` | – | `B2` = schema version (must be `1`). `B3` = export time (hub writes it). |
| `People` | Person ID | Name, Type (Student / Staff / Hire tech), Year, Level 1–4, Specialism, Status |
| `Fobs` | Fob UID | Person ID, Role (Standard / Admin / Day pass), Level (day passes only), Status, Issued, Ended |
| `Kit` | Kit ID | Item, Category, Required level, Specialism, Box ID + Slot (where it lives), Tag UID |
| `Boxes` | Box ID | Name, Type, Required level, Network, IP address, Location, Offline unlock (min) |

Tips:

- **Format the Fob UID column as text**, or a UID starting with `0` loses its leading zero. The
  importer catches this and says so.
- UIDs can be typed with spaces, colons or dashes, in any case: `04:a1:b2…` becomes `04A1B2…`.
- Columns ending in `(auto)` are filled by the hub on export and ignored on import.
- Extra columns of your own are kept (with a warning), never a failure.
- **Deleting a row** shows it as "to remove" in the preview. Once applied, the row is archived,
  not deleted: people become `Left`, fobs `Revoked`. Put the row back to restore it.
- **Changing an ID** is a removal plus an add. The preview warns when it spots one.

## Who can do what

| Fob | Opens / takes |
| --- | --- |
| Standard fob, student | Boxes and kit up to their Level, matching their Specialism (`Lighting + Sound` matches both) |
| Standard fob, staff or hire tech | Everything (counted as Level 4, any specialism) |
| Day pass | Its own fixed Level (blank = 1), **only on the day it was issued** (UK time). Guest passes (no Person ID) only take `Any` kit. |
| Admin fob | Everything, and it confirms imports. "Disable all students" never blocks it. |
| Lost, Revoked or Spare fob, or a person who's Disabled or Left | Nothing |

TECHSOFTWARE updates (week 7) need an Admin fob, or a Standard fob of a Level 3+ student or a
staff member. Reasons for every rule are in [decisions.md](../decisions.md).

## Importing

**On the panel:** tap an admin fob → **Update from workbook** → choose the file → read the
preview → **Apply**, then tap an admin fob to confirm ([page 9](Desk-Panel.md)). From week 7 the
TECHUPDATE stick opens the preview by itself.

### Changes made on the panel (conflicts)

The admin menu changes the same data as the workbook (enrol, lost / revoke, day passes). The hub
remembers every such change until the next **export**. If your workbook would undo one, the
preview lists it as a **conflict** and you choose **Keep panel** (the default) or **Use
workbook** for each. Apply is refused until every conflict has a choice.

So: **after using the admin menu, export first, then edit that exported file.** An export marks
every panel change as included, so re-importing it never conflicts.

### With curl (on the Pi)

The admin routes only answer the Pi itself.

1. In the Claude Sheet: download as `.xlsx`.
2. Copy it to the Pi: `scp tracker.xlsx <you>@tech-hub.local:`
3. On the Pi, upload it and read the preview:

   ```bash
   curl -s -F file=@tracker.xlsx http://127.0.0.1:8080/api/import | python3 -m json.tool | less
   ```

   Look at:
   - `batchId`: you need this next.
   - `canApply`: `false` means there are errors.
   - `diff.errors` / `diff.warnings`: each has `sheet`, `row` (the Excel row number) and `column`.
   - `diff.counts`: adds, changes and removals per sheet.
   - `diff.sheets.<sheet>.removals`: **check these.** They're rows missing from your file.

4. Fix any errors in the Sheet and start again. Each upload replaces the previous pending one.
5. Apply it with an admin fob's UID (the number printed on it, or read with an NFC app):

   ```bash
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"fobUid":"04A1B2C3D4E5F6"}' http://127.0.0.1:8080/api/import/<batchId>/apply
   ```

   You should get `{"kind":"applied",...}`. Applying the same batch twice does nothing the second time.

   If the preview has `diff.conflicts`, add a choice for each conflict's `key`:
   `-d '{"fobUid":"04A1B2C3D4E5F6","resolutions":{"fobs/04A1B2C3D4E5F7/Status":"panel"}}'`
   (`"panel"` keeps the hub's value, `"sheet"` uses the workbook).

### The very first import

An empty hub has no admin fob to tap. For the first import only, the hub accepts an **Active
Admin fob listed in the workbook you're importing**, as long as its person is Active. The event
log records it as `bootstrap: true`. From then on, only admin fobs already in the hub can apply.

So, before the first import: make sure your workbook has at least one `Admin` / `Active` fob for
an `Active` person (Daniel, Mrs Ritter, the sealed spare).

### Apply replies

| Reply | Meaning | Do |
| --- | --- | --- |
| `applied` | Done | – |
| `already_applied` | This batch was applied before | Nothing |
| `has_errors` (422) | The file has errors | Fix them and upload again |
| `forbidden` (403) | Not an Active Admin fob, unknown fob, or its owner isn't Active | Use an admin fob |
| `superseded` (409) | A newer file was uploaded since | Apply the newer `batchId` |
| `stale` (409) | The hub's data changed after this preview | Upload again for a fresh preview |
| `unresolved` (409) | Conflicts with panel changes have no choice yet | Add `resolutions` (or choose on the panel) |

## Exporting

```bash
curl -s -o tech-access-export.xlsx http://127.0.0.1:8080/api/export.xlsx
```

Copy it off with `scp <you>@tech-hub.local:tech-access-export.xlsx .` and open it, or load it
into the Claude Sheet. The export:

- has the `Read me` sheet from your last import, with `B2` and `B3` updated;
- fills `Name (auto)`, `Out with (auto)` (who has each item now) and `Last seen (auto)`;
- writes dates as real dates (`dd/mm/yyyy`), and UIDs as text.

Importing an export straight back shows **no changes**. That's the round-trip check.

Sign-in and kit out/in events are **never** in the workbook. They stay in the hub; any admin fob can view them on the desk panel.
