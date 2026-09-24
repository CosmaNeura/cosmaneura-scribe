# ADR 0042: Dormant captured-audio bilingual storage

**Status:** Owner-approved local expand rung; not deployed or runtime-enabled.

## Decision

Permit a new configured `chunk_upload` session to use the existing normalized
source, translation, creator-review and English working-transcript tables. Keep
the same session identity and actual captured provenance. Do not represent Azure
capture as an `external_async_transcript`, create a duplicate imported session,
backfill existing recordings, or introduce a second transcript store.

Revision `0019_captured_bilingual` follows local `0018_translation_jobs`.
Configuration is complete and immutable at insertion: creator, language mode,
contract and source profiles. Newly configured captures use `azure_ai_speech`,
`azure_phrase_en_es_evidence_v1` and the local adapter-policy profile
`azure_fast_transcription_en_es_v1`. The last identifier denotes the reviewed
English/bilingual fast-transcription configuration, **not a vendor model-weight
version or proof of service deployment**. Runtime admission must bind the actual
selected adapter/configuration to it. The Spanish/English phrase normalizer
preserves unknown locale and speaker roles; it does not infer clinical roles
from language. Other providers/profiles require a separately reviewed expansion.

Configured captures start `created`, then traverse `capturing` → `uploaded` →
`processing` → `source_received`. They cannot take the imported-source shortcut
or jump directly from processing to a ready transcript. The existing bilingual
state machine follows. Failures require attributable terminal evidence and cannot
restart a failed configured session. Capture leases, chunks, upload grants,
audio keys, reservations, finalizations and transcription jobs may belong to
these sessions. Legacy `transcripts` and `transcript_deliveries` remain prohibited
for them, so those writers cannot bypass the normalized/review path.

The mode predicates in the existing source, translation, review, projection and
encrypted-job database guards admit both configured modes. All other predicates
remain unchanged, including immutable exact source/profile lineage, current
source/retention, Spanish-only translation inputs and creator review. The
encrypted-job guard retains its current-consent check. No grants, RLS changes,
security-definer function, route, worker registration or environment setting is
added. The existing application's external and legacy capture queries continue
to exclude configured capture, deliberately leaving it dormant.

## Preservation and recovery

This is Tier 2 storage work authorized only in a new disposable local database.
It changes constraints/functions, not existing row values. Frozen prior SQL is
included in the revision, with exact single-site predicate substitutions; it
does not import runtime code or rewrite an unknown deployed function body.
DDL takes bounded table locks and validates all constraints transactionally.

Operational recovery leaves the new schema dormant. Reversal is rejected outside
a database whose name ends in `_test`, and in that disposable database is rejected
while any configured capture exists. Unused reversal restores the prior guards;
reapplication is tested. This is not production rollback or permission to remove
used data. Before promotion, reconcile the separately evolved integration graph
and rehearse its actual schema/functions, grants, locks and application versions.
No shared database, other repository, live service, cloud or deployment changes
are authorized here.

## Acceptance and remaining work

Tests use invented data in real disposable PostgreSQL, including a restricted
non-owner role. They compare all existing table-row hashes and relation/function
privileges across expand/reversal; exercise configured insertion, immutable
provenance, capture-only children, tenant isolation, legacy-query exclusion,
terminal failures, source → translation → explicit creator review → ready working
projection, encrypted-job consent/source/retention fences and used-schema recovery
refusal. The SQL translation/ciphertext fixtures are **not provider or encryption
qualification**; earlier actual-adapter/encrypted-store tests remain separate.

This packet makes the storage model capable of representing the correct path.
It does not establish that bytes were recorded, a worker owned a valid lease,
Speech recognized those bytes, a model translated them, or a native user signed
in. Next connect trusted capture admission and leased Speech-result persistence
to this schema, then durable translation dispatch and the authenticated review
receiver. Preserve consent rechecks and exact commit/retry recovery in that
composition. The standalone/OS client, physical-device, real-service and signed
release acceptance gates remain open.
