#!/usr/bin/env bash
# Required entry point for this package's `swift test`.
# Default hard limit: 600 seconds (10 minutes). Override with
# PCM_SWIFT_TEST_TIMEOUT_SECONDS. Mac proof runs must also sit inside an
# outer timeout (suite timeLimit / host watchdog); this script is not enough
# alone if the host ignores process-group signals.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LIMIT_SECONDS="${PCM_SWIFT_TEST_TIMEOUT_SECONDS:-600}"
TIMEOUT_FLAG="$(mktemp -t pcm-swift-test-timeout.XXXXXX)"
trap 'rm -f "${TIMEOUT_FLAG}"' EXIT
: >"${TIMEOUT_FLAG}"
# Empty flag means "not timed out"; watcher writes a token on timeout.

# Launch swift test as its own process-group leader so timeout can kill children.
if command -v setsid >/dev/null 2>&1; then
  setsid swift test "$@" &
else
  # macOS / environments without setsid: new process group via perl.
  perl -e 'setpgrp(0, 0); exec @ARGV' -- swift test "$@" &
fi
pid=$!

# Watcher must not hold the caller's stdout/stderr (redirect both away).
(
  exec </dev/null >/dev/null 2>/dev/null
  sleep "${LIMIT_SECONDS}"
  if kill -0 "${pid}" 2>/dev/null; then
    printf 'timed_out\n' >"${TIMEOUT_FLAG}"
    # Signal the whole process group (negative PGID).
    kill -TERM -"${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    sleep 2
    kill -KILL -"${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  fi
) &
watcher=$!

set +e
wait "${pid}"
status=$?
set -e

kill "${watcher}" 2>/dev/null || true
wait "${watcher}" 2>/dev/null || true

if grep -qx 'timed_out' "${TIMEOUT_FLAG}" 2>/dev/null; then
  echo "run-swift-test.sh: exceeded ${LIMIT_SECONDS}s; terminated swift test process group" >&2
  exit 124
fi
exit "${status}"
