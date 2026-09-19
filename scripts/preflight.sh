#!/usr/bin/env bash
# Read-only environment checks for the local Prism instance and optional Node
# utilities. It never creates an account, launches Minecraft, or connects a bot.
set -euo pipefail

with_node=false
if [[ "${1:-}" == "--node" ]]; then
  with_node=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--node]" >&2
  exit 64
fi

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "OK: $*"; }

case "$(uname -s)" in
  Darwin) default_prism_dir="$HOME/Library/Application Support/PrismLauncher" ;;
  *)
    if [[ -d "$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher" ]]; then
      default_prism_dir="$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher"
    else
      default_prism_dir="$HOME/.local/share/PrismLauncher"
    fi
    ;;
esac
prism_dir="${PRISM_DIR:-$default_prism_dir}"
instance_name="${INSTANCE_NAME:-Wynncraft-1.21.11}"

if [[ -f "$prism_dir/instances/$instance_name/mmc-pack.json" ]]; then
  pass "Prism instance exists at $prism_dir/instances/$instance_name"
else
  fail "Prism instance '$instance_name' is absent from $prism_dir (run scripts/install.sh)."
fi

if command -v java >/dev/null 2>&1; then
  java_version="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')"
  if [[ -n "$java_version" && "$java_version" -ge 21 ]]; then
    pass "Java $java_version is suitable for Minecraft 1.21.11"
  else
    fail "Java 21 or newer is required for Minecraft 1.21.11 (found ${java_version:-unknown})."
  fi
else
  fail "Java 21+ is not available on PATH."
fi

if command -v prismlauncher >/dev/null 2>&1 || [[ -x "/Applications/Prism Launcher.app/Contents/MacOS/Prism Launcher" ]]; then
  pass "Prism Launcher executable found"
else
  fail "Prism Launcher executable was not found (set PRISM_LAUNCHER_BIN when launching if necessary)."
fi

if "$with_node"; then
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$node_major" -ge 22 ]]; then
      pass "Node $(node --version) meets Mineflayer's Node 22+ requirement"
    else
      fail "Mineflayer 4.39.0 requires Node 22+ (found $(node --version))."
    fi
  else
    fail "Node 22+ is required for the optional Mineflayer offline check."
  fi
fi

[[ "$failures" -eq 0 ]] || exit 1
