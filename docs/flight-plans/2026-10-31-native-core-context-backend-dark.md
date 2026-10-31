# Native Core context backend — Tier 2

Prepare a default-off receiver backend against the exact Core provider-context
contract in `8eebdb26df64202d1a240681769d639ad2379463`. The receiver's current
startup always requires a separate SELECT-only OS registry and its five tables,
even though current provider authority and encounter catalog already live in
Core. This source removes that dependency only when the host explicitly selects
`authority_backend="core-provider-context-v1"`; the default remains `registry`.
The exact merged Scribe base is `629633c6571104dc485a75f111535cc26d781d01`.

The new mode requires the existing receipt-gated production organization profile,
canonical nonzero Core audience scope and a real qualified Clerk verifier. It
rejects database host/name/reader values and never creates a SQL engine or
requests a PostgreSQL token. The existing staging configuration, identity
projection, registry code and legacy `receiver.py` bytes remain unchanged.
Only the runtime selector and sealed image input list select/package the new
class. Both default configuration templates are disabled; no listener starts.

Each account lookup calls the fixed HTTPS Core context path with the unchanged
Clerk session token in Authorization and the independently acquired workload
token in its separate header. The existing signed production issuer, audience,
organization, native origin receipt and real sid checks stay in force. Core
enforces its dedicated singleton workload caller/audience/tenant/role and current
reviewed provider authority. Replies must be bounded, closed, no-store, current,
nonce-correlated and have an exact connection digest. Missing/dark Core authority,
denials, ambiguous or changed mappings and unexpected replies deny without
registry fallback or retry. Current context is rechecked around native operations
and catalog/selection reads; no permission is cached across those calls.

Catalog comes only from Core and returns Production metadata. This first mode
supports Core catalog, existing encounter list/lookup/selection and the existing
native-facade reads. Creation, patient matching and private-note mutation through
`/encounters` are unavailable and never advertised. Full capture/service-mutation
parity is not qualified: inherited service calls still require their existing
Core authorization/configuration gates, and this source does not enable them. The existing receiver `encounter_creation_enabled` switch
still gates the inherited native-facade dispatch and remains off in templates;
turning it on for existing-encounter capture does not add a create implementation.
Core capture/encounter/workflow gates remain separate, default-off owner decisions.

Recovery scope is newly namespaced to this explicit backend and bound to the
environment, box, reviewed provider-link ref and connection digest. It is not a
mapping or authority input. A change of backend does not automatically adopt
legacy registry recovery IDs or recordings; that recovery/cohort decision stays
with the owner. Real practice, provider mappings, attestations, Clerk settings,
cohort members and recovery image digests are not invented by these fixtures.

Review this final exact source commit independently before publication. Focused
offline checks use the retained hash-qualified Clerk verifier, invented RSA
tokens and mock Core replies. They cover zero engine/PG-token startup, unchanged
legacy/staging behavior, separate tokens, current context before/after native
reads, post-read revocation, invalid/dark Core replies and sealed source inclusion.
No production data, credentials, Azure mutation, schema change, new resource,
dependency-lock change, registry/image publication or runtime activation occurs.

Deploying the receiver before the reviewed Core context source and explicit Core
gate would leave this new mode unavailable; it must fail closed. The previously
held receiver image digest does not contain this new backend and is not evidence
of its readiness. Strict reuse of the three Core containers and existing public
AI/PG transport topology still need their own source rungs. No extra Container
App/job or private endpoint is introduced here.

Before any deployment, discard/revert this source commit. After separately
approved deployment, set receiver `enabled=false` and retain the qualified prior
image. Do not silently switch to registry or alter its IDs as recovery. Stop new
capture and drain accepted work under the existing capture recovery procedure;
retain recordings, mappings, schemas and audit data. Core context can separately
be disabled on its existing API projection without changing Session Prep.
