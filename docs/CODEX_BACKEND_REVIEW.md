# Codex backend review

| Review | Target | Outcome |
|---|---|---|
| First — 2026-08-15 | `main` at `2cc1faa` | 3 P0 + 4 P1 + 1 P2 defects, 8 infrastructure findings |
| Second — 2026-08-15 | `codex/scribe-stt-mobile-roadmap` at `ad5a579` | STT slice added; all defects untouched; 5 new findings |
| **Third — 2026-08-15** | **`main` at `4f11b94`** | **All 8 defects fixed and verified. 5 new findings, none blocking.** |

Findings marked **[verified]** were reproduced or exercised in this working tree. Findings marked
**[read]** come from code inspection without a live Azure target.

---

## 1. Verdict

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
