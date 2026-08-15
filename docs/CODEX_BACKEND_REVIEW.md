# Codex backend review

- **First review:** 2026-08-15 against `main` at `2cc1faa`.
- **Second review:** 2026-08-15 against `origin/codex/scribe-stt-mobile-roadmap` at `ad5a579`
  (3 commits, +2,224 lines, no pull request, not merged).

Scope both times: every foundational document (`CLAUDE.md`, `AGENTS.md`, `README.md`,
`docs/PLAN.md`, all ADRs, the operational runbooks), the full API source, migrations, tests, CI,
and the OpenTofu configuration.

Findings marked **[verified]** were reproduced in this working tree. Findings marked **[read]** are
from code and configuration inspection without a live Azure or PostgreSQL target.

---

## 1. Verdict after the second review

Codex built the speech-to-text slice, and built it well. It also shipped 2,224 lines on top of
three defects that were already reproducible, did not touch any of them, and left the new pipeline
unable to run.

Gates on the new branch: `ruff` clean, `pyright --strict` 0 errors, **44 passed / 2 skipped** (up
from 32/2), `openapi/openapi.json` in sync. Same green, same blind spot.

What is new and genuinely good:

- `transcription.py` — a provider-neutral `SpeechToTextProvider` protocol with an Azure AI Speech
  adapter over the real `azure-ai-transcription` SDK. I verified the package is a legitimate
  Microsoft release (`Microsoft Corporation`, `Azure/azure-sdk-for-python`, MIT, hashed sdist and
  wheel on PyPI) and that every SDK attribute the adapter relies on exists with the right
  optionality: `TranscriptionResult.{duration_milliseconds, phrases}` and
  `TranscribedPhrase.{text, speaker, confidence, offset_milliseconds, duration_milliseconds,
  channel}`. `speaker` is `Optional[int]` and is None-checked. **[verified]**
- `transcription_worker.py` — leased, consent-revalidating orchestration with heartbeat renewal,
  lost-lease cancellation of in-flight provider work, bounded retries, channel-prior role labeling,
  and metadata-only quality gates. This is careful concurrency work.
- Migration 0004 — `transcription_jobs` with RLS forced, a lease/status CHECK that makes an
  unleased `processing` row unrepresentable, and a reversible downgrade.
- **The in-memory and PostgreSQL job repositories agree.** I compared `claim_transcription_job`,
  `renew_transcription_job`, and `update_transcription_job` line by line: identical eligibility
  rules, identical attempt-count semantics, and both require `lease_until > now` on renewal. After
  P0-3, this is the divergence that did *not* happen. **[verified]**
- The benchmark harness gates on `deidentified: Literal[True]` and `consent_verified: Literal[True]`,
  and emits only opaque case IDs with aggregate WER, timing, segment, and speaker counts.
- `docs/TRANSCRIPTION_WORKER.md` states plainly that the worker "is a library boundary today; no
  public route or Azure job trigger is enabled by this change," and lists what the missing
  assembler must do. That is the honest self-report the first review asked for.

What did not happen: `main.py`, `service_auth.py`, `tests/conftest.py`, `scripts/check_phi_logs.py`,
and all of `infra/` are **byte-identical to `main`**. Every defect below still reproduces. **[verified]**

---

## 2. Second-review findings

### N-1 — The worker cannot run [verified]

`TranscriptionWorker` is referenced by nothing outside its own module and its test file.
`build_speech_to_text_provider` is referenced only by `scripts/benchmark_stt.py`. There is no
production `AudioTrackAssembler` — only the Protocol and a test fake. `main.py` gained no route, and
no Container Apps Job was added.

So the pipeline is orchestration plus a provider adapter, with no audio source and no caller.
`POST /v1/sessions/{id}/transcript` still requires some other system to produce the transcript, which
is what the first review said. The gap is now one adapter and one trigger wide instead of an entire
slice — real progress — but the product still cannot transcribe anything end to end.

`docs/TRANSCRIPTION_WORKER.md` says this clearly. `README.md`'s "What works now" does not: it adds
"Consent-gated transcription worker with renewable leases…" to a list of shipped capabilities. Milder
than the earlier overclaims, and worth one qualifier.

### N-2 — Duplicate ADR numbers [verified]

```
docs/adr/0006-private-master-platform-delivery.md
docs/adr/0006-provider-neutral-azure-speech.md
docs/adr/0007-verified-platform-tenant-context.md
docs/adr/0007-web-and-mobile-capture-are-separate-clients.md
docs/adr/0008-leased-consent-gated-transcription-worker.md
```

Two collisions. ADR 0002 already says "Superseded by ADR 0006," which is now ambiguous. Renumber the
three new ADRs to 0008/0009/0010 and add a CI check that ADR prefixes are unique.

### N-3 — The quality gate re-states P0-2's constraint instead of fixing it [verified]

