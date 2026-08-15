# Prompt to push to Codex

Revised 2026-08-15 after a second review, against
`origin/codex/scribe-stt-mobile-roadmap` at `ad5a579`. Paste everything between the rules. It
replaces the standing operating instructions, not `CLAUDE.md` — `CLAUDE.md`'s hard rules still bind.

---

The transcription slice on `codex/scribe-stt-mobile-roadmap` is good work. The leased worker with
heartbeat renewal and lost-lease cancellation is careful concurrency code; the in-memory and
PostgreSQL job repositories genuinely agree on eligibility, attempt counts, and renewal; the
benchmark harness gates on de-identification and emits only aggregate metrics; and
`docs/TRANSCRIPTION_WORKER.md` states plainly that the worker is a library boundary with no trigger
yet. Keep all of it.

The problem is what you did *not* do. Three defects were reproducible before that branch started.
`main.py`, `service_auth.py`, `tests/conftest.py`, `scripts/check_phi_logs.py`, and all of `infra/`
are byte-identical to `main`. All three defects still reproduce, and 2,224 lines now sit on top of
them. One of them you re-encountered and worked around: `BasicTranscriptQualityGate` enforces
exactly the segment ordering, count, and duration limits that `TranscriptCreate` is missing, so
worker transcripts are deliverable and API-supplied transcripts still are not. You wrote the rule a
third time instead of fixing it once.

This round is a stop-and-repair round. No new slices.

## Standing rules for this and every following round

1. **Fix before you extend.** If a defect in shipped code is known and reproducible, it is ahead of
   any new slice in the queue. Do not build on top of it, and do not work around it in new code —
   if new code needs a constraint that existing code is missing, fix the existing code.
2. **A slice is not done until the behavior is proven on the path that runs in Azure.** For anything
   touching persistence, that means an HTTP-level test against real PostgreSQL with RLS and triggers
   active. You applied this correctly to the new job repository; the API routes still have never run
   against a database.
3. **Never introduce a second definition of a rule.** Legal state transitions, field constraints,
   and status vocabularies are defined once in Python and generated into SQL and OpenAPI. Transcript
   segment limits currently exist in three places and are correct in two.
4. **No unhandled exception may reach a client.** Every route returns a declared status code. Any
   500 the code can produce is a bug in the route.
5. **Assume every request is a retry, and that the previous attempt hit a different process.**
   Persisted keys and hashes must be byte-stable across processes and restarts. `min_replicas = 0`
   means every scale-from-zero is a new process.
6. **A README "What works now" bullet means a user can do the thing.** `docs/TRANSCRIPTION_WORKER.md`
   got this right and `README.md` did not — the worker is listed as a shipped capability while
   having no caller and no audio source. Say "implemented, not yet activated" when that is the truth.
7. **When you cannot verify something, say so** in the commit body and in your reply. State exactly
   what you executed and what it printed. Do not write "verified" for a claim you inferred.
8. **Report blockers instead of routing around them.** Put them at the top of your reply as a
   specific ask with the exact decision needed.

## Work queue, in order. Do not reorder or skip.

### 1. Make the tests capable of failing

Nothing else here is trustworthy until this lands.

- Delete the `get_repository` override from `tests/conftest.py:27`. Route endpoint tests through
  `provider.transaction()` exactly as the app does — the same way `tests/test_transcription_worker.py`
  already drives the provider correctly.
- Parameterize the endpoint suite across both backends: in-memory and a disposable PostgreSQL with
  all migrations applied. CI already runs a `postgres:16-alpine` service. Skipping PostgreSQL
  locally is fine; skipping it in CI is not.
- Add a test asserting that `POST /v1/consents` replayed with the same `Idempotency-Key` and the same
  body returns the original record **after the repository provider has been rebuilt in a new process**.
- Add end-to-end tests driving the real `EntraWorkflowAuthenticator` with a locally signed key and a
  stub JWKS, covering 401, 403, and 503 separately.

Commit this alone. Expect it to go red. That is the point — the red is the list below.

### 2. Fix the three confirmed defects

**2a. Idempotency fingerprints are unstable across processes.** `main.py:137` hashes
`model_dump(mode="json")`. `ConsentCreate.participant_regions` is a `set[str]` (`schemas.py:30`),
which serializes in per-process hash order. Six processes, one identical body, six different
fingerprints — still true on your branch. A retry after any restart returns
`409 Idempotency-Key was already used with a different request`, and the unstable hash is what
`idempotency_records` stores, so the PostgreSQL cutover does not help.

