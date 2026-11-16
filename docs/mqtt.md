# MQTT topics (contract for the box firmware, week 5)

Broker: Mosquitto on the Pi, `mqtt://10.102.40.10:1883` (TLS on 8883 later). Every box logs in
with its **Box ID** as the username and a password made by `pi/mqtt-add-box.sh`. The ACL only lets
a box use `box/<its Box ID>/#`; the hub uses everything. All payloads are UTF-8 JSON objects.
Times are ISO 8601 UTC (`2026-11-16T18:00:00.000Z`); boxes get the time from the Pi over NTP.

`<id>` below is the Box ID exactly as in the workbook, e.g. `BOX-01`.

| Topic | Direction | Retained | QoS | When |
| --- | --- | --- | --- | --- |
| `box/<id>/cmd` | hub → box | no | 1 | A fob on the panel opened the box, or End of session |
| `box/<id>/mode` | hub → box | **yes** | 1 | Show mode changed; on hub (re)connect |
| `box/<id>/fobs` | hub → box | **yes** | 1 | The list changed; on hub (re)connect |
| `box/<id>/state` | box → hub | **yes** | 1 | Lock state changed; on box connect |
| `box/<id>/heartbeat` | box → hub | no | 0 | Every 30 s |

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
  match them up. It may be `null`.

## `box/<id>/mode` (retained)

```json
{ "show": true, "ts": "2026-11-16T18:00:00.000Z" }
```

- `show: true` = stay unlocked, no fob needed, until a message with `show: false` arrives.
- Retained, so a box that reboots during a show comes back unlocked.
- No message at all (new box) = `show: false`.

## `box/<id>/fobs` (retained)

The box's cached allowlist, used **only while the hub is unreachable** (see "Offline" below).

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
- `v`: format version. A box that sees an unknown `v` keeps its old list.
- Store the latest list in flash so it survives a power cut.

## `box/<id>/state` (retained, box → hub)

```json
{ "lock": "locked", "ts": "2026-11-16T18:00:09.000Z", "ref": 1234, "fw": "0.1.0" }
```

- `lock`: `"locked"` or `"open"`. Publish on every change and once on connect.
- Retained, so the hub learns every box's state when it restarts.
- Set the broker **last will** on this topic, retained: `{"lock": "open", "why": "offline"}`.
  Power cut and no network both mean "fail open" (decision in the brief), so if the box drops off,
  the hub's view becomes "open". The hub also marks a box *offline* after 90 s with no heartbeat.
- Optional `why`: `"fob"`, `"cmd"`, `"show"`, `"offline"`, `"power"`.

## `box/<id>/heartbeat` (box → hub)

```json
{ "ts": "2026-11-16T18:00:30.000Z", "fw": "0.1.0", "uptime_s": 3600, "ip": "10.102.40.101" }
```

Every 30 s. The hub sets the box's `Last seen` from it. Three missed heartbeats (90 s) = shown
as **offline** on the panel. Extra fields are allowed and ignored.

## Taps at the box (week 5)

A fob tapped **at a box** is checked by the box against its `fobs` list straight away (no
round trip), then reported with a topic to be added in week 5 (`box/<id>/tap`), so the hub logs
`box_open` / `box_denied`. Week 5 adds that topic here before the firmware uses it.

## Offline (Pi unreachable)

From the brief: boxes keep using their cached `fobs` list, then **unlock** after
`offline_unlock_min` minutes without the hub. "Without the hub" = no MQTT connection and no
heartbeat acknowledgement for that long. When the hub comes back, the retained `mode` and `fobs`
messages arrive again on (re)subscribe; resume normal locking.

## What the hub does (for reference)

- Subscribes to `box/+/state` and `box/+/heartbeat`. Messages from Box IDs that aren't in the
  workbook are ignored.
- Publishes `mode` and `fobs` for every box on each (re)connect, after every import and admin
  change, and checks every few minutes for day passes that have expired.
- Never sends `cmd` while disconnected. The panel shows "box offline" instead.
