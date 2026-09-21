# ADR 0046 — Paired creator review receiver and reusable provider panel

Status: accepted for owner-approved local runtime integration; activation unapproved.

## Decision

Expose GET/POST `/v1/captured-sessions/{session_id}/review` in the existing Scribe
API behind its existing Entra app-only trusted-platform authentication. Normal
startup does not bind the required `CreatorReviewRuntime`; an explicit binding,
enabled runtime and tenant allowlist are necessary. No Settings, identity provider,
shared platform or deployed environment is changed.

The trusted platform reauthorizes the actual end user and asserts
`X-Scribe-Creator-Actor-ID`. The browser may not assert this authority. Scribe
compares that actor with the immutable recording creator and rechecks consent,
retention and source evidence. This adds a resource API, not another login path.
It does not establish that the current Core/BFF already implements this contract.

Status/source/working/review data are read from the existing captured store.
Before a source exists, return recording/Speech progress without transcript data.
After handoff, return metadata only. Response caching is prohibited. No Speech,
translation, SOAP call, automatic review or note handoff is triggered by reading.

An explicit accept/reject uses the existing tenant-scoped idempotency table and
immutable review writer within one transaction. The receipt binds actor, session
and the exact request. Recovery uses the persisted review ID and timestamp rather
than new values. Replays are reauthorized; changed content conflicts. This is
pre-handoff current-source recovery, not an indefinite historical receipt API.
No new migration or transcript storage structure is introduced.

The request edge decodes JSON UUIDs/enums but retains strict integer version
checks and forbids extra authority fields. Domain commands retain their existing
strict validation. Errors are bounded and raised outside protected driver handlers.

## Provider surface

The existing review workspace now also builds a reusable ES module and stylesheet.
The standalone or OS authenticated host supplies its existing authorized request
transport; the component owns no login, token or tenant/creator selection. It
shows Spanish original versus English proposal, unchanged English speech,
explicit accept/reject, current status, quality blockers and note readiness.
Speaker roles remain unassigned unless actual evidence labels them.

Unavailable responses clear protected display. An uncertain decision retains
its exact metadata request and key in memory for explicit retry. Disposal clears
state and ignores late responses. The host must dispose on logout/encounter change.
No automatic translation retry, note creation, signing or dashboard save is added.

## Limits and next integration

The original process-local ingest demo remains unchanged. This module is built
but not mounted in the real desktop/iPhone/CosmasOS shell. Actual shell transport,
browser/native interaction, durable pending-decision journal and real identity
are follow-on acceptance. Do not label markup/unit/API tests as device acceptance.

Recovery is to leave the runtime unbound/disabled and the existing storage intact.
There is no deployment, cloud migration, external provider call, cohort enrollment
or release approval in this packet. Later PRs require independent review and
must respect the change budget; generated contracts belong with their receiver.
