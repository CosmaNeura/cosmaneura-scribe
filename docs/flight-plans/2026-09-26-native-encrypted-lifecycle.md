# Native encrypted capture lifecycle

Tier 2 under the owner's explicit long-visit/background direction. Compose the
existing AVFoundation driver, PCM core, encrypted sink and continuation owner.
Only this native graph selects native-encrypted lifecycle behavior; the legacy
JavaScript PCM bridge retains its foreground-only default and disabled renewal.

Require foreground before activation and before arming the microphone. Ignore
background notifications only after successful arming in native-encrypted mode.
Route changes, phone/audio interruptions, media-service failure, lost permission
and watchdog/authority expiry remain terminal. Keep a synchronous claim and
retain a handle on every post-claim failure until physical closure succeeds.
The authenticated host must hold the shared source gate and original stop proof.

Apply the existing 384 MiB plaintext ceiling, four-copy free-storage allowance
and 64 MiB recovery reserve before preparation and again before microphone claim.
Three hours at the existing format needs 345,647,520 plaintext bytes including
WAV headers, below that ceiling. Do not load a full visit into memory.

Validate native and foreground lifecycle policies, background during startup,
all existing interruption guards, bounded PCM delivery, full and partial durable
encryption, low storage before source claim and retryable closure. Compile the
actual iOS AVFoundation implementation. No physical microphone is opened by tests.

This graph is not yet routed into the provider app or activated in an installed
binary. The next host step must retain it across WebView lifecycle, supply native
Core authority and expose metadata/commands only. Background plist activation,
native UI/recovery and device acceptance remain open. Recovery leaves the graph
unused; preserve original keys, queues and source proof. No deployment or install.
