# 10. Lock boxes

[← The desk panel](Desk-Panel.md) · [Home](Home.md) · Next: [Bench test →](Bench-Test.md)

A lock box is a cupboard, cabinet or drawer held shut by a 12 V **maglock**, with a **PN532** fob
reader on the front and a **WT32-ETH01** (ESP32 + Ethernet) inside. One Ethernet cable from the
PoE switch powers it and connects it to the hub. The first one is a filing cabinet.

**Fail open, always.** No power = maglock off = open. No hub for `offline_unlock_min` minutes
(default 5) = open. A crash, watchdog reboot or brown-out = open while it restarts.

How a box talks to the hub: [`docs/mqtt.md`](../mqtt.md). Why it's built this way:
[`docs/decisions.md`](../decisions.md) (2026-11-16, weeks 5–6).

## Parts per box

| Part | Notes |
| --- | --- |
| WT32-ETH01 | ESP32 + LAN8720 Ethernet. No USB port: see "First flash" for the adapter. |
| PN532 NFC module (red "V3" board) | Set both DIP switches for **HSU** (on most boards: `SEL0` off, `SEL1` off / `0 0`). Powered from the WT32's 3.3 V. |
| 12 V maglock, cabinet size | Check its current on the label (typically 0.2–0.5 A). Mount the armature plate on the drawer or door. |
| PoE splitter, 802.3af in, **12 V** out | 12 V for the maglock; also feeds the Mini560. Plug it into a PoE port on the switch. |
| Mini560 buck converter, **5 V** output version | 12 V in, 5 V out to the WT32-ETH01's `5V` pin. |
| Logic-level N-MOSFET (e.g. IRLB8721, or AO3400 on a breakout) | Must be fully on at 3.3 V gate drive (datasheet: R<sub>DS(on)</sub> given at V<sub>GS</sub> = 2.5–4.5 V). Not an IRF540/IRFZ44N. |
| Diode 1N4007 (or 1N5819) | Flyback diode across the maglock. Without it the switch-off spike kills the MOSFET. |
| Resistors: 10 kΩ ×2, 100 Ω ×1 | 10 kΩ gate pull-down, 100 Ω gate resistor, 10 kΩ reed pull-up. |
| Reed switch, normally open, plus magnet | Closed (magnet near) = door shut. Surface-mount door/window type is easiest. |
| Inline fuse holder + **1 A slow-blow** fuse | On the 12 V line straight after the splitter. Use about twice the maglock's current. |
| Wago / screw terminals, small enclosure, cable glands | |
| For flashing (one for all boxes): **3.3 V** USB-serial adapter (CP2102 or FT232, set to 3.3 V) and a jumper wire | The WT32-ETH01 has no USB. |

## Wiring

```
 PoE switch ──Cat6──► PoE splitter ──► RJ45 (data) ──────────────► WT32-ETH01 Ethernet jack
                          │
                          └─► +12 V ──[ 1 A fuse ]──┬──────────────────────────┐
                              GND ──────────────────┼───────────┐              │
                                                    │           │              │
                                             Mini560 IN+   Mini560 IN−         │
                                             Mini560 OUT+ (5 V) ──► WT32 5V     │
                                             Mini560 OUT− ───────► WT32 GND     │
                                                                               │
   Maglock:
      +12 V (after the fuse) ──────┬──────────────── maglock + (red)
                                   │
                              1N4007 diode
                       (stripe / cathode at the top, to +12 V)
                                   │
      MOSFET drain ────────────────┴──────────────── maglock − (black)
      MOSFET source ──► GND
      MOSFET gate ──[100 Ω]──► WT32 IO32
            └───[10 kΩ]───► GND          (gate pull-down: no signal = off = UNLOCKED)

   PN532 (HSU):  VCC ─► WT32 3V3     GND ─► GND
                 TXD ─► WT32 IO5 (RXD)      RXD ─► WT32 IO17 (TXD)

   Reed switch:  one leg ─► WT32 IO4,  other leg ─► GND
                 10 kΩ from IO4 to 3V3 (pull-up; the firmware adds its own as well)
```

The diode goes **across the maglock**, stripe to +12 V. All grounds join (splitter, Mini560, WT32,
MOSFET source, PN532). Set the Mini560 to 5 V **before** connecting the WT32 if yours is the
adjustable kind.

### Pins (WT32-ETH01)

| Pin | Used for | Why this pin |
| --- | --- | --- |
| IO5 (`RXD`) | PN532 TXD → ESP32 RX (UART2) | The board's own serial pins. Strap pin, but the PN532 idles high, which is its default. |
| IO17 (`TXD`) | ESP32 TX → PN532 RXD | |
| IO32 (`CFG`) | MOSFET gate, **HIGH = locked** | Not a strapping pin, nothing on it at boot. |
| IO4 | Reed switch, LOW = shut | Plain input with a pull-up. A broken wire reads "open" (the safe report). |
| IO0 | *Don't use.* LAN8720 clock input, and "hold low at reset to flash" | |
| IO16, 18, 19, 21, 22, 23, 25, 26, 27 | *Don't use.* Ethernet chip | |
| IO1 / IO3 (`TX0` / `RX0`) | USB-serial adapter: flashing and the setup console | |
| IO2, 12, 14, 15, 33, 35, 36, 39 | Free (IO2, 12, 15 are strapping pins: keep them unloaded at boot) | |

