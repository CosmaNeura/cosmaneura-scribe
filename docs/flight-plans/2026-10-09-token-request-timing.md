# Attribute fresh token latency without changing authentication

Tier 1 observational runtime change. Desktop69's latest slow fictional
preparation shows two fresh-token waits totaling3048ms. The exact retained
Clerk SDK already reuses its URLSession; source inspection alone cannot tell
whether the waits include network retries. Add invocation-local numeric request
and response middleware observations around the existing forced token call.

Preserve `skipCache: true`, issuer/audience/authorized-party checks, identity and
revision fences, durable sign-out block, SDK middleware ordering and retries.
No token, request, response, URL, claim, body, error or account reference enters
the ledger. The response middleware reads only numeric HTTP status. Child
tasks inherit the ledger; nested/concurrent invocations keep separate ledgers,
detached tasks have none, and close freezes all observations. Logs use the
existing local performance subsystem only. No configuration, SDK dependency,
credentials, access, consent, capture or cloud logging destination changes.

Validate deterministic interval/response/retry/failure/close/overlap/bounds and
task-inheritance behavior offline, then compile the actual helper with the exact
retained Clerk lock. Run existing native auth/transport checks and scoped lint,
types and whitespace checks. Record exact commit and implementer review before
merge under the owner's local-validation policy. Signed package qualification,
normal launch and a fictional preparation measure actual SDK propagation;
virtual audio only. Numeric middleware cannot divide DNS/TLS/server time, and
pending failed HTTP intervals can include later backoff. Treat these as limits.

Recovery restores signed desktop69 and/or reverts this trace. No migration,
data/Keychain cleanup, new permission or backend rollout applies. The pending
bounded staging numeric diagnostic activation is a separate configuration
decision. All12 and consistent5–7second acceptance remain open.
