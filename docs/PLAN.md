# Ambient scribe build plan

## Product boundary

Cosmaneura Scribe owns consent, capture sessions, raw-audio custody, diarized speech-to-text,
speaker-role labeling, quality gates, retention, and handoff. Note styling and value-point extraction
stay in the existing Cosmaneura engine.

## Delivery phases

1. **P0 pipeline:** consent, private Blob ingestion, orchestration, pluggable STT, role labeling,
   quality gates, and note-engine handoff behind the current upload UX.
2. **P1a web capture profile:** the `apps/capture/` Capacitor source tree delivered as a responsive
   browser/PWA experience for computers and exam-room tablets, with a tested foreground raw-PCM
   adapter, VAD, encrypted chunks, reconnect/resume, and review.
3. **P1b native capture profiles:** the same `apps/capture/` source tree delivered as signed
   iOS/Android shells, with native raw-PCM audio, secure storage, background/lock handling,
   encrypted offline queue/resume, local purge, and platform-specific acceptance evidence.
4. **P2 virtual:** Tauri macOS/Windows companion with separate microphone and system-audio channels.
5. **P3 phone:** Azure Communication Services consent IVR and recording.
6. **P4 real-time:** streaming STT and draft notes within 60 seconds of visit end.

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
- Provider-neutral speech-to-text request/result contract
- Managed-identity Azure AI Speech file transcription with diarization and channel preservation
- De-identified benchmark harness with sanitized WER, latency, and speaker metrics
- Consent-gated transcription orchestration with durable leases, bounded retries, channel-prior
  role labels, heartbeat renewal with lost-lease cancellation, metadata-only quality gates, and
  idempotent transcript persistence
- Client-generated session-key custody, private encrypted Blob assembly, and a manual-only,
  false-by-default Container Apps transcription job with a dedicated least-privilege identity
- False-default capture protocol v1 with renewable leases, canonical chunk reservations,
  refreshable upload authorization, receipt lookup, capability bootstrap, and generated
  Python/TypeScript framing and AAD implementations pinned by cross-language golden vectors

## Next P0 slice

1. Obtain PostgreSQL Flexible Server provisioning access in East US or East US 2 for the development
   subscription.
2. Review and apply the staged private PostgreSQL foundation plan.
3. Build an immutable image from the persistence commit, run the one-shot migration job, and switch
   the internal API to PostgreSQL only after migration and readiness checks pass.
4. Configure the Entra application role and run the synthetic cross-service handoff acceptance
   test.
5. Provision the dedicated private Azure Speech resource and run the two-case synthetic live
   round-trip before activating the already defined manual transcription job.
6. After the server protocol and private acceptance gates pass, scaffold the single Capacitor
   companion at `apps/capture/` and fold the `apps/web-capture` and `apps/mobile-capture` planning
   stubs into it. Deliver the P1a PWA and P1b native profiles from that source tree, with all
   authenticated API/control operations routed through the master platform BFF, without collapsing
   their distinct custody and acceptance requirements.

## Required external decisions

- Confirm Apple and Google developer-account ownership, bundle identifiers, signing custody, and
  mobile device-management requirements before P1b distribution.
- Have counsel approve the state × modality consent matrix before replacing the conservative
  all-party default.
- Benchmark Azure Speech and Deepgram only on de-identified samples under the appropriate BAAs.
