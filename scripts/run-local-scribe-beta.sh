#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
api_host="127.0.0.1"
api_port="${COSMANEURA_SCRIBE_BETA_API_PORT:-8021}"
ui_host="127.0.0.1"
ui_port="${COSMANEURA_SCRIBE_BETA_UI_PORT:-5174}"
tenant_id="00000000-0000-4000-8000-000000000029"
api_pid=""
ui_pid=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_port() {
  case "$2" in
    ''|*[!0-9]*)
      printf '%s must be an integer port.\n' "$1" >&2
      exit 1
      ;;
  esac
  if [ "$2" -lt 1024 ] || [ "$2" -gt 65535 ]; then
    printf '%s must be between 1024 and 65535.\n' "$1" >&2
    exit 1
  fi
}

cleanup() {
  exit_status=$?
  trap - EXIT INT TERM
  for child_pid in "$api_pid" "$ui_pid"; do
    if [ -n "$child_pid" ] && kill -0 "$child_pid" >/dev/null 2>&1; then
      kill "$child_pid" >/dev/null 2>&1 || true
    fi
  done
  for child_pid in "$api_pid" "$ui_pid"; do
    if [ -n "$child_pid" ]; then
      wait "$child_pid" >/dev/null 2>&1 || true
    fi
  done
  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 0' INT TERM

require_command uv
require_command node
require_command npm
require_command curl
require_port COSMANEURA_SCRIBE_BETA_API_PORT "$api_port"
require_port COSMANEURA_SCRIBE_BETA_UI_PORT "$ui_port"

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -ne 24 ]; then
  printf 'Local Scribe Beta requires Node 24; found Node %s.\n' "$(node --version)" >&2
  exit 1
fi
npm_version="$(npm --version)"
if [ "$npm_version" != "11.5.2" ]; then
  printf 'Local Scribe Beta requires npm 11.5.2; found npm %s.\n' "$npm_version" >&2
  exit 1
fi

cd "$repo_root"

uv run uvicorn \
  cosmaneura_scribe.beta_preview_host:create_local_beta_preview_app \
  --factory \
  --app-dir services/api/src \
  --host "$api_host" \
  --port "$api_port" \
  --no-access-log &
api_pid=$!

api_ready="false"
for _attempt in $(seq 1 50); do
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    wait "$api_pid" || exit $?
    printf 'The local Beta API stopped during startup.\n' >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 "http://${api_host}:${api_port}/healthz" >/dev/null; then
    api_ready="true"
    break
  fi
  sleep 0.1
done
if [ "$api_ready" != "true" ]; then
  printf 'The local Beta API did not become ready.\n' >&2
  exit 1
fi

VITE_BETA_TENANT_ID="$tenant_id" \
SCRIBE_BETA_API_ORIGIN="http://${api_host}:${api_port}" \
npm run dev --workspace @cosmaneura-scribe/review-ui -- \
  --host "$ui_host" \
  --port "$ui_port" \
  --strictPort &
ui_pid=$!

printf '\nScribe Beta is starting at http://%s:%s\n' "$ui_host" "$ui_port"
printf 'Synthetic local data only. Nothing is published. Press Ctrl-C to stop.\n\n'

while kill -0 "$api_pid" >/dev/null 2>&1 && kill -0 "$ui_pid" >/dev/null 2>&1; do
  sleep 1
done

if ! kill -0 "$api_pid" >/dev/null 2>&1; then
  wait "$api_pid" || exit $?
  printf 'The local Beta API stopped unexpectedly.\n' >&2
else
  wait "$ui_pid" || exit $?
  printf 'The local Beta review UI stopped unexpectedly.\n' >&2
fi
exit 1
