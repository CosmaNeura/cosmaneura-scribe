#!/usr/bin/env bash
# Local/mac runner for this package's `swift test`. No hosted CI job currently
# runs `swift test` for ios-pcm-capture; this script is the bounded entry point.
# Hard job-style limit: 600 seconds (10 minutes).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LIMIT_SECONDS="${PCM_SWIFT_TEST_TIMEOUT_SECONDS:-600}"

swift test "$@" &
pid=$!

(
  sleep "${LIMIT_SECONDS}"
  if kill -0 "${pid}" 2>/dev/null; then
    echo "run-swift-test.sh: exceeded ${LIMIT_SECONDS}s; terminating swift test (pid ${pid})" >&2
    kill "${pid}" 2>/dev/null || true
    sleep 2
    kill -9 "${pid}" 2>/dev/null || true
  fi
) &
watcher=$!

set +e
wait "${pid}"
status=$?
set -e

kill "${watcher}" 2>/dev/null || true
wait "${watcher}" 2>/dev/null || true

if [[ "${status}" -eq 143 || "${status}" -eq 137 ]]; then
  echo "run-swift-test.sh: swift test killed after ${LIMIT_SECONDS}s timeout" >&2
  exit 124
fi
exit "${status}"
