# Pi setup

Turns a Raspberry Pi 5 (4 GB, M.2 HAT+ with NVMe, RTC battery, active cooler, 27 W PSU) into the
tech-access hub: `tech-hub` at **10.102.40.10** on the Control subnet.

The Pi needs **internet once**, for setup (home network or a phone hotspot). After that it lives
on the show network with no internet, for good.

Every script is safe to run again. Each one ends by listing what it changed ("nothing to change"
on a re-run). **Paste the output back to Claude** after each one.

Settings for all scripts are in [`config.env`](config.env) (committed, nothing secret).

## 1. Hardware

1. Fit the active cooler, then the M.2 HAT+ with the NVMe SSD (ribbon cable into the PCIe port).
2. Plug the RTC battery into the `BAT` connector (between the USB-C and micro-HDMI ports).
3. No SD card needed.

## 2. Flash Raspberry Pi OS to the NVMe

Use **Raspberry Pi OS Lite (64-bit)**, Trixie. Pick one way:

- **Network install (no extra hardware).** Plug the Pi's Ethernet into a router with internet,
  attach a screen and keyboard, and power on while holding **Shift** (with no bootable OS it
  offers this by itself). Raspberry Pi Imager starts on the Pi and writes straight to the NVMe.
- **USB adapter.** Put the NVMe in a USB M.2 enclosure, write it with Raspberry Pi Imager on a
  computer, then fit it in the HAT+.

In Imager:

- **Device**: Raspberry Pi 5.
- **OS**: Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit).
- **Storage**: the NVMe.
- **Customise**:
  - Hostname `tech-hub`.
  - A username and password for you.
  - **Wi-Fi**: your home network or hotspot, country GB. This is the setup internet; see step 4.
  - Locale Europe/London, GB keyboard.
  - Enable SSH (a public key is best).

## 3. Boot order

With no SD card fitted, the Pi 5's default boot order already falls through to the NVMe, so it
just boots. `01-base.sh` then sets `BOOT_ORDER=0xf416` (NVMe first, then SD, then USB) so a stray
SD card can't take over. To do it by hand instead: `sudo raspi-config` → Advanced Options →
Boot Order → NVMe.

## 4. Internet for setup

- **Over Wi-Fi (easiest):** the Wi-Fi you set in Imager. eth0 can be static from the start, and
  the scripts can run in order.
- **Over Ethernet at home:** fine, but run `02-network.sh` **last**, because it switches eth0
  to the static show-network address with no gateway.

## 5. Run the scripts

SSH in (`ssh you@tech-hub.local`), then:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/dbwg2009/tech-access /opt/tech-access
cd /opt/tech-access/pi
```

Until the weeks 1–2 pull request is merged, use the branch instead:
`sudo git clone -b claude/admiring-babbage-ddyagp https://github.com/dbwg2009/tech-access /opt/tech-access`
and run 05 as `sudo REPO_REF=claude/admiring-babbage-ddyagp ./05-bun-hub.sh`.

| Script | Does | Internet? |
| --- | --- | --- |
| `sudo ./01-base.sh` then `sudo reboot` | Hostname, timezone, updates, chrony, RTC battery charging, boot order, automatic upgrades off | yes |
| `sudo ./02-network.sh` | eth0 static `10.102.40.10/16`, no gateway, no DNS | no |
| `sudo ./03-mosquitto.sh` | MQTT broker, no anonymous access, hub login, box ACL | yes (install) |
| `sudo ./04-ca.sh` | Local CA, server certificate, monthly renewal timer | no |
| `sudo ./05-bun-hub.sh` | Bun, repo, `bun install --frozen-lockfile`, `tech-access-hub` service | yes |

After the reboot, check:

```bash
cat /sys/class/rtc/rtc0/charging_voltage   # 3000000 = RTC battery charging
timedatectl                                # Time zone: Europe/London
chronyc tracking
```

## 6. Move to the show network

Plug eth0 into a Control-network port on the desk switch. From the Nomad PC (its CONTROL adapter
is 10.102.100.101):

```powershell
curl.exe http://10.102.40.10:8080/api/health
```

You should get `{"name":"tech-access hub", ... "db":"ok"}`.

## What lives where on the Pi

| Path | What | In git? |
| --- | --- | --- |
| `/opt/tech-access` | This repo | yes |
| `/etc/tech-access/hub.toml` | Hub config, written by 05 from `config.env` | no (generated) |
| `/etc/tech-access/hub.env` | Hub's MQTT password | **no** |
| `/etc/tech-access/mqtt/*.password` | MQTT passwords (hub, boxes) | **no** |
| `/etc/tech-access/ca/ca.key` | CA private key. Back it up to TECHBACKUP (week 7). | **never** |
| `/etc/tech-access/tls/` | Server cert and key, `tech-access-ca.crt` for the iPad profile | no |
| `/var/lib/tech-access/tech-access.db` | The database (source of truth) | no |

## Day to day

- Logs: `journalctl -u tech-access-hub -f`
- Restart: `sudo systemctl restart tech-access-hub`
- Add a lock box's MQTT login: `sudo ./mqtt-add-box.sh BOX-01` (username = Box ID; it can only
  use `box/BOX-01/#`)
- Update the hub (with internet): `sudo ./05-bun-hub.sh`. Offline updates come with the
  TECHSOFTWARE stick in week 7.
- Nothing updates by itself: automatic apt upgrades are off, so nothing changes before a show.
