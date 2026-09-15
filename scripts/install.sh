#!/usr/bin/env bash
# Sets up a Prism Launcher instance for Wynncraft with Wynntils + Wynnventory,
# and a desktop entry that launches straight into play.wynncraft.com.
set -euo pipefail

PRISM_DIR="${PRISM_DIR:-$HOME/.local/share/PrismLauncher}"
INSTANCE_NAME="Wynncraft-1.21.11"
INSTANCE_DIR="$PRISM_DIR/instances/$INSTANCE_NAME"
MODS_DIR="$INSTANCE_DIR/minecraft/mods"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v prismlauncher >/dev/null 2>&1; then
  echo "Prism Launcher not found on PATH. Install it first (e.g. 'pacman -S prismlauncher')." >&2
  exit 1
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

echo "==> Installing quick-launch desktop entry"
mkdir -p "$HOME/.local/share/applications"
cp "$REPO_DIR/desktop/wynncraft-quicklaunch.desktop" "$HOME/.local/share/applications/"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

cat <<EOF

Done.

Next steps:
  1. Open Prism Launcher once and select "$INSTANCE_NAME" so it downloads
     the actual Minecraft/Fabric Loader files and you can accept the Mojang EULA.
  2. After that, launch via the "Wynncraft (Quick Launch)" app entry, or:
       prismlauncher -l "$INSTANCE_NAME" -s play.wynncraft.com
     This skips the launcher UI and joins the server directly.
EOF
