# Scribe beta authentication and cohort plan

**Status:** Locked design for implementation planning

**Scope:** Invite-only, one-to-three-person, synthetic-data beta
**Deployment authority:** None. This document authorizes no code, schema, identity,
network, configuration, cohort, or production change.

## Decision

Clerk remains the only human identity system. Core remains the authority for
account, practice, encounter, consent, and beta eligibility. Scribe does not gain
a user directory or accept Clerk credentials directly.

The desktop authorization-code/S256 PKCE flow is a delegation from an already
authenticated Core browser session, not a second identity provider. Entra remains
workload-to-workload authentication between Core and Scribe; it is not a user
sign-in path. This preserves the existing boundary in
[`MASTER_PLATFORM_HANDOFF.md`](./MASTER_PLATFORM_HANDOFF.md): staff use Clerk,
while Scribe uses a narrowly scoped managed identity.

The resulting path is:

```text
Founder invitation
  -> normal Core/Clerk sign-in
  -> exact-email invitation acceptance
  -> Core practice context + active Scribe beta grant
  -> owner-bound synthetic encounter + consent
  -> short-lived Core launch ticket
  -> system-browser S256 PKCE
  -> short-lived, session-scoped Core desktop bearer
  -> private Core-to-Scribe workload call
```

An invitation, email domain, successful Clerk sign-in, launch ticket, or PKCE
proof alone never authorizes capture.

## Cohorts

| Cohort | Identity | Practice binding | Beta authorization | Data boundary |
| --- | --- | --- | --- | --- |
| MCD legacy | Existing Clerk subject and verified primary email | Production practice and role remain unchanged; the beta environment uses a non-production projection bound to the same subject | Founder-issued Scribe beta grant | Only an owner-bound, durably marked synthetic encounter |
| Non-MCD external/internal tester | Normal Clerk account accepted only after an exact-email invitation | One isolated synthetic beta practice, workforce role | Invitation acceptance atomically creates membership and Scribe beta grant | Only that tester's owner-bound synthetic records |

For the MCD cohort, select only users whose current production practice binding is known and
active. The isolated beta database may project that same verified subject into the synthetic beta
practice, but it must not mutate, guess, or duplicate the user's production membership. If a
desired tester lacks a safe production binding, exclude that tester from this beta rather than
broadening the production tenancy model.

The non-MCD practice is an authorization container, not a shared clinical chart.
Each tester can read and mutate only records owned by that tester. Other testers,
practice members, and the founder cannot browse another tester's transcript or
capture artifacts merely because they share the beta practice. Founder authority
is limited to invitation, grant, and revocation metadata.

## Invitation and grant lifecycle

Only the founder may issue, reissue, or revoke an invitation or beta grant.
Practice owners cannot expand the cohort.

1. The founder chooses one normalized email, one cohort, one fixed practice, and
   the allowed client surfaces (`desktop`, `ios`). Core stores only a
   digest of the bearer token, an email digest plus the normalized email needed
   for safe administration, expiry, issuer, target practice, and metadata-only
   audit evidence.
2. The invitee follows the link and signs in through the ordinary Core Clerk UI.
   Any Clerk factor approved for that environment may be used. Core requires the
   current Clerk subject and exact verified primary email to match the invitation.
3. Acceptance is single-use, idempotent, and atomic. For MCD it preserves the
   existing membership and adds only the beta grant. For a non-MCD tester it
   creates the single synthetic-practice membership and the beta grant together.
   A conflicting identity, membership, email change, expired token, revoked
   token, or replay fails closed.
4. The accepted invitation becomes immutable terminal evidence. Runtime access
   comes from the separate beta grant, which records subject, doctor, practice,
   cohort, allowed client surfaces, `synthetic_only=true`, issue/expiry times, and
   revocation state.
5. Revoking a pending invitation prevents acceptance. Revoking an accepted grant
   blocks new launches and capabilities immediately, revokes pending launch
   tickets/codes and active desktop sessions, and causes the client to stop and
   purge beta credentials and queued synthetic material on its next authoritative
   contact. Clerk access to unrelated Core features is unchanged.

