# 3. Run the setup scripts

[← Flash the Pi](Flash-the-Pi.md) · [Home](Home.md) · Next: [Show network →](Show-Network.md)

The scripts in [`pi/`](../../pi) turn a freshly flashed Pi into the hub. Each one:

- is **safe to run again** (a second run should end with `nothing to change`);
- stops at the first error (`set -euo pipefail`);
- ends by listing **what it changed**.

All settings come from [`pi/config.env`](../../pi/config.env): hostname, IP, ports, Bun version,
repo branch. It holds nothing secret, so it's committed. To change a setting, edit it there and
re-run the script. For a one-off, put the setting before the command:
`sudo REPO_REF=some-branch ./05-bun-hub.sh`.

## Get the repo

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/dbwg2009/tech-access /opt/tech-access
cd /opt/tech-access/pi
```

Always run the scripts from `/opt/tech-access/pi`. The certificate-renewal timer points there.

## Order

| Step | Command | Needs internet | Reboot after |
| --- | --- | --- | --- |
| 1 | `sudo ./01-base.sh` | yes | **yes** (`sudo reboot`) |
| 2 | `sudo ./02-network.sh` | no | no |
| 3 | `sudo ./03-mosquitto.sh` | yes (installs) | no |
| 4 | `sudo ./04-ca.sh` | no | no |
| 5 | `sudo ./05-bun-hub.sh` | yes (Bun, clone) | no |
| 6 | `sudo ./06-kiosk.sh` | yes (installs) | after step 7 |
| 7 | `sudo ./07-reader.sh` | no | **yes** (`sudo reboot`) |

Steps 6 and 7 are the desk panel (weeks 3–4). Run them when the screen and the PN532 are
connected; the hub works without them. One reboot after both is enough.

If your setup internet comes over **Ethernet**, do step 2 last.

---

## 01-base.sh: the basics

| Does | Why |
| --- | --- |
| Hostname `tech-hub`, timezone Europe/London | Logs and day-pass expiry use UK time. |
| `apt full-upgrade`, then installs chrony, git, curl, openssl, sqlite3 and a few tools | One update while there's internet. |
| **Turns off automatic upgrades** (removes unattended-upgrades, masks the apt timers) | Nothing changes on the Pi by itself before a show. |
| chrony: `rtcsync`, `local stratum 10`, serves time to `10.102.0.0/16` | No NTP on the show network. The RTC keeps the time and the Pi gives it to the boxes. |
| Adds `dtparam=rtc_bbat_vchg=3000000` to `/boot/firmware/config.txt` | Charges the RTC cell (off by default). Value from the Raspberry Pi RTC docs. |
| Updates the bootloader EEPROM, sets `BOOT_ORDER=0xf416` | NVMe first, then SD, then USB, so a stray SD card can't take over. |

**Then reboot** (`sudo reboot`). After the reboot, check:

```bash
cat /sys/class/rtc/rtc0/charging_voltage   # 3000000
timedatectl                                # Time zone: Europe/London (GMT/BST)
chronyc tracking                           # with internet: "Leap status: Normal"
sudo rpi-eeprom-config | grep BOOT_ORDER   # BOOT_ORDER=0xf416
```

## 02-network.sh: the static address

Creates a NetworkManager profile called `tech-access-show` on eth0:

| Setting | Value |
| --- | --- |
| Address | `10.102.40.10/16` (Control subnet) |
| Gateway | none, and `never-default`, so it never takes the default route |
| DNS | none |
| IPv6 | off |

Other wired profiles on eth0 (like `Wired connection 1`) are switched to "don't auto-connect",
not deleted. The Pico's DHCP isn't touched: it only serves Wi-Fi devices.

With no cable plugged in, the script says so and carries on. The link comes up by itself when
you plug into the show network.

Check: `ip -br addr show eth0` → `eth0 UP 10.102.40.10/16`

## 03-mosquitto.sh: the MQTT broker

- Installs `mosquitto` and `mosquitto-clients`.
- Copies [`pi/mosquitto/tech-access.conf`](../../pi/mosquitto/tech-access.conf) (listener on
  port 1883, **no anonymous access**) and [`tech-access.acl`](../../pi/mosquitto/tech-access.acl).
- Makes a random password for the `hub` user. It's stored in `/etc/tech-access/mqtt/hub.password`
  and `/etc/tech-access/hub.env`, which the hub service reads.
- Tests itself: the hub can publish and subscribe, and anonymous clients are refused.

**Box logins:** each lock box logs in with its **Box ID as the username** and can only use
`box/<Box ID>/#`. Make one when you build a box (week 5+): `sudo ./mqtt-add-box.sh BOX-01`.

## 04-ca.sh: the local certificate authority

The iPad door station (week 8) needs HTTPS, and with no internet there's no public certificate
authority, so the Pi runs its own.

