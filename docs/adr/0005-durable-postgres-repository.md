# ADR 0005: Durable passwordless PostgreSQL repository

- Status: accepted
- Date: 2026-08-13

## Context

The internal Container App currently scales to zero and loses process-memory records when its
single replica is recycled. Consent, capture custody, idempotency, state transitions, transcript
metadata, and audit history must survive restarts and remain tenant-isolated. Database credentials
must not be distributed through application settings or Terraform state.

## Decision

- Keep the API dependent on an async repository contract and retain an in-memory adapter for local
  development.
- Use Azure Database for PostgreSQL Flexible Server 16 with private VNet integration, Entra-only
  authentication, seven-day development backups, no high availability, and conservative bounded
  development sizing.
- Give each HTTP request one transaction and set `app.tenant_id` transaction-locally before any
  repository query.
- Force PostgreSQL row-level security on every tenant table as defense in depth. Every repository
  statement also includes an explicit tenant predicate.
- Claim idempotency keys atomically inside the same transaction as the entity mutation and audit
  event.
- Store only upload-grant metadata. Never persist a SAS URL or Entra access token.
- Enforce legal session status transitions with a database trigger and make audit events
  append-only.
- Use a separate migration managed identity as the PostgreSQL Entra administrator. It creates the
  runtime Entra database principal, runs reversible Alembic migrations, and grants minimal table
  privileges. The API runtime identity is not an administrator and receives tokens at connection
  time through `DefaultAzureCredential`.
- Gate foundation creation, migration-job creation, and API cutover behind separate false-by-default
  OpenTofu flags.

## Consequences

The API can persist records through scale-to-zero and can later scale horizontally without
process-local state divergence. Tenant isolation, idempotency, state transitions, and audit
immutability no longer depend solely on API code. Token acquisition and PostgreSQL connectivity add
runtime dependencies, so readiness is database-aware while liveness remains independent.

The database introduces recurring Azure cost and operational responsibility. It is not deployed
until an exact plan is approved. At acceptance time, the development subscription reports new
Flexible Server provisioning as restricted in East US and East US 2, so the implementation can be
merged and tested while Azure deployment waits for a subscription capacity exception.
