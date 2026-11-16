# Box test vectors

Shared by the firmware (`pio test -e native`, `test/test_box_core/`) and the box simulator
(`bun test` in `tools/box-sim/`). If a rule changes, change the vector first, then both
implementations until both pass. That's how we know the simulator behaves like a real box.

## File format

```jsonc
{
  "defaults": { "boot": { ... } },          // merged into every case's boot
  "cases": [
    {
      "name": "what the rule is",
      "boot": {
        "clock": "2026-11-16T18:00:00.000Z", // wall clock at t=0, or null = never set
        "fobs": { ... } ,                     // fobs JSON already in flash, or null = none
        "fw": "0.1.0",
        "door_sensor": true,
        "ota_pending_verify": false,          // first boot of a freshly flashed image
        "rolled_back_from": ""                // the bootloader rolled back from this version
      },
      "steps": [ { "at": 1000, ...one input..., ...checks... } ]
    }
  ]
}
```

Each step first advances the clock to `at` (ms since boot) and runs the box's timers, then
applies at most one input, then runs its checks.

Inputs: `"broker": true|false`, `"msg": "cmd"|"mode"|"fobs"|"ota"|"hub"` with `"payload"`
(an object, a raw string, or `null` for an empty retained message), `"tap": "<uid>"`,
`"door": "shut"|"open"`, `"ntp": "<ISO time now>"`, `"ota_result": {"ok": bool, "why": "..."}`.

Checks look at what the box did **in that step** (its timers and its input; the first step also
sees what the box did at boot):

- `"expect": {"lock": "open"|"locked", "why": "..."}` — current lock state (`why` `""` = none).
- `"publish": [{"topic": "tap", "match": {...}, "absent": ["door"]}]` — at least one message on
  that topic whose payload has these exact field values (`"*"` = any value, but present) and
  doesn't have the `absent` fields.
- `"no_publish": ["tap", "state"]` — nothing on these topics.
- `"actions": ["set_lock", "store_fobs", "start_ota", "mark_valid", "rollback"]` — each happened.
- `"no_actions": [...]` — none of these happened.
