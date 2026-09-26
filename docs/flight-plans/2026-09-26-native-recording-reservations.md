# Native recording reservation recovery

Tier 2. The owner's operational-beta scope includes native renewal and encrypted
recording through screen lock/background. This increment prepares bounded native
reservation windows and existing upload-queue records; it does not activate that
recording path or change the installed apps.

Reuse Core's capture-operations/reserve_chunks contract, the verified native
account/encounter context, encrypted SecureQueue journals, and the current queue
record schema. Persist the request intent before HTTP, then the validated batch
and stable upload keys before creating queue records. A lost reply replays the
same request. Partial local writes resume from the retained batch. Unused records
overlapping a renewed window retain their original keys; existing ciphertext or
conflicting metadata must never be overwritten.

Bound each window to 90 chunks and the visit to 2048 positions; the three-hour
10-second packet budget uses 1080 positions. Keep a 64 MiB storage reserve plus
bounded metadata allowance. Verify each receipt's scope, generation-linked lease
deadline, contiguous sequence and canonical authenticated data. Reject malformed
journals, conflicting writes, account changes and cancelled operations while
preserving recovery state. The shared legacy queue scan must skip native journals.

Validate interrupted writes, replay, overlap, cancellation, journal corruption,
low space, exact Core response envelopes and real native encryption into the
existing queue. Exercise the accelerated three-hour position budget without a
wall-clock recording. Compile native code and the real queue adapter for iOS17,
and build the existing Mac helper. Use only local synthetic fixtures.

Reservation metadata is not microphone authority. Native flow/source ownership,
monotonic deadlines, rolling renewal and host activation remain separate work.
No new dependency, database/schema, fixture, device capture or deployment change.
Recovery leaves journals and keys intact and restores prior callers. Record
exact-SHA local checks and implementer review under the owner's September25
merge policy.
