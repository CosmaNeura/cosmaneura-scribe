# Desktop Scribe non-PHI micro-beta contract

**Status:** Scope locked for implementation and acceptance; all runtime activation and deployment
remain prohibited

**Date:** 2026-09-01

**Related plan:** `docs/DESKTOP_CAPTURE_PHASE0.md`

## Purpose and authority

This contract freezes the smallest acceptable Desktop Scribe micro-beta. It narrows the broader
Phase 0 pilot to one operating system while requiring both launch meeting clients. It does not
authorize a deployment, a provider call, a production configuration change, clinical use, or PHI.
Where this document is narrower than the Phase 0 plan, this document controls the initial micro-beta
cohort only.

Implementation may proceed behind false-default controls with synthetic or de-identified fixtures.
Opening any runtime gate, distributing an application, invoking real capture, or enrolling a cohort
requires a separate reviewed decision and its required evidence.

## Locked launch profile

The initial micro-beta supports exactly:

- Apple Silicon macOS 14.2 or newer.
- A signed and notarized Electron companion using the exact reviewed Electron and Recall Desktop SDK
  versions and native artifact hashes.
- Google Meet in supported Google Chrome and Zoom Desktop. Both client cells must pass on the same
  companion artifact before the micro-beta opens.
- Online, audio-only capture of one mixed stream.
- One authenticated clinician, one synthetic or de-identified participant, one canonical synthetic
  appointment, one meeting window, and one capture source at a time.
- Explicit clinician start and stop with a persistent native recording or uncertain-state indicator.
- Desktop Scribe as the primary capture source. The Zoom bot is available only as an explicit,
  pre-start fallback for a Zoom appointment.
- Completed asynchronous transcript delivery into the existing review boundary. Streaming or
  provisional content cannot make a transcript or note ready.

The two meeting clients are concurrently supported choices, not concurrent recording sources. If
Zoom Desktop and Meet Chrome are both detected, a second meeting appears, or the detected meeting
changes, capture must fail closed.

## Authority and appointment binding

Core is the sole source of tenant, actor, appointment, consent, and source authority. The desktop
companion, renderer, Recall, meeting metadata, and request body are never authority.

Before issuing a launch ticket or capture capability, Core must establish that:

1. The authenticated clinician is active and authorized for the current practice.
2. The canonical appointment exists, belongs to that practice, and is accessible to that clinician.
3. The appointment is active for the intended micro-beta visit and has no incompatible completed or
   active capture.
4. The consent record is current and bound to the same tenant, clinician, appointment, and capture
   purpose.
5. One durable source lease is available for the appointment.

The browser launch supplies only a short-lived, single-use, non-PHI ticket. The desktop exchanges it
through PKCE for a short-lived credential bound to opaque clinician, appointment, session, consent,
and source-lease identifiers. No patient identifier, patient name, meeting title, meeting URL, or
provider credential may enter a deep link, renderer message, notification, diagnostic, or log.

For Zoom-bot fallback, the Zoom occurrence, connected Zoom owner, authenticated Core clinician, and
canonical appointment must resolve to the same server-derived binding. A mismatch or missing binding
is terminal and cannot be repaired with client-supplied identifiers.

## Single-source and fallback state contract

Core must serialize source selection and transitions under the appointment's durable source lease.
UI state is explanatory and is not enforcement.

| Current authoritative state | Desktop action | Zoom-bot action | Required result |
| --- | --- | --- | --- |
| No source selected | Preflight only; no audio | Unavailable until explicitly selected | No provider may capture |
| Desktop selected, not started | Start after immediate authority recheck | Available only after an atomic fallback request | Exactly one source wins |
| Desktop start proven `never_started` | Disabled after fallback selection | May be explicitly selected for a Zoom appointment | Desktop capability revoked before bot creation |
| Desktop start or stop uncertain | Stop/quit and reconcile | Disabled | Lease remains held; no second recorder starts |
| Desktop recording was ever confirmed | Stop only | Disabled for the remainder of the micro-beta visit | No mid-meeting handoff |
| Desktop stopped | No silent resume | Disabled for the remainder of the micro-beta visit | Transcript may be incomplete and requires review |
| Zoom bot selected or active | Disabled | Existing explicit bot controls only | Desktop ticket/capability cannot be issued |
| Consent revoked | Stop and reconcile | Stop and reconcile | No fallback or restart |
| Session complete | Disabled | Disabled | One terminal source history is retained |

