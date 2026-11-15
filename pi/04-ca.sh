#!/usr/bin/env bash
# 04-ca.sh: local certificate authority and the hub's server certificate.
#
#   /etc/tech-access/ca/ca.key         CA private key. Stays on the Pi (+ TECHBACKUP). NEVER in git.
#   /etc/tech-access/ca/ca.crt         CA certificate (20 years).
#   /etc/tech-access/tls/server.key    Hub TLS key.
#   /etc/tech-access/tls/server.crt    Hub TLS certificate for $PI_HOSTNAME and $STATIC_IP.
#   /etc/tech-access/tls/tech-access-ca.crt   Copy of the CA cert for the iPad profile (week 8).
#
# iOS only trusts server certificates from a user-installed CA if they last 825 days or less,
# so the server certificate is renewed automatically (monthly check, renews 60 days before
# expiry) by tech-access-cert-renew.timer. The CA stays the same, so the iPad never needs a new
# profile. Safe to re-run; --renew-only just does the renewal check.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

CA_DIR="$ETC_DIR/ca"
TLS_DIR="$ETC_DIR/tls"
SERVER_DAYS=825
RENEW_BEFORE_DAYS=60
RENEW_ONLY=0; [[ ${1:-} == --renew-only ]] && RENEW_ONLY=1

ensure_dir "$ETC_DIR" 0755 root:root
ensure_dir "$CA_DIR" 0700 root:root
ensure_dir "$TLS_DIR" 0755 root:root

say "Certificate authority"
if [[ -s $CA_DIR/ca.key && -s $CA_DIR/ca.crt ]]; then
  ok "CA exists: $(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject -enddate | tr '\n' ' ')"
else
  ((RENEW_ONLY)) && die "no CA yet; run $0 without --renew-only first"
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$CA_DIR/ca.key")
  openssl req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days 7300 \
    -subj "/O=tech-access/CN=tech-access local CA ($PI_HOSTNAME)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$CA_DIR/ca.crt"
  chmod 0644 "$CA_DIR/ca.crt"
  changed "created CA ($CA_DIR/ca.crt, 20 years)"
fi
install_file "$CA_DIR/ca.crt" "$TLS_DIR/tech-access-ca.crt" 0644 root:root

say "Server certificate for $PI_HOSTNAME / $STATIC_IP"
SAN="DNS:$PI_HOSTNAME,DNS:$PI_HOSTNAME.local,IP:$STATIC_IP,DNS:localhost,IP:127.0.0.1"
reason=""
if [[ ! -s $TLS_DIR/server.crt || ! -s $TLS_DIR/server.key ]]; then reason="missing"
elif ! openssl x509 -in "$TLS_DIR/server.crt" -noout -checkend $((RENEW_BEFORE_DAYS * 86400)) >/dev/null; then reason="expires within $RENEW_BEFORE_DAYS days"
elif ! openssl verify -CAfile "$CA_DIR/ca.crt" "$TLS_DIR/server.crt" >/dev/null 2>&1; then reason="not signed by this CA"
else
  have=$(openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName | tail -n +2 | tr -d ' ' | sed 's/IPAddress:/IP:/g')
  [[ $have == "$SAN" ]] || reason="names changed ($have -> $SAN)"
fi
if [[ -z $reason ]]; then
  ok "valid until $(openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate | cut -d= -f2)"
else
  tmp=$(mktemp -d)
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/server.key")
  openssl req -new -key "$tmp/server.key" -subj "/O=tech-access/CN=$PI_HOSTNAME" -out "$tmp/server.csr"
  cat > "$tmp/ext.cnf" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
authorityKeyIdentifier=keyid
subjectKeyIdentifier=hash
EXT
  openssl x509 -req -in "$tmp/server.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -CAcreateserial -CAserial "$CA_DIR/ca.srl" -sha256 -days "$SERVER_DAYS" \
    -extfile "$tmp/ext.cnf" -out "$tmp/server.crt" 2>/dev/null
  # Readable by the hub (techaccess group, if it exists yet) and Mosquitto.
  grp=root; getent group "$HUB_USER" >/dev/null && grp=$HUB_USER
  install -m 0640 -o root -g "$grp" "$tmp/server.key" "$TLS_DIR/server.key"
  install -m 0644 -o root -g root "$tmp/server.crt" "$TLS_DIR/server.crt"
  cat "$TLS_DIR/server.crt" "$CA_DIR/ca.crt" > "$TLS_DIR/fullchain.crt"; chmod 0644 "$TLS_DIR/fullchain.crt"
  rm -rf "$tmp"
  changed "issued server certificate ($reason), valid $SERVER_DAYS days"
  systemctl try-restart tech-access-hub.service mosquitto.service 2>/dev/null || true
fi

if ((! RENEW_ONLY)); then
  say "Automatic renewal timer"
  write_file "${SYSTEMD_DIR:-/etc/systemd/system}"/tech-access-cert-renew.service 0644 root:root <<UNIT
[Unit]
Description=tech-access: renew the hub TLS certificate if it expires soon

[Service]
Type=oneshot
ExecStart=$PI_DIR/04-ca.sh --renew-only
UNIT
  install_file "$PI_DIR/systemd/tech-access-cert-renew.timer" "${SYSTEMD_DIR:-/etc/systemd/system}"/tech-access-cert-renew.timer 0644 root:root
  if was_changed tech-access-cert-renew; then systemctl daemon-reload; fi
  enable_now tech-access-cert-renew.timer
fi

summary
if was_changed "created CA"; then
  echo
  echo "IMPORTANT: back up $CA_DIR/ca.key (TECHBACKUP stick, week 7). If it's lost, every device"
  echo "that trusts this CA (the iPad) needs a new profile. Never commit it to git."
fi
echo "CA certificate for the iPad profile: $TLS_DIR/tech-access-ca.crt"
