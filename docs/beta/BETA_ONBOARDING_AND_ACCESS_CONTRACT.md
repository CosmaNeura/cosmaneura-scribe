# Closed-beta onboarding and creator-access contract

## Locked outcome

The beta adds an entitlement, not a third authentication system. People authenticate through the
existing Clerk identity path; Core-to-Scribe calls continue through the existing Entra workload
path. The beta grant decides whether an authenticated person may enter the isolated synthetic beta.
It never substitutes for authentication, tenant membership, creator ownership, or fresh
authorization of a sensitive action.

The founder is the only inviter. The cohort contains at most three internal/product testers in one
dedicated synthetic practice. Every appointment, capture, source transcript, translation, English
working transcript, and note is visible only to the provider who created it. Sharing a beta
practice does not grant peer access.

## Existing MCD user

1. The user signs in with the existing MCD Clerk identity and existing session behavior.
2. The founder assigns a revocable, server-enforced beta grant scoped to the synthetic practice.
3. Core evaluates the normal identity and session controls, then the beta grant.
4. The limited beta dashboard lists only artifacts whose immutable creator is that user.

There is no invitation-token exchange and no identity migration for an existing MCD user. This is
the intended seamless launch path, but it is not accepted until exact-artifact regression tests
prove session continuity against the stabilized Auth stack.

## Tester outside MCD

1. The founder issues an expiring, single-use invitation bound to one normalized exact email.
2. The tester signs in or registers through the existing Clerk flow.
3. Core compares the verified Clerk email with the invite, consumes the invite atomically, and
   creates the revocable practice-scoped beta grant.
4. A replayed, expired, revoked, or email-mismatched invitation fails closed and creates no grant.
5. The tester enters the same limited synthetic dashboard and creator-only data policy as an MCD
   tester.

The implementation must store only a one-way token digest, never log the token or email, and bind
redemption, grant creation, and audit evidence in one transaction. Those Core changes are deferred
until the stabilized base is available.

## Authorization truth table

The executable acceptance matrix is
`tests/fixtures/beta/invite_and_creator_access_matrix_v1.json`. It fixes these invariants:

- unauthenticated, revoked-session, revoked-grant, and view-as contexts cannot enter the beta;
- an active tester may create only creator-owned work;
- an active tester may list, read, or review a target artifact only when the practice matches and
  the immutable creator is self;
- a same-practice tester cannot see another tester's artifact;
- an outside-MCD tester is eligible only after one exact-email, unexpired, first redemption; and
- all uncertain or unlisted combinations deny.

## Limited dashboard states

The dashboard may show the creator's own synthetic encounters and these states only:

1. capture configured or in progress;
2. source transcript received;
3. Spanish translation pending or failed;
4. creator translation review required;
5. English transcript ready for note generation;
6. draft or approved note status supplied by Core; and
7. retention, deletion, support, sign-out, and session-revocation controls.

It must not show practice-wide clinical content, another tester's identifiers or artifact counts,
CAB, Sovereign, billing, EHR writeback, or production MCD data. A direct URL or guessed identifier
must enforce the same creator-only decision as a dashboard query.

The machine-checkable UI mapping is
`tests/fixtures/beta/limited_dashboard_state_matrix_v1.json`. It covers every current Scribe
external-session status, exposes translation review only for `review_required`, exposes note
request only for `transcript_ready`, and requires creator authorization for every state.

The dormant review transport in
`services/api/src/cosmaneura_scribe/creator_review_contract_v1.py` fixes the review surface without
adding a route: it returns Spanish source beside the proposed English translation only in
`review_required`. The client can return exact lineage plus accept/reject, but cannot assert the
reviewer identity, review ID, or review time. Core must supply those values only after a fresh
creator-only authorization check.

## Deferred implementation gates

Before any user is invited, the stabilized Core base must implement the invitation and grant state,
fresh creator checks, atomic redemption, metadata-only auditing, revocation, rate limits, session
continuity tests, and direct-object access tests. Desktop and iOS must prove the same authenticated
identity maps to the same immutable creator. No statement in this document authorizes a route,
schema migration, Clerk change, IAM assignment, environment apply, cohort enrollment, or PHI.
