# Native recording key-binding recovery

Tier 2. Owner authorization: three-hour native recording continuity and restart
recovery, reusing existing components. Local checks and implementer review are the
merge gate. Synthetic validation only; no production or patient-data activation.

This increment owns the transition from a fresh verified native recording scope
to a server-bound Keychain key. It writes an encrypted preparation intent before
key creation, retains the exact wrapped candidate before dispatch, and records
binding only after a matching acknowledgement and a fresh scope check. Restart
reuses the same intent, public key, Keychain custody and idempotency key. A lost
storage response is resolved by one exact successor read. A missing candidate or
bound key never triggers replacement; conflicts retain the recoverable journal.

Reuse: Apple Security/Keychain and the existing native encryption package, plus
SecureQueueStore's atomic encrypted records, shared lock, backup exclusion and
after-first-unlock protection. No dependency, server contract, schema or data
migration. No new renderer API or key export. Cancellation and concurrent opens
fail before side effects; account/scope checks bracket server binding.

Validation covers real Apple RSA candidate creation, interruption at each durable
transition, lost network responses, missing custody, corrupt records, changed
authority, cancellation and actor reentrancy. iOS compilation checks the queue
adapter. Test stores are isolated; no installed recording or key is touched.

This remains an internal native component: the concrete authenticated Core binding
adapter, native flow/reservation ownership and rolling source renewal must be
connected before enabling background capture. Current foreground recording,
existing JS keys and stop guards remain active. No three-hour physical continuity
claim is made. Recovery is to retain that foreground path and all existing files
and keys; never delete or rewrite recordings to roll back this additive code.
