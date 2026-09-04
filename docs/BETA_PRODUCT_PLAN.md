# Scribe non-PHI micro-beta product plan

Status: product scope locked for implementation planning on 2026-09-01.

This document authorizes documentation, decomposition, and implementation planning only. It does
not authorize a merge, Azure apply, deployment, cohort enrollment, real capture, or PHI processing.

Supporting acceptance contracts:

- [`BETA_AUTH_AND_COHORT_PLAN.md`](./BETA_AUTH_AND_COHORT_PLAN.md)
- [`BETA_DESKTOP_CAPTURE_CONTRACT.md`](./BETA_DESKTOP_CAPTURE_CONTRACT.md)
- [`BETA_ENVIRONMENT_PLAN.md`](./BETA_ENVIRONMENT_PLAN.md)
- [`BETA_IOS_AND_BILINGUAL_CONTRACT.md`](./BETA_IOS_AND_BILINGUAL_CONTRACT.md)

## Outcome

Validate the complete Cosmaneura Scribe product with at most three named internal/product testers
using approved non-PHI test data. Desktop and iOS must both be ready before the formal micro-beta
opens. The beta must exercise the same identity, authorization, encounter, capture, transcript,
translation, note, and dashboard contracts intended for live use.

Going live must not require an account migration, a new authentication method, a different client,
or a relearned workflow. The only intended user-visible change is that an authorized clinical
encounter is processed in the clinical Scribe environment and its result appears in the user's
normal Cosmaneura dashboard. This is a release gate, not a claim that software can never fail.

## Cohort and data boundary

- The founder is the only micro-beta inviter.
- MCD participants retain their existing Clerk identity, provider record, practice, and role.
- Non-MCD internal/product testers enter one isolated test-only beta practice through an exact-email,
  expiring, single-use invitation.
- A server-authoritative, revocable Scribe beta grant controls access. Authentication, email domain,
  UI allowlists, or possession of an invitation alone never grants Scribe authority.
- The beta accepts only approved non-PHI test data: synthetic data, verified de-identified data, or
  other test fixtures explicitly approved as non-PHI. Consent alone does not make data non-PHI.
- Every record carries a durable data classification and provenance. No real customer record or
  data containing PHI may enter the beta.
- Practice membership supplies tenant context but does not grant access to another creator's
  appointments, recordings, transcripts, translations, or notes.

### Permitted test-data classes

- **Synthetic:** generated or fictional data that does not describe a real person or customer.
- **Verified de-identified:** data transformed outside the beta through an approved de-identification
  process and verified as containing no PHI before ingestion.
- **Other approved test data:** licensed benchmark, public-domain, generated, or purpose-built
  fixtures with a recorded owner, source, permitted use, and explicit non-PHI approval.

Every accepted record must identify one of these classes. Unknown, unclassified, merely
“consented,” or real customer data fails closed.

## Shared product journey

1. The user authenticates through the existing Clerk/Core flow.
2. Core verifies the user's identity, active membership, beta grant, data mode, and device/client
   scope.
3. The user selects an eligible test appointment they own or creates an unscheduled test encounter.
   A name-and-date-of-birth workflow uses conspicuously fictional values; de-identified and other
   approved fixtures retain their recorded non-PHI classification and provenance.
4. Possible patient matches are shown for explicit confirmation. The system never silently merges or
   assigns a patient from name and date of birth.
5. A newly confirmed patient and appointment are created atomically and idempotently, attributed to
   the creating user, labeled as Scribe-created, and shown immediately in that user's dashboard.
6. The user confirms the required consent state and explicitly starts capture.
7. Encrypted capture data is uploaded with visible progress, bounded retry, interruption recovery,
   and a durable terminal result.
8. Scribe produces a source-language, speaker-labeled transcript.
9. For the bilingual profile, Spanish segments are translated to English and combined with the
   original English segments into a provenance-preserving English working transcript.
10. Core generates an English draft note from the English working transcript. The user reviews,
    edits, and approves the note.
11. The user can review their own recording status, source transcript, English working transcript,
    note, and deletion/retention state from the limited dashboard.

## Desktop profile

- Signed Electron application on Apple Silicon macOS.
- Google Meet in Chrome and Zoom Desktop are both required acceptance cells.
- Online, audio-only mixed capture with explicit Start and Stop, a persistent recording indicator,
  elapsed time, and visible interruption/uncertain-capture state.
- Exactly one detected meeting and one capture source may be active.
- Desktop Scribe is the primary Zoom source. The existing Zoom bot is an explicit pre-start fallback
  only and cannot remain armed while Desktop capture is reserved or active.
