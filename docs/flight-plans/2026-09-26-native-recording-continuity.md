# Native recording continuity

Tier 2. Owner authorization: implement three-hour continuity, native renewal and
encrypted recording through screen lock/background, reusing existing components.
This authorizes technical implementation and synthetic validation, not production
or PHI activation. Local checks and implementer review govern merges.

The foreground WebView currently encrypts and acknowledges every packet. iOS can
suspend it on screen lock. Raising the duration limit does not remove this dependency.

The first change supplies native session-key custody and an encrypted queue writer.
Apple Security generates/wraps a 256-bit session key with RSA-OAEP-SHA256; device-only
Keychain retains it after first unlock. CryptoKit encrypts each in-memory PCM16/WAV
packet with the existing AES-GCM/AAD/envelope contract. The native writer advances
the existing reserved upload record using the same SecureQueueStore and atomic CAS.
Only a matching durable commit permits acknowledgement. Existing keys are never
replaced on recovery; no keys or PCM are returned through a new JavaScript method.

This first change remains dormant: it grants no capture permission and does not
remove the current background/heartbeat/deadline stops. CocoaPods retains its
existing queue API; this native writer is packaged through SwiftPM. Subsequent
changes must connect native key binding, verified rolling source authority,
reservation replenishment and packet acknowledgement before enabling background
audio. Starting capture still requires deliberate foreground consent/authorization.

Validation uses accelerated synthetic packet volume, actual Apple RSA/AES, the
existing generated envelope/queue decoder, bounded storage failures and ambiguous
commit recovery. Physical lock/background, native Keychain persistence across an
app update, renewal failures and restart reconciliation remain release acceptance.

Recovery for this additive change is to retain the existing foreground capture
path. Retain all queue files and keys. No schema change, data rewrite or deletion.
