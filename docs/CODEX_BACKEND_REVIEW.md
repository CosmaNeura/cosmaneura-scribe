# Codex backend review — 2026-08-15

Scope: every foundational document (`CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/PLAN.md`, ADRs
0001–0007, the four operational runbooks), the full API source, migrations, tests, CI, and the
OpenTofu configuration, at `2cc1faa`.

Findings marked **[verified]** were reproduced in this working tree. Findings marked **[read]** are
from code/configuration inspection without a live Azure or PostgreSQL target.

---

## 1. Verdict

The repository's *documentation and infrastructure* are unusually disciplined. The *application*
is a consent-and-custody CRUD API with no ambient-scribe pipeline in it, and its correctness
guarantees are asserted by tests that structurally cannot observe the production code path.

Baseline gates are green: `ruff` clean, `pyright --strict` 0 errors, 32 passed / 2 skipped,
`openapi/openapi.json` in sync. Those gates are passing over the wrong surface, which is why the
deployed backend fails in ways CI never sees.

Composition after 15 commits:

| Area | Lines | Share |
|---|---:|---:|
| `infra/` (OpenTofu) | 1,326 | 22% |
| `docs/` (runbooks + ADRs) | 878 | 15% |
| `services/` (the product) | 2,414 | 41% |
| `tests/` | 1,190 | 20% |
| `alembic/` | 455 | 8% |

Of the 2,414 service lines, **zero** implement speech-to-text, diarization, speaker-role labeling,
quality gates, or retention — the four things `docs/PLAN.md` names as the P0 slice and the reason
the service exists. `SessionStatus.PROCESSING` and `SessionStatus.FAILED` are declared and never
assigned anywhere in the service **[verified]**; `PROCESSING` appears only as a read-side
precondition at `services/api/src/cosmaneura_scribe/main.py:465`. There is no failure path in the
state machine because there is no worker that could fail.

---

## 2. What is genuinely strong

Keep all of this. It is above the bar for a healthcare backend and should not be disturbed by the
next round of work.

- **The credential model is correct and consistently applied.** No account keys, no client secrets,
  no connection strings. `DefaultAzureCredential` everywhere, user-delegation SAS for blobs, Entra
  tokens for PostgreSQL, GitHub OIDC for CI. `shared_access_key_enabled = false` and
  `password_auth_enabled = false` are enforced at the resource, not by convention.
- **Staged, false-by-default feature flags** with cross-flag preconditions
  (`deploy_database_migration_job` requires `deploy_postgres_foundation`;
  `use_postgres_repository` requires the foundation; production refuses the memory repository via a
  `lifecycle.precondition`). This is the right shape for irreversible infrastructure.
- **Defense in depth in the schema.** RLS `FORCE`d on every tenant table, an append-only trigger on
  `audit_events`, CHECK constraints mirroring the Pydantic contracts, and reversible downgrades in
  all three migrations.
- **ADR 0007 is a real security decision, correctly reasoned.** Recognizing that the Entra `tid`
  claim identifies a directory and not a practice, and refusing `X-Tenant-ID` until the exact
  caller client ID plus app role is proven, is the right call.
- **Validation errors on `/v1/` are sanitized** (`main.py:79`) so request bodies never echo back —
  a genuine PHI control, and tested.
- **Commit hygiene.** Small, single-purpose, well-titled commits with ADRs attached to architectural
  choices.

---

## 3. The structural problem

Codex has been optimizing for *reviewable artifacts* rather than *working software*. Each slice
lands a runbook, an ADR, a set of flags, and a test file — and the checklist at the bottom of
`CLAUDE.md` is satisfied — while the pipeline the product needs stays unimplemented and the parts
that were implemented are verified only against a mock.

Three symptoms:

1. **Verification does not touch the production path.** `tests/conftest.py:27` replaces
   `get_repository` with a bare `InMemoryRepository`, which removes the per-request transaction
   wrapper entirely. Every endpoint test therefore runs against a dictionary, never against
   `provider.transaction()`, never with `app.tenant_id` set, never against a real trigger or RLS
   policy. The two `@pytest.mark.postgres` tests exercise the repository class directly, not any
   HTTP route. **No endpoint has ever been executed against PostgreSQL.** That single gap explains
   most of section 4.

