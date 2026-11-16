#!/usr/bin/env bash
# 06-kiosk.sh: the desk panel's screen. A "kiosk" user logs in automatically on tty1 and runs
# labwc (Wayland) with Chromium in kiosk mode on the hub's panel. swayidle + wlopm turn the screen
# off after SCREEN_OFF_SECONDS with no touch; a touch or a fob tap turns it back on. Also installs
# the polkit rule that lets the admin menu restart the hub and reboot the Pi.
# Needs internet the first time (packages). Safe to re-run. Reboot afterwards to start the panel.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

KHOME="/home/$KIOSK_USER"
HUB_URL="http://127.0.0.1:$HUB_PORT"

say "Packages (Trixie names: chromium, labwc, swayidle, wlopm, polkitd)"
apt_install labwc chromium swayidle wlopm polkitd curl

say "Kiosk user $KIOSK_USER"
if id "$KIOSK_USER" >/dev/null 2>&1; then ok "user exists"; else
  useradd --create-home --shell /bin/bash --comment "tech-access desk panel" "$KIOSK_USER"
  passwd --lock "$KIOSK_USER" >/dev/null
  changed "created user $KIOSK_USER (password locked: it only logs in automatically on tty1)"
fi
for g in video render input; do
  if id -nG "$KIOSK_USER" | tr ' ' '\n' | grep -qx "$g"; then ok "$KIOSK_USER in $g"; else
    usermod -aG "$g" "$KIOSK_USER"; changed "added $KIOSK_USER to $g"; fi
done

say "Auto-login on tty1"
# Named to sort after raspi-config's own autologin.conf, so this one wins if both exist.
write_file /etc/systemd/system/getty@tty1.service.d/tech-access-autologin.conf 0644 root:root <<EOF
# Written by 06-kiosk.sh: log $KIOSK_USER in on tty1; its .bash_profile starts the panel.
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF
if was_changed tech-access-autologin.conf; then systemctl daemon-reload; fi

say "Panel helpers"
write_file "$ETC_DIR/kiosk.env" 0644 root:root <<EOF
# Written by 06-kiosk.sh from pi/config.env. Read by the kiosk helpers.
HUB_URL=$HUB_URL
EOF
for f in tech-access-kiosk-browser tech-access-screen tech-access-screen-helper; do
  install_file "$PI_DIR/kiosk/$f" "/usr/local/bin/$f" 0755 root:root
done
write_file /usr/local/share/tech-access-kiosk/start.html 0644 root:root < <(sed "s|@HUB_PORT@|$HUB_PORT|g" "$PI_DIR/kiosk/start.html")

say "labwc session for $KIOSK_USER"
write_file "$KHOME/.bash_profile" 0644 "$KIOSK_USER:$KIOSK_USER" <<'EOF'
# Written by 06-kiosk.sh. On tty1 start the desk panel (labwc + Chromium). If labwc ever exits,
# the login ends, getty logs in again and the panel comes back. Other ttys get a normal shell.
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
  exec labwc
fi
EOF
ensure_dir "$KHOME/.config" 0755 "$KIOSK_USER:$KIOSK_USER"
ensure_dir "$KHOME/.config/labwc" 0755 "$KIOSK_USER:$KIOSK_USER"
write_file "$KHOME/.config/labwc/autostart" 0644 "$KIOSK_USER:$KIOSK_USER" < <(sed "s|@SCREEN_OFF_SECONDS@|$SCREEN_OFF_SECONDS|g" "$PI_DIR/kiosk/labwc-autostart")
write_file "$KHOME/.config/labwc/environment" 0644 "$KIOSK_USER:$KIOSK_USER" <<'EOF'
# Written by 06-kiosk.sh.
XKB_DEFAULT_LAYOUT=gb
EOF

say "polkit: the admin menu may restart the hub and reboot the Pi (nothing else)"
write_file /etc/polkit-1/rules.d/50-tech-access.rules 0644 root:root < <(sed "s|@HUB_USER@|$HUB_USER|g" "$PI_DIR/polkit/50-tech-access.rules")
# polkitd reloads rules by itself when the file changes.
enable_now polkit.service

summary
if ((${#CHANGES[@]})); then
  say "Reboot to start the panel: sudo reboot"
fi
echo "Logs from the panel session: journalctl -t tech-access-kiosk -b"
echo "Then work through the checklist in docs/wiki/Desk-Panel.md (\"First test on the real hardware\")."
