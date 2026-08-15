# ADR 0006: Deliver transcripts with workload identity

**Status:** Accepted

Scribe delivers quality-ready transcripts to the master platform at
`POST /service/v1/scribe/transcripts`. It uses the Container App's managed identity to request an
app-only Microsoft Entra token for the platform API's `.default` scope. No client secret is stored
in Scribe.

The request contains only the canonical encounter ID, Scribe session ID, duration, and transcript
segments. The master platform derives clinician, patient, and tenant ownership from its canonical
encounter. Scheduling source, names, DOBs, and caller-supplied identity assertions are excluded.

Scribe persists a tenant-scoped, non-PHI delivery receipt before each attempt. The receipt holds a
stable outbound idempotency key, a payload hash, status, attempt count, opaque platform transcript
ID, and sanitized failure code. Retries reuse the key. The session becomes `handed_off` only after
the master platform accepts the delivery. The legacy payload-preparation endpoint remains during
the feature-flagged rollout with its current session-state behavior for compatibility; the delivery
ledger is authoritative for remote acceptance.

This implements the shared architecture contract in
`cosmaneura-architecture/contracts/scribe-handoff.md`.
