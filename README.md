# Cosmaneura Scribe

Consent-gated ambient capture that produces a clean, diarized transcript for the existing
Cosmaneura SOAP-note and value-point engine.

## What works now

- Conservative all-party consent records
- Tenant-scoped capture-session state machine
- Passwordless, short-lived Azure Blob upload grants scoped to one encrypted audio object
- Idempotent audio-chunk registration bound to the matching grant
- Structured, role-labeled transcript persistence and retrieval
- Adapter to the existing `AIVisitTranscript` shape
- Async in-memory and durable PostgreSQL repositories with atomic request transactions
- PostgreSQL row-level tenant isolation, legal state-transition guards, and append-only audit events
- Passwordless Entra-token database access and a separately privileged migration job
- PostgreSQL custody/audit migrations and deployed private Azure OpenTofu foundation
- Non-root container image and internal-only Azure Container Apps deployment definition

The service uses an in-memory repository by default and is ready to switch to PostgreSQL after the
private database foundation is provisioned and bootstrapped. Azure Storage and PostgreSQL both use
`DefaultAzureCredential`, so neither an account key nor a database password is stored in the app.
The currently deployed revision remains on the in-memory repository until that controlled cutover.

## Run locally

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync
make test
make dev
```

OpenAPI docs are at `http://localhost:8020/docs`. Regenerate the committed contract with
`make openapi`.

Before connecting an Azure subscription, follow the passwordless setup in
[`docs/AZURE_ONBOARDING.md`](docs/AZURE_ONBOARDING.md).

The database provisioning and cutover runbook is in
[`docs/POSTGRES_OPERATIONS.md`](docs/POSTGRES_OPERATIONS.md).

## Existing note-engine compatibility

The adapter emits `doctor_id`, `appointment_id`, `patient_id`, `duration`, and transcript entries
with `speaker`, `content`, `startTime`, and `endTime`, matching the current Cosmaneura model. The
new service retains channel, confidence, and speaker-role metadata internally.
