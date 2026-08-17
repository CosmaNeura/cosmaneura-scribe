# ADR 0012: Gate transcription behind a one-target manual Container Apps Job

**Status:** Accepted

## Decision

The first production transcription trigger is a manual Azure Container Apps Job with two
independent, false-by-default controls. `deploy_transcription_job` creates the job, its dedicated
user-assigned identity, and only its ACR pull role. `enable_transcription_job` changes the runner's
hard gate and creates the Blob, Key Vault, and Speech data-plane roles. Enabling requires the API
to use PostgreSQL, keeps the migration job available for principal reconciliation, and requires the
Terraform-owned private Speech foundation. Deployment accepts only an image tag equal to a
lowercase full commit SHA. ADR 0014 owns the private resource, DNS guard, and synthetic acceptance
path.

The job has no ingress, schedule, event scale rule, queue consumer, or principal authorized by this
configuration to start executions. The intended execution supplies exactly two positional
arguments: tenant UUID and session UUID. The base job template contains no arguments. A custom
parser emits only fixed error codes and never echoes values. The runner reads the raw enable
variable before loading `Settings`, parsing UUIDs, opening PostgreSQL, or constructing any Blob,
Key Vault, or Speech client. A disabled execution therefore emits one fixed metadata-only event and
exits nonzero even if arguments are absent or invalid. Accidental starts are visible while
remaining incapable of touching custody. Container Apps start permission can override a job's
image, command, arguments, and environment, so it is treated as trusted code execution under the
worker identity and is not granted here.

A live dormant-job probe disproved the assumption that an args-only container override merges with
the deployed template. The `az containerapp job start` call used `--container-name smoke` and
`--args <uuid> <uuid>`. Azure returned `ContainerAppImageRequired` because the replacement
container had no `Image` property. Clinical activation therefore remains blocked until a reviewed
operator helper submits and verifies a complete execution template, preferably with `--yaml`, that
preserves the exact deployed image, command, environment, CPU and memory resources, and volume
mount while injecting only the two UUID arguments. Supplying ad hoc `--image` or `--command` flags
is not an acceptable repair because other security-critical template fields could be omitted.

Container Apps parallelism and completion count are both one, and platform retries are zero. The
durable PostgreSQL transcription record remains the retry authority: the application worker permits
exactly three claims across separately started executions, using its existing lease, heartbeat,
consent revalidation, terminal-state, and idempotent transcript rules. Container Apps cannot add an
unrecorded fourth attempt or retry a process after an ambiguous platform failure.

The worker has a user-assigned identity distinct from the API runtime and database migration
identity. It receives ACR pull only when deployed and, only when enabled, Storage Blob Data Reader
on the audio container, Key Vault Crypto User on the wrapping key, and Cognitive Services Speech
User on the selected Speech account. The migration identity maps the worker identity to a separate
PostgreSQL Entra role. That role can read consent, chunks, wrapped session keys, and transcripts;
insert transcripts and audit events; and select/update only sessions and transcription jobs. It has
no upload-grant, idempotency, delivery, delete, DDL, or migration privilege.

The foundation creates one RSA-3072 Key Vault key limited to `wrapKey` and `unwrapKey`. The API
runtime gets key-scoped Key Vault Reader so it can publish public wrapping material; it does not get
unwrap permission. The transcription identity gets key-scoped Crypto User only after activation.

Assembly uses an `EmptyDir` mount protected by Azure's platform-managed encryption at rest. The
assembler additionally writes only process-key-encrypted track files with restrictive permissions,
never plaintext paths, and securely cleans the directory under cancellation. SIGTERM and SIGINT
cancel and await the active task so custody cleanup runs before the process exits. The runner closes
all clients under cancellation and emits only fixed structured actions, opaque tenant/session IDs,
and fixed error classes.

## Consequences

- The job definition can be deployed and inspected without making audio readable or Speech
  callable. Turning on the Boolean alone is insufficient unless all private dependencies and roles
  are present.
- Every execution is intentionally narrow and auditable, but an operator must supply the two UUIDs
  through the reviewed full-template helper and start each retry manually until a later reviewed
  trigger replaces this one. No clinical execution may start before that helper is implemented and
  validated.
- The Speech account, its private endpoint and DNS, and the synthetic live acceptance test are
  implemented separately by ADR 0014. The worker derives its endpoint and role scope from that
  owned foundation rather than accepting free-form identifiers.
- The Key Vault key is a data-plane resource. Infrastructure applies must run from an approved
  network path that can resolve and reach the private vault.
