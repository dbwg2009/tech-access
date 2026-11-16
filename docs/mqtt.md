# MQTT topics (contract for the box firmware, weeks 5-6)

Broker: Mosquitto on the Pi, `mqtt://10.102.40.10:1883` (TLS on 8883 later). Every box logs in
with its **Box ID** as the username (and as its client ID) and a password made by
`pi/mqtt-add-box.sh`. The ACL only lets a box use `box/<its Box ID>/#` and read `hub/status`; the
hub uses everything. All payloads are UTF-8 JSON objects. Boxes connect with a clean session, so
nothing is queued for them while they're away.
Times are ISO 8601 UTC (`2026-11-16T18:00:00.000Z`); boxes get the time from the Pi over NTP.

`<id>` below is the Box ID exactly as in the workbook, e.g. `BOX-01`.

| Topic | Direction | Retained | QoS | When |
| --- | --- | --- | --- | --- |
| `box/<id>/cmd` | hub → box | no | 1 | A fob on the panel opened the box, or End of session |
| `box/<id>/mode` | hub → box | **yes** | 1 | Show mode changed; on hub (re)connect |
| `box/<id>/fobs` | hub → box | **yes** | 1 | The list changed; on hub (re)connect |
| `box/<id>/ota` | hub → box | no | 1 | An admin asked this box to update its firmware |
| `hub/status` | hub → boxes | **yes** | 1 | Hub (re)connects; its last will when it drops off |
| `box/<id>/state` | box → hub | **yes** | 1 | Lock or door changed; command answered; OTA progress; on box connect |
| `box/<id>/heartbeat` | box → hub | no | 0 | On connect, then every 30 s |
| `box/<id>/tap` | box → hub | no | 1 | A fob was tapped at the box |

The rules a box follows are in `firmware/lib/box_core` and are tested, with the box simulator
(`tools/box-sim`), against the shared cases in `firmware/test/vectors/`. If this page and the
vectors ever disagree, the vectors are what both implementations are tested against: fix
whichever is wrong.

## `box/<id>/cmd`

```json
{ "cmd": "open", "seconds": 8, "ts": "2026-11-16T18:00:00.000Z", "expires": "2026-11-16T18:00:15.000Z", "ref": 1234 }
{ "cmd": "lock", "ts": "2026-11-16T22:00:00.000Z", "expires": "2026-11-16T22:00:15.000Z", "ref": 1240 }
```

- `open`: unlock for `seconds`, then lock again (unless show mode is on).
- `lock`: lock now. Sent by End of session. Show mode is turned off (in `mode`) at the same time.
- **Ignore a command whose `expires` is in the past** by the box's clock. The hub never queues
  commands while the broker is down, but a QoS 1 redelivery after a reconnect could arrive late,
  and a box must never open long after someone tapped.
- `ref` is the hub's event ID. Echo it in the next `state` message (`"ref"`) so the event log can
  match them up. It may be `null`. A box answers every command it accepts with a `state`, even
  `lock` on a box that's already locked.
- `seconds` is capped at 30 by the box; missing = 8.
- **Clock never set** (no NTP since boot): the box can't check `expires`, so it **accepts** the
  command (decision 2026-11-16). The hub never sends a command it couldn't deliver at once.
- `lock` doesn't end show mode; only `mode` `show: false` does (End of session sends both).

## `box/<id>/mode` (retained)

```json
{ "show": true, "ts": "2026-11-16T18:00:00.000Z" }
```

- `show: true` = stay unlocked, no fob needed, until a message with `show: false` arrives.
- Retained, so a box that reboots during a show comes back unlocked.
- No message at all (new box) = `show: false`.

## `box/<id>/fobs` (retained)

The box's cached allowlist. A box checks every tap at the box against it straight away, hub
online or not (no round trip); see `box/<id>/tap`.

```json
{
  "v": 1,
  "ts": "2026-11-16T18:00:00.000Z",
  "offline_unlock_min": 5,
  "fobs": [
    { "uid": "04A1B2C3D4E5F6" },
    { "uid": "AABBCCDD", "until": "2026-11-16" }
  ]
}
```

