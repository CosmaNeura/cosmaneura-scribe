# Receiver native Core read facade

Risk: Tier 2. Owner: Scribe operational improvement workstream. Depends on the
Core native-capture route being deployed and qualified first.

For Core-created encounters, send mount/opening and creator_review,
provider_encounter, capabilities, native_recording_context through one fixed Core
facade request. Preserve the native client phases after custody/key awaits; never
reuse an earlier opening review as authorization. Preserve patient-name display.
Legacy workspaces and every mutation continue through their existing transport.

The local registry is checked before obtaining the workload token, immediately
before dispatch, and before publishing the response. Compared with the former
five/six encounter lookups, intermediate local-registry sampling is removed inside
Core. Only reads and existing mount metadata use this window. Source-start, consent,
recording-window creation, leases, uploads, completion, note writes and key access
retain all old transport checks; final denial cannot undo those effects.

Clerk and workload credentials go only to the configured fixed HTTPS Core origin.
Validate version, current actor/tenant, workspace, binding, nonce, operation and
receipt freshness. Do not follow redirects, accept cookies, or fall back after an
authentication denial or missing facade. The facade does not return a bearer.

Test real receiver registry revocation before dispatch/after the read; test old
mutation side effects at each boundary; test one Core call per client phase,
malformed, oversized, stale/cross-scope responses and cancellation. Use invented
fixtures with explicit local DB names and a minimal environment.

Release control is the receiver artifact in the existing staging cohort. Owner may
roll back to the preceding receiver without data changes; no automatic fallback.
No Core/Scribe API schema migration, hosted CI, production or physical timing claim.
The observed opening chain is 27 to 3 Core calls, saving 24 network round trips;
Clerk token time and actual service work remain. Re-measure Mac and iPhone after
both dependency releases before claiming the four-second goal is achieved.