- Automatic or mid-meeting source switching, transcript stitching, and silent recovery are excluded.

## iOS profile

- Signed internal TestFlight distribution, ready when the desktop beta opens.
- Foreground native audio capture only.
- The same authentication, beta-grant, encounter-selection, consent, ownership, transcription,
  translation, note, and dashboard contracts as desktop.
- Native session-key custody, encrypted durable queue, upload retry/recovery, local purge, and
  explicit interruption behavior.
- Background/lock-screen capture and Android are excluded.

## English/Spanish profile

- Manual capture mode: `English` or `Bilingual English/Spanish`.
- The bilingual target assumes an English-speaking provider and a Spanish-speaking patient but must
  identify and preserve the actual locale of each recognized phrase rather than infer language from
  speaker role.
- Candidate locales are initially `en-US` and `es-US`.
- English source segments remain unchanged. Spanish source segments receive a separate English
  translation. The immutable source segment, detected locale, translated segment, provider/model
  version, timestamp, and correction history remain distinguishable.
- The ordered English working transcript contains original English segments plus reviewed English
  translations of Spanish segments and is the input to English note generation.
- Bounded automatic English/Spanish language identification may ship as an experimental beta option;
  manual mode remains authoritative.
- Reliable language changes within one sentence, broader Spanish locale coverage, live
  interpretation, and translation into Spanish are excluded.

## Limited dashboard

The beta surface contains only:

- the user's own eligible and Scribe-created appointments;
- the user's own capture status and history;
- the user's own source and English working transcripts;
- the user's own draft and approved notes;
- profile, support, sign-out, and device/session revocation.

No practice-wide clinical content, billing, CAB, Sovereign, public onboarding, EHR writeback, or
unrelated administrative surface is part of the micro-beta.

## Non-negotiable invariants

- No PHI or real customer data in beta input, fixtures, logs, diagnostics, support artifacts, or
  telemetry.
- Every data read and mutation is scoped to the verified creator and tenant on the server.
- Core derives identity, tenant, patient, and appointment authority; clients cannot assert them.
- Consent precedes capture and processing.
- Capture ownership is exclusive across Desktop, Zoom bot, mobile, and any future source.
- A source in an uncertain state blocks another source until reconciliation proves it stopped.
- Original transcripts are never overwritten by translation or correction.
- Revoking a beta grant prevents new launches and invalidates pending tickets, refresh material, and
  active capture authority.
- Feature flags begin false and are scoped independently by environment, cohort, client, meeting
  platform, language mode, and translation capability.

## Delivery work packets

1. **Contract freeze and repository canonicalization** — preserve existing work, establish the
   current `main` baseline, replace oversized historical tranches with small dependency-ordered
   changes, and publish acceptance contracts.
2. **Identity, invitation, and beta authorization** — reuse Clerk/Core; add founder-issued
   exact-email invitation acceptance, durable beta grants, revocation, and creator-only access.
3. **Dedicated beta environment** — provision an isolated non-PHI Core/Scribe runtime and data plane,
   private service path, immutable artifacts, monitoring, rollback, and kill switches while retaining
   the existing Clerk identity experience.
4. **Encounter and dashboard** — add owner-scoped appointment selection, explicit patient-match
   confirmation, atomic Scribe-created encounters, and the limited dashboard.
5. **Shared bilingual pipeline** — carry per-segment locale through transcription and handoff,
   translate Spanish segments to English, construct the English working transcript, and preserve
   provenance through note generation.
6. **Desktop client** — land the signed macOS companion, Meet and Zoom adapters, durable source lease,
   and pre-start-only Zoom bot fallback.
7. **iOS client** — land native foreground capture, secure key/queue custody, recovery, PKCE, signing,
   and TestFlight distribution against the same contracts.
8. **Exact-artifact acceptance** — exercise every supported client/language/source cell, owner and
   tenant isolation, authentication lifecycle, revocation, failure recovery, deletion, rollback, and
   the beta-to-live identity transition before cohort enrollment.

## Release gates

The micro-beta does not open until desktop and iOS exact artifacts pass, the invitation and
creator-only boundaries pass, and a complete approved non-PHI test recording reaches an English
note. Clinical activation remains separately blocked on PHI, security, legal, vendor, operations,
and exact-runtime evidence.

The live transition does not proceed if any named tester fails existing-account login, new-account
invitation, logout/login, token refresh, application restart, account recovery, revocation, or
same-identity dashboard delivery. Passing these tests removes known migration risk; it does not
justify an absolute guarantee that an authentication provider or network can never fail.
