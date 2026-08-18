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
- False-default v1 capture prerequisites: renewable leases, canonical offline-safe chunk
  reservations, refreshable one-object upload authorization, registration receipts, capability
  bootstrap, and generated Python/TypeScript wire implementations with shared golden vectors
- False-default Capacitor capture foundation shared by PWA, iOS, and Android, with a durable
  encrypted upload queue, synthetic-only mock BFF, and device-bound native queue storage
- False-by-default manual Container Apps Job with a dedicated identity, one-target execution,
  cancellation cleanup, zero platform retries, and least-privilege activation roles
- Terraform-owned private Azure AI Speech foundation and a separate false-default manual smoke job
  with two hash-pinned synthetic cases and fail-closed private-DNS verification

Activation still requires an approved infrastructure apply and a successful live synthetic
round-trip. The foundation, smoke, and transcription gates remain disabled by default.

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

## Capture companion

The P1 recording companion foundation is one Capacitor application at `apps/capture/`. One
TypeScript source tree now builds as a foreground browser/PWA experience and as iOS/Android shells.
Phase 2 provides the generated protocol client, durable encrypted queue, synthetic-only mock BFF,
and native device-bound queue storage; recording, active DEK custody, production BFF integration,
background audio, and clinical enablement remain deliberately unimplemented.

Every authenticated API and control operation goes through the master platform BFF; only immutable
ciphertext uses the separately governed ADR 0016 upload edge. The companion does not receive a
Scribe workload token, trust client-supplied tenant context, or call the private Scribe API
directly. The former `apps/web-capture` and `apps/mobile-capture` planning stubs have been folded
into `apps/capture/` rather than becoming separate applications.
`apps/review-ui` and the P2 `apps/desktop-companion` remain separate boundaries.

The proposed authenticated key, encrypted upload, offline recovery, and private Blob edge path is
documented in
[`docs/adr/0016-authenticated-private-client-capture-path.md`](docs/adr/0016-authenticated-private-client-capture-path.md).
The single-codebase decision and its distinct PWA/native custody profiles are recorded in
[`docs/adr/0018-capacitor-capture-companion.md`](docs/adr/0018-capacitor-capture-companion.md).
The disabled server-side lease, reservation, receipt, capability, and generated wire contract is
recorded in
[`docs/adr/0019-versioned-offline-capture-protocol.md`](docs/adr/0019-versioned-offline-capture-protocol.md).

The transcription worker orchestration and inactive encrypted Blob assembly boundary are documented
in [`docs/TRANSCRIPTION_WORKER.md`](docs/TRANSCRIPTION_WORKER.md).

## Legacy note-engine compatibility

The adapter emits `doctor_id`, `appointment_id`, `patient_id`, `duration`, and transcript entries
with `speaker`, `content`, `startTime`, and `endTime`, matching the current Cosmaneura model. The
new service retains channel, confidence, and speaker-role metadata internally.
