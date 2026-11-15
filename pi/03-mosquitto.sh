#!/usr/bin/env bash
# 03-mosquitto.sh: Mosquitto broker on the show network. No anonymous access; one user for the
# hub; boxes log in as their Box ID and are limited to box/<id>/#. Safe to re-run.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

say "Packages"
apt_install mosquitto mosquitto-clients

say "Config"
write_file /etc/mosquitto/conf.d/tech-access.conf 0644 root:root \
  < <(sed "s|@MQTT_PORT@|$MQTT_PORT|" "$PI_DIR/mosquitto/tech-access.conf")
install_file "$PI_DIR/mosquitto/tech-access.acl" /etc/mosquitto/tech-access.acl 0640 root:mosquitto

say "Hub login"
ensure_dir "$ETC_DIR" 0755 root:root
ensure_dir "$ETC_DIR/mqtt" 0700 root:root
hubpw="$ETC_DIR/mqtt/hub.password"
if [[ ! -s $hubpw ]]; then
  (umask 077; openssl rand -base64 24 | tr -d '/+=' > "$hubpw")
  changed "generated hub MQTT password ($hubpw)"
else ok "hub password exists"; fi
if [[ ! -f /etc/mosquitto/passwd ]]; then
  install -m 0640 -o root -g mosquitto /dev/null /etc/mosquitto/passwd
  changed "created /etc/mosquitto/passwd"
fi
# Re-set the hub's entry if missing or if the stored password doesn't match.
need=1
if grep -q '^hub:' /etc/mosquitto/passwd && [[ $(stat -c %Y /etc/mosquitto/passwd) -ge $(stat -c %Y "$hubpw") ]]; then need=0; fi
if ((need)); then
  mosquitto_passwd -b /etc/mosquitto/passwd hub "$(cat "$hubpw")"
  changed "set hub user in /etc/mosquitto/passwd"
else ok "hub user in /etc/mosquitto/passwd"; fi
chown root:mosquitto /etc/mosquitto/passwd; chmod 0640 /etc/mosquitto/passwd

# The hub service reads its MQTT password from this env file (see 05-bun-hub.sh).
write_file "$ETC_DIR/hub.env" 0640 "root:root" <<ENV
# Written by 03-mosquitto.sh. Read by tech-access-hub.service.
TECH_ACCESS_MQTT_PASSWORD=$(cat "$hubpw")
ENV

say "Service"
enable_now mosquitto
if was_changed /etc/mosquitto/; then systemctl restart mosquitto; changed "restarted mosquitto"; fi

say "Test: hub can publish and subscribe; anonymous is refused"
pw=$(cat "$hubpw")
got=$(timeout 5 mosquitto_sub -h 127.0.0.1 -p "$MQTT_PORT" -u hub -P "$pw" -t 'tech-access/selftest' -C 1 -W 4 & \
      sleep 1; mosquitto_pub -h 127.0.0.1 -p "$MQTT_PORT" -u hub -P "$pw" -t 'tech-access/selftest' -m ok; wait) || true
[[ $got == ok ]] && ok "hub pub/sub works" || echo "    warning: hub pub/sub test failed (got '$got')"
if mosquitto_pub -h 127.0.0.1 -p "$MQTT_PORT" -t test -m x 2>/dev/null; then echo "    warning: anonymous publish was accepted!"; else ok "anonymous refused"; fi

summary
echo "Add a box login later with: sudo $PI_DIR/mqtt-add-box.sh BOX-01"
