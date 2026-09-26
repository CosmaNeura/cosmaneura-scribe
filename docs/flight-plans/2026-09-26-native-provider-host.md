# Native provider visit ownership

Tier 2 under the owner's long-visit, recovery and local-merge authority.

Compose the existing native key/lease/reservation/flow owners with the provider
source-start owner and encrypted Apple PCM run. One retained host owns a visit,
including stopped intervals, stable completion, and outstanding cancellation.
The iOS factory obtains account/tenant/session/recovery scope from the existing
verified native Core connection and uses the existing SecureQueue and Keychain.

Opening preloads key custody without opening a microphone or requesting a lease.
Start explicitly requests a fresh interval, renewing expired receipts as needed.
Pause confirms physical and Core stop before recovering committed positions.
Stop-and-upload authenticates once and seals the original completion payload
before the renderer uploader may touch ciphertext. Reopen never starts audio.
Input selection reuses Apple's existing built-in/Bluetooth/external preference
and applies only on the next start. Background/view lifecycle does not own Stop.

Retain source proof before graph construction, even if that construction fails.
Stop failures stay retryable; do not drop source ownership or replace a key.
Cancel delayed preparation before releasing host ownership. Account changes
retire the host; only close/recovery remains available until a new verified host.

Use synthetic in-memory service/source adapters with the actual native custody
modules for restart, pause/resume, sealed/purged completion, cancelled/duplicate
start, expired renewal, constructor failure and lost stop acknowledgement.
Compile the actual iOS17 factory against Core, Apple PCM and SecureQueue modules;
check retained-SDK source assembly, lint/types and implementer review.

This adds the retained host and production factory. Capacitor command routing,
the provider controller selection and installed background acceptance remain
dependent changes. Recovery leaves this path unselected; never delete journals,
uninstall/reset the app or downgrade over an active native flow. No dependency
version change, database write, installation, microphone or deployment here.
