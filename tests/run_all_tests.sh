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

# 2. Viewer wire check: what the browser actually receives on the socket
node "$REPO_DIR/mineflayer-wynn/tests/test_viewer_wire.js"

# 3. Shared dashboard data layer (selection, links, formatters)
node "$SCRIPT_DIR/test_wynn_client.js"

# 4. Draggable panel layout (grid maths and DOM behaviour)
node "$SCRIPT_DIR/test_wynn_layout.js"

# 5. Prism account lock (module behaviour and HTTP surface)
node "$REPO_DIR/mineflayer-wynn/tests/test_account_lock.js"
node "$SCRIPT_DIR/test_account_api.js"

# 6. Viewer character-tracking overlay (helpers, install, and rendering)
node "$REPO_DIR/mineflayer-wynn/tests/test_viewer_overlay.js"
node "$REPO_DIR/mineflayer-wynn/tests/test_viewer_overlay_render.js"

# 7. Trade Market controller (no running server needed)
node "$REPO_DIR/mineflayer-wynn/tests/test_market.js"

# 8. Inventory / chest pane (helpers and rendering against a DOM stub)
node "$SCRIPT_DIR/test_inventory_pane.js"
node "$SCRIPT_DIR/test_inventory_render.js"

# 9. Bridge contract: both sides held to tests/contracts/market_listing.v1.json
node "$SCRIPT_DIR/test_bridge_contract.js"
"${PYTHON_BIN}" "$SCRIPT_DIR/test_bridge_contract.py"

# 10. Trade journal: idempotency across a restart, reconciliation
node "$SCRIPT_DIR/test_trade_journal.js"

# 11. Round trip: read -> decide -> trade -> confirm, against a stand-in game
node "$SCRIPT_DIR/test_round_trip.js"

# 12. Translation properties and boundary fuzzing
node "$SCRIPT_DIR/test_translation_properties.js"

# 13. Protocol harness: a real bot, a real server, the real wire
node "$SCRIPT_DIR/test_protocol_harness.js"

# 14. Trade record over HTTP: pending intents and reconciliation
node "$SCRIPT_DIR/test_trades_api.js"

# 15. Phase 1 market recorder: schema, dedupe, derived liquidity
"${PYTHON_BIN}" "$SCRIPT_DIR/test_market_log.py"

# 16. Roll model: per-attribute RNG, percentile, and roll-aware pricing
"${PYTHON_BIN}" "$SCRIPT_DIR/test_roll_model.py"

# 17. Training pipeline: runs, labels its calibration, beats the roll-blind model
"${PYTHON_BIN}" "$SCRIPT_DIR/test_training.py"

# 18. Trade engine: features, neural net, GA, delta pipeline
"${PYTHON_BIN}" "$SCRIPT_DIR/test_trade_engine.py"

# 19. Trade engine HTTP endpoints (starts a throwaway price server)
"${PYTHON_BIN}" "$SCRIPT_DIR/test_trade_api.py"

# 20. Module Tests
node "$SCRIPT_DIR/test_module.js"

# 21. Integration Tests
node "$SCRIPT_DIR/test_integration.js"

# 22. E2E Tests
node "$SCRIPT_DIR/test_e2e.js"

echo "=================================================="
echo "  ALL TEST SUITES PASSED SUCCESSFULLY              "
echo "=================================================="
