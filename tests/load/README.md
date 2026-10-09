# Capture protocol load tests

These tests drive the capture **control-plane** protocol through the real
FastAPI routes and disposable PostgreSQL used by the full-stack E2E host. Each
simulated session makes the requests the browser capture client makes, in the
same order:

1. consent, session, audio-key binding, capabilities, and lease issue;
2. a reservation batch for the first half of the session's chunks;
3. per chunk: chunk receipt read, upload authorization, chunk receipt read,
   and chunk registration;
4. a lease renewal (as on a paused-then-resumed capture), a reservation batch
   for any remaining chunks under the renewed generation, and the same
   per-chunk requests;
5. capture completion with the renewed lease generation.

They use synthetic identifiers and metadata only. The harness is hard-limited
to loopback and refuses any other `--host`, and the Locust web UI, before a
user spawns. It must never target a deployed or PHI-bearing environment. The
storage data-plane PUT, transcription status polling, and the transcription
provider are out of scope; test them independently with their vendor-specific
tooling.

## Prerequisites

Start the E2E API host (`apps/capture/e2e/support/real_api_host.py`) against a fresh disposable
`_test` PostgreSQL database, reached as a role that may create roles. The host refuses a reused
database and listens on `127.0.0.1:4175`. The tenant comes from the same file the browser suites
use:

```sh
COSMANEURA_SCRIBE_E2E_TENANT_ID="$(sed -E 's/.*"([^"]+)".*/\1/' apps/capture/e2e/support/synthetic-tenant.mjs)" \
COSMANEURA_SCRIBE_E2E_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:55438/cosmaneura_scribe_load_test \
  uv run python apps/capture/e2e/support/real_api_host.py
```

## Profiles

```sh
scripts/run-capture-load.sh burst
scripts/run-capture-load.sh soak
```

- `burst`: 75 users spawned in one second, held for two minutes.
- `soak`: 15 users ramped at three users/second, held for 90 minutes.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCRIBE_LOAD_USERS` | 75 burst, 15 soak | Concurrent simulated users. |
| `SCRIBE_LOAD_SPAWN_RATE` | 75 burst, 3 soak | Users started per second. |
| `SCRIBE_LOAD_DURATION` | `2m` burst, `90m` soak | Locust `--run-time`. |
| `SCRIBE_LOAD_CHUNKS_PER_SESSION` | 4 | Chunks registered per session (at least 1). |
| `SCRIBE_LOAD_MIN_REQUESTS` | 100 | Minimum total requests for a passing run. |
| `SCRIBE_LOAD_MAX_FAILURE_RATIO` | 0.01 | Maximum aggregate failure ratio. |
| `SCRIBE_LOAD_MAX_P95_MS` | 750 | Maximum p95 latency, aggregate and per operation. |
| `SCRIBE_LOAD_OPERATION_MAX_P95_MS` | `{}` | JSON object of per-operation p95 overrides keyed by request name, e.g. `{"POST chunk registration": 1000}`. |

A run exits 0 only when every gate passes, including runs with failures within
the ratio; otherwise it exits 1 and prints the missed gates. Use the overrides
for calibrated non-production hardware. Locust prints per-operation throughput
and percentile tables; retain that console output with the exact commit and
machine profile.

The soak profile is deliberately not a PR gate. It is an operator-run endurance
test whose evidence should include memory/CPU/database observations alongside
the Locust results.

For full-suite coverage, propagate the branch setting and repository configuration
to the harness's child processes:

```sh
uv run pytest --cov=cosmaneura_scribe --cov-branch --cov-config=pyproject.toml
```
