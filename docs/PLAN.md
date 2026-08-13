# Ambient scribe build plan

## Product boundary

Cosmaneura Scribe owns consent, capture sessions, raw-audio custody, diarized speech-to-text,
speaker-role labeling, quality gates, retention, and handoff. Note styling and value-point extraction
stay in the existing Cosmaneura engine.

## Delivery phases

1. **P0 pipeline:** consent, private Blob ingestion, orchestration, pluggable STT, role labeling,
   quality gates, and note-engine handoff behind the current upload UX.
2. **P1 in-person:** mobile/web capture with VAD, encrypted chunks, offline queue/resume, and review.
3. **P2 virtual:** Tauri macOS/Windows companion with separate microphone and system-audio channels.
4. **P3 phone:** Azure Communication Services consent IVR and recording.
5. **P4 real-time:** streaming STT and draft notes within 60 seconds of visit end.

## Completed Sprint 0 foundation

- Conservative consent policy and consent/session state machines
- Short-lived user-delegation upload grants and grant-bound chunk custody metadata
- Structured transcript contract
- Entra-authenticated master-platform adapter with durable, idempotent delivery receipts
- Reversible database baseline, deployed private-storage foundation, internal Container Apps runtime,
  and CI guardrails
- Durable async PostgreSQL repository with per-request transactions and atomic idempotency
- Database-enforced tenant isolation, legal session transitions, and append-only audit events
- Passwordless managed-identity database bootstrap and least-privilege runtime grants
- Disposable PostgreSQL migration, persistence, isolation, and rollback tests in CI

## Next P0 slice

1. Obtain PostgreSQL Flexible Server provisioning access in East US or East US 2 for the development
   subscription.
2. Review and apply the staged private PostgreSQL foundation plan.
3. Build an immutable image from the persistence commit, run the one-shot migration job, and switch
   the internal API to PostgreSQL only after migration and readiness checks pass.
4. Configure the Entra application role and run the synthetic cross-service handoff acceptance
   test.
5. Implement the replaceable speech-to-text worker interface and a de-identified Azure Speech
   benchmark harness.

## Required external decisions

- Confirm the provider mobile-app stack before P1.
- Have counsel approve the state × modality consent matrix before replacing the conservative
  all-party default.
- Benchmark Azure Speech and Deepgram only on de-identified samples under the appropriate BAAs.
