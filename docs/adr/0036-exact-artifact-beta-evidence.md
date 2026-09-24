# ADR 0036: Bind closed-beta evidence to exact artifact components

**Status:** Accepted for dormant synthetic pre-integration

## Context

The closed-beta runbook requires the actual backend, database, environment, desktop, iOS, and
translation artifacts given to testers to earn acceptance. A source-level test result or a result
from an earlier build cannot safely authorize a later candidate. Treating every artifact change as
invalidating every scenario, however, would create unnecessary reruns and make the gate difficult
to operate.

The evidence package must also remain non-PHI, support incomplete runs, and distinguish technical
readiness from the founder's explicit activation decision.

## Decision

Add a strict, dormant evidence model with seven independently fingerprinted components: Scribe
backend, Core backend, database contract, isolated environment configuration, signed/notarized
desktop package, signed TestFlight iOS build, and translation adapter/model contract. Component
fingerprints bind immutable digests and versions plus the synthetic environment scope. The model
contains no transcript, audio, person, appointment, invite, credential, URL, or free-form finding
text.

Each of the ten required closed-beta scenarios has a fixed set of client surfaces and artifact
dependencies. A scenario result records pass, fail, or blocked; a bounded failure code; synthetic
and no-PHI assertions; a digest of its separately reviewed evidence file; and fingerprints for
exactly those dependencies. Constructing a run fails closed if a binding is missing, extra, or
stale. A component rebuild therefore invalidates every dependent scenario while preserving
evidence for scenarios that do not depend on that component.

The run may remain partial with a pending or rejected founder decision. It is technically ready
only after all ten scenarios pass, the run is complete, no open severity-1 or severity-2 finding
exists, and no auth, creator-isolation, consent, data-loss, silent-recording, duplicate-note, or
PHI-boundary finding remains open. The schema rejects an `accepted` founder decision until those
conditions hold and until the decision occurs after the completed evidence window.

## Security and operational boundary

- Models reject unknown fields and input values are hidden from validation errors.
- Linkable synthetic identifiers, fingerprints, signing metadata, and timestamps are protected in
  string representations.
- Finding evidence is a bounded code and category, never a free-text payload.
- This contract does not collect evidence, read a deployed service, sign or distribute a client,
  change Auth/IAM, create a database table, alter configuration, invite a tester, or activate beta.
- All examples and tests use synthetic identifiers and placeholder digests.

## Consequences and next gates

The team can prepare local runners and client conformance checks against one deterministic
acceptance shape while stabilization continues. After integration, an approved evidence writer
must capture these fields from trusted build/deployment sources, store the manifest under the
approved evidence-retention policy, and provide the founder the complete assessment. Any actual
artifact or environment operation remains separately authorized.
