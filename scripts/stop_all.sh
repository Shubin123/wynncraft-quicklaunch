#!/usr/bin/env bash
# ==============================================================================
# Stop Wynncraft Price Dashboard and Bot Server
# Portable across macOS and Linux.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$REPO_DIR/logs"

# 1. Stop Bot Server
BOT_PID_FILE="$PID_DIR/bot_server.pid"
if [ -f "$BOT_PID_FILE" ]; then
  PID="$(cat "$BOT_PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping WynnBot server (PID: $PID)..."
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$BOT_PID_FILE"
fi
pkill -f "node.*wynn_bot_server.js" 2>/dev/null || true

# 2. Stop Price Server (if started by start_all.sh)
PRICE_PID_FILE="$PID_DIR/price_server.pid"
if [ -f "$PRICE_PID_FILE" ]; then
  PID="$(cat "$PRICE_PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping Price Dashboard (PID: $PID)..."
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$PRICE_PID_FILE"
fi

echo "✔ Servers stopped."
