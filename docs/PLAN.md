# Ambient scribe build plan

## Product boundary

The platform owns the canonical encounter, human identity, general consent policy, source
exclusivity, notes, and clinician review. Cosmaneura Scribe owns immutable processing-time consent
evidence, operational capture sessions, raw-audio custody, diarized speech-to-text, speaker-role
labeling, quality gates, retention, and handoff. Note styling and value-point extraction stay in the
existing Cosmaneura engine.

## Delivery phases

1. **P0 pipeline:** consent, private Blob ingestion, orchestration, pluggable STT, role labeling,
   quality gates, and note-engine handoff behind the current upload UX.
2. **P1a web capture profile:** the `apps/capture/` Capacitor source tree delivered as a responsive
   browser/PWA experience for computers and exam-room tablets, with a tested foreground raw-PCM
   adapter, VAD, encrypted chunks, reconnect/resume, and review.
3. **P1b native capture profiles:** the same `apps/capture/` source tree delivered as signed
   iOS/Android shells, with native raw-PCM audio, secure storage, background/lock handling,
   encrypted offline queue/resume, local purge, and platform-specific acceptance evidence.
4. **P2 virtual:** Electron macOS/Windows companion. The accelerated first adapter uses a pinned
   external Desktop SDK directly in the main process for online, audio-only mixed capture; native
   separate microphone/system channels remain the target adapter under central architecture ADR
   0018's exit criteria, with a later Tauri/native shell still available if justified.
5. **P3 phone:** Azure Communication Services consent IVR and recording.
6. **P4 real-time:** streaming STT and draft notes within 60 seconds of visit end.

## Priority desktop acceleration lane

This is the approved first deployable virtual-visit path and now takes product priority over further
PWA/mobile feature expansion. It does not weaken the existing private-service, PWA, mobile custody,
or acceptance gates for features that remain in service. “Desktop Phase 0” below is abbreviated
**D0** so it is not confused with the server-side P0 pipeline above.

1. **D0 — governance and contracts (1–2 days):** ratify architecture ADR 0018 and
   `cosmaneura-architecture/contracts/desktop-capture.md`; freeze the pilot matrix and publish the
   implementation/acceptance plan in `docs/DESKTOP_CAPTURE_PHASE0.md`.
2. **D1 — existing provider-boundary hardening (3–5 days):** verify signed callbacks before any
   side effect, durably deduplicate events, eliminate provider payload/header/meeting data from
   logs, set explicit bounded retention, and preserve the bot path.
3. **D2 — provider-neutral desktop backend (4–6 days):** add durable tenant-bound coordination
   sessions, exclusive source leases, one-time launch tickets, short-lived segment capabilities,
   normalized event/segment state, uncertain-create reconciliation, and deletion evidence.
4. **D3 — signed companion (4–7 days):** implement a hardened Electron shell with the exact pinned
   stable SDK isolated in the main process, narrow schema-validated preload IPC, explicit clinician
   start/stop, persistent recording indicator, supported meeting detection, interruption/gap UX,
   packaged local-only renderer code, restrictive CSP, sender/frame/origin validation, hardened
   fuses, signed downgrade-resistant updates, and no-PHI diagnostics. Scaffold and synthetic adapter
   work may proceed in parallel with D1–D2; real-provider start stays gated on both.
5. **D4 — appointment and review workflow (4–6 days):** launch from an existing canonical
   appointment; feed the clinician scratchpad to note generation as a priority input; preserve
   user-versus-AI authorship and claim-to-transcript segment provenance; deliver the normalized
   transcript to the existing note pipeline; and require clinician edits/approval. No EHR
   writeback.
6. **D5 — retention and operations (3–5 days):** immediately delete provider media after durable
   ingestion, reconcile deletion/unknown outcomes, alert on overdue cleanup, prove the remote kill
   switch and mutually exclusive bot fallback, and produce signing/update/rollback runbooks.
7. **D6 — acceptance and narrow rollout:** pass the exact OS × meeting-client × pinned-SDK matrix,
   then pilot one-clinician/one-patient visits by allowlisted tenant. Expansion requires separate
   evidence; native dual-channel capture starts when the governance exit criteria are met.

The initial accepted combinations are Apple Silicon macOS 14.2+ and Windows 10/11 x64, with Zoom
Desktop or Google Meet in Chrome. They are audio-only, online-only, clinician-started encounters
with one clinician and one patient. Intel Mac, mobile, Teams, Meet PWA/companion mode, offline,
video, automatic start, separate tracks, autonomous EHR writeback, and broader encounter shapes are
deferred.

This desktop profile does not persist raw/mixed audio to platform or Scribe storage and does not use
the 30-day raw-audio window proposed in Scribe ADR 0013. Capture-provider media is explicitly
bounded to at most six hours and deletion begins immediately after durable transcript ingestion;
the normalized transcript remains subject to the platform's clinical-record retention policy.

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
- False-default Capacitor Phase 2 foundation at `apps/capture/`: shared PWA/iOS/Android shells,
  generated API/protocol clients, an encrypted durable queue, a synthetic-only mock BFF, and
  native device-bound queue storage with reproducible platform sync/build gates

## Parallel infrastructure backlog

These foundation items remain valid, but desktop D0–D6 is the immediate product lane. Mobile and
PWA feature expansion is paused unless it is required to preserve an already-supported security or
custody guarantee.

1. Obtain PostgreSQL Flexible Server provisioning access in East US or East US 2 for the development
   subscription.
2. Review and apply the staged private PostgreSQL foundation plan.
3. Build an immutable image from the persistence commit, run the one-shot migration job, and switch
   the internal API to PostgreSQL only after migration and readiness checks pass.
4. Configure the Entra application role and run the synthetic cross-service handoff acceptance
   test.
5. Provision the dedicated private Azure Speech resource and run the two-case synthetic live
   round-trip before activating the already defined manual transcription job.
6. Maintain the false-default `apps/capture/` recording and active-key layers without expanding the
   mobile/PWA product surface. Route every authenticated API/control operation through the master
   platform BFF; preserve distinct PWA/native custody and acceptance requirements.

## Required external decisions

- Confirm Apple and Google developer-account ownership, bundle identifiers, signing custody, and
  mobile device-management requirements before P1b distribution.
- Have counsel approve the state × modality consent matrix before replacing the conservative
  all-party default.
- Benchmark Azure Speech and Deepgram only on de-identified samples under the appropriate BAAs.
- The existing Recall BAA is treated as in place. Before PHI activation, record that the enabled
  Desktop SDK product, selected processing region/account, support/telemetry path, retention setting,
  and deletion behavior are within the approved account configuration. This is an operational
  evidence gate, not a new vendor-selection project.
