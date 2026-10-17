# Optional Core phase observations in native provider diagnostics

Tier 1: additive numeric response metadata and native observation only. The
receiver and shared iPhone/Desktop bridge can ship separately. No recording,
authorization, consent, request ordering, source decision, schema, credential,
configuration or deadline behavior changes.

The deployed receiver 47 and source base `254286817585b96f180794b43c4674e05321ef72`
do not inspect Core's `X-Cosmaneura-Native-Request-Timing` response header. Their
legacy `Server-Timing` schema has exactly eight metrics. Expanding that header
would make existing native clients discard all its measurements.

Keep the existing eight metrics and `provider_request` log line unchanged.
For each existing native Core response, validate the complete closed nine-field,
sixteen-phase Core schema, then aggregate only `workflow_token`, `workflow_http`
and `capture_transaction` milliseconds, counts and failures within the current
provider request. A separate `X-Scribe-Core-Timing` v1 header reports accepted,
missing and invalid observation counts. No identifiers, request kinds, SQL,
errors, bodies, URLs or incoming caller values enter the projection.

At most sixteen Core responses enter an observation; overflow omits the entire
optional header. Absent or wholly malformed Core metadata emits no header. The
middleware replaces any downstream copy, and the existing boundary rejects a
caller-supplied `X-Scribe-*` diagnostic header. Requests and late child tasks
cannot append to another or already closed observation.

Core's snapshot is taken at response start, so unfinished phases may have zero
count and duration. The header explicitly declares `response_start_only=1` and
`nonadditive=1`: nested durations overlap and cannot be summed to explain total
latency. Observation counts describe headers received, not every possible Core
attempt or transport failure. Invalid-header counts are not clinical failures.

The shared Swift observer independently accepts only this bounded v1 schema,
ignores absent/malformed metadata, and emits a separate fixed numeric
`provider_core_timing` log event attached to its existing native action and
request elapsed time. No correlation identifiers are introduced. Original
reply/error/status classification and body limits remain authoritative.

Validation uses invented metadata, offline HTTPX/ASGI/URLProtocol fixtures,
concurrent request/thread isolation, close/cancellation fences, malformed numeric
and privacy cases, and exact legacy eight-metric compatibility. The ASGI test
executes the actual middleware function without identity/database services.
V2 validation uses the complete native provider and URLProtocol transport
fixtures with the real native auth/recording modules. The provider fixture's
obsolete encounters-enum expectation is corrected from 4096 to the existing
16384-byte runtime limit; its separate generic 4096-byte request rejection
remains unchanged. The transport fixture marks its three NSLock-protected static
collections `nonisolated(unsafe)` and requires an `@Sendable` bounded-wait
predicate, preserving every lock and cancellation/redirect/body-limit assertion.
These repairs change tests only. Original baseline failure, missing-CA attempts
and failed Swift 6 fixture compilation remain retained as evidence.

The native auth/recording modules compile in Swift 6 with warnings as errors.
The full bridge fixtures compile/run in Swift 6 with their unchanged SecItem
journal deprecation and transport delegate-test captured-variable warnings;
they do not claim a warnings-as-errors full-bridge build. Provider 104 checks and
transport 10 check groups pass offline; Python 198 cases and Root's separately
executed certificate-verified loopback TLS case are reused only after matching
source inputs. No physical app/account/Keychain/microphone is exercised.

Rollout is receiver first, then separately qualified native builds. Current
installed clients ignore the new header and retain their legacy diagnostics;
they cannot emit the new event until rebuilt. Bind each release to reviewed
merged source and the existing image/app configuration, identity and rollback
receipts. Restore the previous image/app artifact for recovery; no data or
schema work is involved. No latency reduction or hardware acceptance is claimed.
