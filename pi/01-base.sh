#!/usr/bin/env bash
# 01-base.sh: hostname, timezone, updates, chrony + RTC, RTC battery charging, NVMe boot order,
# automatic upgrades off. Needs internet (home network or hotspot). Safe to re-run.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

say "Hostname: $PI_HOSTNAME"
if [[ $(cat /etc/hostname 2>/dev/null) != "$PI_HOSTNAME" ]]; then
  hostnamectl set-hostname "$PI_HOSTNAME"; changed "hostname -> $PI_HOSTNAME"
else ok "hostname"; fi
if grep -qE "^127\.0\.1\.1\s+$PI_HOSTNAME(\s|$)" /etc/hosts; then ok "/etc/hosts"; else
  sed -i '/^127\.0\.1\.1\s/d' /etc/hosts
  echo "127.0.1.1	$PI_HOSTNAME" >> /etc/hosts
  changed "/etc/hosts 127.0.1.1 -> $PI_HOSTNAME"
fi

say "Timezone: $TIMEZONE"
if [[ $(timedatectl show -p Timezone --value) != "$TIMEZONE" ]]; then
  timedatectl set-timezone "$TIMEZONE"; changed "timezone -> $TIMEZONE"
else ok "timezone"; fi

say "Automatic upgrades off (updates happen by hand, never mid-show)"
if dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed'; then
  DEBIAN_FRONTEND=noninteractive apt-get purge -y unattended-upgrades; changed "removed unattended-upgrades"
else ok "unattended-upgrades not installed"; fi
for t in apt-daily.timer apt-daily-upgrade.timer; do
  if [[ $(systemctl is-enabled "$t" 2>/dev/null || true) == masked ]]; then ok "$t masked"; else
    systemctl disable --now "$t" 2>/dev/null || true
    systemctl mask "$t"; changed "masked $t"
  fi
done

say "Updates"
apt-get update
before=$(dpkg-query -W -f='${Package} ${Version}\n' | md5sum)
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
if [[ $before == "$(dpkg-query -W -f='${Package} ${Version}\n' | md5sum)" ]]; then ok "already up to date"; else changed "apt full-upgrade"; fi
apt_install chrony git ca-certificates curl unzip openssl rsync

say "chrony (RTC is the clock on the show network)"
write_file /etc/chrony/conf.d/tech-access.conf 0644 root:root \
  < <(sed "s|@NTP_ALLOW@|$NTP_ALLOW|" "$PI_DIR/chrony/tech-access.conf")
if was_changed /etc/chrony/conf.d/tech-access.conf; then systemctl restart chrony; changed "restarted chrony"; fi
enable_now chrony
if [[ -e /dev/rtc0 ]]; then ok "RTC: $(cat /sys/class/rtc/rtc0/name 2>/dev/null || echo rtc0), reads $(hwclock -r 2>/dev/null || echo '?')"
else echo "    warning: no /dev/rtc0 found (is this a Pi 5?)"; fi

say "Firmware config (/boot/firmware/config.txt)"
CFG=/boot/firmware/config.txt
[[ -f $CFG ]] || die "$CFG not found"
want="dtparam=rtc_bbat_vchg=$RTC_CHARGE_UV"
if [[ $RTC_BATTERY == rechargeable ]]; then
  if grep -qxF "$want" "$CFG" && [[ $(grep -c 'rtc_bbat_vchg' "$CFG") == 1 ]]; then ok "RTC battery charging line present"; else
    sed -i '/rtc_bbat_vchg/d' "$CFG"
    printf '\n[all]\n# tech-access: charge the official rechargeable RTC cell (01-base.sh)\n%s\n' "$want" >> "$CFG"
    changed "$CFG: $want (reboot to apply)"
  fi
  v=$(cat /sys/class/rtc/rtc0/charging_voltage 2>/dev/null || echo "?")
  if [[ $v == "$RTC_CHARGE_UV" ]]; then ok "RTC charging at ${v} uV"; else echo "    note: RTC charging_voltage is now $v; it becomes $RTC_CHARGE_UV after a reboot"; fi
else
  if grep -q 'rtc_bbat_vchg' "$CFG"; then
    sed -i '/rtc_bbat_vchg/d; /tech-access: charge the official rechargeable RTC cell/d' "$CFG"
    changed "$CFG: RTC charging removed (RTC_BATTERY=$RTC_BATTERY)"
  else ok "RTC charging off (RTC_BATTERY=$RTC_BATTERY)"; fi
fi

say "Bootloader: latest EEPROM, BOOT_ORDER=$BOOT_ORDER (NVMe first)"
if command -v rpi-eeprom-update >/dev/null; then
  if rpi-eeprom-update | grep -q 'UPDATE AVAILABLE'; then rpi-eeprom-update -a; changed "bootloader EEPROM update staged (reboot to apply)"; else ok "bootloader up to date"; fi
  current=$(rpi-eeprom-config | sed -n 's/^BOOT_ORDER=//p')
  if [[ ${current,,} == "${BOOT_ORDER,,}" ]]; then ok "BOOT_ORDER=$current"; else
    tmp=$(mktemp)
    rpi-eeprom-config | sed '/^BOOT_ORDER=/d' > "$tmp"
    echo "BOOT_ORDER=$BOOT_ORDER" >> "$tmp"
    rpi-eeprom-config --apply "$tmp"
    rm -f "$tmp"
    changed "BOOT_ORDER ${current:-unset} -> $BOOT_ORDER (reboot to apply)"
  fi
else echo "    warning: rpi-eeprom-update not found; set the boot order with raspi-config"; fi

summary
if was_changed "reboot to apply"; then say "Reboot needed: sudo reboot"; fi
