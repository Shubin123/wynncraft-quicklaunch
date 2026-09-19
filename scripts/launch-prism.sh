#!/usr/bin/env bash
# Launch the managed instance directly, with the correct Prism data directory
# on Linux and macOS. Set PRISM_LAUNCHER_BIN to override binary discovery.
set -euo pipefail

INSTANCE_NAME="${INSTANCE_NAME:-Wynncraft-1.21.11}"
SERVER_ADDRESS="${SERVER_ADDRESS:-play.wynncraft.com}"

default_prism_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s/Library/Application Support/PrismLauncher\n' "$HOME" ;;
    *)
      if [[ -d "$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher" ]]; then
        printf '%s/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher\n' "$HOME"
      else
        printf '%s/.local/share/PrismLauncher\n' "$HOME"
      fi
      ;;
  esac
}

PRISM_DIR="${PRISM_DIR:-$(default_prism_dir)}"

if [[ -n "${PRISM_LAUNCHER_BIN:-}" ]]; then
  PRISM_BIN="$PRISM_LAUNCHER_BIN"
elif command -v prismlauncher >/dev/null 2>&1; then
  PRISM_BIN="$(command -v prismlauncher)"
elif [[ -x "/Applications/Prism Launcher.app/Contents/MacOS/Prism Launcher" ]]; then
  PRISM_BIN="/Applications/Prism Launcher.app/Contents/MacOS/Prism Launcher"
else
  echo "Prism Launcher was not found. Set PRISM_LAUNCHER_BIN to its executable path." >&2
  exit 1
fi

if [[ ! -f "$PRISM_DIR/instances/$INSTANCE_NAME/mmc-pack.json" ]]; then
  echo "Prism instance '$INSTANCE_NAME' is missing from $PRISM_DIR." >&2
  echo "Run scripts/install.sh first, or set PRISM_DIR to Prism's data directory." >&2
  exit 1
fi

exec "$PRISM_BIN" --dir "$PRISM_DIR" --launch "$INSTANCE_NAME" --server "$SERVER_ADDRESS"
