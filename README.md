# Cosmaneura Scribe

Consent-gated ambient capture that produces a clean, diarized transcript for the existing
Cosmaneura SOAP-note and value-point engine.

## What works now

- Conservative all-party consent records
- Tenant-scoped capture-session state machine
- Passwordless, short-lived Azure Blob upload grants scoped to one encrypted audio object
- Idempotent audio-chunk registration bound to the matching grant
- Structured, role-labeled transcript persistence and retrieval
- Entra workload-identity adapter to the master platform's source-agnostic encounter contract
- Fail-closed Entra app-only authentication on every Scribe workflow route
- Durable transcript-delivery receipts with stable idempotency keys and retry status
- Async in-memory and durable PostgreSQL repositories with atomic request transactions
- PostgreSQL row-level tenant isolation, legal state-transition guards, and append-only audit events
- Passwordless Entra-token database access and a separately privileged migration job
- De-identified benchmark harness that emits aggregate accuracy/performance metrics only
- PostgreSQL custody/audit migrations and deployed private Azure OpenTofu foundation
- Non-root container image and internal-only Azure Container Apps deployment definition

The service uses an in-memory repository by default and is ready to switch to PostgreSQL after the
private database foundation is provisioned and bootstrapped. Azure Storage and PostgreSQL both use
`DefaultAzureCredential`, so neither an account key nor a database password is stored in the app.
The currently deployed revision remains on the in-memory repository until that controlled cutover.

## Implemented, not yet activated

- Provider-neutral speech-to-text contract and managed-identity Azure AI Speech adapter
- Consent-gated transcription worker with renewable leases, lost-lease cancellation, bounded
  retries, channel role priors, metadata-only quality gates, and idempotent transcript persistence
- Per-session client-generated audio keys, immutable wrapped-key custody, and lease-bound private
  Blob assembly with encrypted ephemeral tracks

Activation still requires the dedicated worker identity and manual trigger, private Azure AI
Speech connectivity, and a live synthetic round-trip. Those controls remain disabled by default.

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

## Master-platform delivery

The feature-flagged delivery client sends an encounter ID, Scribe session ID, and diarized
transcript to the master platform. It never sends clinician/patient identity assertions or a
scheduling vendor. The master derives ownership from its canonical encounter and invokes the
existing note and engagement pipelines once.

Follow [`docs/MASTER_PLATFORM_HANDOFF.md`](docs/MASTER_PLATFORM_HANDOFF.md) for passwordless Entra
configuration and the safe rollout sequence.

Calls in the opposite direction—from the master platform into Scribe—use a separate
`Scribe.Workflow.Access` app role. The verified platform workload identity is the only caller
allowed to supply practice-tenant context. Follow
[`docs/PLATFORM_WORKFLOW_AUTH.md`](docs/PLATFORM_WORKFLOW_AUTH.md) for the rollout.

## Capture clients

Web and mobile capture are separate P1 applications sharing one generated API client and encrypted
chunk protocol. The responsive web application targets foreground capture on computers and exam
room tablets. The React Native iOS/Android application adds native background/lock handling,
encrypted offline queuing, reconnect/resume, and local purge. The desktop companion remains P2 and
owns dual-channel microphone/system-audio capture for virtual visits.

The current client boundaries are in `apps/web-capture`, `apps/mobile-capture`,
`apps/review-ui`, and `apps/desktop-companion`.

The transcription worker orchestration and inactive encrypted Blob assembly boundary are documented
in [`docs/TRANSCRIPTION_WORKER.md`](docs/TRANSCRIPTION_WORKER.md).

## Legacy note-engine compatibility

The adapter emits `doctor_id`, `appointment_id`, `patient_id`, `duration`, and transcript entries
with `speaker`, `content`, `startTime`, and `endTime`, matching the current Cosmaneura model. The
new service retains channel, confidence, and speaker-role metadata internally.
