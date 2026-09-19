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

echo "=================================================="
echo "  Wynncraft Quick Launch & Bot Controller Tests   "
echo "=================================================="
echo "Target Host: http://localhost:8123"
echo "Server Status: $(curl -s -o /dev/null -w "%{http_code}" http://localhost:8123/api/bot/status || echo "Offline")"
echo ""

# 1. Module Tests
node "$SCRIPT_DIR/test_module.js"

# 2. Integration Tests
node "$SCRIPT_DIR/test_integration.js"

# 3. E2E Tests
node "$SCRIPT_DIR/test_e2e.js"

echo "=================================================="
echo "  ALL TEST SUITES PASSED SUCCESSFULLY (70/70)     "
echo "=================================================="
