#!/usr/bin/env python3
"""Provision a lock box over USB serial in one go (docs/wiki/Lock-Boxes.md).

Uses pyserial, which PlatformIO already installs in its own Python. Run it with that Python so
there is nothing else to install (from the firmware/ folder):

    Windows:        %USERPROFILE%\.platformio\penv\Scripts\python tools\provision.py --port COM5 --id BOX-01 --ip 10.102.40.101
    macOS / Linux:  ~/.platformio/penv/bin/python tools/provision.py --port /dev/ttyUSB0 --id BOX-01 --ip 10.102.40.101

The MQTT password is asked for (not echoed) unless --pass-file is given, so it never ends up in
your shell history or in git. Get it on the Pi with: sudo pi/mqtt-add-box.sh BOX-01
"""
import argparse
import getpass
import re
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is missing. Run this with PlatformIO's Python (see the top of this file) or: pip install pyserial")


def talk(port, line, timeout=5.0):
    """Send one console line, return (ok, reply lines)."""
    port.reset_input_buffer()
    port.write((line + "\n").encode())
    lines, end = [], time.time() + timeout
    while time.time() < end:
        raw = port.readline().decode(errors="replace").strip()
        if not raw:
            continue
        lines.append(raw)
        if raw.startswith("OK"):
            return True, lines
        if raw.startswith("ERR"):
            return False, lines
    return False, lines + ["(no answer: is this a box, and is it running the tech-access firmware?)"]


def main():
    ap = argparse.ArgumentParser(description="Provision a tech-access lock box over USB serial.")
    ap.add_argument("--port", required=True, help="serial port, e.g. COM5, /dev/ttyUSB0, /dev/cu.usbserial-0001")
    ap.add_argument("--id", required=True, help="Box ID exactly as in the workbook, e.g. BOX-01")
    ap.add_argument("--net", choices=["eth", "wifi"], default="eth")
    ap.add_argument("--ip", help="static IP, e.g. 10.102.40.101 (required for eth; omit for Wi-Fi DHCP)")
    ap.add_argument("--mask", default="255.255.0.0")
    ap.add_argument("--hub", default="10.102.40.10", help="the Pi (MQTT, firmware, NTP)")
    ap.add_argument("--door", choices=["on", "off"], default="on", help="reed switch fitted")
    ap.add_argument("--ssid", help="Wi-Fi network (flight cases)")
    ap.add_argument("--pass-file", help="file holding the MQTT password (default: ask)")
    ap.add_argument("--no-reboot", action="store_true")
    a = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_-]+", a.id) or a.id == "hub":
        sys.exit("--id must be a Box ID like BOX-01")
    if a.net == "eth" and not a.ip:
        sys.exit("--ip is required for an Ethernet box (boxes start at 10.102.40.101)")
    if a.net == "wifi" and not a.ssid:
        sys.exit("--ssid is required for a Wi-Fi box")

    if a.pass_file:
        with open(a.pass_file, encoding="utf-8") as f:
            password = f.read().strip()
    else:
        password = getpass.getpass(f"MQTT password for {a.id} (from mqtt-add-box.sh): ").strip()
    wifipass = getpass.getpass("Wi-Fi password: ").strip() if a.net == "wifi" else ""

    settings = [("id", a.id), ("pass", password), ("net", a.net), ("ip", a.ip or "dhcp"), ("mask", a.mask),
                ("hub", a.hub), ("door", a.door)]
    if a.net == "wifi":
        settings += [("ssid", a.ssid), ("wifipass", wifipass)]

    with serial.Serial(a.port, 115200, timeout=0.5) as port:
        # Opening the port can reset the board; give it time to boot.
        time.sleep(2.5)
        ok, lines = talk(port, "help", timeout=8)
        if not ok:
            sys.exit("The box didn't answer:\n  " + "\n  ".join(lines))
        for key, value in settings:
            ok, lines = talk(port, f"set {key} {value}")
            shown = "(hidden)" if key in ("pass", "wifipass") else value
            print(f"set {key} {shown}: {'OK' if ok else 'FAILED'}")
            if not ok:
                sys.exit("  " + "\n  ".join(lines))
        ok, lines = talk(port, "show")
        print("\n".join(l for l in lines if not l.startswith("OK")))
        if not a.no_reboot:
            talk(port, "reboot", timeout=2)
            print(f"\n{a.id} provisioned and rebooting. Watch it connect with: pio device monitor -p {a.port}")


if __name__ == "__main__":
    main()
