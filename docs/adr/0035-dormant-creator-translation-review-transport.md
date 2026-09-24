# ADR 0035: Add a dormant creator translation-review transport contract

**Status:** Accepted for dormant synthetic pre-integration

## Context

The versioned Scribe domain already stores immutable Spanish-to-English attempts, creator review
evidence, and the derived English working transcript. The beta dashboard still needs a narrow,
testable contract for showing a provider the current Spanish source beside its proposed English
translation and for returning an accept or reject decision. Defining an HTTP route or changing
Core authorization while Auth, IAM, Zoom, and staging are stabilizing would violate the
pre-integration boundary.

## Decision

Add a pure creator-review projection over a trusted `ExternalTranscriptBundleV1`. It reports one
of four bounded states: not ready, review required, complete, or quality blocked. Protected source
and translated content is present only when the canonical working projection is
`review_required`. Each actionable item carries the exact source and translation lineage, fixed
`es-US` to `en-US` direction, speaker role, and timestamps needed for a side-by-side review.

The browser or client may submit only that expected lineage and an `accepted` or `rejected`
decision. It cannot supply the reviewer actor, review identity, or review time. Trusted Core code
must freshly authorize the authenticated creator, mint those authority fields server-side, and
then invoke the existing creator-review writer. The writer remains responsible for rechecking
consent, retention, current lineage, creator ownership, idempotency, and state transitions.

Review does not edit the source or translated evidence. Acceptance makes the reviewed English
translation eligible for the working transcript; rejection returns the segment to translation
work and requires a higher-version attempt. Unknown locale or overlapping source timing exposes
no actionable review items.

## Security and operational boundary

- Queue and decision models are strict and reject unknown fields.
- Protected content and linkable identifiers are suppressed from `repr()` and `str()`; validation
  errors hide input values.
- Queue construction performs no authorization and must only run after a trusted tenant-,
  practice-, session-, and immutable-creator check.
- The contract adds no route, OpenAPI operation, Core/Auth/Clerk behavior, migration, grant,
  provider call, setting, infrastructure resource, deployment, or live action.
- All evidence is synthetic, and the code remains unreachable from the running service.

## Consequences and next gates

The shared synthetic vertical can now exercise the same bounded review request that the limited
dashboard will eventually use, while proving authority fields are server-owned. Activation still
requires the stabilized Core base, creator-only object authorization on both list and direct read,
CSRF/session protections appropriate to the final transport, bounded rate limits, metadata-only
audit evidence, and exact deployed-artifact tests. Recovery is to leave the dormant projection
uncalled.
