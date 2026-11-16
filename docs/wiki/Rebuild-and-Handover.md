# 8. Rebuild and handover

[← Troubleshooting](Troubleshooting.md) · [Home](Home.md) · Next: [The desk panel →](Desk-Panel.md)

## Rebuild from nothing

If the Pi or its SSD dies:

1. New hardware ([page 1](Hardware.md)). Flash it ([page 2](Flash-the-Pi.md)) with hostname `tech-hub`.
2. Run the scripts ([page 3](Setup-Scripts.md)), with one change: **restore the secrets
   before 03 and 04**, so the CA (trusted by the iPad) and box passwords stay the same:

   ```bash
   sudo tar xzf tech-access-secrets-<date>.tgz -C /
   ```

   Then run `03`, `04` and `05`. They see the existing files and keep them. Then re-add each
   box's login with `sudo ./mqtt-add-box.sh <Box ID>`, which reuses the saved password.
3. Restore the database ([page 6](Day-to-Day.md#restore-the-database)).
4. Check from the Nomad PC: `curl.exe http://10.102.40.10:8080/api/health`.

Without a secrets backup it still works, but: the iPad needs the new CA profile (week 8+), and
every box needs a new MQTT password (`mqtt-add-box.sh`).

Without a database backup, import the latest workbook (a first import, see
[page 5](The-Workbook.md#the-very-first-import)). People, fobs, kit and boxes come back; the event
log doesn't.

## Handover checklist

For the next person to look after tech-access. Fill these in and keep them with the sealed spare
admin fob in the school office, **not** in the repo:

- [ ] Pi admin username and password (or whose SSH key is on it)
- [ ] Where the latest backup stick is, and its date
- [ ] Where the sealed spare admin fob is
- [ ] Who can edit the source-of-truth Claude Sheet
- [ ] GitHub: who has write access to `dbwg2009/tech-access`

Things to know:

- **Everything is in the repo** except secrets: settings in `pi/config.env`, scripts in `pi/`,
  reasons in [`docs/decisions.md`](../decisions.md). If you change how something works, add a
  line to `decisions.md`.
- **Nothing updates by itself.** That's deliberate. Update with internet, outside show weeks.
- **The certificate renews itself.** The CA lasts until 2046.
- **A failing hub never stops a show.** Boxes fail open.
- If Bun's install website ever disappears, copy `/opt/bun` from a working Pi or backup. The
  hub's packages need nothing from the internet beyond what's in `hub/bun.lock` and `hub/vendor/`.
