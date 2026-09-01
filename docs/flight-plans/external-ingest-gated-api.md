# Flight plan: gated external transcript session admission

## Outcome and boundaries

- Problem and measurable outcome: expose the dormant external-transcript session receiver only to
  the existing authenticated Core workload and one explicitly configured synthetic practice.
  Disabled and non-admitted calls leave no session, idempotency, or audit state.
- In scope: a strict external-session request, a separate creation route, false-default startup
  configuration, exact practice admission, consent/idempotency/audit behavior, generated API
  contracts, and synthetic tests.
- Explicit non-goals: Terraform or environment wiring; deployment or feature activation; a third
  auth path; founder invitations or creator visibility; Core, desktop, Chrome, Zoom, iOS, provider,
  translation, note-generation, patient-name, or DOB handling.
- Affected users, services, environments, and data classes: no user or live environment is affected
  in this packet. The Scribe API contract gains one private workload route. Tests use only
  generated opaque identifiers and synthetic transcript content.

## Risk and dependencies

- Tier and reason: Tier 2 because admission into a transcript-processing boundary depends on auth,
  tenant isolation, consent, and future clinical-data handling.
- Irreversible or high-blast-radius decisions: none activated here. The route is false by default,
  accepts only the existing authenticated service identity, and is not present in deployment
  configuration.
- Dependency stack: domain PR #61; database-expand PR #62; persistence PR #63; this gated receiver;
  then Core admission/ownership; provider-normalized transcript envelopes; client senders; and a
  separately approved dedicated-environment activation.
- Cross-repo order: Scribe is the receiver. Core must consume this additive route only after this
  stack is merged and deployed dark. No sender belongs in this packet.

## Current deployed state

- `origin/main@1aab63c` has none of the external-ingest stack. The current Scribe development
  revision is also known to lag `main`; no live-state claim is made here.
- The packet is based on PR #63 commit `1043e99`. No database migration, environment value, or
  runtime is changed.
- Reconciliation decision: retain current deployed behavior. Before any future promotion, record
  the exact environment SHA, schema, identity, network, and configuration and reconcile them with
  the ordered stack.
- Previous known-good boundary: ordinary authenticated sessions remain `chunk_upload`; no deployed
  caller can create an external-mode session.

## Feature flag / release control

- Control: `external_ingest_admission_enabled`, with the stable practice keys in
  `external_ingest_beta_tenant_ids`.
- Owner and expiry: founder-owned; review by 2026-09-30.
- Initial cohort: exactly one isolated synthetic practice shared by 1–3 internal product testers.
  Only the founder may authorize a later configuration/activation change.
- Semantics: the control blocks new creation and idempotent replays. Existing admitted sessions may
  still receive their transcript so shutdown drains safely.
- Removal condition: replace this startup-scoped micro-beta gate only after Core has a durable,
  reviewed cohort/ownership policy and the broader rollout is separately approved.

## Schema/data sequence

- N/A: this packet adds no migration, table, column, backfill, or data rewrite. It depends on the
  additive `0008` expand rung from PR #62 and preserves its recovery boundary.

## Rollout and promotion

1. Validate settings, auth integration, exact-tenant denial, consent, idempotency, audit, both
   repositories, generated contracts, and the full repository suites.
2. Obtain independent review of the final commit and record its exact SHA and finding dispositions.
3. Hold the PR without merging, deploying, adding Terraform values, or enabling admission.
4. In a later Core packet, enforce signed-in user, invitation/grant, synthetic provenance,
   provider/practice membership, appointment access, and creator-only visibility before calling
   Scribe through the existing Entra workload identity.
5. Treat dedicated-environment configuration and one-practice activation as a separate founder-only
   promotion decision with a synthetic canary.
- Abort a future activation on any authentication regression, non-admitted success, cross-tenant
  disclosure, duplicate session/audit on replay, ordinary-session mode change, or PHI appearing in
  logs or fixtures.

## Security and recovery

- Entra signature, issuer, audience, directory tenant, app-only token type, exact client ID, and
  `Scribe.Workflow.Access` role verification remain unchanged. The allowlist compares the verified
  Core-supplied practice UUID, never Entra `tid` or a request-body value.
- The same opaque `404` covers disabled and non-admitted practices and has no authentication header,
  preventing a cohort denial from appearing to the end user as a login failure.
- Recovery for user-visible behavior is to disable admission or remove the synthetic practice and
  restart/revise the service. Do not revert the mode-aware receiver or drop migration `0008` while
  any external session exists; allow admitted sessions to finish.
- Observation/cleanup: no irreversible cleanup exists. A later activation plan must define canary
  evidence and an observation window before broadening the cohort.

## Completion

- Evidence: defaults fail closed; invalid partial settings fail startup validation; exact Entra
  workload plus admitted practice succeeds; wrong/missing auth and wrong practice fail; denied calls
  write nothing; consent and tenant isolation hold; idempotency converges; ordinary creation stays
  `chunk_upload`; strict input rejects mode, tenant, name, and DOB; generated contracts match; full
  CI and exact-commit independent review pass.
- Follow-ups: Core beta admission/creator ownership; provider transcript envelope; English working
  transcript/Spanish-segment translation; desktop/Meet/Zoom/iOS senders; dedicated environment and
  founder-controlled activation.
- Documentation: ADR 0023 and this flight plan are the contract records for this packet.
