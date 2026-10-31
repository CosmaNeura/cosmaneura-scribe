# ADR 0094: Manual publication of an already-built paired artifact

Status: source route only; publication, promotion, production prerequisite changes
and activation remain explicit founder decisions.

Core's current production release jobs build Core-only. Rebuilding there does
not consume the independently qualified paired Core/Scribe image. Introduce a
manual operator in Scribe that accepts an immutable reviewed archive, verifies
both source revisions and publishes its bytes using the existing operator's
Docker/Azure/gh toolchain. No new runner, workflow, registry, service or credential
is introduced. The ordinary Core jobs remain unchanged.

The operator distinguishes original image source from the later tooling commit.
Current Scribe main must descend from the image source with all sealed runtime
inputs unchanged; Core master must match the original paired source exactly.
A current independent artifact review is bound by file SHA-256. All archive blobs,
Core base layer prefix, runtime contract and source labels are checked without
extraction or execution. Docker-save metadata must describe the same single
image as the OCI layout. Docker load's observed ID must match either the exact
manifest or config digest; remote publication must match the exact reviewed
manifest digest. A conversion or conflict stops rather than qualifying a rebuild.

Separate founder confirmations approve publication and image-only dark promotion
of the existing API/worker/scheduler. Configuration is fingerprinted privately,
then compared before and after each image update. Bundle flags must already be
disabled. The Azure CLI has no established atomic compare-and-swap for this
operation, so the founder must exclude concurrent production work. Partial
failure stops without automatic rollback and remains an owner recovery decision.
An exclusive fsynced plan-hash journal records intent before each remote mutation
and blocks same-plan reuse after interruption. Fixed command deadlines clean up
only owned process groups; timed-out remote mutations remain unconfirmed.

Interactive founder identity and plan-hash confirmation are self-authorization,
not independent approval. Agents never invoke mutation modes. This source route
does not authorize identity, key, database, network, native login, cohort or live
canary changes. Published/default-off bytes are not operational acceptance. See
the [flight plan](../flight-plans/2026-10-31-paired-artifact-publication.md) and
[operator instructions](../production/paired-image-release.md).