| File | What | Notes |
| --- | --- | --- |
| `/etc/tech-access/ca/ca.key` | CA private key | **Never in git.** Back it up ([page 6](Day-to-Day.md#backups)). |
| `/etc/tech-access/ca/ca.crt` | CA certificate | Valid 20 years. |
| `/etc/tech-access/tls/server.crt` + `.key` | Hub certificate | For `tech-hub`, `tech-hub.local`, `10.102.40.10`. Valid 825 days. |
| `/etc/tech-access/tls/tech-access-ca.crt` | Copy of the CA cert | Goes into the iPad's profile in week 8. |

iOS only accepts certificates from a home-made CA if they last **825 days or less**, so the
script also installs `tech-access-cert-renew.timer`. Once a month it checks the certificate and
renews it 60 days before expiry. The CA doesn't change, so the iPad never needs a new profile.

Check: `systemctl list-timers tech-access-cert-renew.timer`

## 05-bun-hub.sh: the hub

- Installs **Bun 1.4.4** into `/opt/bun` and links `/usr/local/bin/bun`.
- Creates the system user `techaccess` and the data folder `/var/lib/tech-access`.
- Clones the repo to `/opt/tech-access`, or updates it to the latest `REPO_REF` (default `main`).
- Runs `bun install --frozen-lockfile --production`. Everything comes from `hub/bun.lock`; the
  `.xlsx` library is vendored in `hub/vendor/`, so it doesn't need its own website.
- Builds the desk panel (`bun run build`: `hub/panel/` → `hub/public/panel/`) when the checkout
  changed. The built files aren't in git.
- Writes `/etc/tech-access/hub.toml` (database path, port 8080, timezone, `reader_device`).
- Installs and starts `tech-access-hub.service` (`Restart=always`, restarts forever).
- Calls `/api/health` and prints the result.

Expected at the end:

```
    ok: {"name":"tech-access hub","version":"0.1.0","schemaVersion":1,"db":"ok",...}
```

## 07-reader.sh: the desk fob reader

The PN532 is on GPIO14/15, which on a Pi 5 is `UART0` = **`/dev/ttyAMA0`**
(wiring: [Hardware](Hardware.md#desk-fob-reader-pn532)).

| Does | Why |
| --- | --- |
| Adds `dtparam=uart0=on` to `/boot/firmware/config.txt` | UART0 is off by default on a Pi 5. |
| Comments out `enable_uart=1` and `dtparam=uart0_console=on` if present | On a Pi 5 these put kernel messages on GPIO14/15, i.e. into the PN532. |
| Removes `console=serial0,…` / `console=ttyAMA0,…` from `/boot/firmware/cmdline.txt` (keeps a copy as `cmdline.txt.before-07-reader`) | No login console on the reader's port. The debug header (`ttyAMA10`) is left alone. |
| Masks `serial-getty@ttyAMA0` and `serial-getty@serial0` | Same. |
| Adds `techaccess` to `dialout`, restarts the hub | So the hub can open the port. |

**Then reboot.** Check: `ls -l /dev/ttyAMA0` and `curl -s http://127.0.0.1:8080/api/health`
(`"reader": … "state":"ok"`). If `/dev/ttyAMA0` doesn't appear, try `dtoverlay=uart0-pi5`
instead of `dtparam=uart0=on` in `config.txt` (both are in the Raspberry Pi docs).

## 06-kiosk.sh: the desk panel's screen

| Does | Why |
| --- | --- |
| Installs `labwc`, `chromium`, `swayidle`, `wlopm`, `polkitd` | Trixie package names (`chromium-browser` is now only a transitional package). labwc is the Wayland compositor Pi OS itself uses. |
| Creates the user `kiosk` (password locked; groups video, render, input) | The panel never runs as you or as root. |
| Auto-login on tty1 (`getty@tty1` drop-in); `~kiosk/.bash_profile` runs `labwc` | If labwc ever exits, getty logs in again and it comes back. |
| labwc autostart: `swayidle`, `tech-access-screen-helper`, `tech-access-kiosk-browser` | Screen off after 5 min without a touch; a fob tap turns it on; Chromium is restarted if it exits. |
| Chromium in kiosk mode on `/panel/?kiosk=1` with no first-run, translate, pinch or swipe-back, and a clean restart after a crash | Nothing for staff to dismiss. A local start page waits for the hub first, so a slow boot never leaves an error page. |
| Installs `/etc/polkit-1/rules.d/50-tech-access.rules` | Lets the admin menu restart the hub and reboot the Pi, and nothing else ([the rule](../../pi/polkit/50-tech-access.rules)). |

**Then reboot.** Logs: `journalctl -t tech-access-kiosk -b`. To get a shell on the Pi's own
screen, use `Ctrl+Alt+F2` with a keyboard plugged in; the panel stays on tty1.

The full test list for the real hardware is on [the desk panel page](Desk-Panel.md#first-test-on-the-real-hardware).

## Re-running

Re-running a script is the fix for most "something got changed by hand" problems. To update the
hub with internet: `cd /opt/tech-access/pi && sudo ./05-bun-hub.sh`. It pulls, reinstalls only
if `bun.lock` changed, and restarts the hub.
