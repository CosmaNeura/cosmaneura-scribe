# Codex backend review

| Review | Target | Outcome |
|---|---|---|
| First — 2026-08-15 | `main` at `2cc1faa` | 3 P0 + 4 P1 + 1 P2 defects, 8 infrastructure findings |
| Second — 2026-08-15 | `codex/scribe-stt-mobile-roadmap` at `ad5a579` | STT slice added; all defects untouched; 5 new findings |
| Third — 2026-08-15 | `main` at `4f11b94` | All 8 defects fixed and verified. 5 new findings, none blocking. |
| Fourth — 2026-08-15 | `main` at `d57d721` | Audio key custody and the production assembler. Strongest work in the series. 6 new findings, none blocking. |
| Fifth — 2026-08-15 | PR #5, `agent/scribe-transcription-job` at `2db0624` (open) | Infrastructure finally moves. Dormant manual job trigger. 6 new findings, none blocking merge. |
| Sixth — 2026-08-17 | `main` at `8546a41` (PRs #5–#20) | Every open finding closed. Two real runtime bugs found by live probing. No new defects. |
| **Seventh — 2026-08-17** | **`main` at `7423f7f` (PRs #21–#23) + Codex status report** | **Report verified accurate. Blocker diagnosed: cold-start ingress rejection, not timeout. One standing-credential risk.** |

Findings marked **[verified]** were reproduced or exercised in this working tree. Findings marked
**[read]** come from code inspection without a live Azure target.

---

## 0. Current pass

Section 9 is the sixth review and supersedes the open-finding lists in every earlier section.
Sections 1–8 are retained as the record of how each defect was found and verified.

---

## 1. Verdict (third review)

The stop-and-repair round did what it was asked to do. Every defect from the first two reviews is
closed, and the fixes are structural rather than local — one canonicalizer, one transition table,
one set of transcript constraints, each with a single definition and multiple consumers.

More importantly, the verification gap is closed. The endpoint suite now runs against real
PostgreSQL as a `NOSUPERUSER` role, so RLS, triggers, and grants are exercised through HTTP for the
first time.

Gates on `4f11b94`, all run locally:

```
128 passed, 0 skipped        (with PostgreSQL 16; 84 passed / 44 skipped without)
ruff            All checks passed
pyright         0 errors, 0 warnings
check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi/openapi.json   in sync
alembic upgrade head -> downgrade base -> upgrade head   clean
```

## 2. The eight defects, re-tested

| # | Defect | Fix | Verified how |
|---|---|---|---|
| P0-1 | Idempotency fingerprints unstable across processes | `canonical_json.py` — sorted collections, UTC-normalized datetimes, fixed key order | 6 subprocesses, one body → **1 identical digest** (was 6) |
| P0-2 | `/deliver` 500s on an accepted transcript; PHI in the traceback | `transcript_constraints.py` enforced in `TranscriptCreate`, reused by the quality gate and the delivery schema; opaque-500 HTTP middleware | Out-of-order transcript now **`422` at write**, deliver `409`. Forced a PHI-carrying unhandled exception: response `{"detail":"Internal server error."}`, log line `{"action":"http.unhandled_exception","error_class":"RuntimeError"}`, **no PHI, no traceback** |
| P0-3 | App and database enforced different state machines | `session_state_v1.py` is the one table; migration 0005 generates the trigger from it; routes guard with `can_transition_session` | `complete` after `transcript_ready` now **`409`** (was `200` + silent regression) |
| P1-4 | `claim_idempotency` raised `NoResultFound` under concurrency | `pg_advisory_xact_lock` on the key, `one_or_none()`, new `IdempotencyClaimUnavailableError` → 409 | Postgres endpoint suite |
| P1-5 | Only v2-shaped tokens accepted, with no diagnosis | 11 typed `AuthFailureReason` values in `WWW-Authenticate: error_description` and structured logs; explicit v1 detection on both `ver` and the `sts.windows.net` issuer | `test_service_auth.py` (+372 lines) |
| P1-6 | JWKS outage reported as 401 | `PyJWKClientError` caught separately → **503** | Unit tests |
| P1-7 | A delivered transcript could leave no receipt | Receipt committed first; `synchronize_delivery_session` runs in its own transaction and swallows failures into a safe log event | Code path + delivery tests |
| P2-8 | PHI-log guard could not detect anything | Rewritten as an AST checker over `services/`, plus `safe_logging.log_event` with a 5-field allowlist | **Injected a raw `logging` call** — guard failed with `consent.py:19: direct logging call bypasses safe_logging.log_event`, then passed again on revert |

## 3. Work that stands out

- **The test harness is the real deliverable.** `tests/conftest.py` creates a
  `NOSUPERUSER` role and connects the application as that role, so row-level security is exercised
  against a non-owner rather than silently bypassed. 44 tests are parameterized `[memory]` /
  `[postgres]`. Downgrade-to-base and partial downgrades to `0003` and `0001` are covered.
- **`_prepare_payload` in the reconciler re-verifies `canonical_sha256(payload)` against the stored
  receipt hash before re-delivering**, so a stale receipt can never ship a transcript that changed
  underneath it.
- **`complete_delivery_failure` handles losing the race** — if another process already marked the
  receipt `delivered`, it returns that instead of overwriting, and the caller branches on it.
- **The opaque-500 is HTTP middleware, not an exception handler.** That is more correct than what
  was asked for: Starlette re-raises after a bare `Exception` handler, so middleware is the only
  layer that reliably stops a traceback reaching the log stream.
- **Status guards moved to after the idempotency claim.** A replay now returns the original result
  even if the session has since advanced, while a first call that fails the guard rolls the claim
  back with the transaction. Correct, and load-bearing — worth preserving deliberately.

## 4. New findings

### N-6 — Migration 0005 imports live application code [verified] — the one worth fixing

```python
from cosmaneura_scribe.session_state_v1 import render_transition_predicate, render_status_values
...
op.execute(_transition_function(render_transition_predicate()))
```

The SQL this migration emits depends on the code at *run* time, not at *authoring* time. Two
databases that both report `0005` applied can carry different triggers if anyone edits
`SESSION_STATUS_TRANSITIONS` — and nothing would flag the divergence.

The `_v1` module suffix is clearly the intended mitigation (a future change becomes
`session_state_v2` plus a new migration), and that convention is right. Nothing enforces it.

**Fix:** add a test that pins `render_transition_predicate()` and `render_status_values()` for v1 to
hard-coded expected strings. Editing v1 then fails CI and forces the v2 + new-migration path. This
is the same "pin the invariant, don't re-derive it" rule already applied to the canonicalization
digest test.

The existing parity test (Python table vs. deployed trigger, all 49 status pairs) is worth keeping —
it proves the *rendering* is faithful — but it cannot catch this, because both sides derive from the
same mutable source.

### N-7 — Migration 0005's `downgrade()` is asymmetric [verified]

`upgrade()` drops and re-adds `scribe_sessions_status_check`; `downgrade()` restores only the
trigger. Harmless today — `render_status_values()` emits the same seven values as migration 0002, so
the constraint is identical either way. I confirmed the trigger itself reverts correctly:

```
trigger has failed->uploaded after upgrade:    t
trigger has failed->uploaded after downgrade:  f
downgrade base -> 0 functions, only alembic_version remains
```

A latent trap only if this pattern is reused when the status set actually changes, which would leave
a widened CHECK behind after a downgrade.

### N-8 — `DeliveryReconciler` has no production caller [verified]

`main.py` imports the three module-level helpers but not the `DeliveryReconciler` class; only tests
construct it. `docs/MASTER_PLATFORM_HANDOFF.md` says so plainly — "implemented but not yet attached
to a scheduler or route" — which is standing rule 6 followed correctly.

Noting it only to keep the inventory honest: three components are now implemented and inert — the
transcription worker, the audio assembler contract, and the delivery reconciler. Each is
individually justified; the set of them is the thing to watch.

### N-9 — Two unreachable exception branches in `service_auth` [read]

The decoder now passes `verify_aud: False` and `verify_iss: False` so it can produce granular
reasons, which means `jwt.decode` can no longer raise `InvalidAudienceError` or `InvalidIssuerError`.
Those two `except` branches are dead with the default decoder; the real checks are the explicit
comparisons below them. Harmless, but misleading to a future reader.

Related and correct: dropping `aud`, `iss`, and `tid` from the PyJWT `require` list is **not** a
weakening — a missing claim reads as `None`, fails the explicit comparison, and is rejected.

### N-10 — In-memory and PostgreSQL raise different types for an illegal transition [read]

`InMemoryRepository.update_session` raises `ValueError`; PostgreSQL raises SQLSTATE `23514`, which
surfaces as a SQLAlchemy `DBAPIError`. Both are defense in depth behind the route guards, so neither
is reachable in normal flow — but code written as `except ValueError` would behave differently per
backend. Worth a shared exception type if anything ever needs to catch it.

### Notes, not findings

- **`/v1/diagnostics/token` can only ever return all-`true`**, since it sits behind the authenticator
  that already enforced every check. The real diagnostic channel for a *failing* caller is the
  `WWW-Authenticate: error_description` header and the structured log. Disclosing which check failed
  is an operability-over-obscurity tradeoff that is right for a VNet-only API with one trusted
  caller, and would not be right on a public endpoint. `TokenDiagnostics` is booleans only — no claim
  values leak.
- **`Retry-After: 0` on 409 responses.** The header is defined for 503/429/3xx, not 409. Harmless;
  some client libraries will ignore it.

## 5. Infrastructure — untouched, all eight findings stand

`infra/` is byte-identical to `2cc1faa`. This is consistent with the queue order (infrastructure was
step 7, behind work that was not reached), but nothing there has moved:

| # | Finding |
|---|---|
| I-1 | `subscription_id` / `tenant_id` marked `sensitive`, so `tofu plan` redacts the Container App settings the runbooks require an operator to review |
| I-2 | Private-only blob storage vs. a SAS URL on the public endpoint — no upload path for the web/mobile clients ADR 0009 commits to |
| I-3 | No diagnostic settings on the storage account or Key Vault |
| I-4 | No lifecycle policy and no retention logic anywhere — still the one P0 responsibility in `docs/PLAN.md` with zero implementation |
| I-5 | No NSGs on the private-endpoint or Container Apps subnets |
| I-6 | Log Analytics `daily_quota_gb = 0.5` silently drops ingestion past the cap |
| I-7 | Bootstrap now grants on `transcription_jobs`, but still no `ALTER DEFAULT PRIVILEGES` — the next new table repeats the problem |
| I-8 | No Azure AI Speech resource, private endpoint, or RBAC assignment for the adapter |

## 6. Where the product stands

Still not activated, and correctly deferred to the next round: the production `AudioTrackAssembler`,
the worker trigger, one live Azure Speech round-trip, retention, and the infrastructure items above.

The pattern the second review named — *Codex only moves forward* — did not repeat. Given a queue
that put repair ahead of new work, it did the repair, in order, and stopped.

The corrective prompt is in [`CODEX_NEXT_PROMPT.md`](CODEX_NEXT_PROMPT.md); steps 6 and 7 there are
still the open work, plus N-6 above.

---

## 7. Fourth review — audio key custody and assembly

**Target:** `main` at `d57d721`, merging PR #4 (`agent/scribe-transcription-pipeline`, 2 commits,
+3,017 lines). Merged before this review; no open PR remained.

This is the strongest work in the series. It is real envelope encryption for clinical audio, and the
implementation matches ADR 0011's claims on every point I checked.

### Gates, all run locally

```
158 passed, 0 skipped        (PostgreSQL 16 attached; was 128)
ruff / pyright / check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi.json   in sync
alembic upgrade head -> downgrade base -> upgrade head   clean, only alembic_version remains
```

### What the design gets right [verified]

- **Envelope encryption.** One client-generated AES-256-GCM data key per session, wrapped with
  RSA-3072 through Key Vault `RSA-OAEP-256`. The server never persists a plaintext key; it unwraps
  once per assembly.
- **AAD binds `tenant_id`, `session_id`, `object_id`, `channel`, `sequence_number`.** A chunk cannot
  be replayed into another session or position even by someone holding the ciphertext.
- **Verify before decrypt.** Registered length and SHA-256 are checked against the fetched envelope
  before any decryption, with `hmac.compare_digest`. The Blob read requests
  `ciphertext_size_bytes + 1` so an oversized object fails the length check.
- **Resource limits bound *before* Blob access** — chunk count, and the sum of registered ciphertext
  sizes against the plaintext ceiling plus a header allowance.
- **Key Vault URL allowlist.** `_parse_key_url` requires HTTPS, a valid `*.vault.azure.net` host, an
  exact `/keys/<name>[/<version>]` path, and rejects userinfo, ports, query, fragment, and
  percent-encoding. Only the *configured* key ID ever receives a token; a client-supplied
  `key_version` is charset-validated and can only be appended. `trust_env=False` and
  `follow_redirects=False` close the proxy and redirect exfiltration paths.
- **Plaintext never reaches a filesystem.** Tracks are built in memory, re-encrypted with a fresh
  process-local AES-256-GCM key, and written `O_EXCL` mode 0600 into a `mkdtemp` 0700 directory.
  Cleanup overwrites, fsyncs, and removes the tree, shielded from cancellation.
- **Assembly is not a general Blob reader.** The manifest is re-resolved through the repository and
  requires the session in `processing`, the named job in `processing`, the exact lease token, and an
  unexpired lease.
- **Key custody gates every audio path.** `/chunks/upload-grant`, `/chunks`, and `/complete` all
  refuse a session with no bound key, so no audio can be uploaded before custody exists.
- **The wrapped key never leaves the service.** I walked the generated OpenAPI: `wrapped_dek` appears
  in exactly one request schema and **zero response schemas**. `SessionAudioKeyReceipt` carries only
  session ID, key version, and timestamp.
- **The two repositories agree.** In-memory and PostgreSQL `get_audio_assembly_manifest` enforce an
  identical condition set — the security boundary does not weaken when the backend changes.
- **Migration 0006** adds an immutability trigger, forced RLS, a composite FK, and CHECK constraints,
  and blocks only `UPDATE` — leaving `DELETE` available for cryptographic erasure. Round-trip verified.

### New findings

**N-11 — `EncryptedAudioTrackReader.path` is not `repr=False` [verified] [low]**

Every sibling field is masked — `key`, `nonce`, `additional_data`, and `AudioTrack.local_path` — but
`path` is not:

```
EncryptedAudioTrackReader(path=PosixPath('/secure/patient-jane-doe.enc'))
AudioTrack(object_id=UUID('...'), channel=<CaptureChannel.MIXED: 'mixed'>)     # correctly masked
```

The real path is `<mkdtemp>/track-00.enc` and carries no tenant, session, or patient identifier, so
this is not an active PHI leak. It contradicts ADR 0011's own invariant — "never include object
paths" — and the discipline applied everywhere around it. One-word fix.

**N-12 — the plaintext ceiling is a duration limit nobody has stated in minutes [verified] [medium, product]**

`DEFAULT_MAXIMUM_PLAINTEXT_BYTES = 64 MiB`, and `total_plaintext_bytes` accumulates across **all**
channels in one assembly, not per track. At 16 kHz / 16-bit that is roughly **35 minutes of mono
audio, or 17 minutes of a two-channel virtual visit**. Ambient clinical encounters routinely exceed
both.

ADR 0011 is honest that the cap exists "until assembly and provider upload are fully streaming," and
the setting is configurable to 128 MiB. But the limit is expressed only in bytes, in code. It should
appear in minutes wherever an operator or clinician-facing decision is made, and it belongs in the
acceptance criteria before any pilot — a visit that silently fails assembly at minute 36 is a bad
way to discover this.

**N-13 — nonce reuse is fatal to the whole session [verified] [low, operational]**

Reuse is detected at assembly, not prevented at upload, and the detection aborts the entire
assembly. Failing closed is cryptographically correct — GCM nonce reuse is catastrophic — but a
client-side bug makes that visit's audio permanently unrecoverable, with no partial recovery. This
belongs in the capture-SDK conformance tests, and the operational consequence should be written
down.

**N-14 — the runtime role cannot perform cryptographic erasure [verified] [note]**

`session_audio_keys` is granted `SELECT, INSERT` — no `DELETE`. That is correct least privilege, but
ADR 0011's "allowing a later authorized retention workflow to delete the row" can be misread as the
runtime being able to erase. Whoever builds retention needs its own principal and grant; do not
widen the runtime role.

**N-15 — capture clients cannot fetch the wrapping key directly [read] [note]**

`GET /v1/audio-encryption-key` sits behind the platform workload identity, so the browser and mobile
clients ADR 0009 commits to must receive the public key relayed through the platform. Consistent
with ADR 0007, but it is an unstated dependency in the client design that will surface in P1a.

**N-16 — the same httpx exception gap, now in two more places [read] [low]**

`get_public_key` and `KeyVaultSessionKeyUnwrapper.unwrap` catch `AzureError`,
`httpx.TimeoutException`, and `httpx.NetworkError`, but not `httpx.ProtocolError`. A malformed Key
Vault response becomes an opaque 500 rather than a typed fixed code. `handoff.py` has the same gap.

### Infrastructure — the gap grew

`infra/` is still byte-identical to `2cc1faa`, three rounds running, while this change added two new
hard requirements:

- **`audio_encryption_key_id`** needs a Key Vault RSA-3072 key with `wrapKey` and `unwrapKey`, plus
  a role assignment for the runtime identity. Neither exists in Terraform.
- **`audio_assembly_encrypted_temp_directory`** must be a real directory. `build_audio_track_assembler`
  refuses to start without it. The Container App defines **no volumes**, and the Dockerfile creates
  no such path — and the container runs as UID 10001, so ownership matters. This is a concrete
  activation blocker, not a preference.

I-8 now covers Speech *and* the audio-encryption key, its RBAC, and the ephemeral volume.

### Still open, carried forward

N-6 (migration 0005 imports live application code) is unchanged and remains the one finding worth
fixing on its own merits. The transcription worker, the delivery reconciler, and now the assembler
all still have no trigger — `build_audio_track_assembler` has no caller outside its module. Retention
remains unimplemented.

---

## 8. Fifth review — PR #5, the dormant transcription job

**Target:** `agent/scribe-transcription-job` at `2db0624`, **open, not merged**. One feature commit
plus a merge from `main`. +1,418 lines across 24 files.

This is the round where infrastructure finally moved, after three rounds untouched.

### Gates, all run locally against the branch

```
180 passed, 0 skipped        (PostgreSQL 16 attached; was 158)
ruff / pyright / check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi.json   in sync
```

Not verified locally: `tofu fmt -check` and `tofu validate`. Neither OpenTofu nor Terraform is
installed in this environment; CI runs both.

### What it does

A manual Azure Container Apps Job as the first production transcription trigger, dormant by default,
behind two independent Terraform flags — `deploy_transcription_job` creates the job, its dedicated
identity, and only ACR pull; `enable_transcription_job` flips the runner's gate and creates the
Blob, Key Vault, and Speech data-plane roles. ADR 0012 records it.

It also closes three things this review series has been carrying:

- **The activation blocker is gone.** An `EmptyDir` volume is mounted at `/mnt/encrypted-assembly`,
  matching `COSMANEURA_SCRIBE_AUDIO_ASSEMBLY_ENCRYPTED_TEMP_DIRECTORY` exactly.
- **The wrapping key exists.** `azurerm_key_vault_key.audio`, RSA-3072, `key_opts` limited to
  `wrapKey`/`unwrapKey`, `prevent_destroy`.
- **Key Vault privilege narrowed.** The API runtime's `Key Vault Secrets User` **on the whole vault**
  is replaced by `Key Vault Reader` **scoped to the key** — it can publish public wrapping material
  and cannot unwrap. Only the transcription identity gets `Key Vault Crypto User`, and only on enable.

### Verified rather than read

**The dormant gate holds.** I probed `run_transcription_job` with trip-wires on settings loading and
client construction:

```
disabled + garbage args  -> transcription_job_disabled   touched: nothing
disabled + valid args    -> transcription_job_disabled   touched: nothing
enabled + garbage args   -> transcription_job_target_invalid   touched: nothing
"1" instead of "true"    -> transcription_job_disabled   touched: nothing
```

No argument value reaches any log line — `../../etc/passwd` never appears, and `tenant_id` /
`entity_id` stay null when parsing fails. The ADR's central claim is accurate.

**The database role matches what the worker actually calls.** I traced every worker operation
against the new grant list: `lock_session` (`SELECT … FOR UPDATE` needs SELECT + UPDATE on
`scribe_sessions` — has both), `claim_transcription_job` (INSERT … ON CONFLICT DO UPDATE — has
SELECT/INSERT/UPDATE), `get_audio_assembly_manifest` (SELECT across three tables — has all), the
transcript insert, and the audit insert. Nothing is missing, and nothing is granted that the worker
does not use: no upload-grant, idempotency, delivery, DELETE, or DDL privilege.

**The Terraform guards are real.** `enable_transcription_job` requires `deploy_transcription_job`
(so the `[0]` identity index cannot go out of range), plus the migration job, the PostgreSQL cutover,
and both Speech values — with a cross-check that the endpoint subdomain equals
`basename(azure_speech_resource_id)`. `deploy_transcription_job` requires a lowercase 40-character
commit SHA image tag.

**Two operational traps I expected to find are already documented.** `infra/README.md` states that
the Key Vault key is a data-plane resource, that an ordinary public GitHub runner cannot create it,
that the deployment principal needs `Key Vault Crypto Officer` (with the GUID) scoped to that vault
only, and that subscription Owner/Contributor grants no Key Vault data-plane permission. It also
says to re-run the migration job after deploying the job so bootstrap maps the new identity. There
is even a decommissioning procedure noting that a recreated identity of the same name has a
different Entra object ID and must never inherit the old database mapping.

### New findings

**N-17 — the Key Vault Reader assumption is the highest-risk unverified thing here [read] [medium]**

The entire client key-wrapping flow depends on `Key Vault Reader`
(`21090545-7ca7-4776-b22c-e363652d74d2`) being sufficient for `GET /keys/{name}` to return public
material. If it is not, `GET /v1/audio-encryption-key` returns 503, no client can wrap a session
DEK, and nothing downstream works. **No test can catch this** — every test uses a fake client.

The same applies to the other three role GUIDs (`AcrPull`, `Storage Blob Data Reader`,
`Key Vault Crypto User`, `Cognitive Services Speech User`). They look right, but a wrong GUID is
either an apply error or a silent least-privilege failure.

One `az role definition show` per GUID plus one live `GET /v1/audio-encryption-key` settles all of
it. Do that before enabling anything.

**N-18 — RBAC propagation on the enable step [read] [low]**

The README correctly says to wait for propagation after the one-time Crypto Officer grant, but the
activation sequence creates three data-plane assignments and flips the env var in the same apply.
The first execution can 403 on Blob, Key Vault, or Speech. One runbook line.

**N-19 — the documented start command needs one dry run [read] [low]**

```bash
az containerapp job start --container-name worker --args <tenant-uuid> <session-uuid>
```

Worth confirming the CLI *merges* this override with the job template rather than replacing the
container spec — if it replaces, `--image` and `--command` are also required and the documented
command starts nothing. Cheap to verify, and the whole operator procedure rests on it.

**N-20 — the migration job can strip privileges from a live execution [read] [low]**

`_grant_transcription_permissions` runs `REVOKE ALL … FROM role` before granting. That is correct
for convergence on re-runs, but PostgreSQL evaluates privileges per statement, so re-running the
migration job during an active transcription execution can fail it mid-transaction. Executions are
manual and rare — a runbook line is the whole fix.

**N-21 — the enable flag is an interlock, not a boundary [read] [note]**

Anyone with Container Apps start permission can override `--env-vars` and set the enable flag true
regardless of Terraform. ADR 0012 says exactly this and treats start permission as trusted code
execution under the worker identity, and the README's framing — "turning on the Boolean alone is
insufficient unless all private dependencies and roles are present" — is the accurate one. The real
boundary is the RBAC assignments, which do not exist while disabled. Worth stating plainly, because
"false by default" reads stronger than it is.

**N-22 — no key rotation policy [read] [note]**

The *code* supports rotation correctly: unwrap uses the version stored on the session, the configured
path is versionless, and `bind_session_audio_key` rejects a stale version with a specific 409 so
clients re-fetch. But there is no rotation policy, no expiration, and no documented answer to how
long an old version must stay enabled — which is: until every session bound to it is transcribed or
cryptographically erased. A later slice.

### Carried findings — unseen, not ignored

The corrective prompt has not been pushed yet, so Codex has not seen these. All four confirmed still
present on this branch:

| # | Status |
|---|---|
| N-6 | Migration 0005 still calls `render_transition_predicate()` at run time; no test pins the v1 output |
| N-11 | `EncryptedAudioTrackReader.path` still lacks `repr=False` (line 205) |
| N-16 | All three Key Vault / handoff call sites still miss `httpx.ProtocolError` |
| N-12 | **Now live in the deployed job.** No `MAX_PLAINTEXT_BYTES` env is set, so the 64 MiB default applies against `memory = "1Gi"` — roughly 35 minutes of mono audio or 17 of a two-channel virtual visit |

The `DeliveryReconciler` still has no trigger; this PR wires the transcription worker only.

### Merge assessment

Nothing here blocks merge. N-17 blocks *enabling*, and the PR already keeps both flags false, so the
sequencing is right. The remaining infrastructure findings from earlier rounds — `sensitive = true`,
storage and Key Vault diagnostics, `ALTER DEFAULT PRIVILEGES`, NSGs, the Log Analytics quota, the
client upload path, and retention — are untouched and still stand.

---

## 9. Sixth review — PRs #5 through #20

**Target:** `main` at `8546a41`. Sixteen pull requests merged since the fourth review: 89 files,
+10,914 / −408 lines. **No branch is unmerged** — this is a clean stopping point.

### Gates, run locally

```
297 passed, 0 skipped        (PostgreSQL 16 attached; 237 passed / 60 skipped without)
ruff / pyright / check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi.json   in sync
```

Not run: `tofu fmt -check` and `tofu validate` — no OpenTofu or Terraform in this environment. CI
runs both. At this diff size I read the new modules, ADRs, and runbooks closely and scanned the
Terraform; I did not review all 10,914 lines line by line.

### Every open finding is closed

| # | Finding | Resolution |
|---|---|---|
| N-6 | Migration 0005 imported live code unpinned | v1 predicate and status values now pinned by tests |
| N-8 | `DeliveryReconciler` had no trigger | Gated manual job, ADR 0015 |
| N-11 | `EncryptedAudioTrackReader.path` unmasked | `field(repr=False)` added |
| N-12 | Assembly ceiling stated only in bytes | ADR 0011 and the runbook now say "about 35 minutes of one-channel audio or about 17 minutes of a two-channel virtual visit" |
| N-16 | `httpx.ProtocolError` uncaught | All three call sites now catch it |
| N-17 | Key Vault Reader assumption unverified | Documented and verified; API still holds Reader only, not Crypto User |
| N-18 | No propagation note on enable | "Treat an initial `403` as propagation delay and never widen a role to bypass it" |
| N-19 | `job start --args` semantics unverified | **Live-probed. The concern was correct** — see below |
| N-20 | Migration job could strip live privileges | "Run bootstrap only in a drained maintenance window with no API traffic or transcription execution" |
| N-21 | Enable flag is an interlock, not a boundary | Stated in ADR 0012 and again in `PRIVATE_TERRAFORM_RUNNER.md`: "A Container Apps Job start permission is code-execution authority" |
| N-22 | No key rotation policy | ADR 0013 covers rotation alongside retention and erasure |
| I-1 | `sensitive = true` redacting reviewable plans | Removed |
| I-3 | No storage/Key Vault diagnostics | `infra/diagnostics.tf` |
| I-4 | No retention | ADR 0013, **design only, enforcement disabled** — correctly staged |
| I-5 | No NSGs | `infra/network_security.tf`: deny-all inbound and outbound, with service-tag-scoped egress |
| I-6 | Log Analytics quota hardcoded | Parameterized |
| I-7 | No `ALTER DEFAULT PRIVILEGES` | Added |
| I-8 | No Speech resource | `infra/speech.tf`, ADR 0014 |

### Two real bugs found by live probing — the most valuable outcome of the series

Both are in the class no test can catch, because every test uses a fake client.

**1. The async Azure transport was missing.** A live token probe on the exact merged image failed
with `ImportError: aiohttp package is not installed`, *before* managed-identity acquisition. Every
async Azure call — Blob, Key Vault, Identity — would have failed at runtime. The fix adds
`azure-core[aio]` and a constructor regression test. The commit body is exactly the honesty the
standing rules ask for: "the corrected image has not yet been deployed or wire-verified."

**2. `az containerapp job start --args` does not merge.** Azure returned
`ContainerAppImageRequired` because the replacement container had no `Image` property — confirming
the concern raised in the fifth review. The response is the right one: rather than guessing at a
patched command, the runbook now says the full-template workflow "has not yet been implemented or
verified, so this runbook intentionally provides no clinical start command," and activation is
blocked behind a reviewed operator helper.

The lesson also propagated. Every `az containerapp job start` in the repository now runs with no
overrides at all — the Speech smoke job and the private Terraform runner both explicitly say to
start "without command, argument, image, or environment overrides."

### Tests Codex could not run, run here

Three commits noted that PostgreSQL was unavailable locally, including the delivery claim fencing
fix. Against a real PostgreSQL 16, those 23 tests all pass:

```
tests/test_endpoint_postgres.py + test_delivery_reconciler_runner.py + test_database_bootstrap.py
23 passed
```

### New surface, sampled

Five ADRs (0013 retention/erasure/rotation, 0014 private Speech, 0015 reconciler trigger, 0016
client capture path, 0017 API key-metadata acceptance) and seven new Terraform files. Spot checks:

- **NSG rules are tight.** Private-endpoint subnet allows inbound 443 from `VirtualNetwork` only,
  with deny-all inbound at 4095 and deny-all outbound at 4096. The Container Apps subnet allows only
  the documented ACA requirements plus service-tag-scoped egress to
  `MicrosoftContainerRegistry`, `AzureFrontDoor.FirstParty`, `AzureActiveDirectory`, `AzureMonitor`,
  and `AzureContainerRegistry`. The one broad-sounding rule, `AllowTemporaryTerraformArmOutbound`,
  is `dynamic` on `enable_private_terraform_runner` — it does not exist while the runner is off.
- **The private Terraform runner is a Container Apps Job, not a VM.** No public IP, no SSH, image
  pinned by digest as well as tag. Its powerful roles — Key Vault Crypto Officer, Key Vault Data
  Access Administrator, Container App Contributor, and a custom state-blob role with only
  `data_actions` — are all resource-scoped and gated on `enable_private_terraform_runner`. The RG
  role is Reader, not Contributor.

### No new defects

I did not find a defect in this round worth reporting as one. The residual items are all
governance or sequencing, and all are already written down:

- **Retention enforcement remains the one P0 responsibility without an implementation.** ADR 0013 is
  labeled "design only; enforcement remains disabled," and its reasoning is sound — an unconditional
  Blob age rule cannot see a legal hold, an active session, a transcription lease, or a pending
  delivery, and giving the API or worker `DELETE` would collapse custody and erasure into the same
  identities. Correct to stage; still the gap.
- **The security model now rests on who holds ARM start permission on three jobs.** The transcription
  worker, the Speech smoke job, and the Terraform runner are each code-execution authority under a
  privileged identity. The repository grants no such permission and says so in two places. That is
  the right boundary — it is also a governance decision that lives outside this repo, and it should
  be written down wherever those grants are actually administered.
- **The product still cannot transcribe an encounter end to end.** Activation is blocked on the
  operator helper that submits a full `--yaml` execution template, and on wire-verifying the
  aiohttp-corrected image. Both are small and well specified. Five reviews ago the blocker was "there
  is no speech-to-text at all."

---

## 10. Seventh review — PRs #21–#23 and the pause-point status report

**Target:** `main` at `7423f7f` (three repair PRs since the sixth review), plus Codex's own status
report delivered at the pause point. This pass cross-checks the report against the repository and
assesses the stated blocker.

### Gates, run locally

```
308 passed, 0 skipped        (PostgreSQL 16 attached; was 297)
ruff / pyright / check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi.json   in sync
```

### The report is accurate on every claim checkable from here

- PR #23 is merged and is `7423f7f`; the fix is exactly as described — the single Settings-owned
  HTTP timeout raised to its 60-second maximum, **no HTTP or job retries added**, pinned by tests
  and recorded in ADR 0017.
- No branch is unmerged; no verified code remains only local, as stated.
- The commit bodies continue the honesty discipline: PR #23's own body says "the authenticated live
  retry remains unverified: both acceptance gates are closed and no retry was performed."

Outside-repo claims (Azure image/auth state, Terraform serial 48, the two failed live checks) are
not verifiable from this session and are taken as reported. The master-platform draft PR #121 is in
a repository not attached to this session and was not reviewed.

### The blocker, diagnosed

The two failed checks tell one story:

1. The 15-second request lost the scale-from-zero race — so the timeout was raised to 60 seconds.
2. The 60-second request received an **ingress rejection before reaching the API**, with API request
   metrics at zero while the replica started.

That second result disproves the assumption ADR 0017 line 47 wrote down: "covers one scale-to-zero
API cold start." Azure Container Apps internal ingress (Envoy) does not reliably hold a connection
open while a scale-from-zero replica starts — it can answer early with a non-200 before any replica
exists. **Timeout was never the axis.** No client-side timeout value fixes a gateway that answers
early with an error, which is why the report correctly concludes "a longer client timeout alone does
not solve it."

### The decision, with recommendation

The report asks: reviewed prewarm/minimum-replica window, or change the acceptance readiness
contract. **Recommendation: change the contract.** Split acceptance into two phases:

1. **Readiness phase** — bounded polling of `/healthz` (unauthenticated, ops-open by design),
   treating ingress-layer non-200s and transport errors as "not ready yet," until two consecutive
   200s or a hard overall deadline (e.g. 240 s inside the job's 300 s budget).
2. **Probe phase** — the authenticated `GET /v1/audio-encryption-key`, **single attempt, unchanged**.

Why this over prewarm:

- Scale-to-zero is the deployed configuration; any real caller must tolerate cold start. A prewarm
  window would test a configuration that production does not run.
- Prewarm mutates the API's scaling through Terraform — via a runner whose apply pins are currently
  `review-required` — and needs a revert apply afterward. The contract change is code plus one
  enable-flag apply.
- It preserves the zero-retry principle where it matters. The no-retry rule exists so failures of
  the *thing under test* are not masked. Cold-start ingress behavior is the platform, not the thing
  under test. Retrying the unauthenticated health poll is readiness; the authenticated probe stays
  single-attempt so its result remains unambiguous.
- ADR 0017 must be amended to record the two-phase contract and to correct the disproven
  60-second-covers-cold-start claim.

### R-1 — Standing privileged credentials on a wedged runner [reported, accepted as fact]

Eight temporary role assignments — including Key Vault **Crypto Officer** and **RBAC
Administrator** — plus two temporary NSG egress rules remain attached to a Terraform runner that has
no active executions and cannot apply (`review-required` pins). That is the most privileged idle
credential set in the estate, held by the one component currently unable to do its job.

The report itself says they should be revoked once the acceptance path resolves. Make that a
deadline, not an intention: resolve acceptance in the next round and revoke at round end regardless
of outcome. Re-granting is now a documented procedure, so revocation is cheap to undo.

### R-2 — Evidence lives in a temp directory [reported]

The protected change record sits under `/private/tmp/...` on the operator machine. The acceptance
evidence is metadata-only by design (fixed events, hashes, serials — no PHI), so a sanitized copy
belongs in the repository where it survives the machine. One directory, one README, committed.

### State of the goal

The single goal of the last prompt — one synthetic encounter end to end — was not reached, and the
reason is exactly the kind the process is designed to surface: a real platform behavior, found by a
real probe, that no test could see and that invalidated a written assumption within hours of it
being written. The response pattern held at every step: no gate was widened, no retry was bolted on
to force a pass, both failures were reported with metrics, and the blocker was escalated as a
decision rather than routed around.

---

## 11. Eighth review — PRs #26–#30: Phases 0–2 of the capture client

**Target:** `main` at `c2ed0f0`. Five PRs, +24,141 lines across 191 files. No branch unmerged.

### Gates, run locally

```
353 passed, 1 failed          (PostgreSQL 16 attached)
ruff / pyright / check_phi_logs / check_secrets / check_adr_numbers   PASS
openapi.json   in sync
```

The one failure is environmental, not a defect: `test_typescript_capture_protocol_matches_golden_vectors`
asserts Node >= 24 and this review container has Node 22. CI pins Node 24.5.0 and passed on merge.
The assertion failing loudly instead of skipping is itself correct behavior.

### The headline: N-17 is closed with live evidence

PR #26's change record documents the successful one-shot authenticated JWK metadata proof — the
versionless Key Vault Reader fix worked, the readiness phase carried it through cold start, and
teardown ran through state serial 62 with only the approved versionless Reader retained. The chain
that started with "Key Vault Reader is the highest-risk unverified assumption" is now: assumption →
live disproof (wrong scope) → narrowest correction → live proof → teardown. That is the process
working end to end.

### What Phases 1–2 delivered

- **Protocol v1** (`packages/capture-protocol` + `protocol/golden`): the versioned capture protocol
  with cross-language golden vectors, tested from both Python and TypeScript. Reservations, upload
  authorization over a reservation, receipt lookup, capability bootstrap, and the capture lease are
  in the API with HTTP-level PostgreSQL tests (`test_capture_protocol_api.py`, 595 lines).
- **`apps/capture`**: Vite 8 + Lit 3 + strict TS (deliberately small — no router, no state runtime,
  no third-party scripts), Capacitor 8.5.0 pinned as one reviewed set, iOS + Android platforms
  generated, a custom `secure-queue` native plugin with Keychain/Keystore tests run on a real
  Android API 36 emulator and signed iOS test host in CI, the durable queue state machine with
  Web-Locks cross-tab coordination, a BFF client, and a mock BFF with integration tests.
- **CI hardening** (PR #30): npm production dependency audit, Android emulator isolation.
- Honest boundaries in the app README: 10-second chunk duration (correcting stale planning stubs),
  pre-reservation persistence explicitly deferred to Phase 3, fail-closed on browsers without Web
  Locks.

### Assessment for the acceleration question

Codex's status is accurate: secure, buildable foundation; not yet a recording app. What its 2–4
week estimate misses is that its own Phase 2 already built the hard middle of the pipeline (queue,
protocol, crypto plumbing, mock BFF, native custody plugin). What remains for a usable synthetic
demo is the two ends — microphone → WAV chunks in, and CI-published builds out — plus wiring the
existing pieces to the existing mock. Those split into four disjoint tracks that the repo's proven
multi-agent pattern can run in parallel. The genuinely incompressible items are external: Apple
Developer enrollment and signing, BAA/service-eligibility review, the live Front Door edge proof,
and clinical-pilot gates.
