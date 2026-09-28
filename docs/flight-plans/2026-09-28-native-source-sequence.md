# Native client for combined source preparation

Owner: MCD operational beta owner. Tier 2: native capture authorization
orchestration in the approved readiness/recovery work. Depends on receiver PR191
for the faster path; existing receivers retain the older source-start behavior.

The encrypted native run obtains Apple microphone permission first, then asks
its existing source owner for one-use start authority. The owner uses the new
native-only `source-start-ready` endpoint when it has no prepared grant. It
validates both complete prepare/authorize receipts, their nonces, the same proof,
lease, session, source, position, actor/consent linkage and the existing short
capability lifetime before returning the permit to the native gate. No capability
is cached between separate preparation/consumption calls or persisted for reuse.
The original protected stop proof is still written before any network dispatch.

The generic renderer constructor rejects the new route, just as it rejects
legacy source-start. Only that new route accepts an HTTP404 for compatibility:
the receiver rejects an unsupported route before any Core work. Core access
denials are403, not404. A404 selects the existing prepare/authorize path with the
same original keys and source intent; all access checks still execute. No other
HTTP status, malformed receipt, cancellation or lost response retries or falls
back. These cases retain the original stop/recovery path. TLS, origin, JSON,
no-store and response-size checks remain; the combined reply is bounded to16KiB.

Microphone start remains inside the existing native gate and encrypted recorder.
The combined source-ready diagnostic stages describe the single network wait;
they carry no content or identifiers. Retired owners, changed accounts, poisoned
journals and a second consume cannot obtain a new permit. A cancelled or lost
response can still correspond to completed server authorization, so physical
closure and original-proof stop confirmation remain mandatory before reopening.

Validate actual native source/gate/recorder composition with synthetic wire and
audio substitutes: one combined request; original intent preservation; legacy
fallback; denied/invalid/expired/mismatched replies; cancellation and account
change during the response; stop recovery; refusal before microphone permission;
single consumption; existing encrypted recording and continuation behavior.
Exercise URLSession's fixed route and404 handling separately, and typecheck the
actual iOS17/Swift6 modules. No physical microphone or live account is required.

The existing signed beta build and immutable receiver image are the release
controls, owned by the beta owner for staging until candidate replacement.
Package/qualify a PR191-or-newer receiver before timing acceptance. The native
client can use the legacy path during receiver rollback; restore the prior
signed native build to disable this new path, preserving its same identity,
recordings, journals and keys. No schema, dependency, configuration, credential,
production rollout or new capture adapter is introduced. Actual device latency,
screen-lock/background and live-call/accessory acceptance remain separate.