`BasicTranscriptQualityGate` enforces segment ordering, a 10,000-segment cap, and a 24-hour duration
cap — exactly the constraints `MasterTranscriptDeliveryRequest` requires and `TranscriptCreate`
still lacks. So worker-produced transcripts are deliverable, and transcripts arriving through
`POST /v1/sessions/{id}/transcript` are still not. P0-2 is fully live on the API route.

The rule now exists in three places (write schema, quality gate, delivery schema) and is correct in
two of them. Put the constraints in `TranscriptCreate` and have the gate reuse them.

### N-4 — `SessionStatus.FAILED` is now reachable and is a dead end [read]

The worker sets `processing → failed` on terminal failure. Migration 0002's transition trigger has
no transition *out* of `failed`. Once a session fails — bad consent, quality-gate rejection,
exhausted retries — no code path can move it anywhere, and the job row is `terminal` with
`attempt_count >= max_attempts` so it can never be re-claimed either. There is no operator recovery
route. Decide whether `failed → uploaded` is legal for a re-run, or add an explicit reset endpoint.

### N-5 — The real Azure client construction is unexercised [read]

Every transcription test uses `FakeAzureClient`; `AzureSpeechTranscriber.from_settings` — the method
that builds the real `TranscriptionClient` with `DefaultAzureCredential` — is never called in a
test. The declared SDK shapes check out statically, so this is a normal gap rather than a defect,
but the adapter should get one live round-trip against a real Speech endpoint on synthetic audio
before the benchmark's numbers are trusted. Note that Azure SDK `rest_field` models are dict-backed,
so a field the service omits reads as `None` regardless of its annotation; `phrase.confidence` is
annotated non-optional and is not None-checked.

---

## 3. Composition after both runs

Line counts on the STT branch:

| Area | Lines | Share of 8,519 |
|---|---:|---:|
| `services/` | 3,568 | 41.9% |
| `tests/` | 1,860 | 21.8% |
| `infra/` | 1,326 | 15.6% |
| `docs/` | 1,069 | 12.5% |
| `alembic/` | 520 | 6.1% |
| `scripts/` | 132 | 1.5% |
| `apps/` (READMEs only) | 44 | 0.5% |

The ratio improved: this run was mostly product code with real tests. The `apps/` directories
remain four README files describing clients that do not exist.

---

## 4. Defects carried over — all re-reproduced on the STT branch

### P0-1 — Idempotency fingerprints are unstable across processes [verified]

`_fingerprint` hashes `model_dump(mode="json")`, and `participant_regions` is a `set[str]`, which
serializes in per-process hash order.

```
same request body, six processes -> 6 distinct fingerprints
```

A client retrying `POST /v1/consents` with the same `Idempotency-Key` and a byte-identical body gets
**409 "already used with a different request"** whenever the retry lands after a restart or on
another replica. With `min_replicas = 0`, every scale-from-zero is a new process. The unstable hash
is what `idempotency_records` stores, so the PostgreSQL cutover does not help.

`main.py:137` · `schemas.py:30`

**Fix.** Canonicalize before hashing — sort collections, normalize datetimes, fix key order. Pin it
with a test asserting a hard-coded digest.

### P0-2 — `/deliver` 500s on transcripts the API accepted, and leaks PHI doing it [verified]

```
PROBE 1  save out-of-order transcript -> 201
PROBE 3  deliver the same transcript  -> 500
ValidationError: segments must be in nondecreasing time order
```

Four routes to an unrecoverable 500: unordered segments, >10,000 segments, a segment over 100,000
characters, or a duration over 24 hours. Retrying never helps; the receipt stays `pending`.

With no global exception handler, the traceback ships to Log Analytics carrying a prefix of the
offending value — reproduced with synthetic data:

```
String should have at most 100000 characters
  [input_value='Patient Jane Doe DOB 197...']
```

Transcript content and a partial DOB in a log sink, which `CLAUDE.md` prohibits without qualification.

`main.py:574` · `handoff.py:157` · `schemas.py`

### P0-3 — The application and the database enforce different state machines [verified]

```
PROBE B  complete again after transcript_ready -> 200  status: uploaded
PROBE C  legacy handoff from that state        -> 200  uploaded -> handed_off
```

Migration 0002's trigger permits neither transition and raises SQLSTATE `23514`. Both calls are 200s
today and 500s the moment `use_postgres_repository` flips.

`main.py:416` · `alembic/versions/0002_durable_repository.py`

### P1-4 — `claim_idempotency` raises `NoResultFound` under concurrency [read]

`INSERT ... ON CONFLICT DO NOTHING` does not block on an uncommitted conflicting row and returns
zero rows; the follow-up `SELECT` also sees nothing, and `.one()` raises. Two concurrent identical
submits produce a 500 where a 409 or a replay belongs.

`postgres_repository.py:128` (was `:126` before the STT branch)

