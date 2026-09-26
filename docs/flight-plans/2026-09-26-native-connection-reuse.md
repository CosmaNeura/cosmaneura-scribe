# Native provider connection reuse

Tier 2 because this changes the lifetime of authenticated native transport.

The Mac/iPhone provider transport currently creates and invalidates an Apple
URLSession for every request. Opening an encounter and authorizing recording
therefore lose connection reuse between sequential calls. Retain at most three
ephemeral sessions for the existing standard, admission and note timeout profiles.
Fresh token acquisition, identity/revision checks and per-request headers remain
unchanged. Cookies, shared credentials and response caches remain disabled.

Reuse URLSession's connection management and existing endpoint/TLS policy. A weak
delegate forwards trust evaluation and rejects redirects; transport deallocation
invalidates the pool. Every response exit cancels only its own task, including
invalid headers, cancellation and oversize responses. No server, schema, consent,
recording authority, Keychain, dependency or deployment change.

Validate both byte-identical transport copies, actual Swift transport/auth with
offline URLProtocol/SDK fixtures, fresh request dispatch, bounded timeout pools,
per-request cancellation, failed-response cleanup and release without a retain
cycle. Compile integrated Mac/iPhone candidates. Follow with physical opening and
record-readiness timings; local request counts do not establish a 50% speed gain.

Release through the existing same-identity native update with preserved data.
Recovery is a same-identity rebuild reverting only this transport change; never
uninstall/reset recordings or keys. No feature flag or schema rollback applies.
Owner local checks and implementer review govern merge. Record exact commit,
commands, results and review disposition in the PR; no independent-review or
hosted-CI claim.
