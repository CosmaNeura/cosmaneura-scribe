# iOS and bilingual Scribe beta contract

**Status:** Product contract approved for implementation; all clinical and distribution activation
remains disabled

**Date:** 2026-09-01

## Outcome

The Scribe beta includes a first-class iOS TestFlight client at the same product-readiness level as
the desktop beta. Both clients must start from an existing authenticated appointment, enforce the
same consent and source-authority rules, produce a durable transcript, and hand an English working
transcript to the existing clinician-reviewed note workflow. The implementations and acceptance
evidence remain platform-specific.

The initial bilingual workflow supports an English-speaking provider and a Spanish-speaking patient.
The provider explicitly selects **English + Spanish (`en-US` + `es-US`)** before capture. Scribe
preserves each source-language segment, translates Spanish segments to English, and constructs an
English working transcript for note generation. English source segments remain unchanged.

This contract is documentation only. It does not enable a feature flag, create a beta cohort, change
an API or schema, configure an Azure service, upload a TestFlight build, or authorize PHI use.

The stable data classes are `synthetic`, `verified_deidentified`, and `approved_test_fixture`.
Founder admission, required privacy/security review, and operator-controlled imported-fixture
ingress follow the product and authentication contracts. The client selects only an eligible
server-classified encounter and cannot assert or upgrade classification.

## Frozen beta scope

### Included

- iPhone distribution through TestFlight with signed, versioned, rollback-capable builds.
- Up to three named creator accounts in the initial cohort. For each session, the creator must also
  be the authenticated user who selects or creates the encounter, records, resumes, completes,
  views, and sends the session to note generation.
- One creator and one participant represented only by approved non-PHI test data on either an
  eligible creator-owned test appointment or an explicitly confirmed Scribe-created unscheduled
  test encounter.
- Foreground-only, audio-only capture with an explicit start, persistent visible recording state,
  explicit stop, and no silent resume.
- Consent confirmation before any audio API opens, with approved English and Spanish consent copy.
- Encrypted local queueing before network I/O, bounded offline operation, deterministic upload
  recovery, and local purge after the server receipt or an authoritative revoke/sign-out decision.
- Manual `en-US` mode for English-only encounters and manual bilingual `en-US` + `es-US` mode for
  the defined provider/patient pairing.
- Bounded automatic language identification within bilingual mode, with only `en-US` and `es-US` as
  candidate locales.
- Phrase- or utterance-level source locale on every transcript segment.
- Spanish-to-English translation linked to the immutable Spanish source segment.
- An English working transcript composed from original English segments and reviewed English
  translations of Spanish segments.
- Existing clinician review and note generation. The generated note remains a draft and requires
  clinician review; there is no autonomous EHR writeback.

### Deferred

- Android distribution and parity.
- Recording while the app is backgrounded, the device is locked, or another application is active.
- Silent restart or resume after interruption, process termination, permission loss, or authority
  expiry.
- More than one clinician or one patient, shared-device workflows, delegate access, tenant-wide
  browsing, and any user other than the session creator operating a beta session.
- Languages or locales other than `en-US` and `es-US`.
- Automatic selection of bilingual mode.
- Reliable language switching inside one sentence, word-level language labels, or a guarantee for
  rapid code-switching without a phrase boundary.
- English-to-Spanish patient-facing translation, real-time interpretation, synthesized speech, or
  translated clinical instructions.
- Transcript editing or export in the capture client. Review, note editing, and export remain in the
  canonical platform workflow.

## Equal beta readiness: desktop and iOS

“Same beta readiness” means equivalent user outcome, safety, and operational evidence; it does not
mean identical capture technology or a shared release artifact.

Neither platform may be described as beta-ready unless its accepted configuration proves:

1. authenticated launch from an authorized existing appointment;
2. immutable consent evidence and an exclusive source lease before capture;
3. explicit start and stop with a persistent visible recording indicator;
4. bounded interruption behavior with no invented continuity;
5. durable, idempotent transcript ingestion and exactly-once note dispatch;
6. creator-only access and tenant isolation on every operation;
7. no-PHI logs, analytics, crash reports, notifications, deep links, or support artifacts;
8. retention, deletion, kill-switch, incident, and rollback procedures;
9. clinician review of the transcript and generated note; and
10. a passing platform-specific release matrix.

Desktop and iOS may reach that bar on different dates. A passing desktop matrix does not waive iOS
device, custody, signing, or TestFlight evidence, and an iOS pass does not waive desktop provider,
packaging, or deletion evidence. A synthetic preview or unsigned simulator build is not a beta.

## iOS runtime contract

### Foreground-only capture

- Capture can start only while the signed application is active and visible.
- Leaving the foreground, locking the device, losing microphone permission, changing an audio route,
  receiving an interruption, or losing capture authority pauses or stops input visibly.
