# ADR 0007: Verify the platform workload before accepting tenant context

## Status

Accepted

## Context

Scribe originally read `X-Tenant-ID` directly on its private `/v1` routes. Private Container Apps
networking limits reachability but does not prove which workload sent a request. The Entra `tid`
claim identifies the Azure directory; it does not identify a Cosmaneura practice.

## Decision

Every `/v1` route requires an app-only Entra access token issued for the Scribe API. Scribe admits
only the exact master-platform managed-identity client ID with the `Scribe.Workflow.Access`
application role. Only after that verification does it accept the platform-supplied practice UUID
from `X-Tenant-ID`. Operations probes remain open. Disabled or incomplete authentication fails
closed with no development bypass in production code.

## Consequences

- Staff and patient login systems remain unchanged and their browser credentials never reach
  Scribe.
- The platform remains responsible for mapping its authenticated user and canonical practice to
  the tenant UUID.
- A stolen token for another application, another managed identity, or a delegated user cannot
  select a Scribe tenant.
- Entra app registration and application-role assignment must precede feature enablement.
