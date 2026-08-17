# Prompt to push to Codex

Revised 2026-08-17 against `main` at `8546a41`, after PRs #5–#20 merged. Paste everything between
the rules. It replaces the standing operating instructions, not `CLAUDE.md` — `CLAUDE.md`'s hard
rules still bind.

---

Every finding from six reviews is closed. More importantly, the two most valuable things this round
were found by probing the platform rather than by reading code: the missing `azure-core[aio]`
transport, which would have failed every async Azure call at runtime while all 297 tests passed, and
the proof that `az containerapp job start --args` does not merge into the deployed container. Both
were invisible to the test suite because every test uses a fake client.

Your response to the second one was the right one — you removed the clinical start command instead of
guessing at a patched version, said so in the runbook, and then propagated the lesson so that every
job start in the repository now runs with no overrides. Keep doing exactly that.

One correction to your own record: three commits noted that PostgreSQL was unavailable locally,
including the delivery claim fencing fix. I ran those 23 tests against a real PostgreSQL 16 and they
all pass.

## Standing rules for this and every following round

1. **Fix before you extend.** A known reproducible defect outranks any new slice.
2. **A slice is not done until the behavior is proven on the path that runs in Azure.**
3. **Never introduce a second definition of a rule.**
4. **No unhandled exception may reach a client.**
5. **Assume every request is a retry, and that the previous attempt hit a different process.**
6. **A README "What works now" bullet means a user can do the thing.**
7. **When you cannot verify something, say so** in the commit body and in your reply.
8. **Report blockers instead of routing around them.**
9. **An assumption about an Azure role, API, or CLI flag is not verified until something real
   returned the expected answer.** This rule has now paid for itself twice. Extend it: when a probe
   disproves an assumption, check whether the same assumption appears anywhere else in the
   repository before moving on — as you did with the job-start overrides.

## The goal for this round

Transcribe one synthetic encounter end to end, in Azure, and record the evidence. Everything below
exists to get there. Nothing new gets built until it works.

### 1. Wire-verify the corrected image

`azure-core[aio]` is in the lock file but the corrected image "has not yet been deployed or
wire-verified" — your words. Build it, deploy it, and prove managed-identity acquisition and one
real Key Vault call succeed on the deployed revision. Paste the actual output.

While you are there, make the same live call that N-17 turned on: `GET /v1/audio-encryption-key`
against the deployed API with only key-scoped Key Vault Reader assigned. If Reader turns out to be
insufficient, say so and propose the narrowest role that works — do not widen to Crypto User, which
would give the API unwrap permission.

### 2. Build the operator start helper

Activation is blocked on it, and the runbook correctly refuses to publish a start command until it
exists.

It must submit a complete `--yaml` execution template that preserves the deployed worker's exact
image, command, environment, CPU and memory, and volume mount, changing only the two positional
tenant and session UUIDs. Do not let it construct a command by adding `--image` or `--command` to a
partial override — omitted template fields can silently discard security-critical settings, which is
the whole reason the direct command was withdrawn.

Verify it against the dormant job first, where a disabled execution must still fail closed. Then
document it, and only then set `enable_transcription_job = true`.

### 3. Run the acceptance path

- Follow `SPEECH_PRIVATE_ACCEPTANCE.md`: provision the private Speech foundation, run the two-case
  synthetic smoke job, and record the `speech_smoke.completed` event and both WER figures.
- Then run one full synthetic encounter: consent, session, audio key, encrypted chunks, complete,
  transcription job, transcript, and delivery. Paste the fixed structured events at each boundary.
- Confirm no transcript text, name, DOB, blob name, object path, SAS URL, token, or DNS answer
  appears anywhere in Container Apps or Log Analytics output for that run.

This is the first time the product will have done its job. Treat the evidence as the deliverable.

### 4. Then implement retention

ADR 0013 is accepted as design with enforcement disabled, and its reasoning is right — an
unconditional Blob age rule cannot see a legal hold, an active session, a transcription lease, or a
pending delivery. It is now the one P0 responsibility in `docs/PLAN.md` with no implementation.

Build it to that ADR, behind its own false-by-default flag, with erasure under a separate principal.
Do not widen the API or worker identities to include `DELETE`. Cryptographic erasure of the
`session_audio_keys` row is the primitive; make the ordering explicit for the case where audio is
erased while a delivery receipt is still pending.

### Things not to do this round

- Do not start the capture clients. ADR 0016 defines the path; implementation waits until an
  encounter has been transcribed end to end.
- Do not add environments, regions, or peering.
- Do not add another dormant component. Three are already implemented and gated; finish activating
  one before adding a fourth.
- Do not mark `docs/PLAN.md` items complete. Report status in your reply; I will update the plan.
- Do not touch the credential model, RLS policies, staged-flag structure, the leased worker design,
  the canonicalizer, the test harness, the audio key custody design, or the NSG rules. They are right.

### One thing to write down outside the code

The security model now rests on who holds ARM start permission for three jobs — the transcription
worker, the Speech smoke job, and the Terraform runner. Each is code-execution authority under a
privileged identity, and this repository correctly grants none of it. Say so wherever those grants
are actually administered, not only in `PRIVATE_TERRAFORM_RUNNER.md`. If that place does not exist
yet, tell me and I will create it.

### Report back with

1. Every command you ran and its actual output — `pytest` with the PostgreSQL-backed runs, `ruff`,
   `pyright`, the three guard scripts, `generate_openapi`, `tofu fmt -check`, `tofu validate`,
   `tofu plan`.
2. For section 1: the deployed-revision probe output and the live `GET /v1/audio-encryption-key`
   response.
3. For section 3: the structured events from the synthetic encounter, and the log search you ran to
   confirm no PHI appears.
4. Anything you did not complete, and precisely why.
5. Every decision you need from me, phrased as a specific question with the options and your
   recommendation.

---

Supporting evidence and file-level detail: [`CODEX_BACKEND_REVIEW.md`](CODEX_BACKEND_REVIEW.md).
