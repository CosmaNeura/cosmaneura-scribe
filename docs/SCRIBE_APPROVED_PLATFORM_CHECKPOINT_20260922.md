# Approved iOS identity and Electron preparation — 2026-09-22

Later update: the owner approved and applied the separate local staging identity
and receiver amendment. See [the staging application checkpoint](SCRIBE_STAGING_PATCH_APPLIED_20260922.md).
That record supersedes the pending issuer/profile discussion below; runtime
activation and installed acceptance remain outside the applied scope.

The owner explicitly approved the iOS identity/build proposal and Electron
dependency/install proposal. This checkpoint supersedes their pending status in
earlier handoffs and the prior blocked audit. Do not request those approvals again.
It continues `21d33f1d82795c6dffbd9a9c46765f375ab0fd73` on the same checkout/branch.
The full standalone desktop/mobile Scribe goal remains incomplete.

## Applied and verified

Electron 44.4.3 is installed in this checkout's `node_modules/electron` and pinned
in the desktop workspace/lockfile. The exact approved patch added seven package
entries and changed no existing package version. The final lockfile is byte-for-
byte identical to the proposal. npm lifecycle scripts were disabled; only the
previously inspected Electron installer was then run. The arm64 runtime archive
matches SHA256 `6b728f5dcfae74f3f936f2bca5b3cd9b9659ffea464f67939f004acb55425a85`.
The installed dependency tree and main/preload typecheck pass. No Electron process
was launched. The downloaded app is ad-hoc/linker-signed with no TeamIdentifier or
sealed resources; strict bundle signature verification fails. No re-signing was
attempted. This is an installed development dependency, not a signed Scribe app.

The exact three-line iOS patch is applied only to a new copy at
`/Users/jw/Desktop/Cosmas/scribe-approved-platforms-20260922.wvwvqtad/ios/native-auth/`.
The existing native session/SDK/storage implementation is unchanged. The copy
also incorporates the already prepared provider bridge. The only changed existing
files are the approved configuration and the earlier bridge integration; the two
provider transport/connection files are added. All 247 files in the qualified
original package remain unchanged.

The new auth module and complete provider bridge compile into static libraries
for arm64 iOS 17.0 using retained Clerk/Capacitor dependencies. Mach-O metadata
confirms `minos 17.0`. The bridge's import search selects the newly compiled auth
module before retained dependencies. The initial bridge compile was repeated to
make that selection explicit; its log is retained separately.

`scripts/standalone-provider/check-standalone-identity.swift` runs the copied
configuration with the approved public identity settings. It accepts the exact
standalone bundle/callback, rejects six nearby bundle IDs, rejects desktop origin
and a production publishable-key prefix, and retains valid W13/existing desktop
profiles. It invokes no native SDK, Keychain, network or capture code.
The selected `StandaloneBuildProfile.plist` is disabled and has no receiver
endpoint. No complete app was signed, installed or launched; libraries are build
preparation, not phone acceptance.

## Evidence and preserved boundaries

Evidence root: `/Users/jw/Desktop/Cosmas/scribe-approved-platforms-20260922.wvwvqtad/`.
`approval.json`, `checkpoint.json`, compile commands, prepared/original source
manifests, static libraries, identity-check executable and logs bind the exact
approval and results. `build/approved-platforms-20260922/evidence-root.txt` locates
it from this checkout.

Core HEAD and all 82 pre-existing dirty paths/statuses/hashes remain unchanged.
Both protected Scribe authority hashes and the original iOS source are unchanged.
Mac R2, W13, their Keychain/receiver/TLS/database and other installed applications
were not changed or queried. No cloud/shared-data write, Core/OS edit, push, PR,
deployment or completed live/device trial occurred. All preparation processes
exited; no listener was started.

## Remaining path to the full goal

The approved iOS identity retains W13's test Clerk issuer. It differs from both
Core environments. The next account/environment decision must identify the
existing Core provider and organization, then define the exact issuer/account
amendment and workload/receiver configuration. The existing Core release packet
still governs schema/source reconciliation, receiver connectivity, upload target,
creation/navigation and the retained-source dashboard concern.

The actual desktop native auth/custody/backend factory, server start authority
and presentation IPC are still missing. Their scope is not included in these two
approvals. Keep the protected authority files unchanged; do not infer a start
capability from the upload lease. No placeholder factory was introduced.

Installed native lifecycle, physical desktop/mobile capture and recovery, real
bilingual fidelity through Core SOAP, signed packaging/update/rollback and
operating acceptance remain required. The successful checks above do not prove
those outcomes.
