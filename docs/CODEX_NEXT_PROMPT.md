# Prompt to push to Codex

Written 2026-08-17 against `main` at `7423f7f` and your pause-point status report. Paste everything
between the rules. It replaces the standing operating instructions, not `CLAUDE.md` — `CLAUDE.md`'s
hard rules still bind.

---

Your status report was verified against the repository and is accurate on every claim checkable from
here. The response pattern through the two failed live checks was exactly right: you did not widen a
gate, did not bolt a retry onto the authenticated probe to force a pass, reported both failures with
metrics, and escalated the blocker as a decision instead of routing around it. PR #23's commit body
saying plainly "the authenticated live retry remains unverified" is the standard — keep it.

One correction to the record: ADR 0017 wrote "the 60-second timeout covers one scale-to-zero API
cold start," and your second live check disproved that within hours. The ingress rejected the
request before the API saw it, with API request metrics at zero. Timeout was never the axis — a
gateway that answers early with an error cannot be outwaited. The amendment below fixes the ADR.

## The decision you asked for

**Change the acceptance readiness contract. Do not add a prewarm/minimum-replica window.**

Reasons, so the ADR amendment can record them: scale-to-zero is the deployed configuration and any
real caller must tolerate cold start, so acceptance should test that shape rather than a prewarmed
one production does not run; a prewarm window would mutate the API's scaling through a runner whose
apply pins are currently `review-required` and would need a revert apply afterward; and the
zero-retry principle survives intact, because it exists to keep failures of the thing under test
unmasked — cold-start ingress behavior is the platform, not the thing under test.

The new contract has two phases:

1. **Readiness phase.** Bounded polling of `/healthz` — unauthenticated, ops-open by design.
   Ingress-layer non-200s and transport errors count as "not ready yet," never as acceptance
   failures. Require two consecutive 200s. Hard overall deadline that fits inside the job's
   300-second execution budget (suggest 240 seconds of polling at a fixed interval; pick the
   numbers deliberately and pin them in Settings and tests, as you did the 60-second timeout).
   Exhausting the deadline is its own fixed failure code, distinct from probe failure.
2. **Probe phase.** The authenticated `GET /v1/audio-encryption-key`, exactly as it is today:
   **single attempt, no retry, unchanged classification.** If readiness passed and the probe fails,
   that is a real finding about the thing under test.

Amend ADR 0017 in the same change: record the two-phase contract, correct the disproven
cold-start-coverage claim, and state why prewarm was rejected. Emit distinct fixed structured events
for readiness-started, readiness-succeeded (with poll count and elapsed time as numbers), and
readiness-deadline-exhausted. No URL, endpoint, or DNS answer in any of them.

## Standing rules — unchanged, plus one

Rules 1–9 from the previous round stand as written. One addition:

10. **A privileged grant outlives its justification the moment the work pauses.** Temporary
    role assignments and NSG rules get a stated expiry tied to a milestone, and the expiry is
    honored even when the milestone slips.

## Work queue, in order

### 1. Implement the two-phase acceptance contract

As specified above. Local suite, guards, `tofu fmt`, `tofu validate` all green before the live run.

### 2. Run the acceptance path live, once

- Re-enable the acceptance gates, run one execution, and capture the readiness metrics (poll count,
  elapsed seconds) and the authenticated probe result.
- This completes the Key Vault Reader / JWK proof that both failed checks left incomplete. If the
  probe fails for a *role* reason, say so and propose the narrowest sufficient role — do not widen
  to Crypto User, which would give the API unwrap permission.
- Then set both gates false again.

### 3. Revoke the temporary runner privileges — this round, regardless of outcome

The eight temporary assignments (including vault Crypto Officer and RBAC Administrator) and the two
temporary NSG egress rules are the most privileged idle credential set in the estate, attached to a
runner that currently cannot apply. Once step 2 has run — pass or fail — revoke them and remove the
gated rules. Re-granting is a documented procedure now; holding them "until things resolve" is the
pattern rule 10 exists to stop. If step 2 cannot run at all this round, revoke anyway and say so.

Also resolve or explicitly park the runner itself: the `review-required` apply pins mean it is
deployed but unusable. Either repair the pin workflow behind its existing gates, or set
`deploy_private_terraform_runner = false` until it is needed again. State which and why.

### 4. Commit the evidence

The protected change record under `/private/tmp/...` survives only as long as that machine does.
The acceptance evidence is metadata-only by design — fixed events, hashes, state serials, no PHI.
Commit a sanitized copy into the repository (suggest `docs/change-records/2026-08-16-private-api-acceptance/`
with a short README), and state in it which artifacts were withheld and why. Terraform state serial
48 and the staleness of all saved plans belong in that record too.

### 5. The master-platform side

Draft PR #121 (`51bfb997`) in the master repository was not reviewed here — this session has no
access to that repo. Report its CI outcome, and confirm the timeout alignment does not import the
same disproven assumption: if the master's client also fronts a scale-to-zero Container App, its
contract needs the same readiness/probe split, not just a longer timeout. Say whether it does.

## Things not to do this round

- Do not add a prewarm or minimum-replica change to the API. The decision above is the decision.
- Do not add retries to the authenticated probe, the transcription job, or the reconciler.
- Do not start the capture clients or add environments, regions, or peering.
- Do not add another dormant component; the acceptance path is the one being finished.
- Do not touch the credential model, RLS policies, staged flags, worker design, canonicalizer, test
  harness, audio key custody, or NSG deny-all structure. They are right.

## Report back with

1. Every command you ran and its actual output — the full local gate set, plus the live acceptance
   execution's structured events with the readiness poll count and elapsed time.
2. The live authenticated probe result — the JWK metadata response shape (no key material beyond
   the public modulus it already returns) or the exact failure classification.
3. Confirmation, with the role-assignment listing, that the temporary grants and NSG rules are gone.
4. The committed change-record path.
5. PR #121 status and the readiness-assumption answer for the master side.
6. Anything you did not complete, and precisely why.
7. Every decision you need from me, phrased as a specific question with options and your
   recommendation.

---

Supporting evidence and file-level detail: [`CODEX_BACKEND_REVIEW.md`](CODEX_BACKEND_REVIEW.md),
section 10.
