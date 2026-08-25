# Flight plan: name the outcome

Use this template only for Tier 2, schema/data sequences, cross-repo rollouts,
or changes released over multiple deploys/cohorts. Delete instructional text
from the completed plan and mark inapplicable sections `N/A` with a reason.

## Outcome and boundaries

- Problem and measurable outcome:
- In scope:
- Explicit non-goals:
- Affected users, services, environments, and data classes:

## Risk and dependencies

- Tier and reason:
- Irreversible or high-blast-radius decisions:
- Dependency-ordered PR stack; explain how each PR can be held safely:
- Cross-repo contract/version and receiver-before-sender order:

## Current deployed state

- Live SHA/digest/configuration/schema evidence by affected environment:
- Default-branch difference and deployed-only behavior:
- Reconciliation decision: assimilate / retain temporarily / replace
- Previous known-good artifact and data-recovery boundary:

## Feature flag / release control (user-visible reversible behavior only)

- Control name, stable practice key, owner, and expiry:
- Cohorts and activation authority:
- Removal PR/condition:
- If no reversible user-visible behavior, reason this is N/A:

## Schema/data sequence (schema/data work only)

| Change | Rung | PR | Invariant | Recovery |
|---|---|---|---|---|
| | | | | |

- PHI-safe rehearsal evidence and result:
- If no schema/data change, reason this is N/A:

## Rollout and promotion

- Ordered environments/cohorts and hold points:
- Health signals and measurable abort thresholds:
- Canary journey:
- Founder-only manual production/PHI promotion record location, or current
  blocker if no production workflow exists:

## Security and recovery

- Open security acceptances, scope, expiry, and promotion impact:
- Recovery move for behavior, image, infrastructure, schema/data, and data
  damage as applicable:
- Observation window before irreversible cleanup:

## Completion

- Evidence required to call the outcome complete:
- Follow-up cleanup PRs and owners:
- Documentation and contract records to update:
