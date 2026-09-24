# ADR 0041: Creator-only persisted bilingual review service

**Status:** First local increment of the owner-approved runtime integration.

## Decision

Add `CreatorTranscriptReviewService`, disabled by default, over the existing
repository and immutable creator-decision writer. Its inputs are trusted,
freshly verified tenant/actor context. It does not authenticate users or accept
identity from an HTTP body. No public route, bootstrap grant or environment
setting is added in this increment.

The repository reader verifies the creator before returning protected evidence,
locks consent then the session, checks current consent/retention, and loads the
current source, attempts and human reviews. It reconstructs the canonical working
view and checks its fingerprint/version/status against the published record.
It never publishes or repairs on read. Missing, stale, inconsistent, expired or
revoked evidence is unavailable. The metadata-only read audit commits before the
application returns the view. This is a snapshot at transaction completion, not
a promise that a future revocation can retract a response already returned.

The review queue preserves Spanish source and the proposed English translation.
An explicit creator decision uses the existing exact-lineage writer, including
its commit-recovery behavior. The future HTTP receiver must supply a durable,
retry-stable review ID and timestamp; this service does not create an idempotency
journal or silently create a new decision after an uncertain response.

All application failures use one opaque error with no retained raw exception
context. Cancellation still propagates. A schema-valid translation is not an
automatic approval, speaker-role inference or claim of clinical fidelity.

## Boundaries and recovery

Tier 2: protected transcript access. No schema, auth, cloud, Core, staging,
provider configuration, live inference, push, PR or deployment change. Keep the
service unconfigured for recovery; the existing schema and saved data remain.
OpenAPI is regenerated and must stay unchanged because no route is registered.

The encrypted-store/Speech-normalizer seam now compares this application read
against independently read PostgreSQL working rows after reopening the pool.
Services and identities in that test are offline fixtures. Tests also exercise
wrong creator/tenant/session, no publish-on-read, explicit decision/retry,
revocation, expiry, corrupt projection and cancellation/error handling.

## Remaining integration

This closes the application-level creator read/review seam, not the full runtime
packet. Captured Azure provenance must be admitted without relabeling it as an
external transcript. Translation dispatch/bootstrap, the authenticated HTTP
receiver and its durable idempotency envelope, actual clients, combined migration
graph, live acceptance and signed release remain. No additional local approval
is pending for the already approved runtime packet. Independent review is still
required before a later PR/promotion; no cross-task review was solicited here.
