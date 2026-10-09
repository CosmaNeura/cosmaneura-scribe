# Match preparation to the verified native session

Tier 2, follow-up to Core 747/Scribe 307 in the existing personal staging cohort.
The owner authorizes backend staging latency fixes and a five-second recording
target. The first two installed consent-to-ready runs after that release measured
7.104 and 5.963 seconds. No repeatable five-second acceptance is claimed.

The native Clerk driver requests `skipCache: true` for every call. The receiver's
handoff keyed on the full JWT digest, so refreshing iat/signature for the same
session made a miss. A regression proof uses the actual retained staging identity
verifier, two offline signed tokens, and owned fictional PostgreSQL: the identity,
account and session are unchanged, but the old handoff cannot be taken.

Derive a fixed private digest of verified issuer/subject/sid in the exact personal
staging receiver after its original current identity/account lookup. Use that
digest in place of the exact JWT digest only for the handoff key. Keep the original
exact-token default for callers without a verified session fingerprint. Keep all
fresh JWT validation, current account/provider/session checks, both Core workload
policies, consent, token age, one-use scope, expiry and post-I/O authorization.
No raw session or retained credential is sent to desktop/mobile; no authorization
decision is cached. General receivers and source start/resume are unchanged.

Validate both Mac and iPhone origin profiles with actual signature/expiry checks,
same-session refresh, different session, invalid sid and current revocation.
Validate the actual native transport forwards the new bearer and retains all six
fresh checks while omitting the setup call. Run applicable registry/transport
suites, Ruff, Pyright and exact-commit implementer review. Record local evidence
in the PR, merge under the owner's September 25 policy, and qualify/publish/update
only the existing staging receiver image. Core 747 is already deployed. Preserve
all config/identity/schema/recovery; repeat installed preparation measurements.

Recovery: retain receiver revision 40 and its immutable image. No production,
schema, account mapping, security-policy, capture/crypto or physical audio changes.
