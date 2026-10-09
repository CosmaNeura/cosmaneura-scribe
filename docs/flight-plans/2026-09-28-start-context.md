# Remove duplicate startup registry reads

Owner: MCD operational beta owner. Tier 2: authentication orchestration.
Scope: the existing provider Core transport; no identity, permission, consent,
source decision, lease or token lifetime changes. This continues the approved
record-readiness performance work. No rollout is included in this source PR.

## Behavior and preserved authority

Each native startup operation negotiates its own fresh Core context. Negotiation
currently reads registry identity/access to construct the user-token exchange,
then immediately reads the same selection again before sending that exchange.
There is no intervening await or remote work between those reads.

Pass the just-validated context directly into the private dispatch helper. Its
only two callers immediately precede dispatch with `_context`; no stored cache,
shared authority or optional bypass is introduced. Every Core HTTP operation
still has a fresh registry check before dispatch and after its complete response.
The normal `_send` wrapper retains the same preflight check for all other paths.
The helper checks that the transport is still enabled. Each subsequent native
request negotiates anew; request-local tokens/interaction/turns stay isolated.

This removes one registry snapshot per operation: four across lease issuance,
chunk reservation, source prepare and source authorization, without changing
the twelve Core HTTP calls in that sequence. It also applies to opening and
resumes after long pauses. No physical time reduction is claimed before rollout
and measurement. It is separate from PR189's eligible warm-resume optimization.

## Verification and recovery

Exercise the actual transport with offline Core responses: exact before/after
check sequence, all six check positions for a three-request source start,
revocation and selection change at each, concurrent requests, transport closure,
lost responses and original idempotency keys. Reuse the real frozen identity
verifier with an isolated socket-only PostgreSQL fixture for native receiver
prepare/authorize revocation checks. Run lint, types and implementer review of
the exact committed bytes. No patient data, device microphone or external Core
service is used by these tests.

The existing immutable receiver-image rollout is the release control, owned by
the beta owner for the staging cohort until acceptance/candidate replacement.
Reconcile current source, digest and configuration before a later rollout;
retain newer Core/Session Prep/CosmaBot and unchanged workers. Restore the prior
approved receiver image to recover the duplicate-read behavior. No schema,
configuration, credential, native app rebuild or saved-recording/key reset is
required for this server-only change.
