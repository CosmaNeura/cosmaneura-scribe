# ADR 0019: Version the offline-safe capture protocol before client code

**Status:** Accepted (server contract remains disabled)

## Context

ADR 0016 requires a client to know an object's identity and exact AES-GCM additional authenticated
data before it can encrypt a durable envelope. The legacy upload-grant route creates that identity
at the same time as a short-lived credential, so a credential expiry cannot be recovered without
changing the cryptographic binding. It also gives web and native implementations no single source
for framing, media, quota, or timing rules.

Phase 1 must land these server prerequisites before `apps/capture/` contains client code. The
platform BFF and upload edge are later phases; Scribe continues to accept only the verified
platform workload identity and derives tenant context from the authenticated request boundary.

## Decision

### One generated protocol definition

`protocol/capture_protocol_v1.json` is the authoritative, versioned definition. A deterministic
repository generator produces the Python implementation, a pinned TypeScript implementation, and
committed golden vectors. CI regenerates and compares every output, executes both implementations,
and requires byte-identical AAD, header, and envelope bytes. Clients consume the generated
TypeScript package; they do not recreate canonical JSON, enum values, framing, or limits.

The client-visible AAD binds the platform-derived tenant, session, object, logical channel, and
sequence. Scribe returns the exact unpadded base64url AAD with each reservation, so a client never
receives tenant context merely to reconstruct it. The transcription track AAD remains server-only
and is deliberately outside the generated client package.

Protocol v1 pins:

- uncompressed WAV, PCM signed 16-bit little-endian, mono, 16 kHz;
- 10,000 ms target chunks;
- a 327,680-byte maximum complete encrypted envelope and equal conservative reservation budget;
- 1,000 aggregate chunks and 64 MiB aggregate reserved budget;
- at most 90 reservations per batch, representing one 15-minute target-duration window;
- a renewable 900-second capture lease and 900-second reservation window; and
- two concurrent uploads.

The 320-KiB envelope bound fits a canonical ten-second WAV plus v1 framing and AES-GCM overhead.
Charging the full bound at reservation time is intentionally conservative and preserves roughly 34
minutes under the current 64-MiB assembly ceiling without trusting client-reported plaintext size.
Changing any value requires a new protocol version and vectors, not an environment override.

### Separate authorization records

The false-default Phase 1 API separates four durable concepts:

1. A capture lease is a short, server-time authorization to begin or continue recording. Issue and
   renewal revalidate consent, the immutable session audio key, and an open capture session.
2. A reservation canonically binds `(tenant, session, channel, sequence)` to one server-generated
   object and the exact v1 AAD. Batches persist their ordered item mapping so a process-restart
   replay returns the same complete response. Concurrent keys converge on the canonical binding.
3. An upload-authorization receipt records only object and expiry metadata. The SAS/URL is never
   persisted or audited. A new idempotency key may refresh an expired credential for the same
   reservation while consent and session state remain valid; a second credential is refused while
   one remains live, and registration or closure refuses it.
4. Registration requires prior upload authorization, then binds the immutable digest and size to
   that exact reservation. A receipt lookup reports only `reserved` or `registered`, allowing
   timeout recovery without client inference.

New capture rows use forced PostgreSQL row-level security. Runtime receives only the exact
select/insert privileges and column-level lease updates it needs. Transcription and delivery
principals receive no lease, reservation, batch, or upload-authorization access. Database time,
session locks, canonical uniqueness, and full reservation foreign keys provide the concurrency
fences; application checks are not the only integrity boundary.

Completion under the new protocol includes the final sequence for every logical channel. Scribe
requires registered positions `0..final` for each declared channel and then closes the lease in the
same transaction. Unused pre-reserved suffixes are not treated as missing audio. The legacy path
continues unchanged while the Phase 1 flag is false; when enabled, the legacy allocator is retired
and cannot bypass leases or reservations.

### Rollout boundary

`enable_capture_protocol` defaults to false and may be true only with workload authentication and
the PostgreSQL repository. Disabled capture endpoints authenticate first, return a fixed 503, and
perform no database or storage operation. No Phase 1 change deploys a client, BFF, upload edge,
transcription dispatcher, tenant activation, or clinical capture.

Consent revocation, the separately privileged transcription trigger/status contract, and the
platform user-authorization surface remain explicit prerequisites for later phases. Phase 1 does
not grant the API permission to start Container Apps Jobs and does not claim that session
completion starts transcription.

## Consequences

- Offline encryption can proceed only within a live lease and a bounded set of durable server
  reservations; upload credentials can expire without changing encrypted bytes.
- Capability bootstrap is the only client source for media and limits, while the generated package
  is the only source for cryptographic wire behavior.
- Existing legacy rows remain readable during the false-default migration, but activation rejects
  the legacy allocator and requires new registrations to carry a reservation binding.
- The conservative reservation charge may stop capture before the theoretical plaintext ceiling;
  that is safer than oversubscription and is visible through remaining-budget capabilities.
- Every new mutation requires HTTP-level PostgreSQL/RLS tests and fresh-process idempotent replay;
  the migration must downgrade cleanly before Phase 1 can merge.
