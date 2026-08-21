# Desktop capture acceleration: Phase 0 plan and acceptance matrix

**Status:** Approved for implementation; clinical activation disabled

**Date:** 2026-08-21

**Governance:** `cosmaneura-architecture/adr/0018-recall-desktop-sdk-is-a-replaceable-capture-adapter.md`

**Shared contract:** `cosmaneura-architecture/contracts/desktop-capture.md`

## Outcome

Deliver a signed Electron companion that a clinician launches from an existing appointment to
record a consented Zoom Desktop or Google Meet visit. The first capture adapter is the exact pinned
stable Recall Desktop SDK, isolated in Electron's main process behind a provider-neutral Cosmaneura
interface and narrow preload bridge. Its authoritative asynchronous transcript appears in the existing clinician dashboard and
note workflow for clinician correction. The product does not write to an EHR.

In this plan, **clinician** means the healthcare professional using Cosmaneura and **capture
provider** means the external recording/transcription vendor.

The reviewed implementation baseline is `@recallai/desktop-sdk` 2.0.28 (stable on 2026-08-21).
Dependency addition must reverify that version's official release provenance, resolve and record the
native binary hashes it installs, and pin the complete dependency graph; it must not float to a newer
stable or nightly release.

The Desktop SDK is an accelerator, not the product boundary. The companion, consent flow, canonical
encounter, provider-neutral session state, transcript handoff, deletion evidence, and dashboard must
survive replacement with native separate microphone/system capture.

## Frozen pilot scope

### Included

- Apple Silicon macOS 14.2 or newer and Windows 10/11 x64.
- Zoom Desktop and Google Meet in Chrome.
- Audio-only online capture using one mixed stream.
- One clinician and one patient on an existing canonical platform appointment.
- Explicit clinician start, explicit stop, and a persistent visible recording indicator.
- Existing meeting bot as a mutually exclusive fallback, selected before capture.
- Appointment scratchpad, transcript status, editable clinician-reviewed note, and manual EHR
  transfer outside Cosmaneura.
- Immediate provider-media deletion after durable transcript ingestion, with durable evidence and
  reconciliation.

### Deferred

- Intel Mac, mobile, Linux, Teams, Doxy, Meet PWA/companion mode, Safari/Edge claims, and any meeting
  client not explicitly accepted.
- Video, automatic start, offline capture, silent resume, parallel meetings, and separate audio
  tracks.
- More than one clinician or one patient, autonomous EHR writeback, and production-grade native
  dual-channel capture.
- Zero-data-retention mode; it requires its own transcription-quality and delivery acceptance.

## Non-negotiable invariants

1. The platform derives tenant, actor, and encounter authority; the companion and capture provider
   do not.
2. Immutable consent evidence and an exclusive source lease exist before any capture capability or
   audio start. Revocation closes authority and stops capture through the bounded control channel.
3. Desktop and bot capture never overlap for one encounter.
4. No provider API key, workload token, patient identifier, meeting URL, or retention authority is
   shipped to the companion.
5. Vendor vocabulary ends at the adapter. Domain state uses the shared desktop-capture contract.
6. The SDK package and native binary are pinned exactly and advance only through the full matrix.
7. Real-time audio/transcript data is provisional. Only the completed asynchronous transcript may
   enter the note pipeline.
8. Provider speaker attribution is advisory. Missing, overlapping, or uncertain segments require
   clinician review; the system never invents speech to close a gap.
9. Provider retention is explicit and no more than six hours for the pilot. Account-default or
   omitted retention fails closed. Durable ingestion immediately schedules deletion.
10. Logs, audit metadata, analytics, crash diagnostics, support bundles, deep links, and
    notifications contain no PHI, transcript/audio, meeting text/URL, secrets, or provider payloads.
11. The clinician scratchpad is a priority note-generation input; clinician-authored and generated
    text remain distinguishable; material generated claims retain transcript-segment provenance.
12. This profile does not persist raw/mixed audio in platform or Scribe storage and does not inherit
    Scribe ADR 0013's proposed 30-day raw-audio window.
13. Security and HIPAA controls are tested throughout every phase, followed by an independent,
    comprehensive release review before the first PHI pilot.

## Work packages and gates

