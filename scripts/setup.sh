#!/usr/bin/env bash
# ==============================================================================
# Wynncraft Quicklaunch & Mineflayer Web Bot — Universal Setup Script
# Works on macOS (Apple Silicon / Intel) and Linux.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"

echo "=================================================================="
echo "  Wynncraft Quicklaunch & Bot Controller — Universal Setup        "
echo "  Platform: $OS ($ARCH)                                           "
echo "=================================================================="
echo ""

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed."
  if [ "$OS" = "Darwin" ]; then
    echo "   Install via Homebrew: brew install node"
  else
    echo "   Install via your package manager (e.g. pacman -S nodejs npm, apt install nodejs npm)."
  fi
  exit 1
fi
NODE_VER="$(node -v)"
NODE_MAJOR="${NODE_VER#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Node.js 22 or newer is required by Mineflayer 4.39.0 (found $NODE_VER)."
  if [ "$OS" = "Darwin" ]; then
    echo "   Upgrade via Homebrew: brew install node"
  else
    echo "   Upgrade Node.js through your package manager or a supported Node version manager."
  fi
  exit 1
fi
echo "✔ Node.js: $NODE_VER"

# 2. Check Python 3
if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ Python 3 is not installed."
  if [ "$OS" = "Darwin" ]; then
    echo "   Install via Homebrew: brew install python"
  else
    echo "   Install via your package manager."
  fi
  exit 1
fi
PY_VER="$(python3 --version)"
echo "✔ Python: $PY_VER"

# 3. Check Prism Launcher
PRISM_DETECTED=false
if command -v prismlauncher >/dev/null 2>&1; then
  PRISM_DETECTED=true
elif [ "$OS" = "Darwin" ]; then
  if [ -d "/Applications/Prism Launcher.app" ]; then
    PRISM_DETECTED=true
  fi
fi

if [ "$PRISM_DETECTED" = true ]; then
  echo "✔ Prism Launcher: Detected"
else
  echo "⚠️ Prism Launcher not found."
  if [ "$OS" = "Darwin" ]; then
    echo "   Recommended: brew install --cask prismlauncher"
    echo "   Or download DMG from https://prismlauncher.org"
  else
    echo "   Install via your package manager (e.g. pacman -S prismlauncher, or Flatpak)."
  fi
  echo "   (Setup will still configure instance files and web components)"
fi
echo ""

# 4. Install Node dependencies
echo "==> [1/4] Installing Node.js bot dependencies..."
if [ -d "$REPO_DIR/mineflayer-wynn" ]; then
  (cd "$REPO_DIR/mineflayer-wynn" && npm ci --no-audit --no-fund)
fi
echo "✔ Node dependencies installed."
echo ""

# 5. Install Python dependencies
echo "==> [2/4] Installing Python dependencies (Pillow)..."
if [ -f "$REPO_DIR/requirements.txt" ]; then
  VENV_DIR="${VENV_DIR:-$REPO_DIR/.venv}"
  if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "    Creating repository virtual environment at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
  fi
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet
  "$VENV_DIR/bin/python" -m pip install --quiet -r "$REPO_DIR/requirements.txt"
fi
echo "✔ Python dependencies installed."
echo ""

# 6. Configure Prism Launcher instance & Fabric mods
echo "==> [3/4] Configuring Wynncraft Prism Launcher instance & Fabric mods..."
bash "$REPO_DIR/scripts/install.sh"
echo ""

# 7. Apply Wynncraft Textures to 3D Viewer
echo "==> [4/4] Deploying official Wynncraft textures to 3D viewer..."
if [ -f "$REPO_DIR/assets/wynnpack/wynn_rp.zip" ]; then
  PYTHON_FOR_TEXTURES="${VENV_DIR:-$REPO_DIR/.venv}/bin/python"
  if [ ! -x "$PYTHON_FOR_TEXTURES" ]; then
    PYTHON_FOR_TEXTURES="python3"
  fi
  "$PYTHON_FOR_TEXTURES" "$REPO_DIR/scripts/apply_wynn_textures.py" || echo "⚠️ Textures deployment completed with warnings."
else
  echo "ℹ️ assets/wynnpack/wynn_rp.zip not found; skipping viewer texture pack."
fi
echo ""

# Make helper scripts executable
chmod +x "$REPO_DIR/scripts/"*.sh "$REPO_DIR/scripts/"*.js "$REPO_DIR/scripts/"*.py 2>/dev/null || true

echo "=================================================================="
echo "  🎉 Setup Complete for $OS!                                      "
echo "=================================================================="
echo ""
echo "Quick Commands:"
echo "  • Start servers (Port 8123 & 8124):  bash scripts/start_all.sh"
echo "  • Stop servers:                     bash scripts/stop_all.sh"
echo "  • Open Web Dashboard:               http://localhost:8123/bot.html"
echo "  • Run Test Suite (68/68):           bash tests/run_all_tests.sh"
echo ""
