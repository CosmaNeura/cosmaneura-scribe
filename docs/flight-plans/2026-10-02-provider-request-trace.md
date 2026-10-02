# Staging receiver request trace

Tier 2: instrumentation surrounds existing identity and selection boundaries;
it changes no authorization decision, ordering, credential lifetime, or data.
Owner: Scribe performance workstream. Initial cohort: the existing fixed staging
native receiver only. Remove the staging opt-in after diagnosis, by 2026-10-09;
the constructor defaults off and refuses exposure for other profiles/origins.
No schema, data, permission, dependency, or environment-variable change.

## Contract and scope

`X-Scribe-Provider-Trace` is an optional, content-free response header. The
existing eight-field `Server-Timing` and safe-log event contracts are unchanged.
The receiver removes any downstream copy before adding its own closed request
snapshot. A caller-supplied `X-Scribe-Provider-Trace` remains forbidden by the
existing request boundary; it cannot opt in. The gate requires both host opt-in
and `core-staging-personal-v1` with the exact existing staging receiver/Core
origins. The fixed staging assembly opts in; general receivers do not.

Version 1 JSON has exactly `v`, `total_us`, `counts`, and `spans`. `v` is 1.
Counts contain all nine fixed keys, including zero counts:

```
registry, workload_token, core_exchange, core_mount, core_binding,
core_operation, core_encounter_lookup, identity_check, selection_check
```

Spans have exactly `phase`, `start_us`, and `duration_us`, in entry order. All
numbers are integers. Offsets and durations use the same request monotonic
clock, in microseconds, within 0–3,600,000,000. Each span fits inside `total_us`;
counts are its exact phase histogram. At most 128 spans and 16,384 ASCII bytes
are allowed. Unknown labels, malformed durations, overflow, or an unfinished
child omit the entire trace. Concurrent requests cannot share their snapshot;
late children cannot append after closure. No URL, HTTP method/status, identity,
tenant, visit, token, payload, arbitrary string, error, or upstream header enters
the trace. Thread handoff uses the existing request context and a brief local
snapshot lock; it adds no network or database work.

The selection and identity spans are nested, **not additive**. Identity includes
the existing verifier and associated identity queries; it does not split JWKS
retrieval, cryptography, or SQL. Registry wraps identity plus registry work.
Core spans wrap the existing HTTP stream/response handling. Core facade internals
remain inside `core_operation`. Zero counts/durations mean unmeasured work, not
proof that a service phase took no time. This header is never an authority or
success receipt, microphone measurement, or proof of the four-second target.

## Preserved source-start-ready call graph

For a Core-owned visit, six fresh `selected_current` boundaries remain. Each
performs five local registry reads and four identity calls: legacy detection,
account read, account-before/Core lookup/account-after, and final account read.
The HTTP sequence is:

1. Outer selection lookup.
2. Negotiation selection lookup.
3. Context exchange, then selection lookup.
4. Mount resolution, then selection lookup.
5. Source-start operation, then selection lookup.
6. Final receiver publication selection lookup.

That is nine Core HTTP calls, 30 registry reads, and 24 identity checks. Trace
off/on must issue the same SQL count and Core calls. At revocation boundaries
5–6 the remote operation may already have happened; denial prevents publication
and does not undo that side effect. The tests retain that distinction.

## Validation and release

Use the existing owned socket-only synthetic PostgreSQL fixture with a fresh
empty database and minimal environment. Tests retain the actual receiver,
identity verifier, SQL, transport, response validation, and async registry
handoff; external Core/identity key responses are invented fixtures. Cover
trace-off/on call/query parity, all six revocation boundaries, default/exact
staging gates, request/downstream spoofing, nested/concurrent/late-child spans,
limits and malformed input, failures/cancellation, and existing transport tests.
Lint the changed files, type-check the performance module, and run PHI-log policy.

Release is additive and receiver-first, but hold staging activation until a
reviewed client/collector can consume the optional header. Current Mac47 ignores
it. This source change itself provides no new staging timing evidence. Root owns
deployment and live synthetic qualification. Revert the receiver source or
disable the staging constructor opt-in to stop emission; old clients and the
unchanged Server-Timing contract keep working. No migration or saved-data action.
