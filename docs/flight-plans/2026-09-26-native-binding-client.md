# Native Core recording-key client

Tier 2. Owner-authorized three-hour recording continuity and recovery work.
Local tests and implementer review govern merge; no production or patient data.

Connect the native binding-journal service interface to the existing authenticated
Core connection. NativeProviderRecordingContext now retains Core's verified
binding reference as well as workspace/session/tenant/account. Callers cannot
substitute a separately supplied encounter binding when creating the key client.
The native token policy, fixed receiver, fresh token per operation, cancellation,
revision checks and bounded replies are reused. The client validates the complete
Core response envelope and existing RSA public-key/binding receipt contracts.
Restart may use a fresh SDK session only within the same native account namespace.

Both iPhone and desktop packaging include the existing native-recording module;
there are no external dependencies, server/schema changes or credential exports.
No generic renderer method is registered. Existing foreground recording remains
active: native flow/reservation ownership and source renewal must still be wired
before background capture can be enabled.

Offline integration exercises the actual auth policy, Core client and journal,
with synthetic replies and in-memory keys/records. Wrong encounter, workspace,
nonce, operation, freshness, key algorithms/fields, account changes and lost bind
replies must fail or recover without changing the candidate. Compile on iOS17 and
build the real Mac helper with the retained Clerk SDK. Physical lock/background
and accessory qualification remain separate acceptance. Recovery retains the
current foreground path and all device keys/recordings; no installed-device or
staging activation is needed for this internal additive client.
