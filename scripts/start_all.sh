#!/usr/bin/env bash
# Start the unified dashboard and bot service in the foreground.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_PATH_PARTS=(
  "$REPO_DIR/scripts"
  "$REPO_DIR/mineflayer-wynn/node_modules"
  "$REPO_DIR/node_modules"
  "$HOME/mineflayer-wynn/node_modules"
  "$HOME/.npm-global/lib/node_modules"
  "/opt/homebrew/lib/node_modules"
  "/usr/local/lib/node_modules"
)
export NODE_PATH="$(IFS=:; echo "${NODE_PATH_PARTS[*]}")"

echo "==> Starting unified Node service on port 8123 (foreground)..."
echo "Open Dashboard in your browser: http://localhost:8123/bot.html"
exec node "$REPO_DIR/scripts/wynn_bot_server.js"
