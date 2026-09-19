#!/usr/bin/env bash
# ==============================================================================
# Start both Wynncraft Price Dashboard (Port 8123) and Bot Server (Port 8124)
# Portable across macOS and Linux.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
PID_DIR="$REPO_DIR/logs"

mkdir -p "$LOG_DIR"

# Assemble cross-platform NODE_PATH candidates
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

# 1. Start Bot Server (Port 8124)
BOT_PID_FILE="$PID_DIR/bot_server.pid"
if [ -f "$BOT_PID_FILE" ] && kill -0 "$(cat "$BOT_PID_FILE")" 2>/dev/null; then
  echo "✔ WynnBot server is already running (PID: $(cat "$BOT_PID_FILE"))"
else
  echo "==> Starting WynnBot server on port 8124..."
  nohup node "$REPO_DIR/scripts/wynn_bot_server.js" > "$LOG_DIR/bot_server.log" 2>&1 &
  echo $! > "$BOT_PID_FILE"
  echo "✔ Started WynnBot server (PID: $(cat "$BOT_PID_FILE"))"
fi

# 2. Start Price & Dashboard Server (Port 8123)
PRICE_PID_FILE="$PID_DIR/price_server.pid"
# Check if port 8123 is already held (e.g. systemd service on Linux)
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8123/api/bot/status 2>/dev/null; then
  echo "✔ Price Dashboard proxy is already listening on port 8123"
elif [ -f "$PRICE_PID_FILE" ] && kill -0 "$(cat "$PRICE_PID_FILE")" 2>/dev/null; then
  echo "✔ Price Dashboard is already running (PID: $(cat "$PRICE_PID_FILE"))"
else
  echo "==> Starting Price Dashboard on port 8123..."
  nohup python3 "$REPO_DIR/scripts/wynn_price_server.py" > "$LOG_DIR/price_server.log" 2>&1 &
  echo $! > "$PRICE_PID_FILE"
  echo "✔ Started Price Dashboard (PID: $(cat "$PRICE_PID_FILE"))"
fi

# Wait up to 5s for endpoints to respond
echo "==> Waiting for servers to initialize..."
sleep 2

BOT_OK=false
DASH_OK=false
for i in {1..5}; do
  if curl -s http://localhost:8124/api/bot/status >/dev/null 2>&1; then
    BOT_OK=true
  fi
  if curl -s http://localhost:8123/api/bot/status >/dev/null 2>&1; then
    DASH_OK=true
  fi
  if [ "$BOT_OK" = true ] && [ "$DASH_OK" = true ]; then
    break
  fi
  sleep 1
done

echo ""
echo "Server Status:"
echo "  • Bot Server (Port 8124):  $([ "$BOT_OK" = true ] && echo "🟢 Online" || echo "🟡 Initializing")"
echo "  • Dashboard (Port 8123):   $([ "$DASH_OK" = true ] && echo "🟢 Online" || echo "🟡 Initializing")"
echo ""
echo "Open Dashboard in your browser:"
echo "  👉 http://localhost:8123/bot.html"
echo ""
