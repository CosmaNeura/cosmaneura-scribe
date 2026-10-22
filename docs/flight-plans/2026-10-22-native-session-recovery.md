# Flight plan: stop false native-session recovery

## Outcome and boundaries

- A failed fresh native token must remain unavailable across passive SDK-state
  polls. Providers can deliberately sign out and sign in again after workspace
  closure completes, instead of alternating between unavailable and reopen.
- Scope: native token-failure state, cancellation/timeout distinction, existing
  sign-out recovery UI, and synthetic regression checks. No renderer credentials,
  token-policy relaxation, backend access changes, or automatic recording restart.
- Affects the native iPhone and Mac provider host. The reported external-test
  failure is iPhone TestFlight 79; its underlying token-failure cause remains
  unconfirmed until account-specific, nonclinical evidence is available.

## Risk and dependencies

- Tier 2: authentication state and recording/workspace cessation boundaries.
- One independently releasable Scribe PR. Existing native APIs and receiver
  contracts remain unchanged; no Core PR or receiver-first rollout is required.
- Distinguish caller cancellation from timeout: cancelled reads must discard
  late tokens while preserving an otherwise valid session. Actual token errors
  and timeouts retain the failure fence. Sign-in/out abandonment stays blocked.

## Current deployed state

- iPhone 79 qualification records source commit
  `10bb9c489b5fadbcd00d2a44fc532455f0c702cb`, source tree
  `3abd0d53f7085596eeee76d0708baf578e6fe52a`.
- Its public native config selects `core-staging-personal-v1`, Clerk frontend
  `https://resolved-emu-53.clerk.accounts.dev`, and the staging native receiver.
- The retained Mac 119 source and this PR base are Scribe main
  `d53be753925d6f55a1dc2199317c7add7d16ff38`. The false-ready logic exists in both
  source snapshots. The build-79 and base provider application sources match.
- Retain current Core main, deployed Session Prep changes and migrations. This
  change performs no Core image restoration or deployment.

## Feature flag / release control

- Release through a new, versioned TestFlight binary after local checks and an
  independent review of the final pushed commit. First cohort: existing Shawn
  and Christa external-test group, as authorized by the owner.
- Owner controls broader App Store/production promotion. Existing builds remain
  preserved; installing an older build requires an idle recorder and saved work.
- No runtime flag: the authentication fence is a correctness requirement, not a
  selectable bypass. Binary version is the release control.

## Schema/data sequence

N/A: no schema, migrations, account enrollment, clinical reads, or data writes.
All automated rehearsals use synthetic identities and in-memory drivers.

## Rollout and promotion

1. Reproduce failed-token metadata recovery on unchanged source.
2. Run native failure/cancellation/mutation tests and provider UI checks;
   typecheck, lint and test the affected provider integration.
3. Push one PR; independent non-implementer review must cite its final SHA in a
   durable PR comment. Actions remain disabled; label local evidence accurately.
4. Build and sign a new iPhone TestFlight artifact from the reviewed source,
   verify source/configuration provenance and preserve existing recording data.
5. Confirm Apple processing and external-test availability, then check a fresh
   sign-in and synthetic workspace journey in the reported environment.

- Abort if passive polling restores the failed identity to ready, cancelled
  requests invalidate a healthy session, late SDK completion opens access after
  abandonment, or recovery bypasses an unconfirmed recorder/workspace stop.
- No production promotion workflow is available; founder-only promotion remains
  separate from the source fix and external staging tests.

## Security and recovery

- Token issuer, identity, session, organization, app binding and expiry checks
  remain enforced. Tokens remain native and are not retained by the failure
  fence. No new security acceptance or credential access is required.
- Sign out is offered only through the existing operation and cessation guards.
  Saved work is retained; recovery does not start recording.
- Hold a failed beta binary from further distribution and release a corrected
  forward build. No Core rollback, database rollback or destructive cleanup.

## Completion

- Local validation: 17 Swift auth checks, including the shipped personal staging
  profile; 25 checks of the compiled provider DOM; 74 native-backend/iOS-host
  integration tests; capture typecheck and affected-file lint all pass.
  [Evidence](../evidence/2026-10-22-native-session-recovery.json) binds those
  results to the tested source bytes. Both the native fence and recovery control
  regressions failed on the relevant unchanged baseline before passing.
- An existing harness assertion was corrected from "reopen this encounter" to
  the current UI text "reopen this visit"; its behavioral recovery assertions
  remain intact.
- Required evidence: regressions fail on unchanged relevant source and pass on
  the reviewed change; local validation and independent review identify the
  exact source; new beta availability is verified separately from source tests.
- Do not claim Shawn's underlying account/token failure is fixed solely from
  the offline loop reproduction. Account-specific diagnosis and installed-build
  verification are distinct completion evidence.
- No irreversible cleanup is planned. Update this plan with actual validation
  and rollout receipts as each hold point is completed.
