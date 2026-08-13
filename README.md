# Cosmaneura Scribe

Consent-gated ambient capture that produces a clean, diarized transcript for the existing
Cosmaneura SOAP-note and value-point engine.

## What works now

- Conservative all-party consent records
- Tenant-scoped capture-session state machine
- Idempotent audio-chunk registration without exposing storage internals to logs
- Structured, role-labeled transcript persistence and retrieval
- Adapter to the existing `AIVisitTranscript` shape
- PostgreSQL custody/audit baseline and private Azure storage baseline

The service currently uses an in-memory development repository. Azure Blob upload-token issuance,
Durable Functions orchestration, and Azure Speech are the next implementation slices.

## Run locally

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync
make test
make dev
```

OpenAPI docs are at `http://localhost:8020/docs`. Regenerate the committed contract with
`make openapi`.

## Existing note-engine compatibility

The adapter emits `doctor_id`, `appointment_id`, `patient_id`, `duration`, and transcript entries
with `speaker`, `content`, `startTime`, and `endTime`, matching the current Cosmaneura model. The
new service retains channel, confidence, and speaker-role metadata internally.