Fallback is permitted only when every condition below is true:

- The appointment is a supported Zoom appointment.
- Desktop audio was never confirmed started.
- The desktop SDK is confirmed shut down and provider-side absence or `never_started` evidence is
  durable; a timeout, process exit, or missing callback is not proof.
- Core atomically closes or transfers the desktop source lease, revokes every desktop capability,
  and records a metadata-only audit event before creating or arming a bot.
- The clinician explicitly confirms the source change, and Zoom's participant and recording-consent
  experiences remain visible to meeting participants.

Fallback is never automatic. A desktop interruption after confirmed start does not launch the bot.
The clinician sees that capture is stopped or uncertain, is told not to assume the visit is being
recorded, and continues without Cosmas capture or ends the visit. Any captured segment is marked
incomplete and cannot automatically make documentation ready.

## Required user experience

Core's appointment surface presents one authoritative `Recording source` state and, before capture,
two distinct actions for eligible Zoom appointments:

- **Start with Desktop Scribe** — the primary path; opens the companion and leaves the bot disabled.
- **Use Zoom bot instead** — an explicit fallback available only while the server proves Desktop
  never started.

Meet appointments show only the Desktop action. The product must never imply that a Zoom bot can join
Meet.

The desktop companion must distinguish these states without optimistic language:

- `Not recording — checking setup`
- `Ready — recording has not started`
- `Recording`
- `Stopping — do not close Cosmas`
- `Capture status uncertain — do not start another recorder`
- `Stopped` or `Could not record`

During an uncertain state, source buttons are disabled everywhere. Closing or minimizing the window
must not hide the native warning. Recovery requires backend reconciliation; a client timer cannot
release the source lease.

## Feature and release controls

Every control is false or empty in source and in every environment until a separately reviewed
activation decision. All required gates compose with logical AND; no flag can bypass a failed
authority, consent, source, provenance, signing, retention, or acceptance check.

| Control | Initial value | Required semantics |
| --- | --- | --- |
| Desktop packaging (`packagingEnabled`) | `false` | No distributable production artifact |
| Real desktop capture (`captureEnabled`) | `false` | Recall native capture cannot load or start |
| Clinical release (`clinicalReleaseApproved`) | `false` | PHI and patient-care use remain prohibited |
| Recall meeting-platform allowlist (`approvedRecallMeetingPlatforms`) | Empty | Populate only with observed exact Meet and Zoom tokens after both pass |
| Core desktop coordination routes | Disabled/unregistered | No launch, exchange, start, heartbeat, or stop authority is reachable |
| Scribe external transcript ingest | Disabled/unregistered | No desktop transcript can enter the runtime receiver |
| Non-PHI micro-beta cohort | Empty | Only separately approved identities may be added later |
| Zoom-bot fallback | Disabled | Cannot be enabled without the shared durable source lease |

The operational kill switch must block every new desktop start and bot fallback while allowing stop,
callback verification, transcript/deletion reconciliation, and evidence collection for already
created resources. Removing either Meet or Zoom from the accepted platform set closes this launch
profile; continuing with one client requires a new scope decision.

## Acceptance matrix

Evidence for every row records the source commit, companion version, Electron version, Recall package
and native hashes, macOS build, meeting-client version, exact observed platform token, flag snapshot,
timestamp, result, reviewer, and sanitized artifact location. One passing client does not prove the
other.