- `uid`: uppercase hex, no separators, 4, 7 or 10 bytes: the same as the workbook's Fob UID.
- `until` (day passes only): the local date (Europe/London) the fob is valid on. After that
  date, by the box's own clock, treat it as absent.
- The list already applies levels, fob and person status, and "disable all students". The box
  doesn't need to know why a fob is on it.
- `offline_unlock_min`: the workbook's `Offline unlock (min)` for this box.
- `v`: format version. A box that sees an unknown `v` keeps its old list. So does a box that
  gets malformed JSON or more than 400 fobs.
- An entry whose `uid` or `until` it can't read is left out (denied), the rest are kept.
- Store the latest list in flash so it survives a power cut.
- **No list at all** (a new box, or flash wiped): the box stays **unlocked** (`why: "no_list"`)
  until the first list arrives (decision 2026-11-16). An empty list (`"fobs": []`) is a real
  list: locked, every fob denied.
- **Clock never set**: day passes (with `until`) are refused (`no_clock`); standard fobs work.

## `box/<id>/state` (retained, box → hub)

```json
{ "lock": "locked", "door": "shut", "ts": "2026-11-16T18:00:09.000Z", "ref": 1234, "fw": "0.1.0" }
{ "lock": "locked", "ts": "2026-11-16T18:05:01.000Z", "fw": "0.1.0", "ota": "refused", "ota_version": "0.2.0", "ota_why": "unlocked" }
```

- `lock`: `"locked"` or `"open"`. Publish on every change and once on connect.
- Retained, so the hub learns every box's state when it restarts.
- Set the broker **last will** on this topic, retained: `{"lock": "open", "why": "offline"}`.
  Power cut and no network both mean "fail open" (decision in the brief), so if the box drops off,
  the hub's view becomes "open". The hub also marks a box *offline* after 90 s with no heartbeat.
  The will has no `fw`, which is how the hub tells it from a real box message.
- `why` (only while it applies): open = `"fob"` (tapped at the box), `"cmd"` (panel open),
  `"show"`, `"offline"` (hub unreachable for `offline_unlock_min`), `"no_list"` (never had a
  `fobs` list); locked = `"cmd"` right after a `lock` command, otherwise absent.