## Adding a box, start to finish

1. **In the hub.** Admin menu → **People, kit & boxes** → **Boxes** → add one (or add a row to
   the workbook's Boxes sheet and import it). Note the Box ID (`BOX-01`…), and give it the next IP
   from `10.102.40.101` up, its Required level and Offline unlock (min) (default 5).
2. **MQTT login.** On the Pi: `cd /opt/tech-access/pi && sudo ./mqtt-add-box.sh BOX-01`. It prints
   the password. Keep that terminal open.
3. **First flash** (on your PC, from the `firmware/` folder of the repo; needs PlatformIO):
   - Wire the USB-serial adapter: adapter **TX → IO3 (RX0)**, **RX → IO1 (TX0)**, **GND → GND**,
     and power the board (its 5 V supply, or the adapter's 5 V to the `5V` pin).
   - Jumper **IO0 to GND**, then press reset (`EN`) or power-cycle. That's flashing mode.
   - `pio run -e wt32-eth01 -t upload --upload-port COM5` (Windows), or `/dev/ttyUSB0` (Linux),
     `/dev/cu.usbserial-…` (macOS).
   - Remove the IO0 jumper and press reset. `pio device monitor -p COM5` shows
     `tech-access box firmware 0.1.0` and `not provisioned`.
4. **Provision** (same cable, monitor closed):
   ```bash
   ~/.platformio/penv/bin/python tools/provision.py --port /dev/ttyUSB0 --id BOX-01 --ip 10.102.40.101
   ```
   On Windows: `%USERPROFILE%\.platformio\penv\Scripts\python tools\provision.py --port COM5 --id BOX-01 --ip 10.102.40.101`.
   It asks for the password from step 2 (paste it; it isn't shown), sets everything, shows the
   result and reboots the box. Add `--door off` if there's no reed switch.
5. **Check.** Plug in the Ethernet. The serial monitor shows `mqtt: connected to 10.102.40.10 as
   BOX-01` and `lock: locked`. The panel's overview shows the box **locked**; `curl -s
   http://127.0.0.1:8080/api/boxes` on the Pi shows its `fw`.
6. **Test.** Tap an allowed fob at the box: it opens for 8 s, and **Admin → Event log** says
   "… opened Mic box at the box". Tap a fob that isn't allowed: it stays shut, and the log says
   why. Open it from the panel. Then run the parts of the [bench test](Bench-Test.md) that apply.

The serial console also has `show`, `status`, `reboot`, `forget-fobs` and `factory-reset`
(type `help`). Nothing secret is stored anywhere but the box's NVS and `/etc/tech-access/mqtt/`
on the Pi.

## What a box does when the Pi is down

| Situation | What happens |
| --- | --- |
| Hub crashes, Pi still up | The broker tells the boxes (`hub/status` goes offline). Taps at the box still work from the box's saved list. After *Offline unlock* minutes the box **unlocks** and stays unlocked. |
| Pi off, or the network's down | Same: saved list first, then unlocked after *Offline unlock* minutes. |
| Hub comes back | Boxes lock again within seconds and send the taps they kept (up to 32 each); the event log shows them at the time they happened, marked "hub was unreachable". |
| Box rebooted while the Pi is down | It comes back **locked** with its saved list (show mode isn't saved), and the offline timer starts again from boot. |
| Power cut to the box | Maglock unpowered = **open**. When power returns it boots, locks with its saved list, and carries on. |
| A brand-new box that has never had a list | **Open** until the hub sends its first list. |
| Box clock never set (Pi's NTP unreachable since the box booted) | Standard fobs work; day passes are refused; panel opens are accepted. |

Nothing a box does depends on Eos, QLab or the WING, and nothing they do depends on the boxes.

## Updating box firmware

Updates only happen when an admin asks, and a box refuses (and says why) while it's unlocked, in
show mode or within 3 s of a tap. A new version that can't reach the hub within 5 minutes, or
crashes, **rolls back** to the old one by itself.

1. In `firmware/platformio.ini`, bump `version` under `[fw]` (e.g. `0.1.0` → `0.2.0`). A version
   is never reused.
2. Build: `pio run -e wt32-eth01`. The image is `firmware/.pio/build/wt32-eth01/firmware.bin`
   (CI also keeps it as the `box-firmware` artifact of every build).
3. Copy it to the Pi (`scp`, or the TECHSOFTWARE stick from week 7), then on the Pi:
   ```bash
   cd /opt/tech-access/hub && bun run scripts/update-boxes.ts --file ~/firmware.bin --version 0.2.0
   ```
   Tap an admin fob when it asks (it opens the admin menu), then again to confirm. Add
   `--boxes BOX-01` to update just one. It shows each box's progress: `requested` → `updating`
   → `rebooting` → `updated`, or `refused (unlocked)` / `failed (…)` / `rolled_back`.
4. **Admin → Event log** (type *software_update*) has the whole history, with who confirmed it.

The same thing is available to any client as `POST /api/admin/firmware` (multipart: `session`,
`version`, `file`) and `POST /api/admin/firmware/update` (`{session, boxes: "all" | [...],
version}`, then an admin fob tap). The native panel app will put a button on it.

## Trying it without hardware

The box simulator (`tools/box-sim/`) runs pretend boxes with the firmware's own rules against a
real Mosquitto and hub on your PC. See [`tools/box-sim/README.md`](../../tools/box-sim/README.md).
