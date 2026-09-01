# ADR 0023: Admit external transcript sessions through the existing workflow identity

**Status:** Accepted (admission remains dark)

## Context

Desktop, browser-meeting, Zoom-fallback, and iOS senders will eventually need a durable Scribe
session whose first clinical artifact is an asynchronous transcript rather than uploaded audio
chunks. The domain, additive database column, and dormant persistence receiver exist in the
preceding stack, but ordinary `POST /v1/sessions` intentionally creates only `chunk_upload`
sessions.

The first micro-beta is limited to one isolated synthetic practice and 1–3 internal product
testers. Scribe must not gain a browser/mobile login path, accept a caller-supplied practice
boundary, or treat a provider identifier in a request body as actor authorization. The existing
Core workload route already authenticates one exact Entra v2 app-only caller and accepts the
practice `X-Tenant-ID` only after that verification.

## Decision

Add a separate `POST /v1/external-transcript-sessions` receiver. Its strict request contains only
the existing opaque appointment, practitioner, patient, consent, and modality fields. It rejects
unknown fields, including `ingest_mode`, tenant, patient name, and date of birth. The server alone
sets `ingest_mode=external_async_transcript`.

Admission uses two non-secret settings:

- `external_ingest_admission_enabled`, false by default; and
- `external_ingest_beta_tenant_ids`, empty by default and capped at one nonzero practice UUID for
  this micro-beta.

An enabled configuration is invalid unless Entra workflow authentication and the PostgreSQL
repository are also enabled. A populated practice set may be staged while admission remains off.
Settings are startup-cached, so an admission change takes effect only with a new process/revision.

The route composes the existing verified-tenant dependency with the admission check before it
opens a repository transaction. Disabled admission and a non-admitted practice return the same
opaque `404` without a `WWW-Authenticate` header. Entra failures retain the existing `401`, `403`,
or `503` behavior. The request body never supplies tenant context.

The route validates the tenant-scoped consent, uses a separate idempotency operation and a
mode-bound request fingerprint, creates one external-mode session, and writes one metadata-only
audit event. Removing the practice or disabling admission blocks new calls and replays but does
not disable transcript receipt for sessions already admitted; those sessions must remain able to
drain safely.

Core remains responsible for Clerk user authentication, founder-controlled invitation/grant,
synthetic-practice provenance, provider-to-practice membership, appointment access, and
creator-only dashboard visibility. Desktop, Chrome, Zoom, and iOS never receive the Scribe Entra
credential and never call this route directly.

## Consequences

- There is no third authentication path and no account or login migration.
- The existing `/v1/sessions` contract and its `chunk_upload` default remain unchanged.
- The endpoint is unusable under repository defaults and is not wired into Terraform or a deployed
  environment by this decision.
- This is an admission control, not a full emergency receiver kill switch. Recovery stops new
  admission first and retains the mode-aware receiver and schema until admitted sessions are
  terminal.
- Generalizing beyond one synthetic practice, accepting PHI, adding a Core caller, or activating a
  deployed cohort requires a separate reviewed decision and rollout record.

