# Tech kit access control: handoff brief

Planning board: https://claude.ai/artifact/Aq3nca2xkPFz1mNHRofgML
Status (16 Nov 2026): weeks 1–2 merged; weeks 3–4 (desk panel, fob reader, admin menu) in progress.

## What it is
A fob-based access control system for the school tech kit (lighting/sound kit, radio mics, Nomad key, keys, show network). It does **not** control the control room door, because that would need site to approve it, install it and issue cards. It's for the Year 7–9 tech crew (Level 1–4 ladder), drama staff, Mrs Pearce/Mrs Ritter and hire company techs. It has to run with as little maintenance as possible after Daniel leaves in 2028.

## Hard constraints
- **Show network only.** The school network needs a MAC whitelist plus a certificate, so nothing joins it. There's no internet, so nothing can depend on the cloud.
- Show network: decentralised, a Pico runs DHCP (keep it, the Pi gets a static IP), it has Wi-Fi, and Eos outputs sACN from the Nomad PC's port.
- **The Nomad PC isn't school-managed**, so custom software can be installed on it. The Macs (QLab) are on the school domain, so nothing gets installed there.
- **Never in the show path.** Access is checked when kit is taken out or someone sits down, never during a show. A crash must not stop a show.
- Fail-open: a power cut unlocks the boxes. Fobs are plain NTAG (UID is enough). Management USBs are recognised by volume label.

## Architecture
- **Pi 5 hub** (4GB, official 27W PSU, M.2 HAT + NVMe SSD, RTC battery, active cooler). It holds the source of truth (SQLite), runs MQTT (Mosquitto), hosts Stage Door, runs backups and watches the USB ports.
- **Desk panel:** a new 10.1" HDMI + USB-touch screen (Waveshare, 1280×800 landscape, dark theme, turns off when idle) on a J-pole or stubby VESA 75 desk mount. A 3D-printed side pod holds a PN532 fob reader (on the Pi's GPIO UART, HSU mode; no buzzer or LED, all feedback on screen) and a panel-mount USB-A port. The Pi sits on a VESA plate behind the screen. The panel runs off the Pi, not the Nomad PC, so touching it never takes focus away from Eos.
- **Nomad PC:** a small background agent that syncs Eos show files to the Pi (bun --compile .exe), plus the panel in an app-mode browser window.
- **Lock boxes / wall key cabinet:** ESP32 Ethernet boards (WT32-ETH01 or Olimex ESP32-POE-ISO) with a PN532 and a fail-open maglock. Fixed boxes run on PoE (PoE switch + 12V splitter per box: one cable). Flight cases run on Wi-Fi.
- **Door station:** the old iPad (iOS 15) running Stage Door crew mode, with an ESP32 acting as a BLE-keyboard fob reader (Safari has no Web NFC). It needs a local CA profile installed for HTTPS.
- Ladder enforcement happens through what's locked away (e.g. Nomad key, radio mics, haze remote), with levels taken from the Tracker.

## Stack
- Hub: TypeScript, Bun + Hono + bun:sqlite. Panel: web UI in Chromium kiosk mode on the Pi.
- Firmware: PlatformIO + Arduino C++, one firmware for every node with per-node config (box ID, required level, Ethernet or Wi-Fi), OTA updates from the Pi.
- Stage Door: currently Cloudflare Workers/D1. Plan to run one codebase on both via Hono, swapping D1 for SQLite. **Check whether "hono" is in its package.json before week 8.**
- Repo: public, on GitHub (dbwg2009).

## Agreed decisions
- **One admin fob role**, with several enrolled copies (Daniel, Mrs Ritter, a sealed spare in the school office). Tapping it opens the admin menu on the desk panel (closes after 90 s without a touch): disable/re-enable students, enrol a fob, mark a fob lost / revoke it, guest day pass, show mode on/off, force-return kit, end of session, event log, hub status, restart hub / reboot Pi. Risky actions are confirmed by tapping an admin fob again. An admin fob first shows the normal crew card with a red Admin panel button. The admin menu also has **People, kit & boxes**, an editor for everything in the workbook: since 16 Nov 2026 **the panel is the main copy** and the workbook is the backup / bulk tool. "Disable all students" affects students only; the admin fob undoes it. Details: `docs/decisions.md` (2026-11-16).
- **Pi unreachable:** boxes keep using their cached fob list, then unlock after 5 minutes (configurable). A power cut unlocks them straight away.
- **Management USBs:** TECHBACKUP (everything to the stick), TECHUPDATE (Tracker .xlsx as-is, preview on the panel, apply with an admin fob tap), TECHSOFTWARE (hub + box firmware; **needs a Level 3+ or admin fob tap**, logged against that fob).
- Fob lifecycle: issued with Level 1; a lost fob gets revoked; £2 charged from the second lost fob.
- Logs: sign-ins and kit out/in, viewable on the panel with any admin fob (changed 16 Nov 2026; was "Daniel only").
- Backups: crew database and logs, Stage Door data, lock box configs (automatic); Eos via the Nomad agent; QLab via USB; WING over the network if that turns out to be possible (test it), otherwise USB.
- **Budget: about £350 agreed** (wired + new screen). Prices so far are rough; check them before ordering. Phase the buying: Pi kit and screen for weeks 1–4, PoE switch and box parts by week 5.

## Build order (about 15 h a week)
1. **Wk 1–2:** Pi base (NVMe boot, static IP, RTC, Mosquitto, Bun, local CA, repo), database schema (people, fobs, levels, kit, boxes, events), Tracker .xlsx importer with preview, fob roles.
2. **Wk 3–4:** Desk panel + Pi fob reader; admin menu.
3. **Wk 5–6:** First lock box end to end + OTA.
4. **Wk 7:** Management USBs.
5. **Wk 8–10:** Stage Door port + door station (biggest unknown).
6. **Wk 11+:** Nomad agent, kit NFC tags, more boxes, key cabinet.
Later: OSC to Eos/WING; per-drawer item recognition (UHF RFID, weight sensors, cameras). Each item gets a location in the data model from day one.

## Still open
- ~~Panel features need detailed discussion.~~ Decided 16 Nov 2026 (see `docs/decisions.md`): idle clock; after a tap, crew card (first name, level + specialism, kit out; sign in/out, take kit, return kit, open a box) plus overview (signed in, box status, kit out, hub health). Hours are not shown. Show mode = all boxes unlocked until an admin turns it off or ends the session. Imports never silently undo panel changes (conflicts are shown and chosen).
- Choose the touchscreen and ESP32 Ethernet board; write the parts list with current prices.
- Map the Tracker .xlsx columns (the MCS Techies Tracker lives in the Training Program project).
## Links (added 15 Nov 2026)
- Source-of-truth workbook (Claude Sheet): https://claude.ai/artifact/BNeQaFp5dnPPTbkmtVAdqn
- Parts list with prices (Claude Sheet): https://claude.ai/artifact/9aqfHVEtPJUr9DeWr2RYvN
- Board chosen: WT32-ETH01 (12V from the PoE splitter for the maglock, Mini560 buck to 5V for the board). Touchscreen: Waveshare 10.1" bare panel (Pi Hut WAV-23739, £72) with a printed VESA 75 plate. Small boards from AliExpress (order before week 3). Parts total about £396, so about £46 over budget.
