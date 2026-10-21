# Store live parent broker

Status: proposed for independently reviewed Store development qualification.

The signed Store service can authenticate its inherited Bridge using macOS14.4
LWCR, but its cross-parent Security guest lookup refused in the signed109
qualification. The original kernel Bridge PID, parent, UID and start-generation
checks passed. The inherited Bridge's signed parent proof previously passed.

Use the distinct `com.cosmaneura.scribe.beta.desktop.store.bridge` signing ID
for a broker that retains the originally admitted parent SecCode and requirement.
Register EXEC/EXIT monitoring before that admission, serialize zero-timeout
monitor drains and retained-code checks, and permanently refuse after an event,
read error, generation change or failed signed sandbox proof. No fresh PID-based
Security object replaces the retained proof.

The service preserves both original kernel fences and creates a native-only
opaque lease. Every positive currentness check requires a nonreused local
sequence, exact typed broker reply, original Bridge kernel tuple before/after,
and a 250ms monotonic deadline on an independent reply queue. Failure revokes
before scheduling the existing role-specific stop and cancelling the exact peer.
Successful completion revokes without failure stop. Swift retains the lease
before asynchronous hops; the window PID is lease metadata only.

The alternative of removing parent validation would lose existing authority.
Launch constraints alone would prove parent identity at exec rather than current
lifetime. This broker keeps the signed parent, generation and lifecycle contract
without private APIs or additional entitlements. macOS14.4 and all existing
Team, role, Boolean, group, custody, consent and descriptor checks remain.

Source fixtures do not establish sandbox monitor availability or signed runtime
capture/save/review behavior. Qualify those on the exact signed successor before
adopting it for submission.
