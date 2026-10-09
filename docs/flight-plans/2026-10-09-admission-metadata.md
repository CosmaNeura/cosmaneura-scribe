# Admission and preparation metadata in one native request

Tier 2. On an explicitly capable Core-owned native mount, the desktop main
process opts the already-journaled first consent admission into a combined
response. Keep the exact admission mutation body and durable idempotency key.
Read the existing preparation metadata immediately afterward, using only this
invocation's negotiated Core context and a distinct deterministic read key.
All six admission and three metadata registry fences remain; the ordinary Core
read retains its complete fresh policy and consent checks. No setup is reused
across native requests. Credentials never leave the receiver.

The desktop main process strips the metadata before returning the admission to
the renderer. Its one-use receipt is bound to this mount, admission key, session
and cancellation. Only a fresh recorder with no retained encrypted preparation
can consume it. Recovery, renewal and old receivers retain the existing path.
Malformed, foreign, revoked or lost replies fail closed without automatic retry
or read fallback. No metadata is persisted; no audio starts during preparation.

Release the native receiver first, then signed desktop build 63. Core 718 already
supports the unchanged underlying operations; no Core/API deployment is needed.
Recover desktop build 62 first, then native receiver revision 35 at its preserved
immutable digest. Keep configuration, identity, profile, schemas and native
helpers unchanged. No migrations, dependencies, grants, PHI or production work.
Virtual audio only. Record exact tested/reviewed source, package qualification,
recovery/configuration and installed timings. Goal remains 5–7 seconds; previous
installed spans were 13.435492 and 9.510730 seconds from admission request start
to window response, excluding UI paint.
