# Expired unused desktop call setup

Risk: Tier 2, because the recovery path selects a capture window before renewed
server authority. Scope: DesktopProviderRecorder and synthetic integration tests.
No schema, Core, authentication configuration, deployment, or installed app change.

## Failure and correction

When a prepared video-call visit expires before recording begins, its UI offers
Start recording through Resume. The old Resume path requires a prior recorded
call even though no call has been recorded. Permit a first selection only when
this recorder observed new/ready unused setup, coverage is absent, no chunks
exist, and continuity is confirmed. Fresh catalog revalidation, server retirement,
renewal, mount, and Start checks continue in their existing order.

Known/unknown prior capture retains the original-call fence. A restored paused
owner is not evidence of unused setup solely because its chunks/coverage are
empty. No automatic replacement of a changed or ambiguous call is added.

## Validation and recovery

Use the real recorder/flow/SQLite/mock-BFF integration fixture with synthetic
consent, a manually fired existing expiry timer, and an inert native driver.
Verify explicit/recommended first calls recover; changed/ambiguous/unavailable
calls and revocation never renew; zero-chunk and retained-chunk prior capture
keep their original call; unknown restored paused work remains blocked.
No physical audio is read and no deployed account is used by these tests.

Run focused regressions, desktop recorder tests, desktop typecheck and changed
file lint. Record exact local evidence and independent final-commit review in
the PR; GitHub Actions remains disabled. Root coordinates review and any push.

Release control: next separately built desktop beta, owned by John Clemente;
initial cohort is synthetic validation, then existing beta testers only after
that build passes. Reassess this release control by October 31, 2026. This patch
does not activate that release. Recovery is reverting the patch and rebuilding
from the resulting reviewed main; preserve encrypted paused work and existing
Core/Session Prep deployments and migrations.
