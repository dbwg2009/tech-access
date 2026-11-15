# Shared helpers for pi/*.sh. Source it; don't run it.
# shellcheck shell=bash

PI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.env
. "$PI_DIR/config.env"

CHANGES=()

say()     { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()      { printf '    ok: %s\n' "$*"; }
changed() { printf '    \033[33mchanged:\033[0m %s\n' "$*"; CHANGES+=("$*"); }
die()     { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run with sudo: sudo $0"; }

# Print what changed. Call at the end of every script.
summary() {
  echo
  if ((${#CHANGES[@]})); then
    say "$(basename "$0"): ${#CHANGES[@]} change(s)"
    printf '    - %s\n' "${CHANGES[@]}"
  else
    say "$(basename "$0"): nothing to change"
  fi
}

# install_file SRC DST MODE OWNER:GROUP. Copies only if content/mode/owner differ.
install_file() {
  local src=$1 dst=$2 mode=$3 owner=$4
  if [[ -f $dst ]] && cmp -s "$src" "$dst" \
     && [[ $(stat -c '%a %U:%G' "$dst") == "${mode#0} $owner" ]]; then
    ok "$dst"
  else
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dst"
    changed "$dst"
  fi
}

# write_file DST MODE OWNER:GROUP <<< content
write_file() {
  local tmp; tmp=$(mktemp)
  cat > "$tmp"
  install_file "$tmp" "$1" "$2" "$3"
  rm -f "$tmp"
}

apt_install() {
  local missing=()
  for p in "$@"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
  if ((${#missing[@]})); then
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
    changed "installed ${missing[*]}"
  else
    ok "packages present: $*"
  fi
}

ensure_dir() { # DIR MODE OWNER:GROUP
  if [[ -d $1 && $(stat -c '%a %U:%G' "$1") == "${2#0} $3" ]]; then ok "$1/"; else
    install -d -m "$2" -o "${3%%:*}" -g "${3##*:}" "$1"; changed "$1/"; fi
}

enable_now() { # UNIT
  if systemctl is-enabled -q "$1" 2>/dev/null && systemctl is-active -q "$1"; then ok "$1 enabled and running"; else
    systemctl enable --now "$1"; changed "enabled $1"; fi
}

# was_changed TEXT: true if a change containing TEXT was recorded in this run.
was_changed() { [[ " ${CHANGES[*]-} " == *"$1"* ]]; }
