# Prompt to push to Codex

Paste everything between the rules. It replaces the standing operating instructions, not
`CLAUDE.md` — `CLAUDE.md`'s hard rules still bind.

---

You have built a well-secured Azure environment and a consent/custody API. The infrastructure,
credential model, ADRs, and staged flags are good work — do not redo them. Two things are wrong,
and this round fixes both.

**Wrong thing 1: the service does not do its job.** After 15 commits there is no speech-to-text,
no diarization, no speaker-role labeling, no quality gates, and no retention. `SessionStatus.PROCESSING`
and `SessionStatus.FAILED` are declared and never assigned by anything. The API stores a transcript
that some other system must produce. `docs/PLAN.md` calls the STT worker the P0 slice; you have
deferred it every round in favor of work with cleaner artifacts.

**Wrong thing 2: the green CI is measuring a substitute for the system.** `tests/conftest.py:27`
overrides `get_repository` with a bare `InMemoryRepository`, which deletes the per-request
transaction wrapper. No endpoint has ever executed against PostgreSQL, against a trigger, against
an RLS policy, or across a process restart. Three defects that will break in Azure are invisible to
the suite, and are reproduced below.

## Standing rules for this and every following round

1. **A slice is not done until the behavior is proven on the path that runs in Azure.** For any
   change touching persistence, that means an HTTP-level test against real PostgreSQL with RLS and
   triggers active. Testing a mock that stands in for the repository proves nothing about the
   deployed service.
2. **No new ADR, runbook, or `README.md` "What works now" bullet in a commit that does not also
   change `services/`.** Documentation describes shipped behavior. If a doc claims a capability,
   a test must exercise that capability through an HTTP route.
3. **Never introduce a second definition of a rule.** Legal state transitions, field constraints,
   and status vocabularies are defined once in Python and generated into SQL and OpenAPI. If a rule
   exists in two places, it will drift, and it already has.
4. **No unhandled exception may reach a client.** Every route returns a declared status code. Any
   500 the code can produce is a bug in the route, not an operational condition.
5. **Assume every request is a retry, and that the previous attempt hit a different process.**
   Persisted keys and hashes must be byte-stable across processes and restarts. `min_replicas = 0`
   means every scale-from-zero is a new process.
6. **When you cannot verify something, say so in the commit body and in your reply.** Do not write
   "verified" for a claim you inferred. State exactly what you executed and what it printed.
7. **Report blockers instead of routing around them.** If the STT decision needs a BAA, an Azure
   quota, or an Entra role, build behind the interface with a deterministic fake, ship it, and put
   the blocker at the top of your reply as a specific ask with the exact decision needed.

## Work queue, in order. Do not reorder or skip.

### 1. Make the tests capable of failing

Nothing else in this list is trustworthy until this lands.

- Delete the `get_repository` override from `tests/conftest.py`. Route tests through
  `provider.transaction()` exactly as the app does.
- Parameterize the whole endpoint suite across both backends: in-memory and a disposable
  PostgreSQL with all migrations applied. CI already runs a `postgres:16-alpine` service; use it.
  Skipping PostgreSQL locally is fine; skipping it in CI is not.
- Add a test asserting that `POST /v1/consents` replayed with the same `Idempotency-Key` and the
  same body returns the original record **after the repository provider has been rebuilt in a new
  process**.
- Keep authentication overridden per-test where it is not under test, but add end-to-end tests that
  drive the real `EntraWorkflowAuthenticator` with a locally signed key and a stub JWKS, covering
  401, 403, and 503 separately.

Commit this alone. Expect it to go red. That is the point — the red is the bug list below.

### 2. Fix the three confirmed defects

**2a. Idempotency fingerprints are unstable across processes.** `main.py:137` hashes
`model_dump(mode="json")`. `ConsentCreate.participant_regions` is a `set[str]` (`schemas.py:30`),
which serializes in per-process hash order. Six processes, one identical body, six different
fingerprints. A retry after any restart returns `409 Idempotency-Key was already used with a
different request`.

Canonicalize before hashing: sort every collection, normalize datetimes to UTC, fix key order.
Make `participant_regions` order-normalized. Pin the invariant with a test that asserts a fixed
payload hashes to a hard-coded digest — do not re-derive the digest inside the test.

**2b. `/deliver` 500s on transcripts this API accepted, and leaks PHI doing it.** `TranscriptCreate`
allows unordered segments, unlimited segment counts, unlimited content length, and any duration.
`MasterTranscriptDeliveryRequest` forbids all four. `to_master_platform_payload` is called at
`main.py:574` with no error handling, so a stored transcript can become a permanent 500.

Reproduced: a transcript whose segments are out of time order saves `201` and delivers `500`.

Fix at the source — enforce ordering, count, and per-segment length in `TranscriptCreate` so an
accepted transcript is deliverable by construction. Then add a global exception handler returning
an opaque 500. Both, not either: the constraint prevents the failure, the handler prevents the next
one from printing PHI.

That leak is real, not theoretical. The uncaught Pydantic error logs
`input_value='Patient Jane Doe DOB 197...'` — transcript content and a partial DOB into Log
Analytics, which `CLAUDE.md` prohibits without qualification. Treat it as a P0 incident class, not a
code-style issue.

