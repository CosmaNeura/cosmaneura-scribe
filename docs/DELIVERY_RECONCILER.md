# Manual delivery reconciler

The delivery reconciler is a tenant-scoped repair path for durable master-platform delivery
receipts. It is not a scheduler and it is not part of the normal delivery route.

## Default state

Both infrastructure gates default to `false`:

- `deploy_delivery_reconciler_job` creates only the manual Container Apps Job, its dedicated
  user-assigned identity, and that identity's `AcrPull` assignment.
- `enable_delivery_reconciler_job` opens the runner's hard gate and lets the database migration
  job configure the identity's narrow PostgreSQL principal.

The base job has no arguments, schedule, event rule, ingress, platform retry, or Terraform-granted
start permission. It uses a commit-SHA image, one completion, parallelism one, and a bounded
timeout. It has no Blob, Key Vault, Speech, or subscription data-plane role.

## Prerequisites for enablement

Do not set the enable gate until all of these are complete:

1. Deploy the master-platform logical-producer migration and configure its exact API and
   reconciler caller client IDs.
2. Assign `Scribe.Transcript.Write` on the master API service principal to the reconciler identity.
   This is an Entra application-role assignment managed outside this Scribe stack.
3. Deploy the corrected Scribe claim implementation and run the PostgreSQL concurrency suite.
4. Run the Scribe database migration job after the enable-gated reconciler principal values are
   present. Verify its column grants match ADR 0015.
5. Review both VNet peerings, routes, private DNS links, and NSGs, then prove the platform hostname
   resolves privately from the job subnet.
6. Run the cross-identity replay and live synthetic delivery acceptance described in ADR 0015.

The Terraform enable validation also requires the deployed migration job, PostgreSQL API cutover,
master-platform handoff, and the existing private-platform VNet connection gate.

## Governed execution

A separately authorized operator starts one manual execution with exactly one positional tenant
UUID. Missing, extra, and malformed arguments fail before settings, PostgreSQL, or Entra token
construction. Delivery IDs, stale cutoffs, limits, endpoints, scopes, and identity selectors are
not runtime arguments.

The runner claims and completes one receipt before claiming another. Claim eligibility uses
PostgreSQL time and the image-owned pending and retry delays. It logs fixed actions, opaque IDs,
and fixed error classes only; it never logs a payload, transcript, token, endpoint, or supplied
invalid argument.

## Disable and rollback

Set `enable_delivery_reconciler_job=false` first and cancel active executions. Then remove external
start authority, the master app-role assignment, and the database principal/grants as required.
Do not delete delivery receipts or audit evidence. The normal API delivery path remains available.
