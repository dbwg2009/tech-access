# tech-access

Fob-based access control for a school's technical theatre kit: lock boxes, a key
cabinet, flight cases and a desk panel, run from a Raspberry Pi 5 on an isolated
show network with no internet.

- `hub/`: Bun + Hono + SQLite app (API, workbook importer, panel UI later)
- `pi/`: Pi setup scripts, systemd units, Mosquitto and CA config
- `firmware/`: ESP32 lock box firmware (from week 5)
- `docs/`: **[setup wiki](https://github.com/dbwg2009/tech-access/wiki)** (source in `docs/wiki/`), [brief](docs/brief.md), [workbook format](docs/workbook-format.md), [decisions](docs/decisions.md)

Design rules: never in the show path, fail open, nothing depends on the cloud at runtime.

Licence: MIT.
