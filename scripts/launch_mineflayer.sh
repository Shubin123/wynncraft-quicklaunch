#!/usr/bin/env bash
# Launch the Mineflayer bot linked to the Wynncraft Prism Launcher instance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Prioritize repo-local and user binary paths across macOS and Linux
export PATH="$REPO_DIR/mineflayer-wynn/bin:$HOME/mineflayer-wynn/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "==> Starting Mineflayer Wynncraft bot (linked to Prism Wynn instance)..."
mineflayer-wynn run "$@"
