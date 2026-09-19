#!/usr/bin/env bash
# Sets up a Prism Launcher instance for Wynncraft with Wynntils + Wynnventory,
# and a desktop entry that launches straight into play.wynncraft.com.
set -euo pipefail

OS="$(uname -s)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Detect Prism Launcher directory per OS
if [ -n "${PRISM_DIR:-}" ]; then
  PRISM_DIR="$PRISM_DIR"
elif [ "$OS" = "Darwin" ]; then
  PRISM_DIR="$HOME/Library/Application Support/PrismLauncher"
else
  # Linux candidates (XDG standard or Flatpak)
  if [ -d "$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher" ]; then
    PRISM_DIR="$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher"
  else
    PRISM_DIR="$HOME/.local/share/PrismLauncher"
  fi
fi

INSTANCE_NAME="Wynncraft-1.21.11"
INSTANCE_DIR="$PRISM_DIR/instances/$INSTANCE_NAME"
MODS_DIR="$INSTANCE_DIR/minecraft/mods"

# Detect Prism Launcher executable
PRISM_BIN=""
if command -v prismlauncher >/dev/null 2>&1; then
  PRISM_BIN="prismlauncher"
elif [ "$OS" = "Darwin" ]; then
  if [ -x "/Applications/Prism Launcher.app/Contents/MacOS/Prism Launcher" ]; then
    PRISM_BIN="/Applications/Prism Launcher.app/Contents/MacOS/Prism Launcher"
  elif [ -x "/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher" ]; then
    PRISM_BIN="/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher"
  elif [ -x "/opt/homebrew/bin/prismlauncher" ]; then
    PRISM_BIN="/opt/homebrew/bin/prismlauncher"
  elif [ -x "/usr/local/bin/prismlauncher" ]; then
    PRISM_BIN="/usr/local/bin/prismlauncher"
  fi
fi

if [ -z "$PRISM_BIN" ]; then
  if [ "$OS" = "Darwin" ]; then
    echo "Prism Launcher not found. Install it via Homebrew: 'brew install --cask prismlauncher' or download from https://prismlauncher.org" >&2
  else
    echo "Prism Launcher not found on PATH. Install it first (e.g. 'pacman -S prismlauncher' or via Flatpak)." >&2
  fi
  echo "Proceeding with directory and mod setup anyway..."
fi

echo "==> Creating instance at $INSTANCE_DIR"
mkdir -p "$MODS_DIR"

echo "==> Copying instance config"
cp "$REPO_DIR/instance/mmc-pack.json" "$INSTANCE_DIR/mmc-pack.json"
cp "$REPO_DIR/instance/instance.cfg" "$INSTANCE_DIR/instance.cfg"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to read the pinned mod manifest." >&2
  exit 1
fi

sha512_file() {
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum "$1" | awk '{print $1}'
  else
    shasum -a 512 "$1" | awk '{print $1}'
  fi
}

echo "==> Downloading and verifying pinned Fabric mods (Minecraft 1.21.11)"
while IFS=$'\t' read -r mod_id filename url expected_sha512; do
  target="$MODS_DIR/$filename"
  temp_file="$(mktemp "$MODS_DIR/.${mod_id}.XXXXXX")"
  echo "    - $mod_id"
  if ! curl --fail --location --retry 3 --connect-timeout 15 --silent --show-error \
      --output "$temp_file" "$url"; then
    rm -f "$temp_file"
    echo "Failed to download $mod_id." >&2
    exit 1
  fi
  actual_sha512="$(sha512_file "$temp_file")"
  if [[ "$actual_sha512" != "$expected_sha512" ]]; then
    rm -f "$temp_file"
    echo "Checksum mismatch for $mod_id; refusing to install it." >&2
    exit 1
  fi
  mv "$temp_file" "$target"

  # Earlier versions of this installer used stable generic filenames. Remove
  # only that installer-owned legacy file once its verified replacement exists;
  # custom user-installed mods are left untouched.
  legacy_file="$MODS_DIR/$mod_id.jar"
  if [[ "$legacy_file" != "$target" && -f "$legacy_file" ]]; then
    rm -f "$legacy_file"
    echo "      removed legacy installer copy: $(basename "$legacy_file")"
  fi
done < <(python3 - "$REPO_DIR/instance/mods.json" <<'PY'
import json
import sys

for mod in json.load(open(sys.argv[1], encoding="utf-8"))["mods"]:
    print("\t".join((mod["id"], mod["filename"], mod["url"], mod["sha512"])))
PY
)

# Install Desktop Quick-Launch per OS
if [ "$OS" = "Darwin" ]; then
  echo "==> Creating macOS quick-launch shortcut on Desktop"
  SHORTCUT="$HOME/Desktop/Wynncraft Quicklaunch.command"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'export PRISM_DIR=%q\n' "$PRISM_DIR"
    printf 'exec %q\n' "$REPO_DIR/scripts/launch-prism.sh"
  } > "$SHORTCUT"
  chmod +x "$SHORTCUT"
  echo "    Created $SHORTCUT"
else
  echo "==> Installing Linux quick-launch desktop entry"
  mkdir -p "$HOME/.local/share/applications"
  cp "$REPO_DIR/desktop/wynncraft-quicklaunch.desktop" "$HOME/.local/share/applications/"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi

echo "==> Setting up Mineflayer Wynncraft Web Bot dependencies"
if [ -d "$REPO_DIR/mineflayer-wynn" ]; then
  echo "    Mineflayer dependencies are installed by scripts/setup.sh (Node 22+ required)."
  echo "    For a direct installation, run: (cd mineflayer-wynn && npm ci)"
fi

if [ -f "$REPO_DIR/requirements.txt" ]; then
  echo "    Python dependencies are installed into .venv by scripts/setup.sh."
fi

chmod +x "$REPO_DIR/scripts/wynn_bot_server.js" "$REPO_DIR/scripts/launch_mineflayer.sh" 2>/dev/null || true

cat <<EOF

Done! Setup complete for $OS.

Next steps:
  1. Open Prism Launcher once and select "$INSTANCE_NAME" so it downloads
     the actual Minecraft/Fabric Loader files and you can accept the Mojang EULA.
  2. Launch via:
EOF

if [ "$OS" = "Darwin" ]; then
  echo "     - Double-clicking '~/Desktop/Wynncraft Quicklaunch.command', or:"
  echo "     - \"$PRISM_BIN\" -l \"$INSTANCE_NAME\" -s play.wynncraft.com"
else
  echo "     - The 'Wynncraft (Quick Launch)' app entry in your app launcher, or:"
  echo "     - prismlauncher -l \"$INSTANCE_NAME\" -s play.wynncraft.com"
fi
echo "     This skips the launcher UI and joins play.wynncraft.com directly."
