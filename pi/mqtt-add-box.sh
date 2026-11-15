#!/usr/bin/env bash
# mqtt-add-box.sh BOX-ID: create (or show) the MQTT login for one box. The username is the
# Box ID, so the ACL limits it to box/<BOX-ID>/#. Passwords are kept in /etc/tech-access/mqtt/
# so they can be put in the box's config and backed up to TECHBACKUP.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root
id=${1:-}
[[ $id =~ ^[A-Za-z0-9_-]+$ ]] || die "usage: sudo $0 BOX-01  (letters, digits, - and _ only)"
[[ $id != hub ]] || die "'hub' is reserved"

ensure_dir "$ETC_DIR/mqtt" 0700 root:root
pwfile="$ETC_DIR/mqtt/$id.password"
if [[ ! -s $pwfile ]]; then
  (umask 077; openssl rand -base64 18 | tr -d '/+=' > "$pwfile")
  changed "new password for $id"
fi
if grep -q "^$id:" /etc/mosquitto/passwd 2>/dev/null; then ok "$id in /etc/mosquitto/passwd"; else
  mosquitto_passwd -b /etc/mosquitto/passwd "$id" "$(cat "$pwfile")"
  systemctl reload mosquitto || systemctl restart mosquitto
  changed "added $id to /etc/mosquitto/passwd"
fi
echo "    username: $id"
echo "    password: $(cat "$pwfile")"
summary
