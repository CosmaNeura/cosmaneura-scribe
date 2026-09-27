#!/usr/bin/env bash
set -euo pipefail

profile="${1:-}"
case "$profile" in
  burst)
    users="${SCRIBE_LOAD_USERS:-75}"
    spawn_rate="${SCRIBE_LOAD_SPAWN_RATE:-75}"
    duration="${SCRIBE_LOAD_DURATION:-2m}"
    ;;
  soak)
    users="${SCRIBE_LOAD_USERS:-15}"
    spawn_rate="${SCRIBE_LOAD_SPAWN_RATE:-3}"
    duration="${SCRIBE_LOAD_DURATION:-90m}"
    ;;
  *)
    echo "usage: $0 {burst|soak}" >&2
    exit 2
    ;;
esac

exec uv run locust \
  --locustfile tests/load/locustfile.py \
  --headless \
  --host http://127.0.0.1:4175 \
  --users "$users" \
  --spawn-rate "$spawn_rate" \
  --run-time "$duration" \
  --only-summary
