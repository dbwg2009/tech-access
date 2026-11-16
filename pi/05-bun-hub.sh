#!/usr/bin/env bash
# 05-bun-hub.sh: install Bun, put the repo in $INSTALL_DIR, install the hub's dependencies from
# the lockfile, and run it as a systemd service. Needs internet the first time. Safe to re-run
# (it also updates the hub to the latest $REPO_REF).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

say "Bun $BUN_VERSION"
if [[ -x /opt/bun/bin/bun && $(/opt/bun/bin/bun --version) == "$BUN_VERSION" ]]; then ok "bun $BUN_VERSION installed"; else
  apt_install unzip curl ca-certificates
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v$BUN_VERSION"
  changed "installed bun $BUN_VERSION in /opt/bun"
fi
if [[ $(readlink -f /usr/local/bin/bun 2>/dev/null) == /opt/bun/bin/bun ]]; then ok "/usr/local/bin/bun"; else
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun; changed "linked /usr/local/bin/bun"; fi

say "Service user $HUB_USER"
if id "$HUB_USER" >/dev/null 2>&1; then ok "user exists"; else
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$HUB_USER"
  changed "created system user $HUB_USER"
fi
ensure_dir "$DATA_DIR" 0750 "$HUB_USER:$HUB_USER"
ensure_dir "$ETC_DIR" 0755 root:root
# Let the hub read its MQTT password and TLS key.
[[ -f $ETC_DIR/hub.env ]] && { chgrp "$HUB_USER" "$ETC_DIR/hub.env"; chmod 0640 "$ETC_DIR/hub.env"; }
[[ -f $ETC_DIR/tls/server.key ]] && { chgrp "$HUB_USER" "$ETC_DIR/tls/server.key"; chmod 0640 "$ETC_DIR/tls/server.key"; }

say "Repo in $INSTALL_DIR ($REPO_REF)"
if [[ -d $INSTALL_DIR/.git ]]; then
  before=$(git -C "$INSTALL_DIR" rev-parse HEAD)
  if git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_REF"; then
    git -C "$INSTALL_DIR" checkout --quiet -B "$REPO_REF" FETCH_HEAD
  else
    echo "    note: couldn't fetch (no internet?); keeping the current checkout"
  fi
  after=$(git -C "$INSTALL_DIR" rev-parse HEAD)
  if [[ $before == "$after" ]]; then ok "at ${after:0:7}"; else changed "repo ${before:0:7} -> ${after:0:7}"; fi
else
  [[ -e $INSTALL_DIR ]] && die "$INSTALL_DIR exists but isn't a git checkout; move it away first"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
  changed "cloned $REPO_URL ($REPO_REF) to $INSTALL_DIR"
fi
if [[ $PI_DIR != "$INSTALL_DIR/pi" ]]; then
  echo "    note: you ran this from $PI_DIR. From now on run the scripts from $INSTALL_DIR/pi"
fi

say "Hub dependencies (from bun.lock, no changes allowed)"
lockhash=$(sha256sum "$INSTALL_DIR/hub/bun.lock" | cut -d' ' -f1)
stamp="$INSTALL_DIR/hub/node_modules/.tech-access-lock"
if [[ -f $stamp && $(cat "$stamp") == "$lockhash" ]]; then ok "node_modules matches bun.lock"; else
  (cd "$INSTALL_DIR/hub" && bun install --frozen-lockfile --production)
  echo "$lockhash" > "$stamp"
  changed "bun install --frozen-lockfile --production"
fi

say "Desk panel (hub/panel -> hub/public/panel, built here, not committed)"
head=$(git -C "$INSTALL_DIR" rev-parse HEAD)
pstamp="$INSTALL_DIR/hub/public/panel/.built-from"
if [[ -f $pstamp && $(cat "$pstamp") == "$head" && -f $INSTALL_DIR/hub/public/panel/app.js ]]; then ok "panel built for ${head:0:7}"; else
  (cd "$INSTALL_DIR/hub" && bun run build)
  echo "$head" > "$pstamp"
  changed "built the desk panel for ${head:0:7}"
fi

say "Hub config $ETC_DIR/hub.toml"
write_file "$ETC_DIR/hub.toml" 0644 root:root <<TOML
# Written by 05-bun-hub.sh from pi/config.env. Edit config.env and re-run, not this file.
db_path = "$DATA_DIR/tech-access.db"
http_port = $HUB_PORT
http_host = "0.0.0.0"
mqtt_url = "mqtt://127.0.0.1:$MQTT_PORT"
mqtt_username = "hub"
usb_mount_root = "/media"
timezone = "$TIMEZONE"
reader_device = "$READER_DEVICE"
fake_reader = false
TOML

say "systemd unit"
write_file /etc/systemd/system/tech-access-hub.service 0644 root:root < <(sed \
  -e "s|@HUB_USER@|$HUB_USER|g" -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
  -e "s|@ETC_DIR@|$ETC_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
  "$PI_DIR/systemd/tech-access-hub.service")
was_changed tech-access-hub.service && systemctl daemon-reload
enable_now tech-access-hub.service
if was_changed "repo " || was_changed "bun install" || was_changed hub.toml || was_changed tech-access-hub.service; then
  systemctl restart tech-access-hub.service; changed "restarted tech-access-hub"
fi

say "Health check"
for _ in $(seq 1 20); do
  if out=$(curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" 2>/dev/null); then break; fi
  sleep 1
done
if [[ -n ${out:-} ]]; then ok "$out"; else
  echo "    warning: hub didn't answer on port $HUB_PORT. Look at: journalctl -u tech-access-hub -n 50"
fi

summary
echo "From the Nomad PC: curl http://$STATIC_IP:$HUB_PORT/api/health"
