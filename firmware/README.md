# Lock box firmware

One firmware for every box (WT32-ETH01 on Ethernet; a plain ESP32 on Wi-Fi for flight cases
later), with per-box settings in NVS. Wiring, provisioning and updates:
[docs/wiki/Lock-Boxes.md](../docs/wiki/Lock-Boxes.md). Contract: [docs/mqtt.md](../docs/mqtt.md).

```
lib/box_core/      every decision, plain C++17 (no Arduino): a state machine, inputs in, actions out
test/vectors/      the rules as JSON cases, shared with the box simulator (tools/box-sim)
test/test_box_core native unit tests: runs the vectors plus helper tests
src/               the hardware layer: pins, PN532, lock, reed switch, Ethernet/Wi-Fi, MQTT, SNTP,
                   flash, OTA, watchdog, the USB serial console
tools/provision.py set a box's ID, password and IP over USB in one go
partitions.csv     two 1.75 MB OTA slots, NVS, LittleFS for the fob list
```

```bash
pio test -e native          # rules, on your PC (needs a C++17 compiler)
pio run -e wt32-eth01       # build a fixed box; add -t upload --upload-port <port> to flash
pio run -e esp32-wifi       # flight cases (compile only for now)
```

Bump `version` under `[fw]` in `platformio.ini` for every release you'll put on a box.
