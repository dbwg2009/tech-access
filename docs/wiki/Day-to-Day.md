# 6. Day to day

[← The workbook](The-Workbook.md) · [Home](Home.md) · Next: [Troubleshooting →](Troubleshooting.md)

All of these are run on the Pi over SSH (`ssh <you>@tech-hub.local`, or `ssh <you>@10.102.40.10`
on the show network).

## Is it working?

```bash
systemctl status tech-access-hub mosquitto chrony --no-pager
curl -s http://127.0.0.1:8080/api/health
```

## Logs

```bash
journalctl -u tech-access-hub -f          # follow the hub
journalctl -u tech-access-hub -n 100      # last 100 lines
journalctl -u mosquitto -n 50
```

## Restart

```bash
sudo systemctl restart tech-access-hub
```

The service restarts by itself if it crashes (`Restart=always`, never gives up). A restart takes
a second or two, and boxes keep working from their cache meanwhile.

## Add a lock box's MQTT login

```bash
cd /opt/tech-access/pi
sudo ./mqtt-add-box.sh BOX-01
```

It prints the username (the Box ID) and the password to put in that box's config. Running it
again shows the same password. Passwords are kept in `/etc/tech-access/mqtt/`.

Watch a box talking (as the hub user):

```bash
mosquitto_sub -h 127.0.0.1 -u hub -P "$(sudo cat /etc/tech-access/mqtt/hub.password)" -t 'box/#' -v
```

## Change a setting

Edit [`pi/config.env`](../../pi/config.env) (in the repo, so the change is recorded) and re-run
the script that uses it. For example, a new hub port: change `HUB_PORT`, then
`sudo ./05-bun-hub.sh`. Don't edit `/etc/tech-access/hub.toml` by hand; 05 rewrites it.

## Update the hub

With internet (home network or hotspot):

```bash
cd /opt/tech-access/pi && sudo ./05-bun-hub.sh
```

Offline updates arrive with the TECHSOFTWARE stick in week 7. **Nothing updates by itself**:
automatic apt upgrades are off, so nothing changes the week of a show.

Updating the OS itself (with internet, not in show week): `sudo ./01-base.sh`, then `sudo reboot`.

## Backups

The TECHBACKUP stick (week 7) will do this with a tap. Until then, by hand. With a USB stick in
the Pi:

```bash
lsblk                                  # find the stick, e.g. sda1
sudo mount /dev/sda1 /mnt
d=$(date +%F)
sudo sqlite3 /var/lib/tech-access/tech-access.db ".backup '/mnt/tech-access-$d.db'"
sudo tar czf "/mnt/tech-access-secrets-$d.tgz" -C / etc/tech-access
curl -s -o "/tmp/tech-access-$d.xlsx" http://127.0.0.1:8080/api/export.xlsx && sudo cp "/tmp/tech-access-$d.xlsx" /mnt/
sudo umount /mnt
```

| File | Contains | Keep |
| --- | --- | --- |
| `tech-access-<date>.db` | Everything: people, fobs, kit, boxes, **and the event log** | Safe place |
| `tech-access-secrets-<date>.tgz` | CA private key, MQTT passwords, TLS key | **Locked away.** Anyone with it can impersonate the hub. |
| `tech-access-<date>.xlsx` | Workbook export (no event log) | Fine to share with staff |

`.backup` is safe while the hub is running.

### Restore the database

```bash
sudo systemctl stop tech-access-hub
sudo install -o techaccess -g techaccess -m 0640 tech-access-2026-11-15.db /var/lib/tech-access/tech-access.db
sudo rm -f /var/lib/tech-access/tech-access.db-wal /var/lib/tech-access/tech-access.db-shm
sudo systemctl start tech-access-hub
```

## Certificates

Nothing to do: `tech-access-cert-renew.timer` renews the hub certificate a month or two before it
expires. To check:

```bash
openssl x509 -in /etc/tech-access/tls/server.crt -noout -enddate
systemctl list-timers tech-access-cert-renew.timer
```
