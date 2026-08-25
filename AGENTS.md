# AGENTS.md — Cosmaneura Scribe engineering guardrails (v0.2.1)

The canonical baseline lives in `cosmaneura-architecture/deploy-kit/`. This
copy is adapted to Scribe; stricter rules in `CLAUDE.md` still bind.

## Operating objective

Reduce deployment risk created by rapid code growth. Keep changes small,
independently deployable, observable, and reversible. Documentation supports
that work; it does not replace decomposition or deployed-state reconciliation.

## Verified commands and current deployment facts

- Install API dependencies: `uv sync --all-groups`
- Install JavaScript dependencies: `npm ci`
- Test Python: `uv run pytest`; focused: `uv run pytest <path>`
- Test JavaScript workspaces: `npm test`
- Lint/typecheck: `uv run ruff check .`, `uv run pyright`,
  `npm run lint`, and `npm run typecheck`
- Local API: `make dev`; local capture app: `npm run dev`
- Generate OpenAPI: `make openapi`
- Apply migrations: `uv run alembic upgrade head`; revisions live in
  `alembic/versions/`

CI also exercises disposable PostgreSQL, OpenTofu, capture web, Android, iOS,
and browser E2E jobs. The `capture-preview` Function/SWA is a synthetic,
non-PHI surface; when `CAPTURE_PREVIEW_DEPLOY_ENABLED` is true, it deploys
automatically after successful `main` CI. Manual capture-preview acceptance is
not a deployment or a production authorization.

There is no production Scribe deployment workflow. Production promotion is
therefore unavailable, not implied by these docs. Before one is enabled it
must accept only a merged `main` commit and an already-built artifact, and only
the founder may dispatch it. That dispatch is recorded self-authorization,
not independent approval. Agents never deploy production directly.

## Risk class (declare one on every PR)

- **Tier 0 — routine:** localized code, tests, copy, style, documentation, or
  behavior-preserving refactoring with no deployment-surface, schema/data,
  auth/session, billing, PHI, security-boundary, or external-contract impact.
- **Tier 1 — deployment-sensitive and reversible:** dependency, runtime
  configuration, CI/build path, additive API/contract, additive schema/data,
  or user-visible behavior with a deliberate recovery move.
- **Tier 2 — irreversible or high blast radius:** destructive or large-scale
  data work; auth/session, billing, PHI, security boundaries, production
  identity/networking/promotion, breaking contracts, or broad infrastructure.

The following paths and concerns set a minimum of Tier 2:
`services/api/src/cosmaneura_scribe/service_auth.py`,
`apps/desktop-companion/src/capture-authority.ts`, the consent state machine,
transcript storage, and destructive migrations. Classify by effect as well as
path; urgency never lowers the tier. Split mixed work where concerns can be
deployed independently.

## Conditional controls

- Use a feature flag or release control only for reversible user-visible
  behavior, with owner, expiry, and initial cohort. It is not rollback for
  schema, data, infrastructure, security, or refactoring work.
- Use a flight plan for Tier 2, schema/data sequences, cross-repo rollouts, or
  multi-deploy/cohort releases. Routine single-deploy PRs do not invent one.
- A migration rung and rehearsal apply only to schema/data work.
- Every code-changing PR receives an independent agent review after its last
  substantive push. A non-implementer agent records the reviewed commit,
  findings, and dispositions in a durable PR comment or check and links it
  from the PR. A later substantive push invalidates that review.
- Agent review is not GitHub approval. Scribe currently requires no human PR
  approval; preserve that GitHub setting until it is separately revisited.

## Approval, promotion, and reconciliation

- Do not claim a GitHub environment reviewer exists; private GitHub Team does
  not provide that control. Founder production dispatch is self-authorization.
- Before promoting over a deployed SHA, digest, configuration, or schema that
  differs from `main`, record the evidence and choose `assimilate`, `retain
  temporarily`, or `replace`. Never reconcile drift by blindly deploying.
- Security acceptance is scoped. Unless it says otherwise, it permits only
  dark development in a non-PHI environment and blocks production or
  PHI-bearing promotion in the affected scope.
- The current deployed Scribe dev revision is behind `main`; reconcile it
  before any further clinical-runtime deployment. The in-memory dev repository
  is not durable and must not be treated as production evidence.

## Permission boundaries

**Allowed without a separate production decision**

- Small/stacked PRs, tests, flight plans, and reversible refactors in scope.
- Dormant additive schema structures through an approved expand rung.
- Read-only live-state inspection and preparation of reconciliation options.

**Ask first**

- Changes to auth/session, consent, transcript storage, PHI boundaries,
  CI/deployment workflows, environment configuration, or production data.
- New dependencies/services, cohort activation, production promotion,
  migration, backfill, or destructive cleanup.

**Never**

- Put PHI in tests, fixtures, seeds, staging, rehearsal exports, logs, PRs, or
  agent prompts; log transcript/audio identifiers only as allowed by
  `CLAUDE.md`.
- Commit secrets, force-push `main`, deploy an unmerged branch, or represent
  agent output as GitHub approval.
- Drop an additive expand structure as immediate rollback; leave it dormant.
- Archive a repository or delete long-lived deployed resources as part of this
  adoption. Disposable rehearsal cleanup requires its separately approved runbook.

## Architecture and workflow

- Consent is a state-machine gate. Keep capture/storage, transcription,
  speaker-role labeling, and note-engine handoff behind replaceable interfaces.
- Vendor auth/claim parsing stays in `service_auth.py` or
  `capture-authority.ts`; domain code consumes a normalized principal.
- Cross-repo work is receiver-first and backward-compatible.
- Each PR should be reviewable in roughly ten minutes and produce one
  deployable outcome. Prefer a dependency-ordered stack to a mixed tranche.
- The separately proposed `change-budget` check blocks PRs over 2,000 changed
  lines or 50 files. Once required, change its thresholds only in a separate
  reviewed policy PR; an oversized change cannot waive its own limit.
- Every PR records tier, tests, exact recovery, agent-review evidence, and only
  the conditional controls that apply.
- Current gap: capture-preview deploy has no docs-only path filter, so an
  enabled preview can redeploy after a docs-only `main` merge. Do not describe
  the target rule "docs do not deploy" as already enforced.
- No workflow currently validates tier, flight-plan, or agent-review evidence;
  those remain documented process controls. The change-budget check is the
  first narrow automated scope gate and does not claim to validate semantics.
