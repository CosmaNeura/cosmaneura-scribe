# Mac App Store private XPC helper boundary

Risk: Tier 2. Owner: founder. Scope: source-only successor to dormant PR 357.
No merge, store activation, signing, service/helper launch, installation, Apple
account mutation, microphone or clinical promotion is included in this work.
The installed direct app and every prior frozen source/release root are retained.

## Concrete implementation

The explicit `--mac-app-store-xpc` host/native targets use the official Electron
44.4.3 MAS runtime. The existing host protocol and profile select a small inherited
stdio bridge instead of directly spawning independently sandboxed app helpers.
The bridge has only sandbox + inherit claims. It authenticates its actual parent
and transfers only fixed-mode input/output descriptors to the owning app's private
XPC services. The service verifies the bridge signature, same UID, kernel parent
and signed host identity before admission. No renderer, argv, environment or
bundle field chooses a different service, group, backend or credential owner.

Auth, audio and presentation retain their existing native bundle identifiers and
separate capabilities. The fixed macOS group
`JVV65668U6.com.cosmaneura.scribe.beta.desktop` holds fence files only. Apple's
Team-ID-prefixed macOS group requires no registration and grants no Keychain
access. Only native auth retains
`JVV65668U6.com.cosmaneura.scribe.beta.desktop.auth`. Its provisioning profile
must authorize both the native Keychain group and Team-ID fence group: an
unprofiled group claim does not establish entitlement-validated DP Keychain
access. Fence-only audio/presentation do not inherit any auth capability. The older dormant target
remains nil. Direct-distribution entry points and default host output are retained.

Audio admits one capture while bounded catalogue/probe sessions may overlap.
Disconnect cancels descriptor-local workers without closing an FD under a reader.
A successful capture releases its fence only after the existing acknowledged
native stop, subsequent discard-stop return, reader join and writer drain. Every
capture failure or unbounded stop retains the fence until the audio service exits.
A failed catalogue cannot terminate another capture. Auth owns one session and
waits for owner/source/operation/reader drain before completion. Presentation uses
the authenticated Electron host PID, not launchd's PID, and preserves the native
unconfirmed-stop warning on host loss.

## Verification and remaining boundary

Actual source-only compiler evidence includes production C with warnings treated
as errors, real auth/audio/presentation XPC Swift products and canonical host
builds. Pure tests use anonymous pipes and synthetic native owners only; they do
not launch or connect services, read devices, access Keychain or capture audio.
A nonimplementer reviewed C/audio/presentation/lifetime source. Root must review
auth and final complete source independently before any substantive push.

This is compile-ready architecture, not sandbox, App Store or clinical acceptance.
The real signed candidate must prove private discovery, peer rejection, user
session/Keychain attribution, actual MAS runtime/claims, callback/auth lifetime,
TCC/indicator behavior, repeated capture with concurrent catalogue, stop/drain,
encrypted save/recovery and saved-audio review. Store application/profile and
installer identities, exact bundle version and separate Mac record are still
required and must be bound by the owner. The MAS recipe explicitly uses
`hardenedRuntime: false`; it must not inherit osx-sign's hardened default or add
JIT/filesystem exceptions. Apple's arm64 MAP_JIT guide requires allow-jit only
when Hardened Runtime is enabled. The direct Developer ID recipe remains intact.

Legacy direct-app coexistence is unresolved. The new sandbox cannot read the old
home fence; the retained Keychain anchor rejects different fence files rather
than migrating. A missing journal or installation marker is not proof of no old
capture. Clerk's sandbox installation-marker and biometric cleanup must be
reconciled before launching auth with legacy credentials. Never delete/reset
credentials, move the old fence, change lock/epoch custody, grant broad filesystem
access, or launch this auth service against the current legacy account to infer
compatibility. A genuinely isolated clean qualification context does not qualify
existing-account migration.

## Owner qualification order and recovery

1. Review the frozen source map/patch, actual build receipts and official runtime
   closure. Preserve direct app and old recovery artifacts.
2. Resolve profile/certificate/store-record inputs and exact MAS runtime signing
   claims. Assemble only into a fresh candidate root; embed services under
   `Contents/XPCServices`, preserving native auth configuration/resources.
3. Resolve legacy custody admission before any existing-account service launch;
   otherwise qualify only in a separately verified clean context.
4. Owner signs and checks actual claims/material closure, then qualifies sandbox
   runtime and source lifecycle before preparing an installer/upload artifact.
5. Failure stops qualification. Retain all candidate evidence and original app;
   do not retry an ambiguous launch/install or silently migrate/reset custody.
