#!/usr/bin/env bash
# 02-network.sh: static IP on eth0 with NetworkManager. No gateway or DNS (the show network has
# none). The Pico's DHCP (Wi-Fi only) is left alone. Safe to re-run.
#
# After this, eth0 no longer uses DHCP. If you're getting internet over eth0 for setup, run this
# script last, or get internet over Wi-Fi (set it in Raspberry Pi Imager).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_root

CON=tech-access-show
ADDR="$STATIC_IP/$PREFIX"
command -v nmcli >/dev/null || die "nmcli not found: this needs NetworkManager (default on Raspberry Pi OS)"

say "NetworkManager profile '$CON' on $ETH_IFACE: $ADDR, gateway ${GATEWAY:-none}"
if ! nmcli -t -f NAME connection show | grep -qx "$CON"; then
  nmcli connection add type ethernet con-name "$CON" ifname "$ETH_IFACE" >/dev/null
  changed "created profile $CON"
fi

# Desired settings. ipv4.never-default stops this link ever taking the default route,
# so a setup Wi-Fi keeps working for internet while eth0 is on the show network.
declare -A want=(
  [connection.interface-name]="$ETH_IFACE"
  [connection.autoconnect]="yes"
  [connection.autoconnect-priority]="100"
  [ipv4.method]="manual"
  [ipv4.addresses]="$ADDR"
  [ipv4.gateway]="$GATEWAY"
  [ipv4.never-default]="$([[ -z $GATEWAY ]] && echo yes || echo no)"
  [ipv4.dns]=""
  [ipv4.ignore-auto-dns]="yes"
  [ipv6.method]="disabled"
)
mods=()
for k in "${!want[@]}"; do
  have=$(nmcli -g "$k" connection show "$CON")
  [[ $have == "--" ]] && have=""
  if [[ $have != "${want[$k]}" ]]; then mods+=("$k" "${want[$k]}"); changed "$CON $k: '${have}' -> '${want[$k]}'"; fi
done
if ((${#mods[@]})); then nmcli connection modify "$CON" "${mods[@]}"; else ok "profile settings"; fi

say "Other wired profiles on $ETH_IFACE: stop them auto-connecting (DHCP would fight the static IP)"
while IFS=: read -r name type _; do
  [[ $type == *ethernet* && $name != "$CON" ]] || continue
  ifn=$(nmcli -g connection.interface-name connection show "$name")
  [[ -z $ifn || $ifn == "$ETH_IFACE" ]] || continue
  if [[ $(nmcli -g connection.autoconnect connection show "$name") == yes ]]; then
    nmcli connection modify "$name" connection.autoconnect no
    changed "profile '$name' autoconnect -> no (kept, not deleted)"
  else ok "profile '$name' already not auto"; fi
done < <(nmcli -t -f NAME,TYPE,DEVICE connection show)

active=$(nmcli -g GENERAL.CONNECTION device show "$ETH_IFACE" 2>/dev/null || true)
if [[ $active != "$CON" ]] || was_changed "$CON "; then
  say "Bringing up $CON (fine if no cable is plugged in yet)"
  if nmcli connection up "$CON" >/dev/null 2>&1; then changed "activated $CON"; else
    echo "    note: $ETH_IFACE not up yet (no cable?). It comes up by itself when plugged into the show network."
  fi
else ok "$CON active on $ETH_IFACE"; fi

ip -4 -br addr show "$ETH_IFACE" || true
summary
