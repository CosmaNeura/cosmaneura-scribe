# Flight plan: beta pre-integration translation slice

## Outcome and boundary

- Outcome: open the synthetic bilingual transcript-to-note gate while the shared platform remains
  unavailable for integration.
- Exact base: `b46ade85f7e0dc3eed36e4c881e3752d2dfc8b3e`.
- Working mode: one local, unpushed branch; no pull request until the stabilization work finishes.
- Risk: Tier 2 because the code prepares protected transcript processing and note handoff, even
  though it is dormant and changes no schema or deployment surface.
- In scope: provider-neutral `es-US` to `en-US` execution contracts, bounded provider outcomes, a
  deterministic synthetic adapter, a shared synthetic conformance fixture, a note-ready English
  handoff mapper, and in-process acceptance evidence.
- Out of scope: Core, Clerk, auth/session code, IAM/RBAC, Zoom, staging, routes/OpenAPI, migrations,
  database grants or configuration, real provider SDKs/calls, infrastructure actions, desktop/iOS
  runtime wiring, PHI, deployment, and activation.

## Ordered implementation and evidence

1. Validate adapter/profile configuration and the caller's authoritative Spanish reservation
   before invoking a provider.
2. Pass only clinical text plus the fixed `es-US` to `en-US` direction to the adapter.
3. Plan only missing/failed/rejected current Spanish lineage, stop on source-quality blockers, and
   require a caller-supplied durable translation identity.
4. Convert success or bounded failure into the existing immutable attempt command, then round-trip
   its tenant/session-bound completed-job envelope before commit. Never rerun the provider inside
   database reconciliation.
5. Exercise the existing consent, translation, creator-review, and English-projection writers with
   a deterministic synthetic adapter.
6. Admit only a blocker-free, note-ready English projection to the existing master-platform
   request model and prove the Spanish source is absent from that request.
7. Keep the cross-client normalized-source fixture stable so desktop and iOS can run the same
   conformance case after their current stacks are rebased.

Required local evidence is focused and full Python tests, Ruff, strict Pyright, `git diff --check`,
and confirmation that no excluded path or migration changed. PostgreSQL persistence is already
covered by the underlying writer packets; the new provider seam is pure and uses the in-memory
repository for its end-to-end test.

## Gates opened, not completed

| Gate | Evidence produced here | Remaining before closed beta |
| --- | --- | --- |
| Scribe backend | Fixed-direction adapter seam, bounded outcomes, and versioned completed-job contract | Encrypted job store/resume, actual provider integration and evaluation |
| Translation/note path | Synthetic source-to-reviewed-English-to-note contract | Core review caller, provider allowlist, exact deployed artifact |
| Core onboarding/dashboard | Stable input/output shapes only | Existing-auth invitation, creator views, encounter/dashboard implementation |
| Desktop and iOS | One shared normalized-source fixture | Client conformance, signing, distribution, live-capture evidence |
| Dedicated environment | False-default activation boundary documented | Approved configuration/IAM/Terraform plan and later apply |
| End-to-end acceptance | Deterministic in-process scenario | Signed-client and deployed non-PHI cohort evidence |

## Rebase and promotion plan

Keep commits independent and preserve this branch locally. After stabilization, inspect the new
base without changing it, classify overlap, and cherry-pick only the still-needed commits onto a
fresh branch. Do not modify the reviewed Packet B branch. Before any PR, re-run the exact-base full
suite and split the final review stack into no more than three reviewable packets under the change
budget.

The local accumulation branch intentionally exceeds the 2,000-line PR budget and must never be
opened as one PR. Rebuild it as these three bounded packets:

1. **Translation execution contracts:** adapter, planner, completed-job envelope, unit tests, and
   ADR 0034.
2. **English handoff acceptance:** handoff mapper, shared bilingual fixture, and the synthetic
   vertical/race tests.
3. **Beta product gates:** onboarding/access and dashboard matrices, dark-activation manifest,
   exact-artifact acceptance runbook, and their contract tests.

Packet 2 depends on Packet 1. Packet 3 is contract-only and may review independently once its
status names are checked against the stabilized Scribe base.

Abort integration on a changed auth/tenant/creator contract, a different transcript schema head,
an incompatible note-engine request, a live-provider or environment dependency, a need to repeat a
provider call for database reconciliation, or any fixture that is not unmistakably synthetic.