- Returning to the foreground never restarts the microphone automatically. The creator must
  reauthenticate as needed, obtain fresh authority, acknowledge any recorded gap, and explicitly
  resume into a new ordered segment.
- The beta requests no background-audio entitlement and makes no lock-screen continuity claim.
- A gap, overlap, dropped buffer, or uncertain boundary is preserved as metadata and blocks automatic
  note readiness until clinician review.

### Secure queue and recovery

- A native module captures accepted raw PCM and an OS CSPRNG creates the session DEK.
- A non-exportable, this-device-only Keychain-backed wrapping key protects the DEK at rest. Queue
  records and keys are excluded from backup and device migration. No raw DEK crosses the JavaScript
  bridge or enters logs, analytics, crash data, or support material.
- Each complete encrypted envelope is durably committed before network I/O. Retries reuse the exact
  reservation, AAD, nonce, ciphertext, digest, byte length, and idempotency key.
- Upload recovery can resume in the foreground after process death or network loss. Capture itself
  does not silently resume. The UI distinguishes recording, paused, queued, uploading, processing,
  ready, and terminal states.
- Expired upload authorization is refreshed only for the same reservation after creator,
  appointment, consent, and tenant authorization are revalidated.
- Registered envelopes remain local only until a server receipt is durable, then purge. Completion,
  consent revocation, sign-out, creator removal, or policy expiry applies the governed purge rule to
  all remaining local custody.
- Recovery never starts a replacement session to evade a conflict and never falls back to plaintext
  storage.

### Creator-only authorization

- The initial cohort contains at most three named creator accounts and is false by default for
  everyone else.
- The server derives tenant and creator identity from verified authentication; neither is accepted
  from a request body or local state.
- Every consent, session, capability, lease, reservation, receipt, completion, status, transcript,
  translation, and note-dispatch operation rechecks that creator and encounter binding.
- Deep links contain no PHI and cannot transfer session authority. A different user, including a
  member of the same tenant, receives no session content or recovery capability.
- Cohort expansion is a separate decision after the creator-only evidence and support runbook pass.

## Bilingual transcription contract

### Manual mode and source truth

- The creator chooses `English (en-US)` or `English + Spanish (en-US + es-US)` before consent and
  capture. The selection is stored on the session and cannot change after audio begins.
- Bilingual mode is not inferred from demographics, names, tenant settings, or prior encounters.
- The source transcript is immutable provider output. Each segment records its source text,
  `source_locale`, speaker attribution, timing, confidence when supplied, provider/model version,
  and source transcript version.
- The only accepted source locales are `en-US`, `es-US`, and an explicit `unknown` failure state.
  Missing, unsupported, or contradictory locale output is never silently coerced to English.
- Provider speaker and locale labels are advisory. Clinician review remains authoritative.

### Bounded automatic detection

- Automatic language identification is experimental, false by default, and available only inside
  manually selected bilingual mode.
- The transcription request supplies exactly two candidate locales: `en-US` and `es-US`. It does not
  ask the service to choose from every supported language.
- Detection is evaluated and represented per returned phrase or utterance. It is not represented as
  word-level detection and does not claim to identify a switch inside one sentence.
- The beta is designed for alternating English and Spanish utterances with an audible phrase
  boundary. Rapid switching, isolated borrowed words, overlapping bilingual speech, and mixed
  sentences require clinician review and may remain labeled `unknown`.
- Azure can return one of the supplied candidates even when neither is correct. A returned locale is
  evidence from the provider, not proof. Unsupported or low-quality audio fails to review-required;
  it does not trigger an unbounded retry or a third-language guess.
- Fixed-language fallback is permitted only when the creator explicitly selects English-only mode or
  a reviewer explicitly corrects a bilingual detection. The original provider result remains
  auditable.

### Translation and the English working transcript

- Translation is asynchronous and post-capture. This beta is not a live interpreter.
- Only source segments labeled `es-US` are translated, and the only target is English.
- Every translation stores the source segment identifier and version, source and target locales,
  translated text, translation provider/model version, creation time, and review state. Translation
  never overwrites source text.
- An `en-US` source segment enters the English working transcript unchanged. An `es-US` source
  segment contributes its English translation. An `unknown`, failed, missing, or stale translation
  creates a visible gap and blocks automatic note readiness.
- Regenerating a source segment invalidates its prior translation and any derived working-transcript
  version. Retries are idempotent and cannot create competing active translations.
- Note generation receives only a versioned English working transcript after every included segment
  resolves to either English source or reviewed Spanish-to-English translation. Every resulting
  material claim retains provenance to the working segment, translation when present, and immutable
  source segment.
- The clinician can compare Spanish source text with English translation before approving the note.
  Machine translation is never presented as clinician-authored text.

