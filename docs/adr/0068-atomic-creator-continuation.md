# Atomic creator recording continuation

Accepted 2026-09-30. Tier 2: existing creator, consent and capture-lease
authorization are preserved across a new composite transaction. No schema,
principal, cohort, media profile or consent-state change is introduced.

## Problem

A paused recording previously needed sequential capability, lease-renewal and
reservation requests before its audio source could restart. At 900 ms per
round trip that consumes 2.7 seconds before device startup. Combining requests
must preserve the original pending operation and recover the same capacity
after a committed response is lost.

## Decision

Add creator-only `POST /v1/captured-sessions/{session_id}/continuation-window`.
The closed request carries schema 1.0, microphone or mixed channel, the first
sequence number, previous lease identity/generation, and immutable renewal and
reservation keys. The outer `Idempotency-Key` binds the complete request and
trusted creator. Tenant and creator remain outside the request body and use
the existing verified workload and configured-creator gates.

One repository transaction claims the outer intent and ordinary component
identities, checks current creator/consent/retention and session eligibility,
renews the lease and creates the reservation batch. Fresh capacity accounts
for existing canonical positions plus unused aggregate and object budgets.
Repository checks under the session lock remain authoritative; any conflict
rolls back renewal, reservation and all new claims together.

Both component claims precede consent/session locks, matching ordinary route
lock ordering. This avoids a composite holding the session while waiting on
a reservation key held by a caller waiting for that same session. Capability
usage is only a candidate count before those locks; a concurrent capacity
change safely rejects the complete transaction.

A committed ordinary reservation batch freezes the count for every retry.
The server never recomputes a smaller count from depleted capacity after a
successful response is lost. Receipts are the unchanged ordinary lease and
reservation DTOs, so ordinary component recovery and the composite recover
identical IDs. Core must derive component keys exactly as its ordinary
renew/reserve forwarding does. Each receipt response still passes fresh
authorization, including after consent revocation or session completion.

Existing persisted media/profile information is retained by the native owner;
the returned exact lease and reservations bound the new interval. The new
endpoint does not return or change dynamic capabilities. Old pending native
continuations keep their existing recovery path. No source starts from a
partial or unpersisted reply.

## Consequences and recovery

The paused Resume preparation needs one network round trip. This does not
alone prove physical-device startup below four seconds; device measurements
remain required. Existing continuous in-recording renewal remains unchanged.

Deploy Scribe and Core receivers before native consumers. Recover by retaining
the additive receiver while switching new native intents back to the legacy
path. Preserve existing encrypted pending intents and component receipts; never
reset saved recording state. No migration, backfill or destructive cleanup is
needed. The paired rollout is recorded in the continuation flight plan.
