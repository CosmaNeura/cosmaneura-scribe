# Mac operational repair — November 2, 2026

Risk: Tier 2. Owner: John Clemente. Implementation: same-chat agent;
independent source review: root agent. This plan covers the normal Mac client
repair in PR521; it authorizes no production service, cohort or profile change.

When the native IPC queue contains eight pending calls, the next periodic
state observation is deferred. Submitted request deadlines and cancellation
remain active. A native rejection, transport failure, authentication withdrawal
or non-ready state still closes the connection. Other callers retain the
existing unavailable result; recording is never resumed by this change.

Mac releases display “Cosmaneura Scribe for Mac” with version, build,
distribution and the actual packaged environment in About. Internal Electron
names, bundle IDs, native callbacks, Keychain groups and user-data paths stay
unchanged. The direct client migrates deliberately from the legacy date-based
counter to version 1.0.0/build 126 for manual replacement. No automatic updater
is configured; iPhone build numbering remains separate.

Sequence:

1. Complete independent review of the final pushed source, existing checks and
   unresolved conversations; merge the reviewed repair.
2. Compile the complete new host and renderer, including this transport fix and
   PR520 account controls. Preserve the qualified Desktop19 native helpers,
   frameworks and exact schema-1 staging profile. Verify source pins, native
   protocol compatibility and unsigned material independently before signing.
3. Sign the parent with the existing Developer ID identity, verify helper pins,
   entitlements and strict signatures, then deliver the direct staging beta.
   No diagnostic or app launch is part of the package operation.
4. Have the owner manually verify patient selection, record startup, retained
   account/sign-out controls, Pause/Resume, Finish, Save/reopen and Listen on the
   normal client. Record the actual version/build and any failure. Source and
   mocked tests do not replace this operational acceptance.

Recovery: retain the signed Desktop19 package for manual replacement, or revert
the repair and rebuild. Existing user data and the preserved native identities
remain in place. This change makes no database or server migration.

Stop delivery on an unexpected profile/native/framework/identity change,
missing new-host pins or a failed package/signature check. Production-profile
activation, Apple submission and production operational acceptance remain
separate decisions.
