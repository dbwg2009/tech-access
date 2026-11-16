# 7. Troubleshooting

[← Day to day](Day-to-Day.md) · [Home](Home.md) · Next: [Rebuild and handover →](Rebuild-and-Handover.md)

**First, always:** re-run the script for that area (it's safe), and read
`journalctl -u tech-access-hub -n 100`.

**During a show:** do nothing. The hub isn't in the show path. If a box won't open and there's no
time, a power cycle of that box unlocks it (fail-open). Fix it afterwards.

## Pi won't boot from the NVMe

- Is the HAT's ribbon cable seated both ends, the right way round, latches closed?
- Boot from any SD card with Raspberry Pi OS and run `lsblk`. You should see `nvme0n1`. If not,
  it's the cable, the HAT or the SSD.
- Remove any SD card. Check the boot order: `sudo rpi-eeprom-config | grep BOOT_ORDER` should be
  `0xf416`. Fix it with `sudo ./01-base.sh` or `sudo raspi-config` → Advanced → Boot Order → NVMe.

## Lost SSH after 02-network.sh

The setup internet was over eth0, and eth0 is now static with no gateway. Either:

- connect over Wi-Fi: `ssh <you>@tech-hub.local` (the Wi-Fi from Imager is still set up); or
- plug a laptop straight into the Pi and give the laptop a static IP of `10.102.40.50/16`, no
  gateway. Then `ssh <you>@10.102.40.10`.

To use DHCP on eth0 again for a while, bring the old profile back up. `nmcli connection show`
lists it; it's usually `Wired connection 1`: `sudo nmcli connection up "Wired connection 1"`.
Go back with `sudo nmcli connection up tech-access-show`.

## Nomad PC can't reach the hub

Work through these in order:

1. On the Pi: `ip -br addr show eth0` should show `10.102.40.10/16`. If not, `sudo ./02-network.sh`.
2. On the Pi: `curl -s http://127.0.0.1:8080/api/health`. If that fails, the hub's down
   (see [next section](#hub-wont-start)).
3. On the Pi: `ss -tlnp | grep 8080` should show `0.0.0.0:8080`.
4. On the Nomad PC: is the **CONTROL** adapter (`10.102.100.101`, mask `255.255.0.0`) plugged
   into the show network? `ping 10.102.40.10`.
5. In PowerShell use `curl.exe`, not `curl`.

## Hub won't start

```bash
journalctl -u tech-access-hub -n 50 --no-pager
```

| Message | Fix |
| --- | --- |
| `config: ...` | `/etc/tech-access/hub.toml` is wrong. Re-run `sudo ./05-bun-hub.sh`. |
| `migrations: ...` | A database migration failed; nothing was half-applied. Restore a backup or ask for help. Paste the full error. |
| `EADDRINUSE` | Something else has port 8080: `sudo ss -tlnp \| grep 8080` |
| `Cannot find module` | `cd /opt/tech-access/hub && sudo bun install --frozen-lockfile --production` (or re-run 05) |
| `SQLITE_READONLY` / permission denied | `sudo chown -R techaccess:techaccess /var/lib/tech-access` |

## Clock is wrong

```bash
timedatectl
sudo hwclock -r                              # what the RTC says
cat /sys/class/rtc/rtc0/charging_voltage     # 3000000 = charging
```

- Wrong after a power cut: the RTC cell is flat or not fitted. Check the battery, then set the
  time. With internet, `sudo chronyc makestep`. Offline, `sudo date -s '2026-11-15 18:30'`,
  then `sudo hwclock -w`.
- Charging voltage is `0`: re-run `sudo ./01-base.sh` and reboot.

Day passes use the clock. A wrong date means passes show "expired" or "isn't valid yet".

## Desk panel

| Problem | Check / fix |
| --- | --- |
| Black screen, nothing on touch or fob | Is the Pi on? Over SSH: `systemctl status getty@tty1`, `journalctl -t tech-access-kiosk -b`. Re-run `sudo ./06-kiosk.sh` and reboot. |
| "Starting the desk panel…" never goes away | The hub isn't answering: `curl -s http://127.0.0.1:8080/api/health`, then [Hub won't start](#hub-wont-start). The page opens the panel by itself once the hub is up. |
| The panel shows an old version after an update | It reloads by itself when the hub restarts. If not: `sudo pkill chromium` (it restarts in 2 s). |
| Fob does nothing, touch works | Reader problem. See [the desk panel page](Desk-Panel.md#if-the-reader-isnt-found). |
| Fob gives "Ask a staff member" | The reason is on screen. **Admin → Event log** shows the same (*Fob refused*). |
| Screen never turns off | Something keeps touching it, or a card was left open (they close after 30 s / 90 s). `journalctl -t tech-access-kiosk -b \| grep -i swayidle` |
| Restart / reboot from the admin menu does nothing | `journalctl -u tech-access-hub -n 20` shows `systemctl ... failed`. Re-run `sudo ./06-kiosk.sh` (installs the polkit rule). Check `ls /etc/polkit-1/rules.d/`. |
| Box shows "offline" / "never seen" | The box isn't sending heartbeats. See [Lock boxes](#lock-boxes) below. |

## MQTT

- Test the broker: `mosquitto_pub -h 127.0.0.1 -u hub -P "$(sudo cat /etc/tech-access/mqtt/hub.password)" -t test -m hi`
- A box gets `not authorised`: its username must be exactly its Box ID, and it can only use
  `box/<Box ID>/...`. Re-run `sudo ./mqtt-add-box.sh <Box ID>` to see its password.
- Broker won't start after a config change: `journalctl -u mosquitto -n 30`, then re-run `sudo ./03-mosquitto.sh`.

## Lock boxes

**A box that won't open in a hurry:** pull its PoE cable. No power = maglock off = open. Fix it
afterwards. Plug a laptop into the box's serial pins (IO1/IO3, 3.3 V adapter) and run
`pio device monitor -p <port>`; type `status` for everything the box knows.

| You see | Means / do |
| --- | --- |
| Panel: box **never seen** | It has never sent a heartbeat. Serial `status`: is it provisioned (`show`)? `net eth down` = cable, splitter or IP. `mqtt down` = see the next rows. |
| Serial: `mqtt: connect failed (error -…, code 4/5)` | Wrong password or Box ID. Re-run `provision.py` with the password from `sudo ./mqtt-add-box.sh <Box ID>`. The Box ID must match the panel exactly (`BOX-01`, not `box-01`). |
| Serial: `mqtt: connect failed (error -3…)`, net up | Can't reach `10.102.40.10:1883`. Wrong `hub` or `ip`/`mask` (`show`), or Mosquitto is down on the Pi (`systemctl status mosquitto`). |
| Panel: box **offline** | No heartbeat for 90 s. Power, cable, PoE port, or the box is rebooting over and over (serial shows the reason, e.g. a watchdog). |
| Box open, panel says open, nobody tapped (`why: offline`) | The box can't see the hub: Pi down, hub stopped, or the network. It locks again by itself when the hub is back. `journalctl -u tech-access-hub -n 50`. |
| Box open with `why: no_list` | It has never had a fob list. The hub sends it when it connects; check the box is in the box list with exactly this Box ID. |
| Allowed fob doesn't open the box | Event log: "couldn't open … at the box: …" gives the reason. `not allowed on this box` = level / status; check the person. `the box's clock isn't set yet` = a day pass and NTP isn't reaching the box (`status` shows `clock not set`; check chrony on the Pi, `sudo ./01-base.sh`). No event at all = the reader: serial `status` shows `reader not answering` (wiring, DIP switches `0 0` for HSU, 3.3 V). |
| Box locks but the door was open | Expected: the maglock catches the door when it's pushed shut. The panel and End of session show the door open. |
| Door always shows open | Reed switch wire broken or magnet too far away (more than ~15 mm). Serial `status` shows `door open/shut` live. |
| Update says `refused (unlocked)` / `(show_mode)` / `(mid_tap)` | Working as intended: a box only updates while locked and idle. Try again when it's locked. |
| Update says `failed (sha256_mismatch)` / `(size_mismatch)` / `(http_404)` | The download was damaged or the file's gone. Upload the image again (`update-boxes.ts`). The box carries on with its old firmware. |
| Update says `rolled_back` | The new firmware didn't reach the hub within 5 minutes (or crashed), so the box went back to the old one. Look at the serial output of the new version on a bench box before trying again. |
| Box keeps rebooting after you changed the wiring | Something on IO0, IO2, IO12 or IO15 at boot (strapping pins). Only use the pins on the [Lock boxes](Lock-Boxes.md#pins-wt32-eth01) page. |
| Can't flash: `Failed to connect to ESP32` | IO0 must be jumpered to GND **while** you press reset; adapter at 3.3 V; TX→IO3, RX→IO1 (crossed). |

## Import problems

| You see | Means |
| --- | --- |
| `Schema version in Read me!B2 is ...` | Wrong or old workbook. `B2` must be `1`. |
| `Sheet "Kit" is missing` | A tab was renamed. Tab names must match (case doesn't matter). |
| `Required column "Status" is missing` | A header was renamed or deleted. |
| `"..." is 7 hex digits` (Fob UID) | Leading zero lost: format the column as text and retype it. |
| `Person ID P042 is not on the People sheet` | A fob points at someone missing from People. |
| `No admin fob is set up yet` | First import: use an Active Admin fob from the file (see [page 5](The-Workbook.md#the-very-first-import)). |
| `stale` | Data changed since the preview. Upload again. |
| Lots of unexpected **removals** | You imported an old or partial file. **Don't apply.** Upload the right one. |
