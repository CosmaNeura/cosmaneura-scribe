# Actions-Off Local Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Scribe mergeable with GitHub Actions disabled while preventing duplicate required-check execution after Actions is deliberately re-enabled.

**Architecture:** Required PR checks remain strict and keep their existing context names, but are no longer restricted to GitHub Actions app `15368`. The required CI and browser-E2E workflows become PR-only, cancel superseded runs, and bound every job. A flight plan records the exact live-policy transition and the evidence rules for any authorized local status writer.

**Tech Stack:** GitHub Actions YAML, Python/pytest policy tests, repository governance documentation.

## Global Constraints

- GitHub Actions remains disabled until the owner explicitly authorizes re-enabling it.
- Preserve required context names, strict up-to-date enforcement, approval settings, and the empty bypass list.
- Never fabricate a status or overwrite a genuine failure.
- Local evidence must bind to the exact PR head and identify whether checks ran or were reused through byte-identical inputs.
- No production, preview, migration, cloud, PHI, or deployment action is authorized.

---

### Task 1: Pin workflow cost controls with failing tests

**Files:**
- Create: `tests/test_ci_cost_controls.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/capture-e2e.yml`

**Interfaces:**
- Consumes: tracked workflow YAML.
- Produces: PR-only, cancellation-safe, finite required workflows.

- [ ] **Step 1: Write tests requiring `pull_request`-only triggers, PR-scoped concurrency with cancellation, and a finite timeout on every job.**
- [ ] **Step 2: Run `uv run pytest tests/test_ci_cost_controls.py -q` and confirm failure because push triggers/concurrency/timeouts are currently unsafe.**
- [ ] **Step 3: Remove `push` from both required workflows, add PR-scoped concurrency with `cancel-in-progress: true`, and add 30-minute caps to the three uncapped CI jobs.**
- [ ] **Step 4: Rerun the focused test and confirm it passes.**

### Task 2: Record the Actions-off trust boundary

**Files:**
- Create: `docs/flight-plans/2026-09-15-actions-off-local-checks.md`
- Modify: `AGENTS.md`
- Modify: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: live branch protection readback and PR #407 precedent.
- Produces: exact admin instructions and merge evidence requirements.

- [ ] **Step 1: Record classic protection's seven required contexts, ruleset `21000654`'s six-context subset, app-ID removal in both layers, strict-policy preservation, collision checks, rollback, and the Actions-off hold.**
- [ ] **Step 2: Update agent and PR guidance so local evidence is never represented as hosted CI and any status binds to the exact head.**
- [ ] **Step 3: Run focused documentation/policy tests and `git diff --check`.**

### Task 3: Validate and submit

**Files:**
- Test: `tests/test_ci_cost_controls.py`
- Test: `tests/test_capture_preview_cloud.py`

**Interfaces:**
- Consumes: final branch diff.
- Produces: one Tier 1 draft PR and an exact live-policy handoff.

- [ ] **Step 1: Run `uv run pytest tests/test_ci_cost_controls.py tests/test_capture_preview_cloud.py -q`.**
- [ ] **Step 2: Run scoped Ruff and Pyright plus the repository security scan.**
- [ ] **Step 3: Commit, push, create/update the draft PR, and obtain independent final-head agent review.**
- [ ] **Step 4: Confirm an admin-capable client removes only app ID `15368` from all existing entries in classic protection and ruleset `21000654`, preserves their respective seven- and six-context sets, and re-reads both layers before any merge.**