**2c. Two state machines disagree.** `complete_session` (`main.py:416`) has no status guard.
Calling it after a transcript exists silently regresses `transcript_ready -> uploaded` and returns
`200`; the following legacy handoff then does `uploaded -> handed_off`. Migration 0002's
`enforce_scribe_session_status_transition` permits neither and raises SQLSTATE `23514`. Both calls
are 200s today and 500s the moment `use_postgres_repository` flips.

Define the legal transition table once in Python. Generate the trigger from it. Add the missing
route guards. Add a test that asserts the Python table and the deployed trigger accept exactly the
same set of transitions — that test is the thing that stops this recurring.

### 3. Harden the paths that will fail in Azure before anyone can debug them

- `postgres_repository.py:126` uses `.one()` after `ON CONFLICT DO NOTHING`. A concurrent identical
  submit sees no committed row and raises `NoResultFound` — a 500 where a 409 or a replay belongs.
  Use `one_or_none()` and handle the empty case. Test it with genuinely concurrent requests.
- `service_auth.py` accepts only v2-shaped tokens: `azp` at `:109`, a bare-UUID audience at
  `settings.py:70`. If the app registration is left at its default `accessTokenAcceptedVersion`,
  Entra issues v1 tokens with `iss = https://sts.windows.net/{tid}/`, `aud = api://<client-id>`,
  and the caller in `appid`. Every call fails with an indistinguishable 401 or 403. **Do not loosen
  the checks.** Emit a non-PHI failure reason on every rejection — `issuer_mismatch`,
  `audience_mismatch`, `token_version_v1`, `idtyp_missing`, `azp_mismatch`, `role_missing` — as a
  structured log field and in the `WWW-Authenticate` `error_description`. Add
  `GET /v1/diagnostics/token` behind the same authenticator, reporting which checks passed and no
  claim values.
- `service_auth.py:103` catches `PyJWTError`, which swallows `PyJWKClientError`. A JWKS outage
  returns 401 and sends the operator to the Entra role assignments instead of to networking. Catch
  it separately, return 503.
- Add structured JSON logging with an explicit allow-list of emittable fields — entity IDs, tenant
  ID, action, error class, duration — and nothing else. Then rewrite `scripts/check_phi_logs.py`:
  it currently greps for a `log.<x>(...)` pattern in a codebase with no logging calls at all, so it
  passes trivially and detects nothing. Make it assert that every log call's arguments come from
  the allow-list, and add a test that drives the known failure paths and asserts the log stream
  contains no transcript text, name, DOB, blob name, SAS URL, or token.

### 4. Close the delivery durability hole

In `deliver_transcript_to_master_platform`, the post-success block (`main.py:664`) calls
`_session_or_404`, whose `HTTPException` rolls back the receipt write *after* the platform accepted
the transcript. Record the receipt first and update the session second; never fail the receipt on a
session lookup, since the session was already locked earlier in the same request. Then add a
bounded reconciler over stale `pending`/`retryable` receipts — the outbound key is stable, so the
platform de-duplicates. Right now `docs/MASTER_PLATFORM_HANDOFF.md` promises retry semantics that
only a human re-POST provides.

### 5. Then, and only then, build the thing the service is for

Implement the replaceable speech-to-text worker interface from `docs/PLAN.md`. Concretely:

- A `TranscriptionEngine` protocol alongside the existing `AudioStorage` and `Repository`
  protocols, with a deterministic fixture-backed implementation used by tests and local dev.
- The `uploaded -> processing -> transcript_ready` path actually driven by that worker, with a real
  `failed` transition and a bounded retry — the two unused statuses become used.
- Speaker-role labeling as a separate, replaceable step over engine output, so diarization quality
  and role assignment can be swapped independently.
- Quality gates that can reject a transcript before it becomes deliverable, recording a non-PHI
  reason code.
- The Azure Speech adapter behind the same protocol, off by default, unconfigured until the BAA and
  de-identified benchmark in `docs/PLAN.md` are cleared. Do not benchmark on anything but
  de-identified samples.

If the STT provider decision is blocked, ship the protocol, the fake, the state transitions, the
role-labeling step, and the quality gates anyway. The pipeline being real matters more than which
vendor terminates it.

## Things not to do this round

- Do not add environments, regions, peering, or flags.
- Do not write another ADR unless code in the same commit implements the decision it records.
- Do not mark `docs/PLAN.md` items complete. Report status in your reply; I will update the plan.
- Do not touch the credential model, the RLS policies, or the staged-flag structure. They are right.

## Report back with

1. Every command you ran and its actual output — `pytest` (including the PostgreSQL-backed
   endpoint runs), `ruff`, `pyright`, `check_phi_logs`, `check_secrets`, `generate_openapi`,
   `tofu validate`.
2. For each of 2a, 2b, 2c: the test that reproduced it failing before your fix, and the same test
   passing after.
3. Anything in this list you did not complete, and precisely why.
4. Every decision you need from me, phrased as a specific question with the options and your
   recommendation — not as a general status note.

---

Supporting evidence and file-level detail: [`CODEX_BACKEND_REVIEW.md`](CODEX_BACKEND_REVIEW.md).
