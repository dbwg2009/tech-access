# Claude Code prompt: tech-access, weeks 1–2

Paste everything below the line into Claude Code, run from the folder that holds this starter kit
(`CLAUDE.md`, `docs/brief.md`, `docs/workbook-format.md`).

---

You're helping me (Daniel) build `tech-access`: a fob-based access control system for my school's tech kit. Read `CLAUDE.md`, `docs/brief.md` and `docs/workbook-format.md` first. They are the spec. This session covers **build weeks 1–2** only (about 30 hours of my time in total).

I like iterative approval. Work in the steps below. At the end of each step, stop, show me what you did (files, test output) and wait for my go-ahead before starting the next one.

## Step 0: questions and repo

Before writing code, ask me these in one go (use your question tool if you have one):

1. The show network's subnet, the Pico's DHCP pool range, and the static IP and hostname I want for the Pi (pick an address outside the pool).
2. Which Raspberry Pi OS release I'm flashing (Bookworm or Trixie, 64-bit Lite or Desktop).
3. What staff (`Type = Staff`) and hire techs (`Type = Hire tech`) can open with a `Standard` fob, since they have no ladder level. Suggest an option, but let me decide.
4. Whether a `Day pass` fob carries the level of the person it's issued to, or a fixed level set when it's issued.

Then create the repo: `gh repo create dbwg2009/tech-access --public --source . --remote origin` (from this folder after `git init`), with an MIT licence, a short README and a `.gitignore` for Bun, PlatformIO and `*.db`. Commit the starter files as the first commit and push.

## Step 1: hub skeleton

- `hub/`: Bun + Hono + TypeScript (strict). `bun:sqlite` for storage. `bun test` for tests.
- Config from one file (`hub/config.toml` or `.json`, with an example committed): DB path, HTTP port, MQTT URL, USB mount root, timezone `Europe/London`.
- `GET /api/health` returns version, schema version, DB status and uptime.
- A tiny static page at `/` saying "tech-access hub" (the real panel UI is weeks 3–4).
- All assets local. No CDN anything.

## Step 2: database schema

Numbered SQL migrations in `hub/migrations/`, applied in a transaction on start-up and recorded in `schema_migrations`. Tables (use the workbook columns from `docs/workbook-format.md` as the source):

- `people`, `fobs`, `kit`, `boxes`: one row per workbook row, keyed by the workbook ID. Store enums as the exact workbook text, enforced with `CHECK` constraints. `kit.box_id` + `kit.slot` give every item a location from day one.
- `events`: append-only log. `id`, `ts` (ISO, UTC), `type` (`sign_in`, `sign_out`, `kit_out`, `kit_in`, `box_open`, `box_denied`, `admin_action`, `import_applied`, `export`, `software_update`), `person_id`, `fob_uid`, `box_id`, `kit_id`, `detail` (JSON). No updates or deletes on this table, ever.
- `import_batches`: pending and applied imports (file hash, uploaded at, preview JSON, status, applied by fob UID, applied at).
- `settings`: key/value (e.g. `students_disabled`, `show_mode`).

Foreign keys on. WAL mode. Write a short `docs/data-model.md` with a diagram (Mermaid is fine).

## Step 3: workbook import with preview, and export

This is the main piece of work. Follow `docs/workbook-format.md` exactly.