| Phase | Deliverable | Can run in parallel | Exit gate |
| --- | --- | --- | --- |
| D0 | Governance ADR, provider-neutral contract, frozen scope, acceptance matrix | Companion threat model and synthetic Electron-main-process research | Cross-repo ownership and invariants agree; no clinical flag or external resource changed |
| D1 | Signed-callback verification, durable inbox/dedupe, sanitized logging, explicit retention on the existing provider adapter | D3 package-only scaffold with synthetic adapter | Forged/replayed callbacks fail; redaction tests and bot regression pass; no default retention remains |
| D2 | Durable coordination session, consent/source lease, tickets/capabilities, normalized segments, cleanup ledger | D3 renderer/preload IPC against generated mocks; D4 wireframes | Tenant/isolation/idempotency/uncertain-create/deletion-state tests pass; real start remains false |
| D3 | Hardened Electron shell, pinned Electron and SDK, local meeting detection, explicit controls/indicator, interruption UX | D4 dashboard against mocks; D5 report-only reconciler | Signed local builds pass synthetic IPC, renderer isolation, permission, crash, sleep, network, stop, purge, and no-PHI gates |
| D4 | Appointment launch, priority scratchpad/status, transcript/note review with authorship and claim provenance | D5 operations, packaging, support runbook | Canonical appointment and bot exclusivity tests pass; one transcript dispatches note generation once; user input and transcript support remain traceable through edits |
| D5 | Retention/deletion reconciler, alerts, kill switch/fallback, signing/update/rollback | D6 synthetic matrix preparation | Provider/local absence evidence, overdue alert, rollback, and active-session drain drill pass |
| D6 | Exact-platform acceptance and allowlisted pilot | Native adapter spike may start if an exit criterion is already met | Every required row below has dated evidence; named approver enables only the passing combinations |

No downstream phase can activate a real-provider behavior before all preceding exit gates on that
behavior pass. Parallel work uses synthetic or de-identified fixtures and false-default flags.

## Phase 0 deliverables

- Architecture ADR 0018 amends ADR 0012 to use Electron for the accelerated pilot without replacing
  the native dual-channel destination; a later Tauri/native shell remains an explicit option.
- `contracts/desktop-capture.md` defines authority, state, IDs, consent/source gates, tickets and
  capabilities, provider callbacks, idempotency, segment recovery, retention, and deletion proof.
- This file freezes scope, phase ordering, parallel lanes, and the evidence matrix.
- `docs/PLAN.md` promotes the desktop lane and names the initial adapter limitations honestly.
- The D1 implementation begins from the current provider-boundary inventory; no D0 change enables
  capture, adds a secret, calls a provider, or deploys infrastructure.

## Acceptance evidence matrix

An item is **required** unless its row says otherwise. Evidence records the commit, exact companion
version, exact SDK/package/native-binary version, OS build, meeting-client version, test fixture,
timestamp, result, and sanitized artifact location. A pass on one matrix cell proves only that cell.

