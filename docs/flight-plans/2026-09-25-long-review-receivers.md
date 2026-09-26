# Receive complete long-visit reviews across native clients

Tier 2, receiver-first increment under the owner's three-hour-visit request.
Core PR507 accepts 500,000 total transcript characters and a 32 MiB review.
This increment carries that review through the existing native/Core adapters,
shared creator-review parser and desktop IPC, retaining their current scope,
revision, authorization, cancellation and decision checks. Smaller operation
limits remain unchanged. No new dependency, writer, schema or deployment.

The Core envelope allows 32 MiB + 8 KiB; desktop object wrappers add 8 KiB and native
JSON-string framing allows at most twice the Core bytes plus 8 KiB. Input/request
bounds remain unchanged. The desktop decoder reuses the existing native audio
decoder's synchronous byte ownership/zeroing pattern with geometrically grown
Node buffers, avoiding repeated whole-response copies. It releases large buffers
after each reply and clears partial bytes on closure/error.

Sequence: compatible Core first, these native/service readers next, expanded
Scribe aggregate source/working validation and database constraints last. Keep
larger writers disabled until all receivers are deployed/installed and qualified.
Before admission of larger text, revert normally. Afterwards retain compatible
readers during recovery so retained sources/notes remain readable. Preserve all
recordings, keys, journals, consent and terminal jobs.

Validate bounded large review consumption across Python/TypeScript/Swift,
native frame fragmentation/overflow/cancellation, existing scope/retry checks,
types/lint and actual native/renderer builds. Measure transport performance
locally without claiming physical-device or cloud latency. This does not qualify
continuous native recording, clinical output quality or hardware routes.
