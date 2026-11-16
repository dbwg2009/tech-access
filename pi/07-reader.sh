#!/usr/bin/env bash
# 07-reader.sh: the desk fob reader (PN532 on GPIO14/15 = UART0 = /dev/ttyAMA0 on a Pi 5).
# Turns UART0 on, keeps the kernel and the login console off it, and lets the hub user open it.
# Separate from 06-kiosk.sh because it changes the boot config (needs a reboot) and has nothing
# to do with the screen. No internet needed. Safe to re-run.
# Background: docs/wiki/Hardware.md ("Desk fob reader") and docs/decisions.md (2026-11-16).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

CFG=/boot/firmware/config.txt
CMDLINE=/boot/firmware/cmdline.txt
[[ -f $CFG ]] || die "$CFG not found"
[[ -f $CMDLINE ]] || die "$CMDLINE not found"

say "UART0 on GPIO14/15 ($CFG)"
if grep -qx 'dtparam=uart0=on' "$CFG"; then ok "dtparam=uart0=on"; else
  sed -i '/^dtparam=uart0=/d' "$CFG"
  printf '\n[all]\n# tech-access: PN532 fob reader on GPIO14/15 (07-reader.sh)\ndtparam=uart0=on\n' >> "$CFG"
  changed "$CFG: dtparam=uart0=on (reboot to apply)"
fi
# On a Pi 5, enable_uart=1 sends kernel log messages out of GPIO14/15, straight into the PN532.
if grep -qE '^\s*enable_uart=1' "$CFG"; then
  sed -i -E 's/^\s*enable_uart=1/# enable_uart=1  # off: would put kernel logging on the PN532 (07-reader.sh)/' "$CFG"
  changed "$CFG: commented out enable_uart=1 (reboot to apply)"
else ok "no enable_uart=1"; fi
if grep -qE '^\s*dtparam=uart0_console=on' "$CFG"; then
  sed -i -E 's/^\s*dtparam=uart0_console=on/# dtparam=uart0_console=on  # off: PN532 on this UART (07-reader.sh)/' "$CFG"
  changed "$CFG: commented out uart0_console (reboot to apply)"
else ok "no uart0_console"; fi

say "No serial console ($CMDLINE)"
line=$(head -n1 "$CMDLINE")
new=$(echo "$line" | sed -E 's/(^| )console=(serial0|ttyAMA0),[^ ]*//g; s/  +/ /g; s/^ //')
if [[ $new == "$line" ]]; then ok "no serial console on the kernel command line"; else
  cp "$CMDLINE" "$CMDLINE.before-07-reader"
  printf '%s\n' "$new" > "$CMDLINE"
  changed "$CMDLINE: removed the serial console (old copy: $CMDLINE.before-07-reader; reboot to apply)"
fi
for u in serial-getty@ttyAMA0.service serial-getty@serial0.service; do
  if [[ $(systemctl is-enabled "$u" 2>/dev/null || true) == masked ]]; then ok "$u masked"; else
    systemctl disable --now "$u" 2>/dev/null || true
    systemctl mask "$u" >/dev/null
    changed "masked $u (no login prompt on the reader's port)"
  fi
done

say "Hub user $HUB_USER may open the serial port"
id "$HUB_USER" >/dev/null 2>&1 || die "user $HUB_USER doesn't exist yet: run 05-bun-hub.sh first"
if id -nG "$HUB_USER" | tr ' ' '\n' | grep -qx dialout; then ok "$HUB_USER in dialout"; else
  usermod -aG dialout "$HUB_USER"
  changed "added $HUB_USER to dialout"
fi
if grep -q "reader_device = \"$READER_DEVICE\"" "$ETC_DIR/hub.toml" 2>/dev/null; then ok "hub.toml reader_device = $READER_DEVICE"; else
  echo "    note: $ETC_DIR/hub.toml has no reader_device = \"$READER_DEVICE\". Re-run sudo ./05-bun-hub.sh"
fi
if was_changed dialout && systemctl is-active -q tech-access-hub.service; then
  systemctl restart tech-access-hub.service; changed "restarted tech-access-hub (new group)"
fi

say "Check"
if [[ -e $READER_DEVICE ]]; then
  ok "$READER_DEVICE exists: $(ls -l "$READER_DEVICE")"
  stty -F "$READER_DEVICE" -a 2>/dev/null | head -1 | sed 's/^/    /' || true
else
  echo "    $READER_DEVICE isn't there yet. That's expected before the reboot."
  echo "    After rebooting, if it's still missing, try dtoverlay=uart0-pi5 instead of dtparam=uart0=on."
fi
reader=$(curl -fsS -m 3 "http://127.0.0.1:$HUB_PORT/api/health" 2>/dev/null | sed -n 's/.*"reader":\({[^}]*}\).*/\1/p' || true)
[[ -n $reader ]] && ok "hub says: $reader"

summary
if was_changed "reboot to apply"; then say "Reboot needed: sudo reboot"; fi
echo "After the reboot: curl -s http://127.0.0.1:$HUB_PORT/api/health   (look for \"reader\": ... \"state\":\"ok\")"