2. **Two state machines exist and they disagree.** The application enforces one set of transitions
   in `main.py`; migration 0002 enforces a different set in a database trigger. Nothing compares
   them.

3. **Documents assert completion that the code does not support.** `README.md` lists "Structured,
   role-labeled transcript persistence" under "What works now" — accurate only in the sense that
   the API stores role labels a caller supplies. Nothing in this service produces them.

---

## 4. Confirmed defects

### P0-1 — Idempotency fingerprints are not stable across processes [verified]

`main.py:137` hashes `payload.model_dump(mode="json")`. `ConsentCreate.participant_regions` is a
`set[str]` (`schemas.py:30`), which serializes in an order that depends on per-process string hash
randomization.

Reproduction — the same request body, six processes:

```
distinct fingerprints across 6 processes for the SAME request body: 6
```

Same process, replayed: correctly returns the original record (`201`, same `id`).

**Impact.** A client retrying `POST /v1/consents` with the same `Idempotency-Key` and byte-identical
body gets `409 Idempotency-Key was already used with a different request` whenever the retry lands
after a restart or on a different replica. With `min_replicas = 0`, every scale-from-zero is a new
process. This is a "passes in CI, fails in Azure" defect and is a strong candidate for the failures
being seen. It also survives the PostgreSQL cutover — `idempotency_records` stores the unstable
hash.

**Fix.** Canonicalize before hashing: sort collections, normalize datetimes to UTC, and emit a
stable key order. Change `participant_regions` to an order-normalized `list[str]` (or sort inside
`_fingerprint`). Add a test that asserts the fingerprint of a fixed payload equals a hard-coded
digest, so the invariant is pinned rather than merely re-derived.

### P0-2 — `POST /v1/sessions/{id}/deliver` returns 500 on transcripts the API itself accepted [verified]

`TranscriptCreate` imposes no ordering, no segment count limit, and no per-segment content length.
`MasterTranscriptDeliveryRequest` imposes all three, plus `duration_seconds <= 86_400`.
`to_master_platform_payload` (`handoff.py:157`) constructs the strict model at
`main.py:574` with no error handling.

Reproduction — save an out-of-order transcript (accepted, `201`), then deliver:

```
PROBE 1  save out-of-order transcript -> 201
PROBE 3  deliver out-of-order transcript -> 500
pydantic_core._pydantic_core.ValidationError: 1 validation error for MasterTranscriptDeliveryRequest
  Value error, segments must be in nondecreasing time order
```

**Impact.** Four separate ways for a stored, valid-per-this-API transcript to become an
unrecoverable 500 at delivery: unordered segments, >10,000 segments, a segment over 100,000
characters, or a duration over 24 hours. Retrying never helps; the receipt is left `pending`.

**Secondary — this is also a PHI-in-logs violation.** With no global exception handler, uvicorn
logs the full traceback to stdout, which ships to Log Analytics. The Pydantic message embeds a
prefix of the offending value. Reproduced with synthetic data:

```
String should have at most 100000 characters
  [type=string_too_long, input_value='Patient Jane Doe DOB 197...xxxxx', input_type=str]
```

That is transcript content and a partial DOB in a log sink, which `CLAUDE.md` prohibits outright.

**Fix.** Make the two contracts one contract: enforce ordering, count, and length in
`TranscriptCreate` at write time, so an accepted transcript is deliverable by construction. Then
add a global exception handler that returns an opaque 500 and logs only an error class plus entity
IDs. Both, not either.

### P0-3 — The application state machine and the database state machine disagree [verified]

`complete_session` (`main.py:416`) has no status precondition. Reproduced against the in-memory
repository:

```
PROBE B  complete AGAIN after transcript_ready -> 200  status now: uploaded
PROBE C  legacy handoff from that state       -> 200   (uploaded -> handed_off)
```

Migration 0002's `enforce_scribe_session_status_transition` permits neither
`transcript_ready -> uploaded` nor `uploaded -> handed_off`. It raises SQLSTATE `23514`, which
surfaces as an unhandled asyncpg exception — another 500.

