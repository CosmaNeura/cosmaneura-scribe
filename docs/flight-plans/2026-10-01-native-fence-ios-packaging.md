# Exclude desktop filesystem custody from the iOS package

Tier 2 because the shared source-recovery implementation is touched. The change
only selects code by platform: macOS retains its existing cross-process file
locks, while iOS retains `NativeCaptureStartGate.recoverWhileIdle`. A non-nil
desktop directory on iOS fails before journal or connection work. Shared anchor
and ticket value types remain available; the iOS process-fence getter still
fails closed. No credential, consent, stop-proof or recovery decision changes.

The current iOS caller constructs `NativeSourceRecovery(journal:)` without a
desktop directory. The linked `fstat`/`fstatat` calls came from its unused desktop
implementation. Adding a container-file privacy reason would misdescribe that
implementation: the desktop path checker also inspects ancestor directories.
Apple's `C617.1` reason is: “Declare this reason to access the timestamps, size,
or other metadata of files inside the app container, app group container, or
the app’s CloudKit container.” See the official
[API-category documentation](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).
No new privacy reason is declared for an API the iOS client does not use.

Validation compiles the actual auth/recovery sources for iOS 17 arm64 and macOS
14 arm64. Inspect the resulting objects: iOS must not import the desktop file
metadata APIs; macOS must retain them. Also run the existing offline desktop
source/recovery regression checks and verify mirrored source parity. These
checks do not execute an iOS device, replace a complete signed-package check,
or establish App Store acceptance.

Release only through a new archive from the reviewed source. Preserve build58,
its signed IPA, installed applications and all existing privacy manifests.
Recheck the final exported iOS executable for file metadata imports and review
any remaining API use before upload. Distribution signing, export-compliance
answers, App Store Connect configuration, uploads and tester access are outside
this change. Recovery is to rebuild the previous source; do not delete or reset
recordings, keys, journals, or device data.
