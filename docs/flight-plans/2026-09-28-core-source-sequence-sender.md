# Use the Core source sequence from the Scribe receiver

Owner: MCD operational beta owner. Tier 2: capture authorization orchestration
within the approved startup performance work. Depends on merged Core PR537.

The existing native source-start-ready request now uses Core's additive
source_start_sequence operation. It eliminates one receiver-to-Core round trip:
exchange, resolve and sequence replace exchange, resolve, prepare and authorize.
Core still performs both original source decisions. No measured phone speedup
is claimed by this software change.

The native request and paired response remain unchanged. The receiver validates
the original closed prepare intent and distinct keys/nonces before I/O. The
prepare key stays in the HTTP header; the original authorize key travels in the
closed Core operation. One request-local negotiation is used; current identity
is checked before and after each of the three Core requests. Core537 retains
the separate current admission checks around both downstream decisions.

Before publishing, validate both result models, immutable paired identity,
source/lease/position/creator, deadlines and the original native proof. Rebuild
the two existing envelopes with their respective original request nonces and
the unmasked native-only capability. Generic renderer and raw native operation
routes still reject this Core operation. No credential cache, permission
extension, dependency, schema, recording or encryption change is introduced.

Cancellation or an uncertain response never triggers fallback or an implicit
retry. Either decision may have committed; the existing native journal keeps
the original proof and stop custody. Preserve recordings, queues and journals.

Qualification covers the transport, frozen identity receiver with an isolated
socket-only database, and a local rehearsal against the actual Core537 facade
and gateway. Authentication and remote Scribe decisions in that rehearsal are
synthetic fixtures; it is not a live service or microphone acceptance test.
Verify request count, exact keys/nonces, both source kinds, resumed positions,
revocation, malformed/expired/crossed replies, concurrency and lost responses.

Deploy Core537 first after reconciling the current staging revision, image,
configuration and schema. Verify support before deploying this merged Scribe
receiver. Retain unrelated API/worker, Session Prep and CosmaBot changes.
Installed native clients already use this route, so no phone update is needed.
The immutable receiver revision is the release control for the existing
synthetic staging cohort, owned by the beta owner until its next replacement.
For recovery restore the prior qualified receiver image first; leave the
backward-compatible Core operation and all data in place. Production and
broader activation remain separate decisions.
