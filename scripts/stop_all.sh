#!/usr/bin/env bash
# Stop the unified dashboard and bot service.
set -euo pipefail

pkill -f "node.*wynn_bot_server.js" 2>/dev/null || true
pkill -f "python3.*wynn_price_server.py" 2>/dev/null || true
echo "✔ Unified server stopped."
