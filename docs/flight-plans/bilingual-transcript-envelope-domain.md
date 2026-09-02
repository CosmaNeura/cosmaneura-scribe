# Flight plan: dormant bilingual transcript envelope domain

## Outcome and boundaries

- Problem and measurable outcome: define one strict provider-neutral representation that preserves
  English and Spanish source evidence, separate immutable Spanish-to-English attempts and
  creator-review evidence, and one deterministically derived English working transcript without
  exposing or storing it.
- In scope: frozen versioned domain models, bounded validation codes, non-persisted source and
  transient complete-input working fingerprints, one PHI-safe validation-error serializer,
  deterministic working-transcript construction, synthetic unit tests, ADR 0024, and this plan.
- Explicit non-goals: API routes; OpenAPI; repository or database changes; migrations or data
  rewrites; provider SDKs/calls; translation execution; creator-review service authorization;
  handoff changes; Core, desktop, Chrome, Zoom, or iOS changes; settings, infrastructure,
  deployment, cohort enrollment, activation, or PHI.
- Affected users, services, environments, and data classes: none. The module has no runtime call
  site and all test content is unmistakably synthetic.

## Contract pinned for this packet

- Language mode is exactly `en-US` or `en-US+es-US`; source locale is exactly `en-US`, `es-US`, or
  `unknown`; translation direction is only `es-US` to `en-US`.
- Language mode is canonical Scribe output in this dormant packet. A later Core-to-Scribe
  pre-capture configuration contract must carry the Core-authorized mode before start; a completed
  transcript cannot first assert it.
- Every source carries opaque Scribe-issued transcription-adapter, model-profile, and
  normalization-profile IDs. Provider speaker labels/IDs are replaced by normalizer-issued UUIDs.
- Optional `locale_confidence` is bounded `0..1` and signed zero is normalized. The accepted,
  versioned normalization profile owns threshold and conflict policy; the domain invents no numeric
  threshold. `unknown` always blocks.
- A translation attempt has outcome `succeeded` with content/no failure code or `failed` with no
  content/a bounded failure code. Attempt IDs are unique; translation-version ordinals are
  Scribe-issued and scoped to the current source segment/version.
- Review evidence has the stable review UUID from Core's future canonical review command, decision
  `accepted` or `rejected`, the exact source and translation versions, an opaque Core-authorized
  reviewer actor ID, and offset-aware time. It cannot predate or reference a failed translation.
  One exact translation version has at most one terminal decision; one current source version has
  at most one accepted translation.
- A working transcript has a stable Scribe-issued UUID per session and monotonically increasing
  Scribe-issued version. A transient canonical fingerprint operation binds the full source, every
  attempt, every review, and the internally derived object; input-order changes converge. No digest
  field is stored or serialized, and `note_ready` is computed and rejected.
- An accepted review selects its exact translation. Otherwise the highest translation-version
  attempt is current: absent, failed, unreviewed-success, and rejected-success evidence map to
  `translation_missing`, `translation_failed`, `translation_review_required`, and
  `translation_retry_required`, respectively. Older unselected evidence remains fingerprint input.
- Session projection precedence is quality (`source_overlap` or `source_locale_unknown`), then
  retryable translation work (missing, failed, or rejected), then creator review, then ready. A
  corrected source commits `source_received` and clears the old working pointer before a later
  projector chooses its state; no direct pending/review-to-quality edge is added.
- Raw Pydantic structured errors are internal and unsafe. Future routes must use the sole sanitizer,
  which caps issues and emits only allowlisted codes and schema-owned or sanitized locations.

## Risk and dependencies

- Tier and reason: Tier 2 because these models define future clinical transcript, translation,
  creator-review, and note-readiness semantics, although this packet is dormant and has no stored
  data effect.
- Dependency stack: micro-beta product contract PR #60; external-session stack through PR #64 at
  `b6c2f412eaf942b364d06075f59c76b58f6d3a95`; the separately governed
  `contracts/scribe-bilingual-transcript.md`; this domain packet; then additive receiver/persistence,
  creator review, backward-compatible handoff, bounded provider adapters, platform review, and
  client senders.
- Cross-repo order: governance defines the contract first. Scribe later receives and derives before
  Core or a client may depend on the representation. Capture clients and bots never receive the
  Scribe workload credential.
