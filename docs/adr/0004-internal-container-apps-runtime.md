# ADR 0004: Internal Container Apps development runtime

- Status: accepted
- Date: 2026-08-13

## Context

The scribe API needs a deployable Azure runtime that can reach the private Blob and Key Vault
endpoints without exposing its unauthenticated development surface to the public internet. The
current repository implementation still uses an in-memory repository, so multiple replicas would
produce inconsistent session state.

## Decision

- Build an immutable Linux image from `uv.lock` and run it as a non-root user with HTTP access logs
  disabled.
- Use a dedicated East US workload-profile Container Apps environment on a delegated `/23` subnet.
- Make the environment internal and disable its public network access. App ingress is enabled only
  on the environment's private address and private DNS zone.
- Pull from a dedicated ACR with the existing user-assigned runtime identity and `AcrPull`; do not
  enable registry administrator credentials.
- Scale the development API from zero to at most one replica until PostgreSQL-backed repositories
  replace process memory.
- Send platform and application logs to a dedicated 30-day Log Analytics workspace capped at
  0.5 GB/day. The application continues to prohibit transcript, audio, patient, and object-location
  logging.

## Consequences

The first deployment is reachable only inside the scribe VNet and is suitable for synthetic or
de-identified smoke tests. Connecting the master platform requires an authenticated private network
path or a separately reviewed edge; it must not be solved by making this development API public.
The internal environment creates Azure-managed load-balancer resources and associated baseline
cost even when the API scales to zero.
