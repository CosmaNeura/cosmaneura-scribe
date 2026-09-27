# Capture protocol load tests

These tests drive the complete capture **control-plane** lifecycle through the
real FastAPI routes and disposable PostgreSQL used by the full-stack E2E host:
consent, session, key binding, capabilities, lease, reservation, upload
authorization, chunk registration, and completion.

They use synthetic identifiers and metadata only. The harness is hard-limited
to loopback and must never target a deployed or PHI-bearing environment. The
storage data-plane PUT and transcription provider are intentionally out of
scope; test them independently with their vendor-specific tooling.

## Prerequisites

Start a fresh disposable `_test` PostgreSQL database and the E2E API host as
documented in `apps/capture/e2e/README.md`. The host refuses a reused database.

## Profiles

```sh
scripts/run-capture-load.sh burst
scripts/run-capture-load.sh soak
```

- `burst`: 75 users spawned in one second, held for two minutes.
- `soak`: 15 users ramped at three users/second, held for 90 minutes.

Both fail unless they collect at least 100 requests, keep failures at or below
1%, and keep aggregate p95 latency at or below 750 ms. Override duration,
users, spawn rate, and gates with `SCRIBE_LOAD_*` variables for calibrated
non-production hardware. Locust prints per-operation throughput and percentile
tables; retain that console output with the exact commit and machine profile.

The soak profile is deliberately not a PR gate. It is an operator-run endurance
test whose evidence should include memory/CPU/database observations alongside
the Locust results.
