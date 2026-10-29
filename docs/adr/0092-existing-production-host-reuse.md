# ADR 0092: False-default reuse of existing production hosting

Status: accepted for dormant source; production planning, apply, migration, and
activation remain unapproved.

## Decision

Keep the dedicated private Scribe foundation and production native edge as the
default architecture. Add one mutually exclusive, false-default reuse mode that
places separate Scribe Container App resources in the existing Core production
Container Apps environment and creates only an isolated `cosmaneura_scribe`
logical database on the existing Core PostgreSQL Flexible Server.

The dedicated private path remains the canonical default selected by the
ratified platform architecture. Merging this false-default alternative changes
no active placement or production boundary. Selecting it for production traffic,
or changing its network/security posture, remains a separate architecture and
activation decision.

Reuse mode binds exact reviewed resource IDs, FQDNs, region, outbound IPv4, and
the existing production Scribe workflow identity. It does not discover a host by
name or accept an arbitrary resource in the resource group. The Scribe workflow
API is internal and scaled to zero. The standalone native receiver is external
but disabled and scaled to zero. Capture, handoff, upload, receiver, encounter,
Speech, transcription, reconciliation, acceptance, runner, and VNet-connection
gates must all remain false. Images must be immutable digest bindings.

The workflow API origin is the FQDN returned by the Container App ingress. It is
not composed from the app name and environment domain: Azure inserts a distinct
`.internal.` label for internal ingress, while the dedicated public edge has no
such label.

The database migration identity and job are Scribe-owned. The Core repository
must separately enable Entra authentication on its existing PostgreSQL server,
without disabling password authentication, and register that exact migration
identity as administrator. Scribe owns its isolated database and roles; it does
not take ownership of the shared server or Core database.

## Consequences

- No second paid PostgreSQL server or Container Apps environment is needed.
- Existing Core workloads are not modified or sidecar-mounted.
- The applied private Scribe environment, network, storage, Key Vault, registry,
  and identities remain managed and are not destroyed or repurposed.
- The existing non-VNet Container Apps environment cannot reach Scribe's private
  storage or Key Vault. Therefore this mode is suitable only for a dark apply
  until a separately reviewed activation-network design is approved.
- Existing production Azure Speech/AI capacity must be inventoried and reviewed
  before any new cognitive resource is considered; this ADR creates none.
- The existing B1ms PostgreSQL capacity must be observed under synthetic load
  before activation. The API pool is capped at two connections with no overflow.

## Recovery

Keep `deploy_production_existing_host_reuse=false`. If a later dark apply is
reversed, scale remains zero and behavioral gates remain false; remove only the
new Scribe apps/job after preserving the database. Never destroy the shared
server or the isolated database as an automatic rollback. The dedicated/private
path remains available and unchanged.
