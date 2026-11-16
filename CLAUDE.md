# tech-access

Fob-based access control for the school tech kit (lock boxes, key cabinet, flight cases, desk panel).
Full brief: `docs/brief.md`. Workbook import/export contract: `docs/workbook-format.md`.

## Hard rules

- **Show network only, no internet at runtime.** Nothing may depend on the cloud, a CDN or a package registry once deployed. Fonts, JS and CSS are bundled locally.
- **Never in the show path.** Access is checked when kit is taken out or someone sits down. A hub crash must never affect Eos, QLab or the WING.
- **Fail open.** Power cut = boxes unlock. Pi unreachable = boxes use their cached fob list, then unlock after the box's offline timeout (default 5 min).
- **Low maintenance after 2028.** Prefer boring, well-documented choices over clever ones. Every script idempotent. Every config in the repo.
- Do not install anything on the QLab Macs (school-managed). The Nomad PC is fine.

## Stack

- Hub: TypeScript (strict), Bun, Hono, `bun:sqlite`. Tests with `bun test`.
- Panel: web UI served by the hub, shown in Chromium kiosk mode on the Pi.
- Broker: Mosquitto on the Pi.
- Firmware: PlatformIO (pioarduino, Arduino-ESP32 3.3.12, pinned) + Arduino C++, one firmware for all nodes with per-node config, OTA from the Pi. Rules in `firmware/lib/box_core`; change `firmware/test/vectors` first, then box_core and `tools/box-sim/core.ts` together.
- Tests: `bun test` in `hub/` and `tools/box-sim/`; `pio test -e native` in `firmware/`.

## Layout

```
hub/        Bun + Hono app (API, panel UI, importer, MQTT bridge, box firmware store)
pi/         setup scripts, systemd units, Mosquitto and CA config
firmware/   PlatformIO project: lib/box_core (rules, plain C++), src/ (hardware), test/vectors
tools/      box-sim: simulated boxes (same rules + vectors as the firmware), end-to-end test
docs/       brief, workbook format, decisions, MQTT contract, wiki
```

## Working with Daniel

- Plan first and wait for approval before large changes. Small, reviewable commits.
- Ask when a decision isn't in `docs/brief.md`; don't invent policy (who can open what).
- Scripts for the Pi are written here and run by Daniel on the Pi. Ask him to paste output back.
- Record new decisions in `docs/decisions.md` (date, decision, reason).
