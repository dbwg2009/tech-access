# Box simulator

Pretend lock boxes that speak the [MQTT contract](../../docs/mqtt.md) with the firmware's own
rules: `core.ts` is a line-by-line port of `firmware/lib/box_core`, and both are tested against
the same cases in [`firmware/test/vectors/`](../../firmware/test/vectors/README.md). It's the
test tool for the hub and the reference for how a real box behaves.

```bash
cd tools/box-sim
bun install --frozen-lockfile
bun test                      # the shared vectors + the end-to-end test (needs Mosquitto)
```

## Everything on your PC: hub + Mosquitto + two boxes

You need [Bun](https://bun.sh) and [Mosquitto](https://mosquitto.org/download/) (Windows: the
installer, then use `"C:\Program Files\mosquitto\mosquitto.exe"`; macOS: `brew install mosquitto`;
Linux: `sudo apt install mosquitto` and `sudo systemctl stop mosquitto` so port 1883 is free).
Four terminals, all from the repo root:

1. **Broker** (no passwords, localhost only, the Pi's real ACL):
   ```bash
   mosquitto -c tools/box-sim/mosquitto-dev.conf
   ```
2. **Hub** with a demo database and the fake fob reader:
   ```bash
   cd hub && bun install --frozen-lockfile && bun run build && bun run scripts/demo-db.ts data/demo.db
   ```
   Make `hub/config.toml` (not committed) with:
   ```toml
   db_path = "data/demo.db"
   fake_reader = true
   # paste the fake_fobs = [...] line that demo-db.ts printed
   firmware_url = "http://127.0.0.1:8080"
   ```
   then `bun run start` and open <http://127.0.0.1:8080/panel/> in a browser.
3. **Two boxes**:
   ```bash
   cd tools/box-sim && bun install --frozen-lockfile && bun run sim.ts --boxes BOX-01,BOX-02
   ```
   Both connect, get their fob lists and lock. Type `help` for the commands:
   `tap BOX-01 04A1B2C3D4E501` (a tap at the box), `drop BOX-01` / `back BOX-01` (network
   cable), `power BOX-01 off` / `on`, `door BOX-01 open`, `ota BOX-02 broken`, `status`.
4. **Things to try**
   - Panel: **DEV: tap next fob** until you get Ada (`…E501`, Level 2) → **Open a box** → Mic box.
     BOX-01 prints `UNLOCKED (cmd)`, then `LOCKED` 8 s later.
   - Simulator: `tap BOX-01 04A1B2C3D4E504` (Cal, Level 1): denied. Admin → Event log shows both
     taps "at the box".
   - Admin (Mrs Ritter `…E502` or Daniel `…E505`): Show mode on → both boxes unlock; End of
     session → both lock.
   - Stop the hub (Ctrl+C): after 5 minutes both boxes print `UNLOCKED (offline)`. Start it
     again: they lock. (`--minute-ms 1000` makes a box "minute" one second, for quicker tries.)
   - OTA to both (uses the fake reader to tap Mrs Ritter's admin fob twice):
     ```bash
     cd hub && bun run scripts/update-boxes.ts --dev-tap 04A1B2C3D4E502 --version 0.2.0
     ```
     Then `ota BOX-02 broken` in the simulator and push `0.2.1`: BOX-02 rolls back to 0.2.0
     after 5 box-minutes.

## Against the real Pi

`--url mqtt://10.102.40.10:1883 --password-file pw.txt`, where `pw.txt` has a line
`BOX-01=<password>` per box (from `sudo ./mqtt-add-box.sh BOX-01` on the Pi). Only for boxes
that don't exist as hardware yet: two clients with the same Box ID knock each other off.
