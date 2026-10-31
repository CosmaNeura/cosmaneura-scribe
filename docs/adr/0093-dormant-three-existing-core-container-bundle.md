# ADR 0093: Dormant Scribe bundle in the three existing Core containers

Status: proposed source option; production architecture selection, image
promotion, identity/network/grant changes and activation remain unapproved.

## Decision

Prepare a separate, default-off option that overlays the locked Scribe runtime
onto an exact digest-pinned Core image and uses the three existing Core API,
worker and scheduler containers. The API starts a non-root loopback Scribe
child; the worker starts bounded speech and translation children; the existing
scheduler sends a content-free pickup task through the existing broker. Core
routes, middleware, dependencies and commands retain their existing behavior
when the bundle flags are false.

This is a new option beyond [ADR 0092](0092-existing-production-host-reuse.md),
whose separate Scribe Container Apps option explicitly leaves Core workloads
unmodified. ADR 0092 and the dedicated private path remain available. This
source option adds no Azure container, service, paid resource, dependency or
shadow authority table, and authorizes no production placement decision.

The child consumes the exact existing Core provider-context authority contract
with fresh human-session and workload-token checks. Core denial or unavailable
authority fails closed without local registry fallback. Only existing catalog
reads are covered: native new-patient/visit creation and service-mutation parity
remain an explicit source gap. Global Agent API and Session Prep stay disabled.

## Consequences and held prerequisites

- The actual merged Core/Scribe image pair, Core Python 3.13, inspected Core
  runtime user, file permissions, sealed source and every Core process/non-root
  child need qualification on the actual layered artifact. A cached Python 3.12
  component smoke with a fixture Core handler does not satisfy this gate.
- Existing identities are selected explicitly. The translation foundation
  identity has account-wide Blob Data Contributor; owner-reviewed reduction or
  removal must precede its held attachment to the existing worker. A shared
  worker with two identities is one trust domain. API key Reader-only access,
  worker unwrap/storage/AI grants and distinct DB roles need actual proof.
- Existing Core PostgreSQL Entra authentication and Scribe Key Vault/Blob public
  access are disabled. Entra, schema/bootstrap/RLS and the exact Core-egress
  ciphertext read/unwrap network policy remain owner-held changes. Existing
  public AI transport alone does not complete hosting.
- Real Clerk organization/session audience/receipt, tenant/practice authority,
  source and image disposition, initial cohort, canary and recovery acceptance
  remain unqualified. No default-off source flag supplies those decisions.

## Recovery

Before deployment, discard or revert the dormant leaves. After separately
approved deployment, stop admissions and pickup, drain accepted work, disable
bundle flags and restore the qualified prior compatible image/configuration
pair. Preserve ciphertext, keys, schemas, mappings and audit data. Network/grant
revocation requires a separate owner plan after drain and SAS expiry; flags are
not rollback for security or data changes. Never fall back to registry or CLI
credentials. The [Tier 2 flight plan](../flight-plans/2026-10-31-existing-core-three-container-bundle-dark.md)
defines the paired source and remaining activation holds.