Core already contains the durable invitation primitives—hashed bearer,
normalized invitee email, expiry, idempotency, and mutually exclusive accepted
or revoked terminal states—in its
[`PracticeInvitation` model](https://github.com/CosmaNeura/cosmaneura/blob/8fa02a71f4b880cd43f4fccc8c81c92a0d635623/app/models/public_onboarding.py#L85-L186).
The beta must add or port a small founder-only receiver; the schema by itself is
not an active invitation flow.

## Reused authorization boundaries

- Core's existing Clerk middleware, verified-primary-email checks, Doctor
  binding, duplicate-account recovery, practice access decision, and membership
  constraints remain authoritative. An uninvited user may authenticate, but every
  Scribe operation returns a generic denial without an active beta grant.
- The provider-neutral launch-ticket/code/token design from
  [Core PR #140](https://github.com/CosmaNeura/cosmaneura/pull/140) is reused only
  as a decomposed contract on current Core. It binds the browser's authenticated
  actor and practice to the appointment, installation thumbprint, one-use launch
  ticket, S256 challenge, redirect URI, one-use code, and short-lived bearer.
  PR #140 is not merged or activated by this plan.
- The desktop owns PKCE verifier and random state, uses the system browser, and
  keeps the resulting bearer in the Electron main process and OS-protected
  storage. The accepted design keeps authentication replaceable and separate
  from capture authority; see the
  [desktop authentication ADR](https://github.com/CosmaNeura/cosmaneura-scribe/blob/d30e376cfc9e2aa20398068c6d4bca5dc06d98be/docs/adr/0022-replaceable-desktop-authentication-and-bound-lifecycle-receipts.md#L16-L57).
- Core derives tenant, actor, patient, and appointment. The client never supplies
  tenant authority. Scribe accepts only the private Core workload identity and
  tenant context. The native-client boundary already rejects direct user-token
  authentication on Scribe in
  [ADR 0016](./adr/0016-authenticated-private-client-capture-path.md#keep-user-authentication-and-workload-identity-at-the-platform-boundary).
- Consent, source lease, one-time capture capability, idempotency, and explicit
  start/stop remain mandatory. The existing desktop acceptance matrix makes
  short-lived, single-use, PKCE-bound launch and tenant/encounter failure closed
  requirements, not optional beta shortcuts
  ([`DESKTOP_CAPTURE_PHASE0.md`](./DESKTOP_CAPTURE_PHASE0.md#acceptance-matrix)).

## Minimum implementation slices

1. **Core beta admission:** founder-only invitation issue/list/revoke plus atomic
   exact-email acceptance, and a durable Scribe beta grant with expiry and
   revocation. Do not restack or activate the broad stale public-onboarding work.
2. **Synthetic encounter provisioning:** list only creator-owned appointments and allow the creator
   either to select one or enter a conspicuously synthetic patient name and DOB for a new
   unscheduled encounter. Search only that creator's records, show possible matches for explicit
   confirmation, never auto-merge, and create the patient and appointment atomically and
   idempotently with durable synthetic and Scribe-created provenance. No tenant ID, meeting URL, or
   real patient data is accepted from the client.
3. **Core desktop receiver:** port the smallest current-master-compatible launch,
   authorize, token, and lifecycle slices receiver-first. Apply the beta-grant
   and synthetic-provenance decision at launch and recheck it on authorization,
   exchange, refresh, capability issue, and lifecycle mutation.
4. **Desktop consumer:** adopt the existing system-browser PKCE adapter and secure
   state storage after the canonical Scribe source line is established. No
   password, Clerk token, invite token, tenant selector, or Scribe credential
   enters the desktop renderer.
5. **Revocation and evidence:** prove invite replay denial, wrong-email denial,
   cross-tenant denial, grant/session revocation, safe stop, local purge, and
   metadata-only audit output using synthetic fixtures.

iOS consumes the same Core admission and authorization decision in the initial micro-beta. It must
not create a separate mobile identity or direct-to-Scribe user-token path.

## Synthetic-data and environment boundary

No real patient name, DOB, recording, meeting, transcript, appointment, or chart identifier may
enter this beta. The creator may exercise the name+DOB workflow only with conspicuously synthetic
values. Matching is owner-scoped, advisory, and requires explicit confirmation; it never silently
merges identities. Every accepted encounter must carry durable synthetic provenance, and the server
must reject an otherwise valid user, grant, or PKCE exchange if that provenance is absent.

The existing public capture preview is useful protocol evidence but is not this
beta: it has no Core BFF, clinical authentication, Scribe API, production storage,
or microphone path, as documented in [`CAPTURE_PREVIEW.md`](./CAPTURE_PREVIEW.md).

The beta reuses the existing Clerk identity plane and stable subject while isolating the Core/Scribe
runtime data, storage, synthetic practice, and private service path. It does not introduce a third
auth provider or require an identity migration at live activation. The exact environment topology
must prove issuer/audience/callback isolation and prevent beta credentials or data from reaching
production.

MCD's production account, practice, and role remain unchanged. The isolated beta environment maps
the same verified Clerk subject to non-production authorization state and synthetic records. A live
transition must be rehearsed with the same identity and client and is blocked by any login,
membership, token-refresh, or dashboard-delivery regression.

## Production transition gates

None of the following is satisfied or authorized by this document:

- canonical Scribe source line and small, current-base Core receiver PRs accepted;
- isolated Clerk, private networking, workload identity, tenant mapping, storage,
  retention, and diagnostics reconciled to the exact deployed revisions;
- founder invitation and grant lifecycle independently reviewed, including
  email-change, duplicate-account, one-practice, replay, rate-limit, and
  revocation races;
- signed/notarized desktop build and supported-device acceptance completed;
- end-to-end synthetic acceptance proves consent, PKCE, one owner, one tenant,
  one capture, idempotent delivery, stop/recovery, purge, and no sensitive logs;
- kill switch, cohort expiry, support owner, incident response, recovery, and
  rollback rehearsed;
- explicit founder promotion decision for the exact merged source and immutable
  artifact; and
- a separate privacy, legal, security, and clinical-safety decision before any
  PHI-bearing test or broader cohort.

Until those gates pass, all relevant flags remain false, no invitation is sent,
no tester is provisioned, and no desktop or mobile build is distributed.

## Principal risks

- confusing authentication, invitation possession, or PKCE proof with runtime
  authorization;
- assigning an MCD identity to the wrong practice or violating the one-practice
  membership constraint;
- forwarded/replayed invitations or an email change binding access to the wrong
  Clerk account;
- revocation that blocks new launches but leaves a bearer, capability, local
  queue, or capture session usable;
- accidental PHI entry or visibility of existing MCD clinical records;
- practice-wide visibility defeating owner-only beta data;
- a synthetic membership unintentionally affecting seat or billing state;
- weakening private networking by exposing Scribe directly; and
- merging stale broad Core/Scribe branches instead of restacking small,
  receiver-first slices on the canonical sources.
