# Scribe committed release checkpoint — September 24, 2026

The owner resumed work, authorized local commits, and requested a checkpoint for
a combined update with Session Prep. This supersedes the September 23 pause and
no-commit status. It does not claim the operational beta is accepted.

## Source reconciliation

Existing checkout and branch retained: `codex/beta-preintegration-20260904`.
The reviewed/tested source endpoint is
`381bc418790333cb1f5e81d93c1bdb8ef3f3a399`; the documentation commit follows it.

- All 116 previously modified/untracked Scribe files are committed in nine
  packets. Three stale desktop fixture responses were corrected to include the
  existing native process fence.
- Current Scribe `main`, `d6fcdb2d0a94c9f158b74593e0fb18d810209673`, is incorporated.
  The one merge conflict retained the newer capture migration guards. There is
  no remote Scribe `staging` branch; staging is a deployed environment.
- Shared Core's default branch is `master`, not `main`. It remains at
  `82e8ca268cff7bfd3329c6193808bc129a78912e` and already incorporates the Scribe
  integration, bounded consent diagnostics, timeout changes and newer fixes.
  The older owned `core-candidate` snapshot is superseded as a release base.
  No Core checkout was edited or reverted.
- First-party native identity, source ownership and iOS PCM packages are now
  committed in Scribe. The exact retained Clerk SDK remains an external offline
  dependency, pinned by a 233-file content lock. The assembly command verifies
  it and copies it into a new output; no SDK upgrade/download is implicit.

The complete branch contains substantial earlier unmerged work and exceeds a
single PR's 2,000-line/50-file budget. Do not treat it as one merge-ready PR.
The new commits are individually within that budget; preserve the ordered review
stack and applicable independent review before merging. No push, PR, merge to a
remote default branch, deployment, signing or installation occurred in this run.

## Current staging, checked at 11:37 UTC

| Component | Ready revision | Image digest |
| --- | --- | --- |
| Shared Core | `cosmaneura-staging-app--r1790210779a1-82e8ca2` | `sha256:c7cdae9307ba085931544ec77322d41d939604cf864b40e4cc37c70aeab5bf09` |
| Scribe API | `cosmaneura-staging-scribe-api--0000004` | `sha256:b6560a83449d0bc8a98d3b97c99c48776126e0c568b2c27ec969928e58f240cf` |
| Native receiver | `cosmaneura-staging-scribe-native--0000007` | `sha256:bfd1c23ac58204089d5fcdd7d66e72aece51e0fd9e37aa85f1fd7e5098296fea` |

All three reported Running with their latest revisions Ready. Core has advanced
from the prior Core18 image. The API revision changed but its image digest did
not; receiver7 is unchanged. Revision names are not a unified beta version.

## New functional change

Shared Core now permits two admission phases of up to 65 seconds each. The
receiver/native callers still had 20-second waits, and the desktop pipe had a
35-second deadline. Admission now has a 140-second Core HTTP wait and a bounded
180-second receiver operation; native HTTP waits are 200/210 seconds and the
desktop pipe waits 220 seconds. Other operations retain their existing budgets.

These limits only govern waiting. Consent checks, authorization rechecks,
capture deadlines and short-lived physical start decisions are unchanged.
Cancellation still propagates. No automatic mutation retry or replacement
request key is introduced. The old consent-phase failure's root cause remains
unproven; the new patch has not yet been accepted in an installed workflow.

The database fixture now rehearses historical reversible migrations through
0019, then applies the expand-only head. It explicitly verifies that dropping
new source history is refused. It requires a fresh disposable test database
instead of downgrading retained capture history for setup or cleanup.

## Validation

- Capture: 215 tests passed. Desktop: 101 passed, 28 platform-specific cases
  skipped; the final changed backend/bridge selection passed 16 checks.
- Review UI: 18 passed. Main integration: 14 passed.
- Capture service, processing, review and repository against fresh local
  PostgreSQL: 92 passed. The task-owned database instance is stopped.
- Receiver and actual TypeScript-client wire fixtures: 24 passed, including
  the longer wait, bounded deadline, unchanged request intent and no retry.
- Capture, desktop and review UI type-check. Changed final Python/TypeScript
  files pass lint. Whitespace checks pass.
- Native helper builds successfully, unsigned and unlaunched. All 250 build
  input hashes match the final committed/runtime dependency inputs.
- Protected `service_auth.py` and desktop `capture-authority.ts` hashes remain
  unchanged. Original Core, W13/P1 and retained native inputs remain untouched.

These are local build/fixture results. They do not establish installed recording
or operational acceptance. Independent review remains pending; no other task or
agent was contacted. Exact commits, commands/results and log hashes are recorded
in [the evidence manifest](evidence/SCRIBE_RELEASE_CHECKPOINT_20260924.json).

## Combined update handoff

1. Use this Scribe branch/committed source, and the current shared Core master
   plus the intended Session Prep changes. Recheck deployed revisions/configuration
   before publishing; never redeploy the obsolete Core18 snapshot over that work.
2. Review the dependency-ordered source changes and build immutable release
   artifacts from the chosen merged commits. This checkpoint supplies source,
   not newly published container images or signed native applications.
3. Build the receiver and both native applications with the new admission
   budgets. Use `scripts/assemble-native-source.py` and the retained SDK directory
   documented in the native package README. Preserve existing approved identities,
   issuer, endpoint, entitlements, synthetic practice and cohort configuration.
4. Resume the retained synthetic admission using its existing operation/key.
   Observe the bounded Core diagnostic on a changed release; do not loop unchanged
   retries or create replacement sessions to conceal an uncertain outcome.
5. Accept installed recording → encrypted upload → processing → provider review
   → saved/reopened Core note on Mac and iPhone, then process-loss, interruption,
   logout/revocation and provider-access recovery. Reuse completed provider trials.

The installed iPhone remains build 9, last owner-confirmed at the encounter list.
Both platforms have accepted native sign-in and the authorized synthetic list.
No complete installed recording-to-note run is accepted by this checkpoint.

Engineering estimate: approximately **75% complete**, with **3–5 focused
engineering days** remaining and up to **7 working days** if installed acceptance
reveals additional integration faults. This is an estimate, not a launch promise.