| Area | Required evidence | Failure disposition |
| --- | --- | --- |
| Package provenance | Lockfile has exact Electron and SDK versions; native hashes match trusted release; SBOM and license scan recorded | Block package/build |
| Electron isolation | Renderer loads packaged local-only content through a least-privilege custom protocol rather than `file://` under restrictive CSP; sandbox, context isolation, and web security stay enabled; Node integration, remote module, webviews, insecure/experimental/Blink content, arbitrary navigation/windows, broad permissions, and generic IPC/shell execution are absent; every handler validates channel/schema/top-frame/origin | Block package/build |
| Electron packaging/update | Applicable Run-as-Node, NODE_OPTIONS, CLI-inspection, and unexpected-app-loading fuses are disabled; embedded ASAR integrity is enabled where supported; only signed provenance-verified updates install and downgrade is rejected | Block package/release |
| macOS distribution | Apple Silicon build is signed and notarized; Gatekeeper accepts it; macOS 14.2 and current supported release pass | Block failed OS/version |
| Windows distribution | x64 build is Authenticode-signed; SmartScreen/reputation plan documented; Windows 10 and 11 pass | Block failed OS/version |
| Deep-link launch | Ticket has no PHI, expires in two minutes, is single-use, cannot start capture, and is bound to an authenticated PKCE exchange | Block all launch |
| Tenant/encounter authority | Cross-tenant IDs, body-supplied tenant, wrong clinician, missing/cancelled appointment, and stale user session fail closed | Block clinical activation |
| Consent | Missing, mismatched, expired/revoked consent cannot reach `ready`; start revalidation and bounded remote stop are proven | Block clinical activation |
| Source exclusivity | Concurrent desktop/bot claims serialize; fallback waits for proven stop and lease close; duplicate meeting capture is impossible | Block both sources for tenant |
| Provider capability | No account credential reaches disk/client; grant is single-session/segment, short-lived, replay-resistant, and rejected after revocation | Block real SDK start |
| Callback authentication | Missing, malformed, wrong-secret, stale, replayed, duplicate, and out-of-order callbacks have deterministic safe results | Block provider events |
| Durable idempotency | Timeouts at local reservation, provider create, mapping, start, stop, transcript, note dispatch, delete, and confirmation do not duplicate effects | Block affected operation |
| Zoom Desktop capture | Explicit start/indicator/stop, microphone/system permissions, meeting switch, and one-active-meeting behavior pass on each accepted OS | Block failed cell only |
| Meet Chrome capture | Explicit start/indicator/stop, browser/tab changes, permission changes, and one-active-meeting behavior pass on each accepted OS | Block failed cell only |
| Unsupported client | Intel Mac, unsupported OS/browser/app, PWA/companion mode, second meeting, and video request are detected before capture | Fail closed with bot option |
| Interruption recovery | Network loss, machine sleep, SDK/main-process/renderer crash, update, sign-out, and permission loss end visible capture state; no silent resume occurs | Require reconciliation or new segment |
| Segmentation | Explicit resume creates a new ordered segment; gaps/overlap/truncation are metadata; uncertain/missing segments require review | Block automatic note readiness |
| Transcript authority | Streaming/provisional output cannot dispatch notes; completed async transcript is ingested once and mapped to opaque encounter | Block note dispatch |
| Speaker quality | Mixed-audio diarization and role-label thresholds are measured on de-identified fixtures; provider names remain advisory/correctable | Require clinician review or invoke native exit criterion |
| Scratchpad and provenance | Clinician scratchpad materially informs generation; authorship remains distinct; each material AI claim resolves to supporting transcript segments through edit/regeneration | Block note readiness |
| Existing note pipeline | One accepted transcript creates/replays one platform transcript and dispatches note generation once; clinician edits remain required | Block pilot workflow |
| Retention setting | Every create call proves explicit provider retention of at most six hours; omitted/default/unsupported configuration fails closed | Block provider resource creation |
| Deletion | Success, cancellation, failed start, partial transcript, provider outage, timeout, and duplicate delete all reach confirmed absence or overdue alert | Block expansion; incident on overdue PHI |
| Local custody | No intentional raw-audio persistence; SDK caches/temp files are inventoried, isolated, and absent after stop/crash/uninstall tests | Block affected package/OS |
| No-PHI telemetry | Automated scans and manual review cover logs, standard I/O, crash data, analytics, deep links, notifications, errors, update logs, and support artifacts | Block release |
| Kill switch | New capabilities stop; active sessions drain/stop; transcript and deletion reconciliation continue; bot fallback remains mutually exclusive | Block rollout |
| Upgrade/rollback | Exact SDK upgrade reruns all cells; failed update rolls back without abandoning media or duplicating capture | Keep last accepted version or disable desktop |
| Load/rate behavior | Start/status/callback/reconcile bursts respect provider and platform limits without dropping durable work | Block expansion |
| Incident response | Runbook identifies who disables start, reconciles active sessions/media, contacts provider, notifies compliance, and preserves metadata evidence | Block PHI pilot |
| Final release review | Independent security/HIPAA review covers threat model, Electron/SDK/native dependencies, authentication, tenant isolation, consent, retention/deletion, telemetry, operations, and accepted residual risks | Block PHI pilot |

## Native-adapter decision checkpoint

Start the native dual-channel workstream when a target cohort needs unsupported devices/apps or
offline operation; separate channels are necessary to meet accepted speaker-quality thresholds;
provider retention, deletion, region, telemetry, or incident controls cannot pass; the pinned SDK
cannot remain stable across the required matrix; or provider cost/availability/product direction no
longer supports the approved operating model.

The transition is an adapter replacement. It does not relax consent, tenant authority, explicit
controls, source exclusivity, idempotency, segment recovery, transcript review, or deletion evidence.

## Phase 0 verification commands

These checks are intentionally documentation-only:

```bash
git diff --check
rg -n "Recall|Desktop SDK|desktop_companion|meeting_bot|six hours|6 hours" docs/PLAN.md docs/DESKTOP_CAPTURE_PHASE0.md
rg -n "Intel Mac|Teams|offline|video|EHR writeback|separate" docs/PLAN.md docs/DESKTOP_CAPTURE_PHASE0.md
test ! -e apps/desktop-companion/package.json
```

The final command records that D0 did not turn the reserved companion directory into an
implementation implicitly. D3 owns that scaffold and its dependency review.
