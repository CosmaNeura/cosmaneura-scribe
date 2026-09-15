# Actions-off local checks

**Status:** source controls prepared; live branch-policy transition pending
**Risk:** Tier 1 — CI and required-status reporter trust
**Owner:** founder
**Scope:** synthetic/non-PHI repository validation only

## Outcome

Keep GitHub Actions disabled while allowing independently verified, exact-head
local results to satisfy Scribe's existing required status names. If Actions is
later re-enabled, the required workflows run only for pull requests, cancel
superseded runs, and never run again solely because a PR merged to `main`.

This plan does not enable Actions, grant status-write permission, alter runtime
or deployment behavior, or authorize production, preview deployment, migration,
or PHI processing.

## Source controls

- `.github/workflows/ci.yml` is `pull_request`-only and retains required jobs
  `quality`, `infrastructure`, `capture-web`, `capture-android`, and
  `capture-ios`.
- `.github/workflows/capture-e2e.yml` is `pull_request`-only and retains
  `synthetic-recording-flow`.
- Both workflows use a PR-number concurrency group with
  `cancel-in-progress: true`.
- Every required job has a timeout between 1 and 60 minutes.
- `change-budget` remains a trusted-metadata `pull_request_target` check and
  keeps its existing fixed limits.
- Non-required CodeQL, provenance, preview, and deployment workflows are
  unchanged.

## Live GitHub policy transition

Read-only evidence before this change showed these seven strict required
contexts bound to GitHub Actions app ID `15368`:

1. `quality`
2. `infrastructure`
3. `capture-web`
4. `capture-android`
5. `capture-ios`
6. `synthetic-recording-flow`
7. `change-budget`

An admin-capable client must remove only the app/integration binding from those
seven entries. It must preserve the context names, strict up-to-date policy,
pull-request rule, approval count, force-push/deletion restrictions, and bypass
policy. The client must re-read both classic branch protection and active
rulesets after mutation. Repository source cannot perform or prove this account-
side change.

## Exact-head evidence contract

Before an already-authorized status writer reports any required context:

1. Re-read the open PR's exact head and base.
2. Confirm Actions remains disabled and no same-name check run or commit status
   is pending or failed on that exact head.
3. Run the context's repository command locally, or record byte-identical input
   hashes and the exact prior successful execution being reused.
4. Publish only the result actually established. Local evidence is not GitHub
   Actions execution and must not be described as hosted CI.
5. Record commands, exit codes, reviewed SHA, findings, and dispositions in the
   PR.
6. Refuse to replace or mask a genuine failure. A substantive push invalidates
   the prior result and independent review.

No new token, app, role, or status writer is created by this change.

## Recovery

Revert the source PR to restore `main` push triggers and prior concurrency.
Separately restore app ID `15368` on the seven required contexts if hosted
GitHub Actions reporting is intentionally restored. Either recovery action may
leave PRs blocked while Actions is disabled; neither action enables Actions.

## Acceptance

- Focused workflow policy tests pass on the exact PR head.
- Existing capture-preview policy tests still pass.
- Scoped lint/type checks and security review report no blocking finding.
- An independent non-implementer reviews the final substantive commit.
- An admin-capable client records before/after GitHub policy readback.
