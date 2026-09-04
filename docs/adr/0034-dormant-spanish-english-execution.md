# ADR 0034: Add a dormant Spanish-to-English execution seam

**Status:** Accepted for dormant synthetic pre-integration

## Context

The versioned external-transcript stack can retain source evidence, immutable translation attempts,
creator review decisions, and a canonical English working transcript. It does not yet define how a
translation provider is invoked, and the existing note-engine handoff mapper accepts only the
legacy transcript model. Connecting a provider or a new delivery path while Core authentication,
IAM, Zoom, and staging are stabilizing would create an unsafe integration dependency.

The micro-beta contract is narrower than general multilingual translation: the user manually
selects bilingual English/Spanish capture, Spanish source segments are translated to English, a
creator reviews each successful translation, and only the resulting English working transcript is
eligible for note generation. Automatic language detection and English-to-Spanish output are out
of scope.

## Decision

Add a provider-neutral adapter protocol for exactly `es-US` to `en-US`. The adapter sees only the
source text and fixed locale direction; it does not receive tenant, practice, patient, encounter,
session, actor, or source-segment identifiers. A caller supplies a protected, durable reservation
that pins the translation UUID, current source and segment versions, expected prior translation
version, authoritative Spanish locale, and source content.

Adapter and model-profile identifiers must be bounded safe identifiers before any provider call.
A successful adapter result becomes the existing immutable `TranslationAttemptCommand`. Provider
rejection, timeout, unavailability, or an invalid response becomes a failed command with one
bounded code; raw provider details and clinical text are not retained in an exception. Cancellation
is not converted into a provider failure.

The adapter call occurs before the existing transaction-owning writer. Database reconciliation
reuses the exact completed command and therefore never repeats provider work. A resumable runtime
must durably retain that completed command before attempting its database commit. This packet does
not add that job store or claim production resumability.

Add a pure mapper from a note-ready `EnglishWorkingTranscriptV1` to the existing
`MasterTranscriptDeliveryRequest`. It fails closed while any blocker remains, maps speaker roles to
the established note-engine labels, and sends only the canonical English segment content. It does
not add a route or make a network call.

## Security and operational boundary

- Manual segment locale is authoritative; no language detector is introduced.
- Existing persistence rechecks consent, live retention, source lineage, and creator identity.
- Tests and the shared conformance fixture are synthetic and contain no names, DOBs, audio, or PHI.
- No logging, route, OpenAPI operation, authentication logic, setting, secret, provider SDK,
  migration, grant, managed identity, environment value, deployment, or live action is added.
- The new code remains unreachable from the running service.

## Consequences and next gates

The in-process contract can now prove the intended chain: normalized bilingual source, one bounded
Spanish-to-English provider outcome, creator acceptance, canonical English projection, and the
existing note-engine request shape. Desktop and iOS can use the checked-in fixture as a common
normalized-source acceptance target without depending on Core or staging.

This is not translation-provider readiness. Activation still requires a selected provider and
model profile, an approved synthetic accuracy/latency evaluation, private connectivity and secret
handling, a durable reservation/completed-command job boundary, bounded telemetry, least-privilege
identity activation, Core creator reauthorization and idempotency, exact-artifact end-to-end
evidence, and an explicit founder decision. Recovery is to leave the seam uncalled; no stored data,
schema, or deployed resource changes are created by this packet.
