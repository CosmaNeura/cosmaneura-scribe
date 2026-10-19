# Dormant Mac App Store distribution

October 19, 2026. Tier 2. Status: source prototype, activation unavailable.

The Developer ID app uses Electron's `darwin` runtime and native helpers outside
App Sandbox. Mac App Store distribution needs the matching official `mas`
runtime, a sandboxed parent and helper profiles. Adding entitlements to the
current installed app is insufficient. Keep the direct target and its package
checker unchanged; select the separate main entry and native compile flag only
in the new unsigned build target.

The proposed store source resolves an OS App Group container after validating
the current native executable's signature, exact role/team/bundle claims and
one compiled approved group. The group is currently `nil`; the host and every
native helper stop before auth or capture. No renderer, argument, environment,
bundle profile or filesystem path enables the variant. The fence creates only
`SourceFence` with mode0700 inside that container and retains its current
mode0600 files, no-follow opens, UID/device/inode checks, coordinator/capture
locks, durable anchor, epochs and terminal-source retirement. There is no
fallback to the external home directory in a store build.

The native identity helper retains its existing bundle/callback, Clerk service
and Keychain access group. No other helper receives that credential group.
The retained Clerk SDK is copied unchanged through the233-file source lock.
Its cache/session custody uses Keychain; its installation marker uses native
`UserDefaults`. It has no external-home credential file. The existing source
journal remains native-only, non-synchronizing and device-only. Electron
encrypted record/device custody, preference and diagnostics paths still use
the runtime's `userData` directory, which requires sandbox attribution tests.
No old journal, credential, recording or preference is moved or reset.
Clerk's existing installation-marker reconciliation can retire local biometric
credentials on a new preference scope; the sandbox attribution and that marker
must be reconciled before activation. No alternate credential reader is added.

The draft parent grants client network and audio input; Electron's children
inherit App Sandbox. The native auth/audio/presentation helpers have separate
least-privilege draft sandbox claims and one shared group, retaining native
credential ownership. Their launch attribution and profile/container behavior
must be proven with actual Apple development profiles before activation. The
prototype does not claim this signing topology has been physically qualified.

The input preparer emits unapproved entitlement placeholders and leaves App
Group, profiles, distribution identities, store record/version/build and the
official MAS archive checksum absent. No sign, install, upload, backend change,
public activation, microphone or account action is part of this prototype.

Reference: [Electron Mac App Store guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide).