**Impact.** These two calls are 200s today and become 500s the moment `use_postgres_repository`
flips. Precisely the class of regression the staged cutover is supposed to de-risk, and precisely
the class the current tests cannot see.

**Fix.** Define the legal transition table once, in Python, and have both the route guards and the
migration generate from it. Add status preconditions to `complete_session` and
`prepare_note_engine_handoff`. Then run the endpoint suite against real PostgreSQL so the
divergence cannot reappear.

### P1-4 — `claim_idempotency` raises `NoResultFound` under concurrency [read]

`postgres_repository.py:126` calls `.one()`. `INSERT ... ON CONFLICT DO NOTHING` does not block on
an *uncommitted* conflicting row and returns zero rows; the follow-up `SELECT` then also sees
nothing, and `.one()` raises. Two concurrent identical submits produce a 500 rather than a 409 or a
replay.

**Fix.** Use `one_or_none()` and treat the empty case as a concurrent-claim conflict, returning
`409` (or retry once). Cover it with a real concurrent test against PostgreSQL.

### P1-5 — Entra token validation accepts only one of the two token shapes Azure emits [read]

`service_auth.py` reads `azp` only (`:109`) and `Settings` requires `workflow_api_audience` to be a
bare UUID (`settings.py:70`). Both hold for **v2** tokens. If the Scribe API app registration's
`accessTokenAcceptedVersion` is left at its default, Entra issues **v1** tokens instead:
`iss = https://sts.windows.net/{tid}/`, `aud = api://<client-id>`, and the caller in `appid` rather
than `azp`. Every call then fails — 401 on issuer/audience, or 403 on the missing `azp`.

`docs/PLATFORM_WORKFLOW_AUTH.md` step 3 does tell the operator to configure v2 and add the `idtyp`
optional claim. The problem is that a missed step produces an indistinguishable 401/403, with no
signal telling the operator which of six checks failed.

**Fix.** Do not loosen the checks. Emit a non-PHI structured failure reason on every rejection —
`issuer_mismatch`, `audience_mismatch`, `token_version_v1`, `idtyp_missing`, `azp_mismatch`,
`role_missing` — as a log field and a `WWW-Authenticate` `error_description`. Add a
`GET /v1/diagnostics/token` route, behind the same authenticator, that echoes which checks passed
for the presented token and no claim values.

### P1-6 — JWKS unavailability is reported as an authentication failure [read]

`service_auth.py:103` catches `PyJWTError`, and `PyJWKClientError` is a subclass. A failure to
reach `login.microsoftonline.com` therefore returns `401`, indistinguishable from a bad token. If
egress is ever restricted, the whole API returns 401 and the runbooks point the operator at Entra
role assignments instead of at networking.

**Fix.** Catch `PyJWKClientError` separately and return `503`.

### P1-7 — A delivered transcript can leave no receipt [read]

In `deliver_transcript_to_master_platform`, the post-success block (`main.py:664`) opens a fresh
transaction and calls `_session_or_404`, which raises `HTTPException` inside the `async with` and
rolls the whole thing back — after the master platform has already accepted the transcript. The
receipt stays `pending` and the session stays `transcript_ready`. Same outcome if the process dies
between the HTTP response and the commit.

There is no reconciler. `docs/MASTER_PLATFORM_HANDOFF.md` describes retry as an operator re-POST.
Nothing sweeps `pending` or `retryable` receipts.

**Fix.** Never fail the receipt write on a session lookup — the session was locked earlier in the
same request. Record the delivered receipt first, update the session second, and add a bounded
reconciliation job over stale `pending`/`retryable` rows (the outbound key is stable, so the
platform de-duplicates).

### P2-8 — The PHI-log guard cannot detect anything [verified]

`scripts/check_phi_logs.py` greps `services/**.py` for `log.<something>(... content|transcript|...)`.
The service contains no logging calls at all — no `logging` import, no logger, no structured
logging configuration. The check passes trivially and always will, while the actual PHI-leak path
(P0-2, unhandled exception tracebacks) is invisible to it.