Canonicalize before hashing: sort every collection, normalize datetimes to UTC, fix key order. Make
`participant_regions` order-normalized. Pin the invariant with a test asserting a fixed payload
hashes to a hard-coded digest — do not re-derive the digest inside the test.

**2b. `/deliver` 500s on transcripts this API accepted, and leaks PHI doing it.** `TranscriptCreate`
allows unordered segments, unlimited counts, unlimited content length, and any duration.
`MasterTranscriptDeliveryRequest` forbids all four. `to_master_platform_payload` is called at
`main.py:574` with no error handling.

Reproduced: a transcript with out-of-order segments saves 201 and delivers 500.

Fix at the source — move the ordering, count, per-segment length, and duration limits into
`TranscriptCreate`, then have `BasicTranscriptQualityGate` reuse those same constraints instead of
restating them. One definition, three consumers. Then add a global exception handler returning an
opaque 500. Both, not either: the constraint prevents the failure, the handler prevents the next one
from printing PHI.

That leak is real. The uncaught Pydantic error logs
`input_value='Patient Jane Doe DOB 197...'` — transcript content and a partial DOB into Log
Analytics, which `CLAUDE.md` prohibits without qualification. Treat it as a P0 incident class.

**2c. Two state machines disagree.** `complete_session` (`main.py:416`) has no status guard. Calling
it after a transcript exists silently regresses `transcript_ready -> uploaded` and returns 200; the
following legacy handoff then does `uploaded -> handed_off`. Migration 0002's
`enforce_scribe_session_status_transition` permits neither and raises SQLSTATE `23514`. Both calls
are 200s today and 500s the moment `use_postgres_repository` flips.

Define the legal transition table once in Python. Generate the trigger from it. Add the missing route
guards. Add a test asserting the Python table and the deployed trigger accept exactly the same set of
transitions.

While you are in that table: **`failed` is now reachable and is a dead end.** The worker sets
`processing -> failed`, the trigger has no transition out of `failed`, and the job row is `terminal`
with `attempt_count >= max_attempts` so it cannot be re-claimed. A session that fails a quality gate
is unrecoverable by any code path. Decide whether `failed -> uploaded` is legal for a re-run or add
an explicit operator reset, and say which you chose and why.

### 3. Harden the paths that will fail in Azure before anyone can debug them

- `postgres_repository.py:128` uses `.one()` after `ON CONFLICT DO NOTHING`. A concurrent identical
  submit sees no committed row and raises `NoResultFound` — a 500 where a 409 or a replay belongs.
  Use `one_or_none()` and handle the empty case. Test it with genuinely concurrent requests.
- `service_auth.py` accepts only v2-shaped tokens: `azp` at `:109`, a bare-UUID audience at
  `settings.py:70`. If the app registration is left at its default `accessTokenAcceptedVersion`,
  Entra issues v1 tokens with `iss = https://sts.windows.net/{tid}/`, `aud = api://<client-id>`,
  and the caller in `appid`. Every call fails with an indistinguishable 401 or 403 across six checks.
  Do not loosen the checks. Emit a non-PHI failure reason on every rejection — `issuer_mismatch`,
  `audience_mismatch`, `token_version_v1`, `idtyp_missing`, `azp_mismatch`, `role_missing` — as a
  structured log field and in the `WWW-Authenticate` `error_description`. Add
  `GET /v1/diagnostics/token` behind the same authenticator, reporting which checks passed and no
  claim values.
- `service_auth.py:103` catches `PyJWTError`, which swallows `PyJWKClientError`. A JWKS outage
  returns 401 and sends the operator to Entra role assignments instead of to networking. Catch it
  separately, return 503.
- Add structured JSON logging with an explicit allow-list of emittable fields — entity IDs, tenant
  ID, action, error class, duration — and nothing else. Then rewrite `scripts/check_phi_logs.py`: it
  greps for a `log.<x>(...)` pattern in a codebase with no logging calls at all, so it passes
  trivially and detects nothing. Make it assert that every log call's arguments come from the
  allow-list, and add a test that drives the known failure paths and asserts the log stream contains
  no transcript text, name, DOB, blob name, SAS URL, or token.

### 4. Close the delivery durability hole

