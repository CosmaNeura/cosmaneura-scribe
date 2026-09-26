# Reuse native recorder context during one opening

Tier 2, within the owner's native long-visit, performance and recovery scope.
Remove one serial Core creator-review round trip during iPhone recorder opening.
The version-2 native bridge provides a local-only recorder-context action that
uses the existing authenticated Core native_recording_context operation. It
returns only revision/session/nonce acknowledgement before renderer custody
inspection; tenant and account context remain native.

A single native context is retained for at most five monotonic seconds and never
past the original server-response freshness bound. Native open consumes it once,
matching request nonce, native revision/account, session, binding and original
mount. Expiry requires a fresh Core read. Cancellation, auth changes, replacement
mounts, connection closure and replacement preparations invalidate it. Invalid
or missing tickets fail closed. An older version-1 plugin retains its prior path.
Existing browser keys/journals are inspected only after fresh reauthorization and
remain on the legacy flow. A ticket is unused if legacy custody is found.

No microphone/source grant, lease, key or token is cached in this ticket. Every
key/lease network operation still uses current native credentials. The separate
source prepare/authorize decision immediately before microphone start remains
unchanged. The local action must never reach an HTTP destination. No server
contract, identity, SDK policy, storage schema, configuration, fixture or cohort
activation changes. Existing native provider release control applies.

Check nonce/session/mount substitution, once-only use, expiry, cancellation and
late-response races, account changes, version-1 compatibility and no tenant
leakage. Compile real Swift/native modules and full iOS plugin; test the actual
provider composition and existing stop/recovery guards. Record exact tested
commit and implementer review in the PR under the September25 owner policy.
Recovery reverts this optimization, restoring the extra context read while
preserving all recording, source-proof, key and completion custody.
