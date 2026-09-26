# Native recording lease recovery

Tier 2. The owner's operational-beta instruction includes native renewal and
encrypted recording through background/screen lock. This change supplies the
native lease client and durable issue/renew owner; it does not activate capture.

Reuse the existing Core capture-operations contract, native credential owner,
account/encounter context and encrypted SecureQueue create/CAS implementation.
Write an immutable request intent before contacting Core and retain the previous
lease/generation until its exact successor has been durably acknowledged. Lost
responses replay the original idempotency key and body. An unreadable journal
must never become a new lease. Scope changes, cancellation, conflicting writes,
or mismatched receipts stop the operation while retaining recovery state.

Lease metadata alone cannot start/extend a microphone. The native source owner
must still validate source-start, reservations and monotonic deadline. Expired
metadata may reopen for recovery, never for recording. Native flow ownership,
reservation integration and rolling background activation remain separate work.

Validate restart/lost-response recovery, write failures before/after commit,
scope/receipt mismatch, cancellation and overlap; exercise actual native Core
client envelope/lease validation and compile for iOS17/Swift6. Use synthetic-only
local fixtures. No phone, staging fixture, database, dependency, identity or
permission change. Restore prior callers without deleting journals or keys.
Use exact-SHA implementer review under the owner's September25 merge policy.
