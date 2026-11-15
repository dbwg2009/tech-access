# 1. Hardware

[← Home](Home.md)

## The hub

| Part | Notes |
| --- | --- |
| Raspberry Pi 5, 4 GB | |
| Official 27 W USB-C power supply | Smaller supplies cause USB and NVMe trouble. |
| Official active cooler | Fit it first; it's hard to reach once the HAT is on. |
| M.2 HAT+ and an NVMe SSD | The OS and database live on the SSD. No SD card. |
| Official rechargeable RTC battery (Li-Mn, JST plug) | Keeps the clock when the power's off. The show network has no time server, so this **is** the clock. |
| Short Ethernet cable | To a Control-network port on the desk switch. |

Later (not needed for weeks 1–2): the Waveshare 10.1" touchscreen and VESA plate, and the printed
side pod with the PN532 fob reader and the USB-A port. Prices and order links are in the parts
list linked from the [brief](../brief.md).

## Assembly

1. Stick on the **active cooler** and plug its fan lead into the `FAN` connector.
2. Fit the **NVMe SSD** to the M.2 HAT+. Connect the HAT's ribbon cable to the Pi's PCIe
   connector (contacts the right way round, latch closed), then mount the HAT on its standoffs.
3. Plug the **RTC battery** into the two-pin `BAT` connector next to the USB-C power port.
   Stick it down with its pad.
4. Leave the SD slot empty.

A Pi 5 with nothing bootable shows a boot screen on HDMI. That's normal until you flash it
([page 2](02-flash-the-pi.md)).

## Things that matter later

- **Never use a non-rechargeable lithium cell** in the RTC slot (the Pi charges it), and never a
  lithium-ion cell. `01-base.sh` turns charging on because the official cell is fitted
  (`RTC_BATTERY=rechargeable` in `pi/config.env`). If you fit no battery, or a different one, set
  `RTC_BATTERY=none` and re-run `01-base.sh`.
- The Pi sits behind the desk screen. Keep the cooler's air path clear.
