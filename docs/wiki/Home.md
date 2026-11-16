# tech-access setup wiki

How to build, run and look after the tech-access hub. Written for whoever has the job after
Daniel, as well as for Daniel.

> These pages live in the repo at `docs/wiki/` and are published to the GitHub Wiki on every
> push to `main`. Edit them in the repo. Offline, read them in `/opt/tech-access/docs/wiki` on the Pi.

**tech-access** controls who can take the school's tech kit. Crew tap an NFC fob, and lock boxes
(mics, the Nomad key, keys, flight cases) open only for people at the right ladder level. It runs
on a Raspberry Pi 5 on the show network, with **no internet**, and it is **never in the show
path**: if the hub dies mid-show, Eos, QLab and the WING carry on, and the boxes fail open.

## Pages

| # | Page | When you need it |
| --- | --- | --- |
| 1 | [Hardware](Hardware.md) | Building the hub, or replacing a broken part |
| 2 | [Flash the Pi](Flash-the-Pi.md) | New Pi, new SSD, or starting again from scratch |
| 3 | [Run the setup scripts](Setup-Scripts.md) | After flashing; also to update or repair |
| 4 | [Show network](Show-Network.md) | IP addresses, ports, what talks to what |
| 5 | [The workbook](The-Workbook.md) | Adding people, fobs, kit and boxes; the first import |
| 6 | [Day to day](Day-to-Day.md) | Logs, restarts, box logins, updates, backups |
| 7 | [Troubleshooting](Troubleshooting.md) | Something's wrong |
| 8 | [Rebuild and handover](Rebuild-and-Handover.md) | The Pi died; or you're taking this over |
| 9 | [The desk panel](Desk-Panel.md) | Using the touchscreen, the admin menu, the fob reader; first hardware test |

## What exists so far (weeks 1–4)

| Built | Coming |
| --- | --- |
| Pi hub: NVMe boot, static IP, RTC, chrony, Mosquitto, local CA, hub service | First lock box + OTA (weeks 5–6) |
| Database, workbook import with preview, export | Management USBs: TECHBACKUP, TECHUPDATE, TECHSOFTWARE (week 7) |
| Access rules (levels, specialisms, day passes, admin, show mode) | Stage Door port + iPad door station (weeks 8–10) |
| Desk panel: touchscreen kiosk, PN532 fob reader, crew card, admin menu, event log | Nomad agent, kit tags, more boxes (week 11+) |
| MQTT topics for the boxes ([docs/mqtt.md](../mqtt.md)) | |

Imports can be previewed and applied from the panel's admin menu ([page 9](Desk-Panel.md)) or with
`curl` on the Pi ([page 5](The-Workbook.md)).

## The short version

1. Build the hardware, flash **Raspberry Pi OS Lite (64-bit, Trixie)** to the NVMe with hostname `tech-hub`.
2. With internet: `sudo git clone https://github.com/dbwg2009/tech-access /opt/tech-access`
3. `cd /opt/tech-access/pi` and run `01` (then reboot), `02`, `03`, `04`, `05`, then `06` and `07` (then reboot), each with `sudo`.
4. Plug into the show network. From the Nomad PC: `curl.exe http://10.102.40.10:8080/api/health`

## Rules that shape everything

- **No internet at runtime.** Nothing may need the cloud, a CDN or a package registry once installed.
- **Never in the show path.** Access is checked when kit is taken, not during a show.
- **Fail open.** Power cut: boxes unlock. Hub unreachable: boxes use their cached list, then unlock after 5 minutes.
- **Boring and repeatable.** Every script can be run again safely. Every setting is in the repo.
- **Nothing gets installed on the QLab Macs** (school-managed). The Nomad PC is fine.

Background and reasons: [brief](../brief.md), [decisions](../decisions.md),
[data model](../data-model.md), [workbook format](../workbook-format.md).
