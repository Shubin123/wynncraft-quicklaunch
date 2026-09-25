#!/usr/bin/env bash
# Stable, short entrypoint for the daily MySQL backup.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/linux_mysql_backup.sh" "$@"
