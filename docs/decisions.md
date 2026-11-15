# Decisions

Date, decision, reason. Newest at the bottom.

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-15 | Show network is two /16 subnets with no gateway or DNS: LX `10.101.0.0/16` (sACN only) and Control `10.102.0.0/16` (everything else). DHCP (server `10.102.10.30`) hands out `10.102.200.10`–`10.102.200.250` to Wi-Fi devices only; wired devices are static. | Existing show network IP scheme. School IT still to confirm no clash with the school network. |
| 2026-11-15 | Pi OS: Raspberry Pi OS Trixie, 64-bit Lite. | Daniel's choice. Kiosk (weeks 3–4) will add a minimal compositor + Chromium on top. |
| 2026-11-15 | Staff and hire techs with a `Standard` fob are treated as Level 4 for boxes and kit. Admin powers still need an `Admin` fob. | Daniel's choice. They have no ladder level; both are trusted adults. |
| 2026-11-15 | A `Day pass` fob carries a fixed level set when it is issued (new optional `Level` column on the `Fobs` sheet, default 1), not the holder's level. | Daniel's choice. Suits guests who aren't on the ladder. |
| 2026-11-15 | Pi hub static IP `10.102.40.10/16` on `eth0` (Control subnet), hostname `tech-hub`, no gateway. `10.102.40.x` becomes the access-control block (boxes from `10.102.40.101`). | Third octet = device type in the IP scheme; `40` is unused and outside the DHCP pool and all reserved ranges. |
| 2026-11-15 | Day pass level lives in a new optional `Level` column on the `Fobs` sheet (1–4, blank = 1). Read only for `Day pass` fobs. | Fixed-level day passes need a place to store the level; optional so the existing Sheet still imports. |
| 2026-11-15 | An `Active` `Day pass` fob may have a blank Person ID (guest). Blank is still an error for `Standard` and `Admin` fobs. | Guests aren't on the People sheet. |
