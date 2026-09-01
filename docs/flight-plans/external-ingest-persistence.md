# Flight plan: dormant external-ingest persistence

## Outcome and boundaries

- Problem and measurable outcome: make the application preserve the immutable
  ingest mode introduced by the database-expand packet while keeping the
  existing session-creation request on `chunk_upload`. Repository-created
  `external_async_transcript` sessions can move directly from `created` to
  `transcript_ready`, and they cannot enter an audio-capture path.
- In scope: the internal session model, in-memory and PostgreSQL repositories,
  mode-aware transcript transition validation, audio-capture guards, generated
  response contracts, and synthetic tests.
- Explicit non-goals: a request field or endpoint that selects external mode;
  a beta feature flag or cohort allowlist; provider callbacks; Zoom, Meet,
  desktop, or iOS wiring; translation; note generation; Core changes; migration
  application; deployment or feature activation.
- Affected surfaces if separately merged: Scribe API responses gain an additive
  `ingest_mode`; Scribe repositories preserve the column from PR #62. Existing
  requests remain unchanged and create only `chunk_upload` sessions. Tests use
  synthetic identifiers and transcript content and no PHI.

## Risk and dependencies

- Tier: Tier 2 because transcript readiness and the boundary between external
  transcript ingest and audio custody affect clinical-data processing.
- High-blast-radius decisions: none are activated here. The ingest mode remains
  immutable, and an external-mode session is rejected from audio-key, lease,
  reservation, upload, registration, audio-transcription-job, and completion
  paths.
- PR #61 intentionally preserves the existing status graph and adds only the
  direct external transcript-ready transition. This packet therefore enforces
  the audio-custody boundary on immutable ingest mode, not on status labels;
  changing an external session's status cannot unlock an audio operation.
- Dependency-ordered PR stack: domain contract PR #61; database-expand PR #62;
  this dormant persistence packet; a future false-default, tenant-allowlisted
  beta API; then provider and client integrations. Each packet can remain held
  without activating a user path.
- Cross-repo contract/version: N/A in this packet. The additive response field
  and generated web client live in this repository. Future Core and client
  integration must remain receiver-first and backward-compatible.

## Current deployed state

- `origin/main@1aab63c` has neither the domain/database expansion nor this
  persistence wiring. This packet is based on PR #62 at `63354cc` and records
  no claim about a live environment.
- The dedicated synthetic beta environment remains a future target. No shared
  database, production service, or PHI-bearing environment is changed here.
- Reconciliation decision: retain current deployed behavior. Before any
  promotion, record the exact deployed SHA, schema, and configuration and
  explicitly reconcile them with the ordered stack.
- Previous known-good behavior is the current `chunk_upload` path. Recovery is
  to hold or revert this application packet while retaining the additive
  database structure dormant.

## Feature flag / release control (user-visible reversible behavior only)

- N/A in this packet: there is no request field, route, adapter, or client that
  can select `external_async_transcript`. The existing create-session request
  always constructs `chunk_upload`. The next callable API packet must add a
  false-default, founder-controlled tenant allowlist before external mode can be
  selected.

## Schema/data sequence (schema/data work only)

- N/A: this packet adds no migration, table, column, backfill, or data rewrite.
  It depends on the additive `0008` schema from PR #62 and is validated against
  a disposable PostgreSQL database.

## Rollout and promotion

1. Validate focused repository/API tests, the full Python and JavaScript suites,
   Ruff, Pyright, generated-contract parity, and one Alembic head.
2. Obtain independent review of the final commit and record the exact SHA and
   finding dispositions on the PR.
3. Hold the stacked PR. Do not merge, deploy, apply a migration, or activate a
   cohort as part of this packet.
4. In the next packet, add a false-default external-session creation contract
   restricted to the dedicated synthetic beta tenant and existing trusted
   service-auth path; do not introduce a third authentication path.
- Abort a future promotion if a public request can select external mode without
  the approved gate, a default request no longer creates `chunk_upload`, an
  external session can enter an audio path, tenant isolation changes, or an old
  idempotent request no longer replays.

## Security and recovery

- Existing Entra service authentication, tenant context, consent validation,
  row-level security, and creator-visibility responsibilities are unchanged.
  This service still receives a tenant-scoped service principal rather than a
  provider identity; creator-only authorization remains an upstream/Core
  requirement for the later callable path.
- Behavioral recovery before any external-mode rows exist: stop rollout and
  revert this packet while retaining migration `0008` dormant. After any such
  row exists, do not revert below the mode-aware receiver; stop future creation
  at its source and keep this code until every external session is terminal.
  Never drop `0008` as an emergency rollback.
- Data-damage boundary: no data rewrite occurs. An external-mode row created by
  privileged internal code keeps its original transcript storage and tenant
  boundary.
- Observation window before irreversible cleanup: N/A; no cleanup is planned.

## Completion

- Required evidence: old create-session request and idempotency behavior remain
  stable; both repositories round-trip each mode and enforce immutability;
  external-mode direct transcript persistence works; audio paths reject that
  mode; cross-tenant reads remain hidden; generated contracts match; full CI
  and exact-commit independent review pass.
- Follow-up packets: false-default tenant-allowlisted external-ingest API;
  provider-normalized transcript envelope; desktop/Meet/Zoom/iOS senders;
  English-working-transcript translation and note generation.
- Update the beta contract if activation authority, identity propagation,
  storage semantics, or the recovery boundary changes.
