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
  if [ -x "/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher" ]; then
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

MODS=(
  "fabric-api|https://cdn.modrinth.com/data/P7dR8mSH/versions/6qAuTtLR/fabric-api-0.141.6%2B1.21.11.jar"
  "cloth-config|https://cdn.modrinth.com/data/9s6osm5g/versions/xuX40TN5/cloth-config-21.11.153-fabric.jar"
  "modmenu|https://cdn.modrinth.com/data/mOgUt4GM/versions/j2vTurvl/modmenu-17.0.1-beta.1.jar"
  "wynntils|https://cdn.modrinth.com/data/dU5Gb9Ab/versions/c0EUB5Np/wynntils-4.2.11-fabric%2BMC-1.21.11.jar"
  "wynnventory|https://cdn.modrinth.com/data/CORVJbiT/versions/pOBUOPAI/wynnventory-2.2.4-fabric-1.21.11.jar"
)

echo "==> Downloading mods (Minecraft 1.21.11, Fabric)"
for entry in "${MODS[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  echo "    - $name"
  curl -sL -o "$MODS_DIR/$name.jar" "$url"
done

# Install Desktop Quick-Launch per OS
if [ "$OS" = "Darwin" ]; then
  echo "==> Creating macOS quick-launch shortcut on Desktop"
  SHORTCUT="$HOME/Desktop/Wynncraft Quicklaunch.command"
  cat > "$SHORTCUT" << 'MACOSEOF'
#!/usr/bin/env bash
# macOS Quick-Launch straight into play.wynncraft.com
PRISM_BIN="prismlauncher"
if ! command -v prismlauncher >/dev/null 2>&1; then
  if [ -x "/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher" ]; then
    PRISM_BIN="/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher"
  elif [ -x "/opt/homebrew/bin/prismlauncher" ]; then
    PRISM_BIN="/opt/homebrew/bin/prismlauncher"
  fi
fi
"$PRISM_BIN" -l "Wynncraft-1.21.11" -s play.wynncraft.com
MACOSEOF
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
  echo "    Installing local dependencies in mineflayer-wynn..."
  (cd "$REPO_DIR/mineflayer-wynn" && npm install --no-audit --no-fund) || true
fi

if [ -f "$REPO_DIR/requirements.txt" ] && command -v pip3 >/dev/null 2>&1; then
  echo "    Installing Python dependencies (Pillow)..."
  pip3 install -q -r "$REPO_DIR/requirements.txt" || true
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

