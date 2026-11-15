# 2. Flash the Pi

[← Home](Home.md) · Next: [Run the setup scripts →](03-setup-scripts.md)

You need **internet once**, for flashing and setup: a home network or a phone hotspot. After that
the Pi lives on the show network with none.

## Choose a way to flash

**A. Network install (no extra hardware).** Plug the Pi's Ethernet into a router with internet.
Attach a screen and keyboard. Power on holding **Shift** (with nothing bootable fitted, the Pi
offers network install by itself). Raspberry Pi Imager downloads and runs on the Pi, and can
write straight to the NVMe.

**B. USB adapter.** Put the NVMe in a USB M.2 enclosure, plug it into any computer, and use
Raspberry Pi Imager there. Then fit the SSD in the HAT+.

## Imager settings

| Setting | Value |
| --- | --- |
| Device | Raspberry Pi 5 |
| OS | Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)** (Trixie) |
| Storage | The NVMe |
| Hostname | `tech-hub` |
| Username / password | Your own admin login. Write it in the handover notes ([page 8](08-rebuild-and-handover.md)). |
| Wi-Fi | Your home Wi-Fi or a hotspot, country GB. This is the setup internet. |
| Locale | Europe/London, keyboard `gb` |
| SSH | On. A public key is best; a password is fine. |

## First boot

1. Boot the Pi with no SD card. It finds the NVMe by itself.
2. Find it on the setup network: `ping tech-hub.local`, or look on your router.
3. SSH in: `ssh <you>@tech-hub.local`

If it doesn't boot from the NVMe, see [Troubleshooting](07-troubleshooting.md#pi-wont-boot-from-the-nvme).

### Setup internet over Wi-Fi or Ethernet?

- **Wi-Fi (easiest).** The Wi-Fi from Imager gives internet, and eth0 can take its show-network
  address straight away. Run the scripts in order.
- **Ethernet at home.** Fine, but `02-network.sh` switches eth0 to the static show-network
  address with no gateway, which ends the internet over that cable. Run `02-network.sh` **last**.
