#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not in PATH."
  exit 1
fi

DISPLAY_HOST="$HOST"
if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
  DISPLAY_HOST="127.0.0.1"
fi

BASE_URL="http://${DISPLAY_HOST}:${PORT}"
API_BASE="${BASE_URL}/v1"

echo "========================================"
echo "chatjimmy OpenAI Proxy"
echo "========================================"
echo "Bind Host : $HOST"
echo "Port      : $PORT"
echo "API Base  : $API_BASE"
echo "Health    : $BASE_URL/healthz"
echo
echo "Available API paths:"
echo "  GET  /v1/models"
echo "  GET  /v1/models/{id}"
echo "  POST /v1/chat/completions"
echo
if [[ -n "${PROXY_API_KEY:-}" ]]; then
  echo "Auth      : Enabled (Authorization: Bearer <PROXY_API_KEY>)"
else
  echo "Auth      : Disabled"
fi
echo "========================================"
echo
echo "Starting server..."
exec node "$SCRIPT_DIR/src/server.js"
