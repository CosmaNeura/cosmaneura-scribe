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
- PostgreSQL custody/audit baseline and deployed private Azure OpenTofu foundation
- Non-root container image and internal-only Azure Container Apps deployment definition

The service currently uses an in-memory development repository by default. The Azure adapter uses
`DefaultAzureCredential` and user-delegation SAS, so it needs no storage account key. Durable
PostgreSQL repository wiring, orchestration, and Azure Speech are the next implementation slices.

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

## Existing note-engine compatibility

The adapter emits `doctor_id`, `appointment_id`, `patient_id`, `duration`, and transcript entries
with `speaker`, `content`, `startTime`, and `endTime`, matching the current Cosmaneura model. The
new service retains channel, confidence, and speaker-role metadata internally.