- Principal risks controlled here: silently discarded locale/provenance fields; overloading one
  content field as Spanish source and English note input; caller-selected identity, version, or
  readiness; inferred locale; an invented universal confidence threshold; stale/dangling evidence;
  provider self-approval; competing review decisions; PHI in representations/errors; incomplete
  lineage invalidation; and nondeterministic retries.

## Current deployed state

- Review baseline is Scribe PR #64 exact commit
  `b6c2f412eaf942b364d06075f59c76b58f6d3a95`.
- The deployed Scribe revision may lag repository `main`; this packet makes no live environment,
  schema, identity, or network claim.
- Existing `TranscriptCreate` has no source-locale, translation, review, working-version, or
  provenance contract. Existing handoff uses each segment's single `content` value as note input.
- Reconciliation decision: retain all deployed behavior. The module is not imported by a route,
  repository, worker, provider adapter, or handoff.

## Feature flag and schema sequence

- No flag is added because there is no call site. Existing external-ingest admission remains false
  by default and unchanged. Bilingual, translation, review, and note-readiness controls remain
  future false-default activation gates.
- No table, column, JSONB write, stored schema version, migration, backfill, or rewrite is added.
  The existing transcript JSONB is not declared an approved persistence design.
- The later working-transcript schema must admit `translation_retry_required`, enforce the same
  highest-attempt blocker choice and global precedence, and preserve the existing versioned-session
  transition graph. This packet adds no migration.
- A later receiver packet must allocate source, translation, review, and working identities and
  versions server-side, authenticate the existing platform workload, preserve the external-session
  drain rule, and demonstrate backward reads before any write.

## Rollout and promotion

1. Verify exact modes/locales/outcomes/decisions, strict and frozen input, source ordering and bounds,
   locale-confidence evidence, opaque profile IDs, attempt identity/version uniqueness, review
   chronology and referential integrity, accepted-review uniqueness, computed readiness,
   complete deterministic fingerprints, signed-zero convergence, and PHI-safe serialized failures.
2. Obtain independent review of the final commit. Hold it without route, merge, deploy, provider
   configuration, or environment change.
3. Merge the governing bilingual transcript contract before treating these values as cross-service
   authority.
4. In a separate receiver-first packet, add authenticated receipt and additive persistence while
   preserving the external-session drain rule and old transcript/handoff behavior. Identical retry
   must converge; conflicting version or terminal-review reuse must fail.
5. Separately add the admitted adapter/profile registry and measured `es-US` locale-accuracy matrix,
   translation execution, Core-reauthorized creator review, backward-compatible handoff, retention
   job, and each capture sender.
- Abort later activation on lost source/provenance, inferred locale, unsupported Spanish claims,
  untranslated Spanish entering note input, caller-supplied identity/version/readiness, cross-tenant
  or cross-creator disclosure, provider self-approval, non-idempotent retries, PHI in diagnostics,
  retention failure, or incompatible storage/handoff.

## Retention and recovery

- This packet persists no content or digest. A later design must enforce architecture ADR 0026's
  maximum fourteen-day retention for identifiable source-transcript and standalone-translation
  text, hand accepted English working content and exact versioned lineage to Core before purge, and
  retain the accepted working transcript under Core's governed supporting-artifact policy.
- Any post-purge content-free proof needs separate review and a keyed commitment. The source and
  working fingerprints here are transient, protected, unkeyed idempotency/retry primitives that
  expire with plaintext. Neither is an approved post-purge proof for low-entropy clinical text.
- Recovery is a normal revert of this isolated module and documentation. There is no data cleanup,
  migration reversal, session drain, provider deletion, or environment rollback.

## Completion

- Focused synthetic tests cover alternating English/Spanish speech; role/locale independence;
  profile-owned confidence; English-only and unknown behavior; missing, failed, rejected, and
  accepted translation paths; latest-attempt selection; mixed-blocker status precedence; multiple
  attempts; translation/review identity and version rules;
  review chronology; stale/dangling/competing evidence; overlap; strict fields; immutability;
  deterministic ordering and source/working fingerprints; stable working identity; computed
  readiness; and text-safe representations/errors.
- Ruff, strict Pyright, focused tests, relevant existing transcript/session tests, and
  `git diff --check` pass on the final substantive commit.
- Only the new domain module, focused tests, ADR 0024, and this flight plan change. No route,
  persistence, schema, generated contract, settings, infrastructure, or client path is modified.
