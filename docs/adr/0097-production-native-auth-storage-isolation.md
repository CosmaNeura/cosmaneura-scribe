# ADR 0097: Isolate production native auth storage from the staging beta

Status: accepted for source preparation; runtime qualification remains held.

The native beta and production client retain the same actual bundle/callback and
Apple identity. The pinned Clerk SDK's default cache service is not instance
scoped. Its owner-clear recovery journal is bundle scoped and can complete an
interrupted staging clear during production SDK configuration. A different
diagnostic cache service alone does not isolate that journal.

Production explicitly selects an instance-scoped storage policy. The actual
Frontend API and publishable key determine the existing SDK namespace fingerprint.
The resolved cache service and storage owner use that fingerprint consistently,
including app-local fallback, stable identity, owner slots and clear-recovery
journal. Default/staging names are unchanged. Real bundle/callback/access-group
values remain unchanged. Ordinary recovery continues within production; staging
stores are neither read for migration nor cleared by the new production scope.

The original 233-file SDK input remains locked. A maintained zero-fuzz patch in
Scribe source modifies only Options, ConfigurationManager and DependencyContainer
in a new assembled copy. Exact input, patch and output hashes are mandatory.
Builds reject drift rather than modifying retained SDK directories.

Focused in-memory checks cover legacy-name preservation, cache/journal separation,
pending production recovery preserving pending staging state, both scopes' normal
recovery, and rejection of this opt-in for development keys. They establish source
behavior only. Fresh native composition and genuine production login, default
token/native-party/audience evidence, provider admission and canary remain required.

Recovery: keep production configuration disabled until qualified. After activation,
disable the production native profile if needed; retain both secure storage scopes.
Do not revert to the legacy shared namespace or delete staging state as rollback.

The SDK retains its normal secure Keychain Client/session/device-token storage.
Observer output must contain sanitized facts only. No SDK logging policy change is
included; error log privacy requires separate review before an auth observation.
