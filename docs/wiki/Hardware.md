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

Weeks 3–4: the Waveshare 10.1" touchscreen and VESA plate, and the printed side pod with the
PN532 fob reader (wiring below) and the USB-A port. Prices and order links are in the parts
list linked from the [brief](../brief.md).

## Assembly

1. Stick on the **active cooler** and plug its fan lead into the `FAN` connector.
2. Fit the **NVMe SSD** to the M.2 HAT+. Connect the HAT's ribbon cable to the Pi's PCIe
   connector (contacts the right way round, latch closed), then mount the HAT on its standoffs.
3. Plug the **RTC battery** into the two-pin `BAT` connector next to the USB-C power port.
   Stick it down with its pad.
4. Leave the SD slot empty.

A Pi 5 with nothing bootable shows a boot screen on HDMI. That's normal until you flash it
([page 2](Flash-the-Pi.md)).

## Desk fob reader (PN532)

The reader in the side pod is a PN532 board wired straight to the Pi's GPIO header and used in
**HSU** mode (high-speed UART: plain serial at 115200 baud). There's no buzzer or LED; the
screen shows every tap.

### 1. Set the switches to HSU

Most PN532 boards have two DIP switches (labelled `1`/`2`, `SEL0`/`SEL1` or `SET0`/`SET1`) that
choose the interface. **HSU is both switches OFF (0, 0).** The other settings are I2C (1 on, 2 off)
and SPI (1 off, 2 on). Check the table printed on your board's silkscreen: if it disagrees with
this, the board wins. Set the switches with the power off; the PN532 reads them at power-up.

### 2. Wire it (power off)

Use the board's 4-pin header marked `GND VCC TXD RXD` (on some boards the same pins are marked
`SDA/TXD` and `SCL/RXD`). Pin numbers are the Pi's 40-pin header, pin 1 nearest the SD slot
end.

| PN532 | Pi 5 | Pin |
| --- | --- | --- |
| `VCC` | **3.3 V** | 1 |
| `GND` | GND | 6 |
| `RXD` | GPIO14 (TXD) | 8 |
| `TXD` | GPIO15 (RXD) | 10 |

- **3.3 V, not 5 V.** The Pi's GPIO pins are 3.3 V only. Powered from 3.3 V, the PN532's logic is
  3.3 V too, so nothing can push 5 V into the Pi.
- TX goes to RX and RX to TX (crossed). If the reader isn't found, swapping these two wires is
  the first thing to try. It's harmless.
- Keep the wires short (under about 30 cm) and away from the screen's power lead.

### 3. Turn the UART on (done by the setup script)

On a Pi 5, GPIO14/15 are `UART0`, which Linux calls **`/dev/ttyAMA0`**. It's off by default.
`/dev/serial0` is **not** this port on a Pi 5: it points at the little 3-pin debug header
(`/dev/ttyAMA10`). So the hub is set to `reader_device = "/dev/ttyAMA0"`. (Source: Raspberry Pi
documentation, *Configuration → Configure UARTs*, checked 16 Nov 2026.)

`sudo ./07-reader.sh` does this, so you don't have to by hand (then reboot):

- adds `dtparam=uart0=on` to `/boot/firmware/config.txt` (if `/dev/ttyAMA0` still doesn't
  appear after a reboot, `dtoverlay=uart0-pi5` is the documented Pi 5 alternative);
- does **not** add `enable_uart=1`: on a Pi 5 that sends kernel log messages out of GPIO14/15,
  straight into the PN532;
- turns the serial login console off (`raspi-config nonint do_serial_cons 1`) so nothing else
  talks on the port;
- puts the `techaccess` user in the `dialout` group so the hub can open the port.

The hub sets the port to raw 115200 8N1 each time it opens it.

### Check it

`curl -s http://127.0.0.1:8080/api/health` on the Pi shows a `reader` section. `"state": "ok"`
with `"firmware": "PN532 v1.6"` means it's working. `"reader not found: /dev/ttyAMA0 missing"`
means the UART isn't on; `"reader not found: no answer on /dev/ttyAMA0"` means the port is there
but the PN532 isn't answering (check the switches, then swap TX/RX).

## Things that matter later

- **Never use a non-rechargeable lithium cell** in the RTC slot (the Pi charges it), and never a
  lithium-ion cell. `01-base.sh` turns charging on because the official cell is fitted
  (`RTC_BATTERY=rechargeable` in `pi/config.env`). If you fit no battery, or a different one, set
  `RTC_BATTERY=none` and re-run `01-base.sh`.
- The Pi sits behind the desk screen. Keep the cooler's air path clear.