- `door` (only if a reed switch is fitted): `"shut"` or `"open"`. When the box locks with the door
  open, it powers the maglock anyway (it catches the door when it's pushed shut) and reports
  `door: "open"`; End of session lists it as still open (decision 2026-11-16).
- `ts` is `null` if the box's clock has never been set.
- `fw`: the running firmware version, always present.
- `ota`, `ota_version`, `ota_why`: firmware update progress, reported once each (see
  `box/<id>/ota`). `ota` is one of `"updating"`, `"refused"`, `"failed"`, `"rebooting"`,
  `"updated"`, `"rolled_back"`. `"updating"` stays in every state until the update finishes.

## `box/<id>/heartbeat` (box → hub)

```json
{ "ts": "2026-11-16T18:00:30.000Z", "fw": "0.1.0", "uptime_s": 3600, "ip": "10.102.40.101" }
```

Every 30 s. The hub sets the box's `Last seen` from it. Three missed heartbeats (90 s) = shown
as **offline** on the panel. Extra fields are allowed and ignored.

## `box/<id>/tap` (box → hub)

A fob tapped **at a box** is checked by the box against its `fobs` list straight away (no round
trip), online or offline, then reported here. The hub logs `box_open` / `box_denied` with
`detail.via = "box"` and `detail.source`.

```json
{ "uid": "04A1B2C3D4E5F6", "result": "allow", "reason": "listed", "source": "cached", "ts": "2026-11-16T18:00:01.000Z", "fw": "0.1.0" }
```

- `result`: `"allow"` or `"deny"`. An allowed tap unlocks for **8 s** (same as a panel open).
- `reason`: `"listed"` (on the list), `"not_listed"`, `"day_pass_expired"` (after its `until`
  date, Europe/London, by the box's clock), `"no_clock"` (a day pass, clock never set), or, when
  the box was already unlocked, `"show"`, `"offline"`, `"no_list"` (result `"allow"`).
- `source`: `"cached"` if the hub was reachable at the time, `"offline"` if not.
- `ts`: when it happened by the box's clock, `null` if never set. The hub logs a queued tap at
  this time (if it's sane).
- A box only sends taps while the hub is reachable (a broker with no hub subscribed would drop
  them). Taps made while it isn't are kept in RAM, newest 32, and sent when `hub/status` says
  online again.
- QoS 1 can deliver one twice: the hub ignores a repeat of the same box, UID, `ts` and result.
- UIDs that aren't 4, 7 or 10 bytes of hex are ignored by the box.

## `box/<id>/ota` (hub → box)

```json
{ "version": "0.2.0", "url": "http://10.102.40.10:8080/fw/box-0.2.0.bin", "sha256": "9f86d0…0a08", "size": 1144304, "expires": "2026-11-16T18:05:00.000Z" }
```

- Sent only when an admin asks (Update boxes, confirmed by a tap; decision 2026-11-16), and only
  to boxes that are online and not already on that version. Never queued, never retained.
- The box downloads `url` (plain HTTP from the Pi, Control subnet only), checks `size` and
  `sha256` while writing it to the other app slot, reboots into it and reports the new `fw`.
- It **refuses** (state `ota: "refused"`, `ota_why`) when: `bad_request` (a field is missing),
  `expired` (past `expires` by its clock; with no clock it can't tell and accepts),
  `already_running`, `show_mode`, `unlocked`, or `mid_tap` (any tap in the last 3 s). A second
  request while one is in progress is ignored.
- Failures (`ota: "failed"`): `http_<code>`, `size_mismatch`, `sha256_mismatch`,
  `download_incomplete`, `no_space`, `flash_write_failed`, `flash_failed`. The box carries on
  with its current firmware.
- Rollback: the new firmware is marked good only after it has connected to MQTT and sent a
  heartbeat (state `ota: "updated"`). If it hasn't within 5 minutes of booting, or it crashes
  first, the bootloader goes back to the old one, which reports `ota: "rolled_back"` with
  `ota_version` = the version that failed.

## `hub/status` (retained, hub → boxes)

```json
{ "online": true }
```

- The hub publishes `{"online": true}` on every (re)connect and sets its broker last will to
  `{"online": false}` (retained); a clean shutdown publishes `{"online": false}` itself.
- A box counts the hub as **reachable** only while it's connected to the broker **and**
  `hub/status` says online. So a crashed hub with a healthy broker still starts the boxes'
  offline timers (decision 2026-11-16).

## Offline (Pi unreachable)

From the brief: boxes keep using their cached `fobs` list, then **unlock** after
`offline_unlock_min` minutes without the hub (`why: "offline"`). "Without the hub" = not
connected to the broker, or `hub/status` not online, for that long (the timer starts at boot,
too). `0` = unlock as soon as the hub is unreachable. When the hub comes back, the retained
`hub/status`, `mode` and `fobs` messages arrive again on (re)subscribe; the box locks again
(unless show mode or an open time still applies) and sends any taps it kept.

A box that **reboots** while the hub is away comes back locked with its list from flash (show
mode isn't stored, so it's off until the hub is back or the offline timer runs out).

## What the hub does (for reference)

- Subscribes to `box/+/state`, `box/+/heartbeat` and `box/+/tap`. Messages from Box IDs that
  aren't in the workbook are ignored. Stores `fw` (heartbeat, state), `door` and the OTA status
  per box; `GET /api/boxes` shows them.
- Publishes retained `hub/status` online on every (re)connect.
- Publishes `mode` and `fobs` for every box on each (re)connect, after every import and admin
  change, and checks every few minutes for day passes that have expired.
- Never sends `cmd` while disconnected. The panel shows "box offline" instead.
