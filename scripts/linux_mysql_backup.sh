#!/usr/bin/env bash
# Daily Linux backup: mirrors local Wynn JSONL records to the RDS MySQL table.
# Keep key.text beside this repository (never commit it); it contains only the
# MySQL password, one line, and should be chmod 600.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The public Gist may be downloaded anywhere. Prefer an explicit repository,
# then common locations, rather than assuming this file lives in scripts/.
REPO_DIR=""
for candidate in "${WYNN_REPO_DIR:-}" "$PWD" "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$HOME/wynncraft-quicklaunch"; do
  if [[ -n "$candidate" && -f "$candidate/scripts/mysql_backfill.js" ]]; then
    REPO_DIR="$(cd "$candidate" && pwd)"
    break
  fi
done
if [[ -z "$REPO_DIR" ]]; then
  echo 'Cannot find scripts/mysql_backfill.js. Clone the project and set WYNN_REPO_DIR=/path/to/wynncraft-quicklaunch.' >&2
  exit 1
fi
# Preserve the existing standalone convention: key.text is resolved from the
# directory from which the script is invoked, unless explicitly overridden.
KEY_FILE="${WYNN_MYSQL_PASSWORD_FILE:-$PWD/key.text}"
CA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wynn-dashboard"
CA_FILE="${WYNN_MYSQL_SSL_CA:-$CA_DIR/us-east-2-rds-ca.pem}"

: "${WYNN_MYSQL_HOST:=csc370db.c940y2gqws8x.us-east-2.rds.amazonaws.com}"
: "${WYNN_MYSQL_PORT:=3306}"
: "${WYNN_MYSQL_USER:=admin}"
: "${WYNN_MYSQL_DATABASE:=wynn_dashboard}"

if [[ ! -r "$KEY_FILE" ]]; then
  echo "MySQL password file is missing or unreadable: $KEY_FILE" >&2
  exit 1
fi
if [[ ! -s "$KEY_FILE" ]]; then
  echo "MySQL password file is empty: $KEY_FILE" >&2
  exit 1
fi

mkdir -p "$CA_DIR"
chmod 700 "$CA_DIR"
if [[ ! -s "$CA_FILE" ]]; then
  curl --fail --silent --show-error --location \
    'https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem' \
    --output "$CA_FILE"
  chmod 600 "$CA_FILE"
fi

export WYNN_MYSQL_HOST WYNN_MYSQL_PORT WYNN_MYSQL_USER WYNN_MYSQL_DATABASE
export WYNN_MYSQL_SSL_CA="$CA_FILE"
export WYNN_MYSQL_PASSWORD_FILE="$KEY_FILE"
exec node "$REPO_DIR/scripts/mysql_backfill.js"
