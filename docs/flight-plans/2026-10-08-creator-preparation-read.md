# Creator preparation metadata receiver

Tier 2: current creator/consent and capture metadata. Owner-directed Scribe
startup latency work, with September 25 local validation and merge authority.

The preceding Core sequence requests creator review three times, public key once,
and capabilities once. Add a closed GET receiver returning those same three
receipts in one response. Preserve existing routes for older consumers. No
identity, consent policy, schema, cohort or environment changes.

Authorize the current configured creator/consent before external public-key I/O.
Release that transaction before fetching the key and closing its provider. Then
recheck current creator/consent, read review and capability usage and assemble the
complete response within one transaction. Never return partial metadata; this
response does not authorize source startup. Use the same capability projection
as the existing endpoint. No key or permission cache is added.

Qualification uses task-owned synthetic PostgreSQL, real session/consent gates,
and synthetic key providers. Cover old/new receipt equivalence and database work,
wrong creator/tenant, disabled cohort/protocol, revoked consent before and during
key I/O/close, key failure, cancellation, no locks during key fetch, and key
resource closure. Run creator review/recording and capability regressions. Generate
OpenAPI; record the final tested/reviewed commit and exact results in the PR.

Receiver-first rollout: merge and qualify this additive receiver before a Core
consumer selects it. Release through the existing approved immutable staging
methodology, preserving configuration, identity and schema. Do not release a
consumer to an older receiver. Recovery restores the preceding Core consumer
first, then the preceding Scribe receiver image if necessary. Production and
physical audio remain outside this work. The installed 5–7 second target remains
open until release and measurement.
