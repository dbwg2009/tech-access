# 11. Bench test (first lock box)

[← Lock boxes](Lock-Boxes.md) · [Home](Home.md)

Run this on the bench when the parts arrive, **before** fitting anything to the filing cabinet.
Tick each box; if one fails, stop and fix it (see [Troubleshooting](Troubleshooting.md#lock-boxes)).
Wiring and parts: [Lock boxes](Lock-Boxes.md). Allow about 3 hours.

You need: the parts for one box, the PoE switch, the Pi (hub running, on the show network), a
laptop with PlatformIO and the repo, the 3.3 V USB-serial adapter, a multimeter, two fobs (one
allowed on the box, one not) and an admin fob.

Write down as you go: maglock current ______ A, fuse ______ A, Box ID ______, IP ______.

## A. Power and the lock, no firmware (the fail-open check)

Do this **with no WT32-ETH01 fitted** (or with it unplugged from the MOSFET gate).

1. [ ] Mini560 alone on 12 V from the bench supply or splitter: output reads **5.0 V ± 0.2 V**. Adjust *before* connecting anything.
2. [ ] PoE splitter on the switch: output reads **12 V** (11.4–12.6 V).
3. [ ] Maglock wired through the fuse and MOSFET, gate pull-down fitted, **gate not connected to anything**: the maglock is **not** holding (armature plate falls off / pulls away freely). This is fail-open with no controller.
4. [ ] Touch the gate to +3.3 V (via the 100 Ω): the maglock **holds**. Remove it: it **releases** at once. Repeat 5 times; no buzzing, the MOSFET stays cool.
5. [ ] With the maglock holding, measure the current: ______ A. The fuse is roughly twice that (1 A for up to 0.5 A).
6. [ ] Check the flyback diode's direction: stripe to +12 V. (Wrong way round = a short when the gate turns on: the fuse blows.)
7. [ ] Reed switch: meter on continuity. Magnet next to it = closed; magnet away = open.

## B. First flash and provisioning

8. [ ] Mini560 5 V to the WT32 `5V` pin, grounds joined. The WT32's power LED is on; nothing gets hot.
9. [ ] USB-serial adapter set to **3.3 V**: TX → IO3, RX → IO1, GND → GND. IO0 jumpered to GND, reset.
10. [ ] `pio run -e wt32-eth01 -t upload --upload-port <port>` finishes with `SUCCESS`.
11. [ ] Remove the IO0 jumper, reset. `pio device monitor -p <port>` shows `tech-access box firmware 0.1.0`, `lock: open (no_list)`, `not provisioned`.
12. [ ] Connect the MOSFET gate to IO32 (100 Ω + 10 kΩ pull-down) and the maglock: with no list it's **open** (holds nothing).
13. [ ] PN532 wired for HSU (DIP switches `0 0`). After reset the monitor shows `reader: PN532 firmware 1.6` (not "not answering").
14. [ ] Reed switch on IO4: type `status` in the monitor. Magnet on = `door shut`, magnet off = `door open`.
15. [ ] Add the box on the panel (Box ID, IP from `10.102.40.101`, Required level, Offline unlock 5). On the Pi: `sudo ./mqtt-add-box.sh <Box ID>`.
16. [ ] `provision.py --port <port> --id <Box ID> --ip <IP>` prints OK for every setting and reboots the box.
17. [ ] Ethernet in (PoE splitter data port to the WT32). The monitor shows `mqtt: connected to 10.102.40.10 as <Box ID>`, then `lock: locked`. The maglock **holds**.
18. [ ] `status` shows `clock 2026-…` (NTP from the Pi works) and `fobs stored (N)`.
19. [ ] On the Pi: `curl -s http://127.0.0.1:8080/api/boxes` shows the box `"status":"locked"`, `"fw":"0.1.0"`, `"door":"shut"`. The panel overview shows it **locked**.

## C. Fobs at the box

20. [ ] Tap the **allowed** fob: the maglock releases at once (no delay you can notice) and holds again after **8 s**. Event log: "… opened … at the box".
21. [ ] Hold the fob on the reader for 10 s: it opens **once** (one event), not over and over.
22. [ ] Tap the **not-allowed** fob: stays locked. Event log: "… couldn't open … at the box: not allowed on this box".
23. [ ] Tap an unknown fob (one not in the hub at all): stays locked; the log shows "fob …1234".
24. [ ] Disable students on the panel (if the allowed fob is a student's): within a few seconds that fob no longer opens the box. Re-enable.

## D. Panel open

25. [ ] Tap the allowed fob on the **desk** reader → **Open a box** → this box: it opens within a second, locks after 8 s. The overview shows open, then locked.
26. [ ] Unplug the box's Ethernet, wait 90 s: the panel shows it **offline** and "Open a box" says so instead of sending. Plug it back in: **locked** again within a few seconds.

## E. Show mode and End of session

27. [ ] Admin → Show mode on (confirm with an admin fob): the box **opens** within a second and stays open. Any fob tapped at the box is logged as "show mode".
28. [ ] Reboot the box (`reboot` in the monitor, or power-cycle) while show mode is on: it comes back **open** (the retained show flag).
29. [ ] Open the door (magnet away). Admin → End of session: the box is listed as still open; then it **locks** (maglock powered even though the door is open), show mode is off, and `api/boxes` says `"door":"open"`. Close the door: `"door":"shut"`.

## F. Unplug the Pi (hub unreachable)

30. [ ] `sudo systemctl stop tech-access-hub` on the Pi (broker still up). Tap the allowed fob at the box: it **still opens** (saved list). The not-allowed one doesn't.
31. [ ] Leave it: after **5 minutes** (the box's Offline unlock) the box **unlocks** by itself (`lock: open (offline)` in the monitor).
32. [ ] `sudo systemctl start tech-access-hub`: within a few seconds the box **locks** again. The event log shows the taps from step 30, at the time they happened, "hub was unreachable".
33. [ ] Now pull the Pi's power (or the box's Ethernet) instead: same thing (saved list, then unlocked after 5 min). Put it back: locks again.

## G. Power cut

34. [ ] With the box locked, pull the PoE cable: the maglock **releases immediately**.
35. [ ] Plug it back in: the box boots, **locks** within a few seconds (list from flash, even if the Pi is off), and the panel shows it locked once it reconnects.
36. [ ] Pull the cable while the box is open from a tap, and again during boot (within 2 s of plugging in): every time it ends up open while unpowered and locked once running. Never stuck locked.

## H. Firmware update (OTA)

37. [ ] On your PC, change `version` in `firmware/platformio.ini` to `0.1.1`, `pio run -e wt32-eth01`, copy `.pio/build/wt32-eth01/firmware.bin` to the Pi.
38. [ ] Tap the allowed fob at the box, then straight away run `bun run scripts/update-boxes.ts --file ~/firmware.bin --version 0.1.1 --boxes <Box ID>` and confirm: it says **refused (unlocked)** (or `mid_tap`), and nothing changes.
39. [ ] Wait until it's locked and run it again: `requested` → `updating` → `rebooting` → `updated`. The monitor shows the download, `ota: flashed, rebooting`, then `tech-access box firmware 0.1.1` and `ota: new firmware reached the hub, marked valid`. `api/boxes` shows `"fw":"0.1.1"`. The box stayed **locked** apart from the reboot (a second or two open).
40. [ ] Show mode on, try to update: **refused (show_mode)**. Show mode off.

## I. A broken update rolls back

41. [ ] Make a build that can't reach the hub: set `version = 0.1.2`, and in `firmware/src/main.cpp` comment out the line `mqttMaintain(now);` in `loop()` (it then never connects to MQTT). Build it.
42. [ ] Push it with `update-boxes.ts --version 0.1.2`: it goes `updating` → `rebooting`, then the box boots 0.1.2 and never connects.
43. [ ] Within **5 minutes** the monitor shows `ota: new firmware never reached the hub, rolling back`, the box reboots into **0.1.1** and the hub shows `rolled_back` (event log: "went back to its old firmware: 0.1.2 didn't work"). `api/boxes` shows `"fw":"0.1.1"`.
44. [ ] **Undo the deliberate break** in `main.cpp` (`git checkout firmware/src/main.cpp`) and set the version back to the next real number.

## Done

45. [ ] Fill in the cabinet details in `docs/decisions.md` (contents, Required level, location, how the maglock holds the drawers) and the measured current and fuse above.
46. [ ] Note anything that surprised you at the bottom of this page.

Notes:
