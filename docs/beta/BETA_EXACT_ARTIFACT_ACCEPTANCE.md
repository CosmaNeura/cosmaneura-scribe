# Closed-beta exact-artifact acceptance

## Purpose

Closed-beta readiness is earned by the exact backend, desktop, and iOS artifacts that will be given
to testers. Passing source tests, simulator tests, or an earlier build does not promote a later
artifact. This runbook defines the evidence package; it does not authorize deployment, signing,
distribution, invitation, or PHI.

## Evidence identity

One acceptance run records only non-PHI metadata:

- Scribe and Core Git commit SHAs;
- immutable container image digest for each deployed service;
- database migration head and bootstrap-policy version;
- environment identifier and synthetic tenant/practice identifiers;
- desktop package version, SHA-256 digest, signing identity, notarization result, and macOS version;
- iOS bundle version/build, archive digest, signing team, TestFlight build identifier, and iOS
  version;
- translation adapter and model-profile identifiers;
- test case ID, start/end timestamps, pass/fail, bounded failure code, and evidence-file digest; and
- operator/founder decision time and the exact artifact set accepted.

Do not record email, name, DOB, transcript text, audio/blob URL, object name, invite token, access
token, cookie, provider response, or database query/bind values. Screenshots and recordings require
the same synthetic-only review before retention.

## Required closed-beta scenarios

1. Existing MCD identity: sign in through the stabilized existing Clerk path, receive the beta
   grant without identity migration, refresh/restart clients, and prove session continuity.
2. Outside-MCD identity: founder invite, exact-email Clerk registration/sign-in, single first
   redemption, active grant, expiry rejection, replay rejection, and revocation.
3. Creator isolation: own items appear; same-practice and cross-practice artifacts created by
   another tester are absent from lists and denied by direct identifier.
4. Google Meet in Chrome: explicit consent and start, persistent recording indicator/timer,
   provider and patient audio, explicit stop, upload completion, and dashboard appearance.
5. Zoom Desktop: the same checks using local desktop capture. The meeting bot is exercised only as
   an explicit pre-start fallback, never as an automatic mid-session switch.
6. iOS: foreground capture through interruption, retry, encrypted queue recovery, explicit resume,
   server receipt, local purge, and dashboard appearance. Lock/background never silently records.
7. Bilingual flow: run `bilingual_source_to_handoff_v1.json`; translate every Spanish segment to
   English, require creator review, retain source evidence, and prove only the accepted English
   projection enters note handoff.
8. Encounter binding: select one existing creator-owned synthetic appointment; separately create an
   unscheduled synthetic encounter with name/DOB input, require explicit possible-match choice,
   avoid auto-merge, and show the result immediately in the creator's dashboard.
9. Failure controls: revoke consent, session, beta grant, and capture lease independently; inject
   offline/retry, provider timeout, upload uncertainty, duplicate mutation, stale source, and app
   interruption; prove fail-closed state, bounded UI, and no duplicate note.
10. Retention/deletion: perform the approved synthetic expiry/purge scenario and prove content is
    unavailable while metadata-only audit evidence remains.

## Acceptance rule

Every required scenario must pass on both distribution clients where applicable, against the same
candidate backend digests and database head, with no severity-1 or severity-2 defect and no open
auth, creator-isolation, consent, data-loss, silent-recording, duplicate-note, or PHI-boundary
finding. A rebuilt, resigned, re-notarized, re-uploaded, reconfigured, or redeployed component
invalidates only the evidence that depends on that component, but the affected scenarios must be
rerun before invitation.

## Stop and rollback order

On a security, identity, consent, capture-state, data-integrity, or privacy failure: stop new
invitations, stop new capture sessions, stop translation execution, stop note handoff, revoke beta
grants, preserve metadata-only evidence, and use the approved retention process for content. Do not
silently fall back from desktop capture to a meeting bot, change identity paths, retry an ambiguous
provider operation, or promote a different artifact to salvage a run.
