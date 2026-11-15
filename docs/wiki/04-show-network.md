# 4. Show network

[← Setup scripts](03-setup-scripts.md) · [Home](Home.md) · Next: [The workbook →](05-workbook.md)

## Addresses

Two subnets, both `255.255.0.0` (/16), **no gateway, no DNS, no internet**. The third number
says what kind of device it is.

| Subnet | Range | Used for |
| --- | --- | --- |
| LX | `10.101.0.0/16` | Lighting data (sACN) only |
| Control | `10.102.0.0/16` | Everything else |

| Address | Device |
| --- | --- |
| 10.101.10.11 | Desk switch (IGMP querier) |
| 10.101.50.1 | XNODE 4 |
| 10.101.100.101 | Lighting PC "LX" port |
| 10.102.10.10 / .11 | Rack / desk switch management |
| 10.102.10.20 / .21 | Wi-Fi AP 2 (stage) / AP 1 (control room) |
| 10.102.10.30 | DHCP server (Pico) |
| 10.102.20.10 | Behringer WING |
| 10.102.30.11 / .12 | QLab Mac A / B |
| **10.102.40.10** | **tech-access hub (`tech-hub`)** |
| 10.102.40.101+ | Lock boxes and key cabinet (planned) |
| 10.102.100.101 | Lighting PC "CONTROL" USB adapter (the Nomad PC) |
| 10.102.200.10–250 | DHCP pool: **Wi-Fi devices only** (flight cases) |

Reserved, don't use: `10.101.0.1` and `10.102.0.1` (future router), `10.10x.100.102` (backup
lighting PC), `10.101.50.2+` (future DMX nodes), `10.102.50.x` (video and projectors).

`10.102.40.x` is the access-control block. Fixed boxes get static addresses from `.101` up; write
each one in the Boxes sheet's `IP address` column. Wi-Fi flight cases get theirs from DHCP.

School IT still needs to confirm none of these clash with the school network.

## Ports on the hub

| Port | Service | Who uses it |
| --- | --- | --- |
| 22 | SSH | You, for maintenance |
| 123/udp | NTP (chrony) | Lock boxes get the time |
| 1883 | MQTT (Mosquitto) | Lock boxes; the hub itself |
| 8080 | HTTP: hub API and panel | Desk panel (on the Pi), Nomad PC; `/api/health` from anywhere |
| 8883 | MQTT over TLS | Not on yet (commented out in the Mosquitto config) |

**Admin API routes** (import, apply, export) only answer requests **from the Pi itself**
(`127.0.0.1`), because the panel runs on the Pi. Proper login arrives with Stage Door in week 8.

## Checking from the Nomad PC

In PowerShell (use `curl.exe`; plain `curl` in PowerShell is a different command):

```powershell
ping 10.102.40.10
curl.exe http://10.102.40.10:8080/api/health
```

## Why the Pi is safe on the show network

- It only listens. It doesn't broadcast sACN, Art-Net or OSC, and nothing in a show depends on it.
- It never takes a default route, so it can't confuse other devices' routing.
- If it crashes, boxes keep their cached fob list and unlock after their offline timeout.
