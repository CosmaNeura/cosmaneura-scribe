# ADR 0024: Define a provider-neutral bilingual transcript envelope before receipt

**Status:** Accepted (domain remains dormant)

## Context

The external-transcript session stack can represent a session whose first durable clinical artifact
is a completed asynchronous transcript. It does not yet define the bilingual artifact that a future
receiver may accept. The existing transcript model has one `language_code` and one `content` value
per segment, and the existing handoff treats that content as note input. Reusing that value for both
Spanish source text and English note input would either lose the immutable source or pass
untranslated Spanish to an English note pipeline.

The beta contract requires a manually selected `en-US` or `en-US+es-US` mode, phrase-level source
locale, immutable source text, separate Spanish-to-English translation and creator-review evidence,
and a derived English working transcript. Provider payloads, participant identity, resource
identifiers, and readiness assertions cannot become part of that contract.

## Decision

Add a versioned, provider-neutral domain module with no route or persistence integration. Every
model is strict, frozen, rejects unknown fields, and hides input in rendered validation errors.
Raw Pydantic structured errors remain internal and unsafe because they can retain input, context,
URLs, messages, and caller-selected location tokens. Any future route must serialize a validation
failure only through `serialize_external_transcript_validation_error`, which emits capped,
allowlisted codes and schema-owned or sanitized locations. Text is omitted from representations.

### Source transcript

`SourceTranscriptV1` records schema version `1.0`, the language mode, a source-transcript version,
bounded duration, opaque Scribe-issued transcription-adapter, model-profile, and
locale-normalization-profile identifiers, and deterministically ordered source segments. Each
segment has a stable UUID and version, a normalizer-issued opaque speaker UUID, advisory role,
source-relative timing, exact source text, source locale, and optional `0..1` locale-confidence
evidence.

The only modes are `en-US` and `en-US+es-US`; the only source locales are `en-US`, `es-US`, and
`unknown`. `es-US` is the deliberately narrow US-Spanish beta profile. English-only mode rejects a
Spanish segment. Either mode accepts `unknown`, which always blocks note readiness. Locale is never
inferred from speaker role or confidence inside this domain. An admitted, versioned normalization
profile owns its provider field, minimum-confidence, and conflict rules. This module records the
profile and bounded confidence evidence but invents no universal threshold. Signed zero is
normalized so semantically identical confidence values have one canonical representation.

Provider speaker labels and IDs must be replaced with normalizer-issued opaque UUIDs before model
construction. Raw provider or model names and identifiers are represented only by internal opaque
adapter/profile IDs. URLs, provider resources, names, dates of birth, tenant or actor claims, and
unknown fields are rejected.

The language mode and source versions in this packet are canonical Scribe domain output, not caller
authority. Before bilingual capture is enabled, a later versioned Core-to-Scribe pre-capture
configuration contract must carry the Core-authorized mode, and Scribe must persist it before start
authority. The later receiver must allocate source-transcript versions monotonically within the
Scribe session; a completed-transcript caller cannot select them.

The canonical source fingerprint binds contract version, mode, source version, opaque profiles,
duration, ordered segment provenance, and exact content. It is only a non-persisted domain primitive
for a future idempotency operation. It is not a post-purge provenance proof.

### Translation and review evidence

`TranslationRecordV1` is one immutable attempt for one exact current Spanish source-segment UUID and
version. Each attempt has a unique Scribe-issued translation UUID and a Scribe-issued ordinal version
scoped to that source segment/version. Its direction is always `es-US` to `en-US`. Outcome is exactly
`succeeded`, with nonblank English content and no failure code, or `failed`, with no content and one
bounded failure code. Opaque translation-adapter and model-profile IDs and an offset-aware creation
time record provenance without exposing vendor resource identifiers.

`TranslationReviewEvidenceV1` is separate immutable evidence. It has the stable opaque review UUID
from Core's future canonical review command, binds the exact source and translation IDs/versions,
records decision `accepted` or `rejected`, an opaque Core-authorized reviewer actor ID, and an
offset-aware review time that cannot predate the translation. A review can reference only a
successful current translation. There is at most one terminal review decision per exact translation
version and at most one accepted translation for a current source-segment version. Competing
acceptance, opposite decisions, stale references, and dangling references are rejected before a
working transcript can be built.

A later service operation, not this model, must reauthorize the authenticated session creator before
creating review evidence. Capture clients and provider workers cannot self-approve. That operation
must make an identical replay converge on the existing review while treating a different terminal
decision as a conflict. Once accepted, a translation cannot be replaced in the micro-beta without a
new source-segment and source-transcript version.

### English working transcript

`EnglishWorkingTranscriptV1` has a stable Scribe-issued UUID per session and a Scribe-issued
monotonically increasing version. Its derivation fingerprint binds that identity/version and the
complete canonical current source, every translation attempt, and every review input. Consequently,
even an unselected attempt or review change stales the working version; input-order changes alone
converge. No input schema accepts `note_ready`.

- An English segment contributes its exact source text without a translation reference.
- A Spanish segment contributes only a successful current translation with accepted review.
- An unknown locale, absent or failed translation, or successful translation without accepted
  review produces an unresolved segment and a bounded blocker.
- A source overlap is a blocker. A dangling or stale reference, conflicting review, or competing
  accepted review invalidates the bundle and produces no working transcript.

Working segments preserve source UUID/version, opaque speaker UUID, advisory role, timing, locale,
and any selected translation UUID/version and review UUID. The serialized `note_ready` value is
computed only from the derived blockers and resolutions.

The canonical working fingerprint binds the complete derived object and its derivation fingerprint,
including working and source versions, source/translation/review references, English content,
resolutions, and blockers. Handoff and note retries can therefore pin the exact immutable working
version rather than rebuilding from different evidence.

### Retention boundary

This packet stores nothing. A later persistence/handoff design must enforce architecture ADR 0026's
maximum fourteen-day window for identifiable source-transcript and standalone-translation text.
Before purge, Core must receive the accepted English working content and its exact versioned
lineage. The accepted working transcript then follows Core's governed supporting-artifact retention,
while the clinician-approved English note remains the clinical system of record.

No digest or tombstone field is added here. The source and working fingerprints are transient,
protected, unkeyed idempotency/retry primitives; they expire with the corresponding plaintext and
cannot be exposed. Any future content-free post-purge proof requires a separately reviewed
keyed-commitment design. Neither fingerprint can satisfy that requirement.

## Consequences

- No API route, database shape, repository behavior, Alembic migration, OpenAPI contract,
  environment setting, provider call, client, or feature flag changes.
- The current `Transcript`, transcript receiver, and platform handoff remain unchanged. Nothing can
  construct this domain through an application request in this packet.
- A later receiver/persistence packet must allocate identities and versions server-side, authenticate
  the existing platform workload, consume Core-authorized session context, preserve identical replay,
  reject conflicting reuse, enforce retention, and prove old-row compatibility.
- Later packets must separately add bounded adapters, creator review, backward-compatible Core
  handoff, and false-default activation. Desktop, meeting-bot, browser, and iOS clients still never
  call Scribe directly.