**Fix.** Add structured JSON logging with an allow-list of emittable fields, then rewrite the check
to assert that no log call takes an argument outside that list, and add a test that drives known
failure paths and asserts nothing but IDs and error classes reaches the log stream.

---

## 5. Infrastructure findings

| # | Finding | Where |
|---|---|---|
| I-1 | `subscription_id` and `tenant_id` are `sensitive = true`. `tenant_id` feeds `COSMANEURA_SCRIBE_ENTRA_TENANT_ID`, the Key Vault, and the PostgreSQL `authentication` block, so sensitivity propagates and `tofu plan` prints `(sensitive value)` for exactly the settings the runbooks require an operator to eyeball. These are identifiers, not secrets — the onboarding doc says so. Drop `sensitive`. | `infra/variables.tf:1-11` |
| I-2 | Audio blobs live behind a private endpoint with `public_network_access_enabled = false`, but `/upload-grant` returns a SAS URL on `primary_blob_endpoint`. Nothing outside the VNet can reach it. The P1 mobile/web and P2 desktop capture clients in `docs/PLAN.md` have no documented upload path. This needs an ADR before client work starts. | `infra/main.tf:47`, `storage.py:112` |
| I-3 | No diagnostic settings on the storage account or Key Vault. PostgreSQL has one; the store that actually holds the audio does not. Blob data-plane access to PHI is unaudited. | `infra/main.tf` |
| I-4 | No lifecycle-management policy on the audio container, and no retention logic in the service. `docs/PLAN.md` claims retention as an owned responsibility. Raw clinical audio currently accumulates forever. | `infra/main.tf:78` |
| I-5 | No NSGs on the private-endpoint or Container Apps subnets. | `infra/network.tf`, `infra/container_apps.tf` |
| I-6 | Log Analytics `daily_quota_gb = 0.5` silently drops ingestion past the cap. With an unhandled-exception path that logs full tracebacks, a bad day both leaks PHI and then hides the evidence. | `infra/container_apps.tf:29` |
| I-7 | The runtime role receives table grants only at bootstrap time; there is no `ALTER DEFAULT PRIVILEGES`. Any future migration that adds a table silently produces `permission denied` at runtime until someone re-runs the job. Worth a note in `POSTGRES_OPERATIONS.md` at minimum. | `database_bootstrap.py:60` |
| I-8 | `development.tfvars.example` omits `postgres_subnet_address_prefixes` while `production.tfvars.example` sets it. Harmless (the default is in range) but inconsistent. | `infra/development.tfvars.example` |

`ingress.external_enabled = true` inside an `internal_load_balancer_enabled = true` environment is
**correct** — it means "exposed on the environment's load balancer," which is private. Worth one
inline comment, because it reads like a mistake and someone will eventually "fix" it.

---

## 6. Why CI is green

- `conftest.py` removes the transaction wrapper, so no route is ever exercised through
  `provider.transaction()` — P0-3 is unobservable.
- No endpoint test runs against PostgreSQL, so triggers, RLS, and grants are never exercised through
  a route.
- Every idempotency test runs in one process, so P0-1 is unobservable by construction.
- The delivery tests use transcripts that happen to satisfy the strict master contract, so P0-2 is
  unobservable.
- `check_phi_logs.py` scans for a logging pattern the codebase does not contain.
- `pyright --strict` and `ruff` pass because the defects are semantic, not typal.

The suite is well written for what it covers. It just covers a substitute for the system.

---

## 7. Root cause

The instructions Codex is working from reward artifacts that are individually checkable — a
migration with a downgrade, an ADR, a flag, a passing test — and say nothing about whether the
service does the thing it is for. `CLAUDE.md`'s "Definition of done" is a list of gates, all of
which can be satisfied without the product working.

So Codex built the safest, most reviewable thing available at each step, and never chose the
speech-to-text worker — the one slice with no clean artifact, an external dependency, and a BAA
question attached. Fifteen commits in, the environment is production-shaped and the product is a
metadata store.

The corrective prompt is in [`CODEX_NEXT_PROMPT.md`](CODEX_NEXT_PROMPT.md).
