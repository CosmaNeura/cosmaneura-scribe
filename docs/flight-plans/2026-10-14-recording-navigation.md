# Recover failed recording setup and verify microphone packaging

Tier 1: reversible provider navigation and desktop build qualification. The
capture authority, consent, native recorder, transcript storage, authentication
claims, and backend contracts remain unchanged. The package checker additionally
requires the responsible hardened-runtime host's microphone entitlement; the
existing provider helper's exact Keychain claims and signature checks remain.

## Baseline and release order

The merged baseline is `78c0545ad7344b7afa17b5ab57141ec0a817c9f2`. The owner's
Mac currently uses the repaired, notarized native 0.1.0 (77), with finalized
archive SHA-256
`2446bbed6fecc81d78d8f52e7013a832defd32c31e65667d452492484da582fa`.
The retired Mac TestFlight wrapper is recoverable in Trash. The iPhone has one
Scribe product app, 1.0 (67), under `com.cosmaneura.scribe.beta`; native desktop
77 uses `com.cosmaneura.scribe.beta.desktop`. Build counters are platform-specific.

1. Obtain independent non-implementer review after the final substantive push,
   run applicable local checks, and merge with Actions remaining disabled.
2. Build and qualify desktop and iPhone artifacts from the resulting merged
   source. Assign new platform build numbers; do not label changed executable
   code as desktop 77 or iPhone 67.
3. Retain current installed artifacts until replacements are qualified. Replace
   the Mac app at its existing Applications path, with a recoverable previous
   package, and verify there is one installed and running Scribe product app.
4. Update the iPhone app in place under the existing bundle ID and existing
   approved beta groups. Preserve its data and keys; do not uninstall it to
   change versions. No new groups or invitations are part of this change.

The release control is artifact selection, owned by John, initially for the
owner and Shawn's operational beta testing. Reassess by October 21, 2026;
there is no scheduled activation or automatic promotion. No production,
schema, environment, credential, or delivery-route changes are included.

## Validation

Check Back and Refresh at desktop and small phone widths, refresh of the same
authorized encounter without admission or automatic capture, disabled Refresh
during recording or unconfirmed stop, and explicit unsaved-note decisions.
Exercise existing synthetic cancellation, source selection, saved-note recovery,
native input, and encrypted-recorder tests. Verify both a known broken native77
package is rejected and the repaired installed native77 package is accepted.

The owner requested silent virtual tests while actively using the Mac. Do not
play audio, open physical capture devices, or request manual recording tests.
Virtual timing profiles use explicit injected delays and do not establish real
device startup latency. Native synthetic speech tests generate voice files and
mix buffers without playback or microphone access. Keep hardware acceptance
and Shawn's real authenticated login outstanding until directly observed.

## Recovery

For a UI regression, restore the qualified repaired native77 package above at
the same Mac path after a normal close, preserving data. Keep or select the
existing iPhone67 beta artifact through normal in-place TestFlight update paths.
Do not restore the original desktop77 package with the missing microphone
entitlement. Retain all interrupted recordings, upload receipts, drafts, and
account identities. Refresh uses the existing close and reopen path; a failed
close must preserve its existing capture custody barrier.
