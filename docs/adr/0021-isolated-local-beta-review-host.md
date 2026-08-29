# ADR 0021: Isolate the local Beta review host from the clinical API

**Status:** Accepted

## Context

The founder needs a same-day product loop that creates one synthetic ingest, keeps it for the
life of a local process, and opens its transcript in a review UI. The production API cannot be
used as a shortcut: its workflows require verified service identity, consent, durable tenant
storage, and deployment controls that a local synthetic preview neither has nor should imitate.

Mounting preview routes in `main.py`, adding a cloud persistence dependency, or publishing a
preview artifact would expand the clinical and deployment boundaries for a local-only need. A
JSON contract without an interactive UI would not validate the product workflow.

## Decision

The Beta uses a separate FastAPI application in `beta_preview_host.py` and a process-local store
in `beta_ingest_store.py`. It is never mounted by the production application. The store accepts
only generated synthetic transcript content, scopes records and idempotency keys by tenant, and
records metadata-only audit events. The host accepts only the fixed local tenant fixture and
returns the same not-found response for absent, malformed, and cross-tenant reads.

`Settings.beta_preview_host_enabled` is a default-false dark latch for the configured host
entrypoint. Its initial cohort is empty, its owner is Scribe, and it is reviewed by 2026-09-30.
The local launcher does not change that setting; it calls a separate, explicit local application
factory and binds both processes to loopback. No Azure, Entra, database, publish workflow, or
production API module participates.

The browser UI is a separate local Vite process. It proxies only `/api/beta` to the loopback host,
accepts no free-form clinical text, and visibly labels all content synthetic and process-local.
Missing tenant or session identifiers stop requests in the browser and show fail-closed copy.

## Consequences

- A founder can exercise create, persistence, list, and transcript-review behavior without cloud
  credentials or infrastructure.
- All sessions disappear when the API process stops. This is intentional and must not be described
  as durable or production evidence.
- The preview host contains no real authentication and must never receive PHI or be bound to a
  non-loopback interface by the launcher.
- Enabling or deploying the dark configured entrypoint requires a separate security and release
  decision; this change does not authorize either.
- Recovery is a code revert: remove the local UI, launcher, isolated host/store, and dark setting.
  There is no migration, remote state, or published artifact to roll back.
