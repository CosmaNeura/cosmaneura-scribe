# ADR 0020: Silence third-party HTTP loggers inside the API service

**Status:** Accepted

## Context

The hard rules forbid logging transcript text, audio or blob URLs, object names, patient
names and DOBs. Three mechanisms already enforce that for code we own:

- `safe_logging.log_event` is closed-schema — keyword-only, five fixed fields, `action` and
  `error_class` constrained by a safe-label pattern, no free-text field of any kind.
- `scripts/check_phi_logs.py` rejects `logger.*`, `print(...)` and non-allowlisted `log_event`
  keywords at the AST level.
- The service image runs uvicorn with `--no-access-log`, and no `HTTPException` detail
  interpolates a value.

None of the three can say anything about libraries. `azure-storage-blob` is used by
`storage.py` and `audio_assembly.py`, and its HTTP logging policy emits the request URL. An
audio object's name is a path segment of that URL, so the SDK logger is a direct route to a
value the rules prohibit.

Nothing is written today, but only because Python's root logger defaults to WARNING while the
policy emits at INFO/DEBUG. The protection is a default, not a decision. One `--log-level
debug` during an incident, or a library changing its own default, turns it into object names
on stdout — and the standalone runners already muzzle these namespaces explicitly
(`configure_private_api_acceptance_logging`), so the service was the inconsistent case.

## Decision

`safe_logging.configure_service_logging()` disables the `azure`, `httpcore` and `httpx`
logger namespaces, and the API lifespan calls it before serving. `_silence()` is now shared
with `configure_private_api_acceptance_logging`, so the service and the acceptance job cannot
drift apart.

The function is deliberately narrow. It does **not** touch the root logger or this service's
own logger:

- uvicorn and FastAPI report startup and request failures through root, and losing those
  would trade a latent PHI risk for a real operability one.
- The service's own logger is already closed-schema, so leaving it propagating costs nothing.

Both blob clients now pass `logging_enable=False` at construction, so the guarantee does not
depend on process-wide logger state alone. `transcription.py` already did this; the two
modules that actually handle object names did not.

## Consequences

Azure SDK, httpx and httpcore diagnostics are unavailable in the API service. That is the
accepted cost, and it matches what the acceptance job already accepts. Anyone debugging a
storage or transport problem should reproduce it in a standalone runner rather than raising
the service's log level.

Adding a new third-party HTTP client means adding its namespace to
`_PHI_RISK_LOG_NAMESPACES`, and any new blob client must pass `logging_enable=False`.
`tests/test_service_log_muzzle.py` covers both: it asserts an object name cannot reach stdout
or stderr through any muzzled namespace, that the root logger is left intact, and that both
blob client constructions disable SDK HTTP logging.
