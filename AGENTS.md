# AGENTS.md — Cosmaneura engineering guardrails

> Canonical copy lives in `cosmaneura-architecture/deploy-kit/`. Sync on Contract Friday.
> Keep this file under ~150 lines: only non-inferable rules belong here.

## Stack

GitHub + GitHub Actions (no Azure DevOps) · Azure Container Apps · ACR ·
Azure Database for PostgreSQL Flexible Server · Clerk + Microsoft Entra ID
(sign-in; varies by service). Core deploys from `master`. Key Vault + App
Insights are target-state, not yet live in core prod.
**This repo: the capture/scribe service. ACA **dev only**.**

## Commands

- Install: `make dev  # bootstraps the workspace`
- Test (all): `uv run pytest`
- Test (single file): `uv run pytest <path>`
- Lint + typecheck: `uv run ruff check .`
- Local dev: `make dev`
- DB migration create: Alembic in `services/api`. Note the dev environment currently runs an in-memory repository — see Repo notes.
- Deploy: **no deploy job in CI.** The dev revision was deployed by hand.

## Risk tiers (declare one on every PR)

- **Tier 0** — copy, styling, docs, config text, additive UI behind an existing flag. CI green → merge.
- **Tier 1** — new feature logic, new endpoints, additive-only schema changes (new tables/columns, nullable). Requires: feature flag + flight plan reference.
- **Tier 2** — anything touching `services/api/src/cosmaneura_scribe/service_auth.py`, `apps/desktop-companion/src/capture-authority.ts`, the consent state machine, and anything touching transcript storage, or any destructive migration. Requires: flight plan, migration ladder compliance (docs/MIGRATION_PLAYBOOK.md), rehearsal run, founder sign-off.

Tier is set by the *paths a change touches*, never by urgency.

## Permission boundaries

**Allowed freely**
- Creating branches, PRs, and stacked PRs; small refactors inside a feature's own module
- Adding feature flags; additive migrations (new nullable columns, new tables, new indexes)
- Updating docs, tests, and flight plans

**Ask first**
- Any change under the Tier 2 paths above — even one line
- Adding a new external dependency or third-party service (BAA implications)
- Changing CI workflows, environment config, or anything under `.github/`
- Backfill scripts that write to production data

**Never**
- Destructive migrations (DROP/RENAME column or table, type changes) outside a labeled `contract` PR whose hold period has elapsed
- Importing auth/billing internals from feature code — go through the public interface of the module only
- Turning a feature flag on for all users in code; rollout happens through the flag system, by cohort
- Touching production directly (`az` commands against prod resources), force-pushing the default branch, committing secrets, or putting real PHI in tests, fixtures, seeds, staging, or logs

## Architecture rules (the non-inferable ones)

- Identity: only this repo's designated auth adapter module(s) — `services/api/src/cosmaneura_scribe/service_auth.py` (Microsoft Entra ID) and `apps/desktop-companion/src/capture-authority.ts` (desktop capture authority) — may import vendor SDKs (Clerk, Entra/MSAL) or parse provider claims. All domain code consumes a normalized principal from the adapter — never raw tokens, never provider-specific branches. One adapter per service; there is no cross-service facade.
- Reversible user-visible behavior ships behind a flag/cohort control from its first commit (name: `ff_<feature>_<yyyymm>`, owner + expiry in the flight plan). Refactors, security fixes, infra, and schema work are NOT flagged — small PRs + migration ladder + revert.
- All schema changes follow docs/MIGRATION_PLAYBOOK.md. Additive first; destructive only as a final `contract` step. A "rung" = one independently deployable, observable, backward-compatible transition (may span coordinated cross-repo PRs; receiver/auth deploys before sender activation).
- Users carry an `auth_version` (or equivalent) marker during auth migrations; both old and new paths must work until the contract step.

## Workflow

1. New feature? FIRST draft `docs/flight-plans/<feature>.md` from the template. Do not write feature code before the flight plan exists.
2. Build as a stack of small PRs (interface/seam → logic → UI → flag wiring). One session per layer. Keep diffs reviewable by one human.
3. Every PR fills in the PR template completely, including the tier and the change record.
4. If a PR changes deploy-relevant behavior, update this file in the same PR.

## Repo notes

**Preserved from this repo’s existing AGENTS.md — these still bind:**
Follow `CLAUDE.md`. Consent is a hard state-machine gate, not a UI concern. Keep
capture/storage, transcription, speaker-role labeling, and note-engine handoff
behind replaceable interfaces.

- Dev runs with an **in-memory repository**: state does not survive a restart. Do not
  treat anything observed there as durable.
- The durable production runtime is blocked on a **pending East US PostgreSQL
  region-access request**. That is an Azure approval, not a PR — do not try to code
  around it.
- The deployed dev revision is **behind `main`**. Every deployed environment must
  trace to a commit on the default branch (SECURITY_HARDENING.md item 6).
- Monorepo: `apps/`, `services/`, `packages/`. Scribe is the first deployment target,
  so its onboarding guide is canonical for scheduling too.
