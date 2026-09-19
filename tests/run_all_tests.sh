#!/usr/bin/env bash
# Runs all module, integration, and end-to-end tests for Wynncraft Quick Launch & Bot Controller
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Assemble cross-platform NODE_PATH candidates (repo local, macOS Homebrew, Linux npm-global)
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

# Prefer the project venv (Pillow lives there on macOS/Homebrew Python).
if [[ -x "$REPO_DIR/.venv/bin/python3" ]]; then
  PYTHON_BIN="$REPO_DIR/.venv/bin/python3"
else
  PYTHON_BIN="python3"
fi

echo "=================================================="
echo "  Wynncraft Quick Launch & Bot Controller Tests   "
echo "=================================================="
echo "Target Host: http://localhost:8123"
echo "Server Status: $(curl -s -o /dev/null -w "%{http_code}" http://localhost:8123/api/bot/status || echo "Offline")"
echo ""

# 1. Mineflayer viewer block-state translation (no running server needed)
node "$REPO_DIR/mineflayer-wynn/tests/test_viewer.js"

# 2. Trade Market controller (no running server needed)
node "$REPO_DIR/mineflayer-wynn/tests/test_market.js"

# 3. Inventory / chest pane (helpers and rendering against a DOM stub)
node "$SCRIPT_DIR/test_inventory_pane.js"
node "$SCRIPT_DIR/test_inventory_render.js"

# 4. Trade engine: features, neural net, GA, delta pipeline
"${PYTHON_BIN}" "$SCRIPT_DIR/test_trade_engine.py"

# 5. Trade engine HTTP endpoints (starts a throwaway price server)
"${PYTHON_BIN}" "$SCRIPT_DIR/test_trade_api.py"

# 6. Module Tests
node "$SCRIPT_DIR/test_module.js"

# 7. Integration Tests
node "$SCRIPT_DIR/test_integration.js"

# 8. E2E Tests
node "$SCRIPT_DIR/test_e2e.js"

echo "=================================================="
echo "  ALL TEST SUITES PASSED SUCCESSFULLY              "
echo "=================================================="