In `deliver_transcript_to_master_platform`, the post-success block (`main.py:664`) calls
`_session_or_404`, whose `HTTPException` rolls back the receipt write after the platform accepted the
transcript. Record the receipt first and update the session second; never fail the receipt on a
session lookup, since the session was already locked earlier in the same request. Then add a bounded
reconciler over stale `pending`/`retryable` receipts — the outbound key is stable, so the platform
de-duplicates. `docs/MASTER_PLATFORM_HANDOFF.md` currently promises retry semantics that only a human
re-POST provides.

### 5. Fix the ADR numbering

`docs/adr/` has two `0006` files and two `0007` files. ADR 0002 says "Superseded by ADR 0006," which
is now ambiguous. Renumber the three new ADRs to 0008/0009/0010, update every cross-reference, and
add a CI check that ADR number prefixes are unique.

### 6. Then finish the transcription pipeline you started

Only after 1–5 are green. In this order:

- **The `AudioTrackAssembler` production implementation**, to the contract you already wrote in
  `docs/TRANSCRIPTION_WORKER.md` — managed identity, private Blob connectivity, only object IDs
  registered to the tenant/session under lease, ciphertext size and SHA-256 verified before
  decryption, ordered channel tracks in encrypted ephemeral storage, secure cleanup on context exit,
  and no blob URL, object path, or patient value in any log or error. Where the key-custody design
  is not yet reviewed, stop and ask rather than inventing one.
- **The trigger.** The worker has no caller. Decide between an internal authenticated route and a
  Container Apps Job, write the ADR for that choice, and wire it — behind a false-by-default flag,
  consistent with every other activation gate in this repo.
- **One live round-trip** of `AzureSpeechTranscriber.from_settings` against a real Speech endpoint on
  synthetic audio. Every current test uses `FakeAzureClient`, so the real client construction and
  wire shape are unverified.
- **Retention.** It is the one P0 responsibility in `docs/PLAN.md` with zero implementation in either
  the service or `infra/` — no lifecycle policy on the audio container, no deletion path for audio,
  transcripts, or job rows. Raw clinical audio currently accumulates forever. Propose a policy with
  the ADR before implementing.

### 7. Infrastructure items this round created or made urgent

- ADR 0007 commits to web and mobile capture clients, but the audio container has
  `public_network_access_enabled = false` while `/upload-grant` returns a SAS URL on the public blob
  endpoint. No capture client outside the VNet can upload. This now blocks a scheduled deliverable.
  Write the ADR for the upload path before any client work starts.
- No Azure AI Speech resource, private endpoint, or RBAC assignment exists for the adapter you wrote.
- `subscription_id` and `tenant_id` are marked `sensitive = true` in `infra/variables.tf`.
  Sensitivity propagates, so `tofu plan` prints `(sensitive value)` for exactly the Container App
  settings your runbooks require an operator to eyeball. They are identifiers, not secrets — your own
  onboarding doc says so. Drop `sensitive`.
- Add diagnostic settings on the storage account and Key Vault. Blob data-plane access to PHI is
  currently unaudited while PostgreSQL has full diagnostics.
- Add `ALTER DEFAULT PRIVILEGES` to the bootstrap. You correctly added a `transcription_jobs` grant
  this round; the next new table will repeat the problem.

## Things not to do this round

- Do not start the capture clients. `apps/web-capture` and `apps/mobile-capture` stay READMEs until
  the upload path has an ADR.
- Do not add environments, regions, or peering.
- Do not write a new ADR unless code in the same commit implements the decision it records — the
  renumbering in step 5 and the ADRs called for in steps 6 and 7 are the exceptions.
- Do not mark `docs/PLAN.md` items complete. Report status in your reply; I will update the plan.
- Do not touch the credential model, the RLS policies, the staged-flag structure, or the leased
  worker design. They are right.

## Report back with

1. Every command you ran and its actual output — `pytest` (including the PostgreSQL-backed endpoint
   runs), `ruff`, `pyright`, `check_phi_logs`, `check_secrets`, `generate_openapi`, `tofu validate`.
2. For each of 2a, 2b, 2c: the test that reproduced it failing before your fix, and the same test
   passing after.
3. Anything in this list you did not complete, and precisely why.
4. Every decision you need from me, phrased as a specific question with the options and your
   recommendation — not as a general status note.

---

Supporting evidence and file-level detail: [`CODEX_BACKEND_REVIEW.md`](CODEX_BACKEND_REVIEW.md).
