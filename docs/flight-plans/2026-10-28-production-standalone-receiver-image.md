# Production standalone receiver image: sealed disabled build input

## Outcome and boundaries

- Problem and measurable outcome: prepare one reviewable, digest-ready image
  input containing the current standalone receiver and the exact receipt-gated
  production identity source. The source-only gate passes when all context
  bytes match its manifest and the disabled receiver returns 404 without
  constructing runtime resources or importing external identity code.
- In scope: the receiver Dockerfile, deterministic context preparation, static
  inspection, disabled ASGI smoke, documentation, and focused offline tests.
- Explicit non-goals: building or pushing an image; Azure, registry, network,
  DNS, TLS, ingress, database, Clerk, Core, client, cohort, or production
  changes; active configuration; credentials; protected data; deployment or
  promotion.
- Affected users, services, environments, and data classes: no running user or
  environment. Source and synthetic offline fixtures only; no PHI.

## Risk and dependencies

- Tier and reason: Tier 2 because this packages a future production identity
  and deployment boundary, although this PR cannot activate it.
- Irreversible or high-blast-radius decisions: none in this source-only slice.
  A later image promotion and active configuration are separate hold points.
- Dependency order: merged production native-policy source first; this image
  context second; reviewed production infrastructure/configuration and an
  immutable built artifact later. Each can remain dormant independently.
- Cross-repo contract/version: the image preserves the existing receiver/Core
  contract. Receiver deployment and acceptance precede production client
  selection. No sender contract changes here.

## Current deployed state

- Live evidence: there is no production Scribe receiver artifact, deployment,
  origin, or workflow. This PR performs no live read and creates none.
- Default-branch difference: current main contains a disabled receiver
  Dockerfile but no sealed image context or immutable artifact.
- Reconciliation decision: retain current deployed state; add dormant build
  preparation only. There is no production receiver drift to replace.
- Previous known-good artifact: N/A; no production receiver artifact exists.
  Staging resources and retained data are outside this change.

## Feature flag / release control

- The only packaged configuration is the constant disabled sentinel. It is a
  safety boundary, not a rollout flag. No user-visible behavior is introduced.
  Activation owner, cohort, and expiry are therefore N/A in this PR.

## Schema/data sequence

- N/A: no schema, migration, database read/write, seed, export, or data change.

## Rollout and promotion

1. Merge only after focused checks and independent final-head review.
2. Separately resolve and review both base-image digests. Prepare a fresh
   context from an exact clean merged-main revision and retained qualified
   identity checkpoint; archive its manifests as evidence.
3. In a separately authorized build lane, build once and record the resulting
   immutable image digest and materials. This PR does not run that lane.
4. Independently review production Azure identity/network/configuration and
   reconcile deployed state before any image push or app revision.
5. Founder-only promotion, disabled canary, active configuration, and the full
   mobile/Desktop/Core acceptance journey remain separate hold points.
- Abort threshold: any revision/base/source/hash mismatch, mutable base,
  unexpected context file, credential/config value, non-root change, runtime
  construction, identity import, or response other than the exact disabled 404.
- Founder production record: unavailable because no production Scribe
  deployment workflow exists. Agents never deploy production directly.

## Security and recovery

- The context includes only four receiver runtime modules, one fixed contract
  launcher, tracked Scribe API/build inputs, twelve hash-verified identity files transformed by the reviewed
  zero-fuzz policy, two manifests, and the disabled sentinel. No secret,
  environment value, certificate, active receipt, or protected data is copied.
- Pre-activation recovery: discard the generated context or local image and
  revert this source PR. No running service or data is touched.
- Post-activation recovery is out of scope: a future runbook must disable the
  receiver profile first, preserve queued/custodied data, and roll back by
  immutable digest without changing client environment namespaces.
- Observation window and destructive cleanup: N/A; no activation or cleanup.

## Completion

- Required evidence: exact final source SHA; focused test/lint results; a real
  context prepared from the retained qualified checkpoint; checker output with
  manifest hashes, disabled 404, no runtime construction, and no identity
  import; change budget; and independent review after the final push.
- Follow-up: owned production infrastructure/configuration, an independently
  proven image build/provenance lane, immutable artifact promotion, and live
  acceptance. None may be represented as complete by this PR.
- Contract records: this flight plan and the standalone-provider README.
