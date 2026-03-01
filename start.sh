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

if command -v lsof >/dev/null 2>&1; then
  LISTENER_INFO="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$LISTENER_INFO" ]]; then
    echo "Error: port $PORT is already in use."
    echo
    echo "$LISTENER_INFO"
    echo
    echo "How to fix:"
    echo "  1) Stop the process that is listening on port $PORT."
    echo "  2) Or set a different PORT in .env, then run ./start.sh again."
    exit 1
  fi
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
if [[ -n "${CHATJIMMY_TOP_K:-}" ]]; then
  echo "Default topK: $CHATJIMMY_TOP_K"
else
  echo "Default topK: upstream default"
fi
echo "Models cache TTL: ${MODELS_CACHE_TTL_MS:-30000} ms"
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