### P1-5 — Token validation accepts only one of the two shapes Azure emits [read]

The code reads `azp` only and requires a bare-UUID audience. Both hold for **v2** tokens. If the app
registration's `accessTokenAcceptedVersion` is left at its default, Entra issues **v1** tokens —
`sts.windows.net` issuer, `api://<id>` audience, caller in `appid` — and every call fails with an
indistinguishable 401 or 403 across six separate checks.

`service_auth.py:109` · `settings.py:70`

### P1-6 — A JWKS outage is reported as an authentication failure [read]

`PyJWKClientError` subclasses `PyJWTError`, so a failure to reach `login.microsoftonline.com`
returns 401. If egress is ever restricted, the whole API returns 401 and the runbooks send the
operator to Entra role assignments instead of to networking.

`service_auth.py:103`

### P1-7 — A delivered transcript can leave no receipt [read]

The post-success block calls `_session_or_404`, whose `HTTPException` rolls back the receipt write
*after* the platform accepted the transcript. Same outcome if the process dies before the commit.
Nothing sweeps `pending` or `retryable` receipts.

`main.py:664`

### P2-8 — The PHI-log guard cannot detect anything [verified]

`check_phi_logs.py` greps for a `log.<x>(...)` pattern in a codebase with no logging calls at all.
It passes trivially and always will, while the actual leak path in P0-2 is invisible to it.

---

## 5. Infrastructure — unchanged, so all findings stand

`infra/` is byte-identical to `main`.

| # | Finding | Where |
|---|---|---|
| I-1 | `subscription_id` and `tenant_id` are `sensitive = true`. Sensitivity propagates, so `tofu plan` prints `(sensitive value)` for exactly the settings the runbooks require an operator to eyeball. These are identifiers, not secrets — the onboarding doc says so. | `infra/variables.tf:1-11` |
| I-2 | Audio blobs sit behind a private endpoint with public access disabled, but `/upload-grant` returns a SAS URL on the public blob endpoint. The web and mobile capture clients that ADR 0007 just committed to have no reachable upload path. This now blocks a scheduled deliverable, not a hypothetical one. | `infra/main.tf:56`, `storage.py:112` |
| I-3 | No diagnostic settings on the storage account or Key Vault. PostgreSQL has one; the store that holds the audio does not. Blob data-plane access to PHI is unaudited. | `infra/main.tf` |
| I-4 | No lifecycle policy on the audio container and no retention logic anywhere in the service — still the one P0 responsibility in `docs/PLAN.md` with zero implementation. Raw clinical audio accumulates forever. | `infra/main.tf:59` |
| I-5 | No NSGs on the private-endpoint or Container Apps subnets. | `infra/network.tf`, `infra/container_apps.tf` |
| I-6 | Log Analytics `daily_quota_gb = 0.5` silently drops ingestion past the cap. With an unhandled-exception path that logs full tracebacks, a bad day both leaks PHI and then hides the evidence. | `infra/container_apps.tf:29` |
| I-7 | Partially addressed: the bootstrap now grants on `transcription_jobs`. Still no `ALTER DEFAULT PRIVILEGES`, so the next new table repeats the problem. | `database_bootstrap.py:82` |
| I-8 | No Azure AI Speech resource, private endpoint, or RBAC assignment exists for the adapter that was just written. | `infra/` |

`ingress.external_enabled = true` inside an internal-load-balancer environment remains **correct** —
it means "exposed on the environment's load balancer," which is private. Worth one inline comment.

---

## 6. Why CI is still green

`tests/conftest.py:27` still replaces `get_repository` with a bare `InMemoryRepository`, removing the
per-request transaction wrapper. No endpoint has run against PostgreSQL in either review.

The new worker tests are **better** — they drive `InMemoryRepository` as a `RepositoryProvider`, so
they exercise `provider.transaction()` properly, and `tests/test_postgres_repository.py` covers the
job primitives against real PostgreSQL. That is the right instinct applied to new code while the old
code keeps its blind spot.

P0-3 stays unobservable because no endpoint test touches a trigger. P0-1 stays unobservable because
every idempotency test runs in one process. P0-2 stays unobservable because the delivery tests use
transcripts that satisfy the strict contract — and now the quality gate guarantees the worker's
transcripts do too, which hides it further.

---

## 7. Root cause, revised

The first review said Codex optimizes for reviewable artifacts over working software. This run
partly refutes that: the worker is real product code with real tests and an honest
"remaining activation boundary" section.

What it confirms instead is narrower and more actionable: **Codex only moves forward.** Given a
choice between a new slice and a defect in a shipped one, it takes the new slice every time. Three
reproducible defects sat untouched while 2,224 lines landed on top of them, and the new code
re-implemented one of those defects' missing constraint (N-3) rather than fixing it at the source.

The corrective prompt is in [`CODEX_NEXT_PROMPT.md`](CODEX_NEXT_PROMPT.md).
