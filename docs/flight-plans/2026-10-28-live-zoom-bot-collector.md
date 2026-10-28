# Live Zoom bot observation collector

Risk tier: Tier 1 scoped lab tooling. Read-only access to existing staging
credentials happens inside one existing owned replica. No authentication,
consent, production, API surface, database schema, or capture behavior changes.
Root reviews the exact execution selection before any staging read.

The existing bot proof gate and loopback relay have no live producer. A new
Azure exec per proof cannot meet their existing two-second nonce window. This
change establishes one private exec connection before source admission and
keeps its database, Redis and Recall clients resident for the finite test.

The resident reader verifies the exact synthetic doctor/Clerk/host/meeting/
appointment/patient and consumed occurrence through durable joined authority.
Every nonce performs Core-before, one exact Recall bot GET, then Core-after.
It exports only the maintained DTO metadata and never exports provider bodies,
URLs, raw bot/recording/patient references, keys or clinical fields. The normal
host action artifact and all named screenshot/tree bytes are hash-checked by
the local collector. Normal End adds the exact canonical release HMAC row,
without decrypting payloads or claiming exhaustive inventory.

The reader has a stricter 1.8-second local work deadline; the existing gate,
relay, two-second end-to-end limit and single-request constraints are unchanged.
Unknown response shapes, changed bindings, reused nonces, stale replies,
unsolicited output and unresolved transport state refuse source admission or
restart. Explicit remote close acknowledgment confirms DB/Redis/HTTP clients
are closed; killing the local child alone does not produce that confirmation.

Files are additive under `tools/virtual-lab/coordinator`. Production applications
do not import them. Rollback closes the owned collector/relay/SSH tunnel and
removes the lab selection files. It changes no deployed workload setting.

Validation consists of actual owned child-pipe/artifact regressions and the
reader's actual read method with offline external services, then the unchanged
bot gate/relay suite. Those tests qualify source behavior only. Live acceptance
requires an actual R8 tuple and host consent, real scoped reads meeting the
two-second budget, monitored synthetic emission, normal End, canonical release,
and owned-resource close acknowledgment. Until those occur, live is NOT_RUN.

Independent review after the final substantive push is required before
integration. The root owns staging selection, normal browser/capture actions,
deployment and publication. The audio owner owns the two silent guests and
fixture emission. No other chat/task is contacted.
