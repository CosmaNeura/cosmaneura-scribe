# Fresh recording startup request consolidation

Tier 2: initial recording admission and source-authority handoff. Owner: John.
This receiver change applies to the existing Scribe mobile and desktop beta
cohort. It uses the already deployed Core capability contract; no Core change,
app binary, database migration, dependency or API schema change is required.

The physical desktop build86 baseline measured 6.703–7.922 seconds from final Record
dispatch to native readiness across three valid trials. Physical iPhone71 took
9.095–11.560 seconds in one controlled synthetic trial, including conservative
phone-minus-Mac clock bounds. Input, native release and saved-recording UI were
confirmed. These timings exclude name entry and consent before Record. The
phone's native driver startup took approximately550ms; most delay precedes it.
The receiver improvements below have not yet been physically remeasured.

## Implementation and preserved boundaries

The fresh preparation-context branch now carries the exact singleton
`X-Cosmaneura-Prepared-Source-Start-Version: 1` capability into the existing
handoff. It previously dropped this flag, causing later source preparation to
repeat setup even when Core advertised the supported combined path.

For a fresh context, the receiver also uses the existing prepared-admission
operation when Core advertises the exact singleton combined native or desktop
metadata capability. It returns the same validated admission and recording
metadata with fewer Core requests. Missing, malformed, duplicated or unsupported
capabilities select compatibility before admission I/O. A dispatched failure
never falls back, retries or publishes partial admission.

Current account/identity snapshots, Core consent and locked authority checks,
scope matching, original issuance epoch, 15/25/30-second age fences, one-use
context handoff and cancellation/revocation checks remain. Nothing warms or
starts audio before consented Record. No source grant, permission or access
decision is cached. This is protocol composition, so no user-visible feature
flag applies. Release remains restricted to the existing approved beta receiver.

## Validation and release

Relevant API transport regressions, Ruff, Pyright and generated OpenAPI checks
run locally against the combined source. Owned fresh PostgreSQL fixtures verify
real endpoint reads, preparation, source handoff and committed revocation; the
native HTTPS fixture verifies the pinned Swift transport using synthetic offline
identity. No microphone, speech/model service or real patient is used in these
integration checks. Record exact commands/results in the PR. GitHub Actions
stays disabled under the repository owner's local-validation decision.

After the last substantive push, a non-implementer independently reviews the
exact commit and records findings/dispositions in durable PR evidence before
the authorized merge. Reconcile the currently deployed receiver's source,
immutable image digest, qualified runtime/configuration and dependencies before
promotion. Overlay only reviewed merged-source package modules onto the
qualified retained runtime; validate the whole package and unchanged receiver
entry/configuration. Publish an immutable source-labelled image and change only
the existing staging receiver image. Preserve its identity, secret references,
network/configuration, resources, cohort and preceding inactive revision.

Acceptance requires healthy receiver readiness, unchanged unauthenticated401
and no-store behavior, preserved runtime/configuration, and fresh physical
phone/desktop Record-to-native-ready trials after release. Do not claim the
five-second target is achieved from virtual tests or predicted work removal.
If devices are locked, continue source/build/review/backend validation and queue
physical UI work until accessible. Stop promotion on any authority, receipt,
scope, cancellation or image-provenance regression.

## Recovery

Record the exact current receiver image digest and revision in the release
baseline before any update. Recovery restores that digest on the same existing
staging receiver and rechecks its preserved configuration and readiness. Revert
the two composition changes in source if needed; Core retains compatibility
with the preceding receiver. Preserve recordings, consent evidence, transcripts
and notes. No data reversal, schema downgrade or new production promotion is
part of this change.
