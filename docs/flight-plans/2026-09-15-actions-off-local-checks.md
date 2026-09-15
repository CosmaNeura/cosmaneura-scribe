# Actions-off local checks

**Status:** Actions disabled and binding-only branch transition verified; final-head validation/review/status gates pending
**Risk:** Tier 2 — required-status reporter trust boundary
**Owner:** founder
**Scope:** synthetic/non-PHI repository validation only

## Outcome

Keep GitHub Actions disabled while allowing independently verified, exact-head
local results to satisfy Scribe's existing required status names. If Actions is
later re-enabled, the required workflows run only for pull requests, cancel
superseded runs, and never run again solely because a PR merged to `main`.

This plan does not enable Actions, grant status-write permission, change clinical
runtime, or authorize production, preview deployment, migration, or PHI processing.
CI no longer emits the main-push completion consumed by capture-preview-deploy.yml;
that preview route remains dormant even if its enable variable changes. A separately
reviewed and authorized trigger design is needed before preview reactivation.

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

An account payment failure or reached spending limit is not Actions
disablement. On 2026-09-15, PR #93 still triggered workflows whose jobs failed
before startup with that billing annotation. Before using the local-status
path, an admin must explicitly disable Actions for this repository and verify
the setting. A later final PR head must have no Actions-created same-name
checks.

## Live GitHub policy transition

Read-only evidence before this change showed classic branch protection with
these seven strict required contexts bound to GitHub Actions app ID `15368`:

1. `quality`
2. `infrastructure`
3. `capture-web`
4. `capture-android`
5. `capture-ios`
6. `synthetic-recording-flow`
7. `change-budget`

Active ruleset `21000654` separately required six Actions-bound contexts:
`quality`, `infrastructure`, `capture-web`, `capture-android`, `capture-ios`,
and `change-budget`; it did not include `synthetic-recording-flow`.

An admin-capable client must remove only the app/integration binding from the
existing entries in both enforcement layers. It must preserve each layer's
context names, strict up-to-date policy, pull-request rule, approval count,
force-push/deletion restrictions, and bypass policy. The client must re-read
both classic branch protection and active rulesets after mutation. Repository
source cannot perform or prove this account-side change.

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

Revert the source PR to restore `main` push triggers and remove the new
PR-scoped cancellation.
Separately restore app ID `15368` on all existing entries in both classic
protection and ruleset `21000654` if hosted GitHub Actions reporting is
intentionally restored. Re-read both layers and preserve their respective
seven- and six-context sets. Either recovery action may leave PRs blocked while
Actions is disabled; neither action enables Actions.

## Acceptance

- Focused workflow policy tests pass on the exact PR head.
- Existing capture-preview policy tests still pass.
- Scoped lint/type checks and security review report no blocking finding.
- An independent non-implementer reviews the final substantive commit.
- Repository-level Actions disablement is confirmed; a billing failure or spend
  limit is not accepted as equivalent.
- An admin-capable client records before/after GitHub policy readback.


## Recorded account-side transition

The [sanitized before/after record](evidence/2026-09-15-actions-off-policy.json)
retains Actions permissions, complete branch controls, effective rules and active
rulesets. Exact expected context sets and strictness were checked before mutation.
Both repositories were disabled before any new commit/push; billing errors were
not treated as disablement. Full policy comparison verified that the only branch
delta is removal of Actions issuer 15368. No required context, approval rule,
strictness, deletion/force-push restriction or bypass actor changed.

Classic protection was updated through its required-status-checks subresource,
not a partial whole-protection replacement. Scribe's ruleset was updated with its
complete editable policy, preserving the deliberate six-versus-seven distinction.
The disabled Actions response omits allowed-actions selection; retained before
settings must be reviewed before any separately authorized re-enablement.

Old-head failed Actions checks remain intact. This meaningful evidence commit
creates a new head; it is not an empty commit or a replacement of failed results.
After its single normal push, verify no Actions run/check appeared on the new head
before publishing any local status. Record exact commands, hashes, exit codes,
review/dispositions and status evidence in the PR; historical successes alone are
not current-head validation. No status or merge success is asserted in this file.

The owner subsequently authorized merging only if independent review and genuine
required-status evidence pass and the cost-control goal is met. That is not bypass
authority or deployment approval. Leave the PR draft/unmerged if any gate is unmet.
Bugbot autofix remains off; confirmed findings are fixed in this task. Do not ask
for repeated unchanged-head reviews or rerun hosted CI to obtain green results.
Opsera is not claimed to have run; authentication and any compensating security
evidence must be stated explicitly in the final PR report.
