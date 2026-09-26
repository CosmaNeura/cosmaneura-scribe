# Native key candidate recovery

Tier 2: device-only recording-key custody. This continues the native recording
integration; the active recorder is unchanged.

A native key insert can commit before the caller receives its result. The
native host needs an idempotent candidate operation before binding that key to
Core. Persist a unique binding intent first, then call `prepareBindingCandidate`
only for an explicitly new, authorized session. The same intent, full recording
scope and published wrapping key recover the retained candidate without another
insert. Different intents, wrapping keys, legacy keys and corrupt records fail.
An ambiguous insert triggers one readback, never another key generation.

After server binding, use `reopen` with the exact retained wrapped-key receipt.
Missing bound custody remains an error. The candidate operation must never be
used as fallback for an existing bound recording or a lost local journal.
No method exports raw key bytes, replaces or deletes keys, or changes Keychain
accessibility. Existing records without the optional intent remain readable.

Validate interrupted inserts, exact replay, intent/key mismatch, legacy and
corrupt custody, and unchanged bound-key recovery with real native crypto tests.
Compile the package for iOS and check formatting. Implementer review and exact
tested source are recorded in the PR under the owner's local merge policy.

Recovery: leave this additive API unused. Preserve all retained keys and records.
Native host binding, renewal/reservation ownership and background packet saving
remain integration work; this change alone does not qualify three-hour capture.