“Bidirectional” in this beta describes a conversation in which participants may speak either English
or Spanish. The product normalizes the clinical working transcript in one direction—Spanish to
English. It does not produce English-to-Spanish advice for the patient.

## Acceptance evidence

All fixtures are synthetic, verified de-identified through an approved process before ingestion, or
other test data explicitly approved as non-PHI with recorded source, owner, and permitted use.
Consent alone does not make data non-PHI. Evidence records the data classification, source commit,
app and OS version, provider/model version, selected mode, locale pair, result, timestamp, and
sanitized artifact location.

| Area | Required beta evidence | Failure disposition |
| --- | --- | --- |
| TestFlight | Signed archive validates, installs through TestFlight, launches on each accepted physical iPhone/OS pair, and rolls back to the last accepted build | Block iOS beta |
| Foreground lifecycle | Home, lock, call/alarm, route change, permission loss, crash, and forced termination never leave hidden or silently resumed capture | Block affected device/OS |
| Queue custody | Airplane-mode capture, process death, ordered recovery, exact-byte retry, receipt-before-purge, backup exclusion, sign-out, and revocation pass with native storage | Block PHI capture |
| Creator isolation | Cross-user, cross-tenant, stale-session, copied deep-link, and removed-creator attempts fail closed on every operation | Block clinical activation |
| Consent | English and Spanish approved copy is shown before audio; missing, expired, or revoked consent cannot capture, resume, translate, or dispatch a note | Block clinical activation |
| English baseline | Existing English WER, diarization, latency, provenance, and note-review thresholds remain passing | Block regression |
| Spanish baseline | `es-US` medical vocabulary, names replaced by synthetic tokens, numbers, medication directions, and noisy short utterances meet the approved thresholds | Block bilingual mode |
| Alternating turns | English clinician and Spanish patient turns preserve order, speaker, source locale, timestamps, and immutable source text | Block bilingual mode |
| Code-switch challenge | Mixed-sentence and borrowed-word cases are measured and visibly routed to review; no word-level guarantee is claimed | Block only if the UI obscures uncertainty |
| Translation | Spanish source and English translation remain paired and versioned; omissions, unsupported output, and provider failures visibly block note readiness | Block note dispatch |
| Working transcript | Every working segment resolves to source and optional translation provenance; English note input is deterministic and versioned | Block note dispatch |
| Clinical review | A bilingual clinician reviews sampled source/translation pairs and the resulting draft note against approved acceptance thresholds | Block bilingual cohort |
| Privacy | Source audio/text, translations, prompts, and notes are absent from logs, telemetry, crash data, notifications, and support bundles | Block release |
| Operations | Kill switch stops new bilingual sessions while preserving bounded recovery, review, deletion, and incident handling | Block rollout |

Accuracy thresholds, the accepted physical-device matrix, and the named creator are release inputs.
They must be approved and recorded before activation; this contract does not invent them.

## Delivery slices and sequencing

1. **Receiver-first language contract:** add session mode, segment source locale, translation record,
   English working-transcript version, provenance, and backward-compatible handoff fields while all
   flags remain false.
2. **Bounded Azure adapter:** send only the two selected locale candidates, preserve phrase locale,
   translate only Spanish segments through the approved provider boundary, and sanitize failures.
3. **Platform review:** render source/translation pairs, uncertainty and gaps; gate note dispatch on a
   complete versioned English working transcript.
4. **iOS runtime:** finish native PCM capture, device-bound DEK custody, foreground lifecycle,
   queue/recovery, PKCE/BFF authorization, and explicit resume.
5. **Release evidence:** pass approved non-PHI bilingual evaluation, physical-device and lifecycle
   matrices, signing/privacy review, TestFlight installation, rollback, and incident drill.
6. **Creator-only activation:** enable each of at most three named creators only after every
   preceding gate passes; one creator's evidence does not authorize another.

The shared receiver, auth, transcript, translation, and note-provenance slices serve desktop and iOS.
Platform capture and packaging work remain separate so an iOS issue does not destabilize desktop and
an external desktop-provider issue does not weaken mobile custody.

## Rollout and rollback

- All iOS, bilingual-detection, and translation controls start false with an owner, expiry, and the
  single named creator cohort.
- Enable English iOS first. Enable bilingual mode only after its language and translation matrix
  passes on that same signed build and backend revision.
- Any unexplained locale, translation/source mismatch, missing provenance, queue uncertainty,
  creator-isolation failure, or hidden recording state disables new bilingual capture immediately.
- Rollback stops new capture first. Already authorized encrypted envelopes may drain only within the
  existing bounded authority; transcript/translation reconciliation and governed deletion continue.
- Cohort expansion, background capture, another locale, or patient-facing translation requires a
  new explicit product and safety decision.
