# Phone preparation ticket and duplicate status read

Tier 2. Fresh phone consent currently performs a standalone creator-status read
before the native recorder checks the same status during context acquisition.
Advertise acquisition review only for the verified version-two native context
path, carry that capability through the iOS host, and reuse the existing desktop
skip at fresh consent. Reopening, recovery and older native versions retain
their original review reads. Recorder denial still prevents mounting or Start.

Successful single-use ticket consumption currently changes the context's
generation, invalidating its bundled public wrapping key before the native
service can consume it. Transfer the same generation on successful consumption;
invalid or expired consumption still invalidates, including thrown validation.
Account/SDK changes, remount, cancellation, replacement and closure keep their
existing invalidation. Public key consumption remains single-use and at most
five seconds within the original server freshness bound. No source permission,
keys, journal recipes, consent policy or server contract changes.

Validate compiled desktop/iOS consent entry, native-version compatibility,
reopening, denied acquisition and actual ticket-to-service key/window handling.
Use fictional PCM, identity and transports only. Compile current native sources
for macOS/iOS and record exact tested commit and implementer review in the PR.
Current Core738 and receiver298 support this consumer. Recovery uses the prior
signed app with all stored work preserved. No phone upload without the pending
explicit App Store Connect approval; device seconds remain unmeasured.