| Area | Meet Chrome | Zoom Desktop | Launch disposition |
| --- | --- | --- | --- |
| Native detection | Exact `window.platform` observed on the original event | Exact `window.platform` observed on the original event | Block both until both tokens are observed and reviewed |
| Supported runtime | Apple Silicon macOS 14.2 and current supported macOS pass | Same | Block failed OS/build |
| Package integrity | Same signed/notarized artifact; Gatekeeper, nested signatures, hashes, SBOM, and provenance pass | Same | Block distribution |
| Permissions | Accessibility, microphone, and screen/system-audio paths pass and denial fails closed | Same | Block failed client |
| Explicit start | Matching `recording-started` proves physical start; no command result is treated as proof | Same | Block failed client |
| Visible recording state | Renderer and native indicator remain visible and agree | Same | Block failed client |
| Explicit stop | Matching `recording-ended` plus confirmed SDK shutdown proves stop | Same | Block failed client |
| Meeting lifecycle | Tab/window close, browser quit, navigation, and meeting switch fail safely | Leave, end, rejoin, client quit, and meeting switch fail safely | Block failed client |
| Interruption | Network loss, permission loss, sleep, renderer/main-process failure, and forced termination produce stopped or uncertain state without silent resume | Same | Block failed client |
| Multiple meetings | Second meeting or simultaneous Zoom detection fails closed | Second meeting or simultaneous Meet detection fails closed | Block both on any overlap |
| Owner and appointment | Wrong clinician, practice, appointment, consent, or stale ticket fails closed | Same, plus wrong Zoom owner/occurrence fails closed | Block all capture |
| Source race | Desktop is the sole available source | Simultaneous Desktop and bot claims serialize to one winner | Block all Zoom capture |
| Pre-start fallback | Not applicable; no bot fallback | Confirmed `never_started` Desktop lease transfers once to bot | Block Zoom fallback |
| Ambiguous start | Bot remains disabled while reconciliation is pending | Bot remains disabled while reconciliation is pending | Block all fallback |
| Mid-meeting failure | No bot handoff; mark incomplete | No bot handoff; mark incomplete | Block automatic note readiness |
| Transcript handoff | One completed transcript is ingested and dispatched once | Same | Block affected client |
| Retention and deletion | Explicit bounded provider retention and confirmed deletion/absence | Same for Desktop and bot resources | Block affected client |
| No-PHI evidence | Synthetic/de-identified audio only; logs, diagnostics, crash data, screenshots, URLs, and fixtures contain no PHI | Same | Stop test and treat exposure as an incident |
| Kill switch and recovery | New starts stop; active cleanup continues | New starts and fallback stop; active cleanup continues | Block cohort |

The launch gate passes only when every shared row and both client columns pass on the same candidate
artifact and backend contract. A failed client cell cannot be waived by the other client's result.

## Explicitly deferred

- Windows, Intel Mac, Linux, mobile, Teams, other browsers, Meet PWA/companion mode, and additional
  meeting clients.
- Simultaneous or parallel meetings, automatic source selection, automatic fallback, bot standby,
  mid-meeting Desktop-to-bot handoff, bot-to-Desktop fallback, and source switching after any
  confirmed recording start.
- Pause/resume, silent resume, multi-segment transcript merging, gap repair, offline capture, video,
  separate participant tracks, and native dual-channel capture.
- Real patients, PHI, clinical decision-making, autonomous note readiness, EHR writeback, and broad
  clinician or tenant enrollment.
- Production publication, auto-update rollout, app-store distribution, production infrastructure,
  production secrets, and production provider resources.

## Hold points and recovery

This document changes no runtime behavior. Its recovery is a documentation revert. It creates no
schema, data, provider, infrastructure, or artifact rollback obligation.

Implementation must stop before each of these independent decisions:

1. Registering Core coordination or Scribe ingest routes.
2. Creating or migrating persistent state.
3. Loading Recall for real capture or populating either meeting-platform token.
4. Signing, notarizing, publishing, or distributing an artifact.
5. Adding a user or tenant to a non-PHI cohort.
6. Permitting PHI or clinical use.

No passing test, signed artifact, merged pull request, or statement in this contract opens those
gates. Activation and deployment remain separate, explicitly reviewed actions.
