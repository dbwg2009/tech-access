# Pi setup scripts

Turn a Raspberry Pi 5 into the tech-access hub (`tech-hub`, 10.102.40.10).

**Full instructions are in the [setup wiki](https://github.com/dbwg2009/tech-access/wiki)** (source: [`docs/wiki/`](../docs/wiki)): hardware, flashing,
what each script does, troubleshooting and rebuilding.

| Script | Does | Internet? |
| --- | --- | --- |
| `sudo ./01-base.sh` then `sudo reboot` | Hostname, timezone, updates, chrony, RTC charging, boot order, auto-upgrades off | yes |
| `sudo ./02-network.sh` | eth0 static `10.102.40.10/16`, no gateway (run last if setup internet is over eth0) | no |
| `sudo ./03-mosquitto.sh` | MQTT broker, no anonymous access, hub login, box ACL | yes |
| `sudo ./04-ca.sh` | Local CA, server certificate, monthly renewal timer | no |
| `sudo ./05-bun-hub.sh` | Bun, repo, `bun install --frozen-lockfile`, `tech-access-hub` service | yes |
| `sudo ./mqtt-add-box.sh BOX-01` | MQTT login for one lock box | no |

Run them from `/opt/tech-access/pi`. Settings: [`config.env`](config.env). Every script is safe
to re-run and ends by listing what it changed.
