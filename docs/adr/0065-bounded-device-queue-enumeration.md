# ADR 0065: Bound audio memory while enumerating the device queue

Status: Accepted for local implementation; native delivery requires a new client build.

## Context

Restore, drain and completion need chunk state, reservation identity, retries and
receipts. Full enumeration previously retained every audio envelope, including
an additional clone in CaptureQueue. A three-hour mono recording has 1,080 chunks
and about 346 MB of audio before storage encoding. Loading all those payloads
defeats the uploader's existing two-worker bound and burdens encounter reopening.

## Decision

Reuse the encrypted native plugin, IndexedDB and desktop SQLite stores. Add a
required metadata enumeration method to the internal queue storage interface.
Authenticate/decode/validate each complete record before projecting state without
its envelope. Enumerate keys/digests first, then read one record at a time. Restore,
drain and completion consume metadata; workers fetch current full records through
the existing get/CAS path with unchanged upload concurrency and receipt rules.

The iPhone opening read still verifies custody and is consumed once under the
same exclusive flow lock. It now retains metadata. Gets, writes, full diagnostic
lists and release discard it; later metadata reads return to native storage.
Creator/workspace/session namespaces, abort checks and server reauthorization
remain enforced. No persisted index, cache, record format, key or migration changes.

The desktop scanner clears each opened buffer when advancing, closing or failing.
Enumeration is not a transactional snapshot across asynchronous reads; each
record is freshly authenticated. Missing/corrupt records fail the scan, and
mutations continue to require the existing revision CAS. No database transaction
or SQLite payload cursor remains open across an await.

Full diagnostic list methods remain available but are not used for operational
restore/drain/completion. Metadata consumes memory proportional to record count;
audio memory is proportional to bounded per-record processing and active workers.

## Validation and limits

Exercise maximum-sized chunks, metadata projection, one-at-a-time native reads,
corruption rejection, original envelope retention, scanner cleanup, two-worker
draining and the existing device recovery/scoping integration tests. Measure an
accelerated 1,080-chunk queue separately; this is not native RSS or device latency.

This change does not promise faster disk scans: existing native list still
authenticates stored records, and the JS bridge still transfers each selected
record. Disk headroom, continuous source renewal, screen-lock/background capture
and long-text processing remain separate prerequisites for three-hour visits.
Recovery is a client source revert; encrypted records and keys stay compatible.
