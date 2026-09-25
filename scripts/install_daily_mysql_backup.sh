#!/usr/bin/env bash
# Install a per-user systemd timer that runs linux_mysql_backup.sh every day.
set -Eeuo pipefail
if ! command -v systemctl >/dev/null; then
  echo 'systemd is required for this installer.' >&2
  exit 1
fi
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/wynn-mysql-backup.service" <<EOF
[Unit]
Description=Back up Wynncraft Quicklaunch data to MySQL

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/scripts/linux_mysql_backup.sh
EOF
cat > "$UNIT_DIR/wynn-mysql-backup.timer" <<'EOF'
[Unit]
Description=Run Wynncraft MySQL backup daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now wynn-mysql-backup.timer
systemctl --user list-timers wynn-mysql-backup.timer
