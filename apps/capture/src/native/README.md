# Native iOS recorder used by the provider entry

The provider entry exports `createProviderIOSCaptureSource()`. It requires native
iOS and the `IOSPCM` plugin, and fails without them. Construction does not request
microphone permission or record. The authorized host supplies the resulting
source to `AuthorizedProviderEncounter.recorder` while retaining its existing
exclusive lock and creator-scoped stores. The existing controller starts it only
after configured consent/admission and an explicit provider Record action.

The PCM bridge, source and their existing checks are reused from local Scribe
commit `21812cc`. The internal `capacitor-pcm` transport definitions, codec and
registration are unchanged copies of the retained W13 package's TypeScript
surface. Only the two package imports were redirected to that internal module.
Exact input/output hashes are recorded in
`scripts/w13-private-workspace/provider-native-reuse.json` at the repository root.
No new dependency was installed. Fake bridge code is used only by tests and is
not exported from the provider entry.

The retained W13 host already supplies the native Swift `IOSPCM` plugin. Its
versioned extension methods are not used by this bounded Scribe source. Native
Swift/authentication/Keychain code and the default synthetic preview source are
unchanged. This source reuse is not installation of the provider workflow in W13;
authenticated host/backend composition and physical acceptance remain required.

Native interruption does not prove successful closure. A fixed
`audio_capture_native_stop_failed` keeps the existing controller paused, the
encrypted queue retained, and Stop available for retry. Upload/completion waits
for a confirmed stop. The source retains the same failed native handle for that
retry and rejects new recording. Buffers, packets, bounds, acknowledgements and
discard-over-drain behavior remain governed by the reused implementation.

The immutable Base64/framework copies inherent to the existing Capacitor
transport remain a documented limitation. This increment does not add logging
or new audio-storage paths. Physical permission, audio route/interruption,
offline recovery, iOS 17 and device-memory acceptance are still open.