- Library: it must read and write `.xlsx` under Bun with no network at runtime. Check what's current before choosing. The npm `xlsx` package is stale, so either ExcelJS or SheetJS from its own CDN tarball, pinned in the lockfile. Tell me which and why in one paragraph before installing.
- `parseWorkbook(buffer)` → typed rows plus a list of errors and warnings, each with sheet, row number and column. Check: schema version in `Read me!B2`, required columns present, enum values, ID uniqueness, Fob UID normalising (uppercase hex, strip `:`/`-`/spaces, 4/7/10 bytes), Person ID and Box ID references, levels 1–4, the box/kit level warning.
- `diff(parsed, db)` → `{ adds, changes (field-level old → new), removals, errors, warnings }` per sheet. Rows missing from the file are `removals`, never applied silently.
- `POST /api/import` (multipart `.xlsx`) → stores a pending `import_batches` row and returns the preview. Refuse to apply if there are errors.
- `POST /api/import/:id/apply` with `{ fobUid }` → only an `Active` fob with role `Admin` can apply. One transaction. Log an `import_applied` event with counts. A second apply of the same batch is a no-op.
- `GET /api/export.xlsx` → the current DB in exactly the workbook layout, including the `Read me` sheet, the `(auto)` columns and `Exported (auto)`. Round trip test: export → import → the diff is empty.
- Admin-only routes accept requests from `127.0.0.1` only for now (the panel runs on the Pi itself). Leave a `TODO` for proper auth when Stage Door moves over in week 8.
- Tests with fixture workbooks generated in code: a good file, each error type, a file with removals, and the round trip.

## Step 4: fob roles and access decisions

A pure, fully tested module (`hub/src/access.ts`) with no I/O:

- `decideBoxOpen({ fob, person, box, settings, now })` → `{ allow, reason }`.
- `decideKitTake({ fob, person, kit, settings, now })` → `{ allow, reason }`, including the specialism match (`Any` matches everyone; `Lighting + Sound` matches both).
- `isAdmin(fob)`, `canApplySoftwareUpdate(fob, person)` (Level 3+ or Admin, for the week-7 TECHSOFTWARE stick).
- Rules: fob must be `Active`; person must be `Active`; "disable all students" blocks `Type = Student` only and never an Admin fob; Day pass expires at the end of the issue day (Europe/London); level ≥ required level. Use my answers from step 0 for staff, hire techs and day passes.
- `reason` strings are short and human, because they'll show on the panel ("Level 2 needed, you're Level 1").

## Step 5: Pi setup scripts

In `pi/`, written here, run by me on the Pi. Every script idempotent, `set -euo pipefail`, and it prints what it changed.

- `pi/README.md`: the order to do things in, starting from flashing the NVMe with Raspberry Pi Imager (USB adapter or network install) and setting the boot order. Note that the Pi needs internet once for setup (home network or a hotspot), then lives on the show network with none.
- `01-base.sh`: hostname, timezone `Europe/London`, updates, `chrony` (no NTP on the show network, so the RTC is the clock), enabling RTC battery charging if the official rechargeable cell is fitted (check the current `rtc_bbat_vchg` setting from the Pi docs before writing it), unattended upgrades off.
- `02-network.sh`: static IP on `eth0` with NetworkManager (`nmcli`), using my answers from step 0. Leave the Pico's DHCP alone. No default gateway if the show network has none.
- `03-mosquitto.sh`: install, a listener on the LAN, no anonymous access, a password file and ACL with one user for the hub and a pattern for boxes (`box/<id>/#`). Config files live in `pi/mosquitto/` and get copied in.
- `04-ca.sh`: a local CA with `openssl` (CA key stays on the Pi and in TECHBACKUP, never in git), a server certificate for the hostname and static IP, and an exported `tech-access-ca.crt` for the iPad profile later.
- `05-bun-hub.sh`: install Bun, clone or copy the repo, `bun install --frozen-lockfile`, a `systemd` unit for the hub with `Restart=always`.
- Don't do the Chromium kiosk yet (weeks 3–4).

## Definition of done for weeks 1–2

- `bun test` passes: migrations, import/diff/apply/export round trip, access rules.
- I can run the five Pi scripts on a fresh Pi and `curl http://<pi-ip>:<port>/api/health` works from the Nomad PC. (HTTPS with the local CA gets switched on when the iPad door station arrives in week 8; the certificates just need to exist by then.)
- Exporting from the hub and importing that file into my Claude Sheet works. (I'll do this part by hand and tell you.)
- `docs/decisions.md` lists my answers from step 0 and the library choice.
- Everything is pushed to `dbwg2009/tech-access`.

Not in scope yet: panel UI, fob reader on the Pi, firmware, management USB detection, Stage Door, Nomad agent.
