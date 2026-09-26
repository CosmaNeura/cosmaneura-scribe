# Native provider recording context and renewal errors

Tier 2, within the owner's native long-visit, performance and recovery work.
Reuse the existing authorized Core mount response to retain only workspace,
binding and recovery namespace IDs in the native connection. Clear them on
account/revision change, connection closure or an invalid replacement response.
The native recording host can retrieve this typed context without accepting a
renderer-supplied queue namespace or performing another mount round trip.
This metadata grants no microphone or lease authority.

The recording service already requires a Core-minted tenant/session context.
Journal scope checks revalidate the native account locally; each network
operation still obtains current credentials and validates the complete Core
envelope. Avoid repeatedly rediscovering immutable scope IDs over HTTP around
every journal operation. A recovered key/lease cannot start a microphone; the
source-start gate remains independent and unchanged.

Treat explicit Core 401/403/409/422 responses as authority rejection and retire
native continuation immediately. Only transport or service unavailability may
retry inside the previous short monotonic deadline. Do not lengthen permission
or reinterpret an invalid receipt as a successful renewal.

Validate exact native client/auth modules with synthetic replies: mount namespace
and revision tampering, stale cache invalidation, denial vs service unavailability,
scope checks without extra requests, and account change rejection. Re-run current
binding/provider/transport checks, iOS compile and real retained Clerk helper build.
Native provider recorder routing follows this step. No SDK/auth policy, token
store, server contract, fixture rows, installed app or deployment changes.

Recovery restores redundant scope reads and omits the optional mount lookup;
all key, queue and source-proof custody remains intact.
