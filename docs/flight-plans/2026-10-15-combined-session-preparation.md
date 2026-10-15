# Combined session preparation and visit token preparation

Tier 2. Owner authorized implementation on October 15. No production promotion,
capacity change, new telemetry service, or device recording is part of this patch.

Measured baseline: Desktop 81 full starts 12.203/8.271/6.902 seconds. Virtual
fresh-token waits 0.713–1.553 seconds; receiver access SQL totals 0.212–0.222
seconds. These are different measurement boundaries; neither is a new pass.

Receiver first: add POST /v1/captured-sessions/prepared with the existing immutable
admission body and original session idempotency key. Return admission plus the
existing creator preparation metadata. Reuse the unchanged admission and metadata
primitives, including current creator/consent checks before and after key I/O.
No audio, source authorization, key binding, lease or reservation is speculative.
A lost response recovers the same session family; no fallback after dispatch.

Then Core may opt in through a default-off configuration after the exact receiver
is merged, reviewed and qualified. Existing clients and recovery paths remain
compatible. Native visit preparation holds at most one scoped credential in RAM,
claims it once, preserves its original mint and JWT clocks, and falls back fresh
before wire I/O on any expiry, cancellation, mount or account mismatch.

Core numeric dependency observations use the existing staging-only console sink
and Azure Log Analytics. No request IDs, URL, SQL, tokens, clinical text or exception
messages are exported. CPU/SQL capacity remains unchanged until observations
attribute a constraint. Independent exact-head review is required before merge.

Validation: local fictional receiver storage tests, denied/revoked/replayed/failed
key cases; Core HTTP and authority tests; deterministic native deadline and
cancellation tests; generated OpenAPI, lint and types. Physical speed remains
unqualified until a later available-device test measures the full capture boundary.

Recovery: disable Core opt-in first. Revert native prewarming independently.
Leave existing session/consent records intact; no migration or deletion.
