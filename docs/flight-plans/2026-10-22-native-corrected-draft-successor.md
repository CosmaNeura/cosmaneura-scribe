# Native corrected-transcript draft successor

Risk: **Tier 2**, deliberately scoped to clinical-source selection and the
additive encrypted local journal contract. Owner: founder; intended initial
cohort: providers' own beta visits. This plan does not activate a cohort or
change Scribe/Core staging, installed applications or configuration.

## Current main integration

The isolated integration uses Scribe main
`6cabbe5665490682240b336920b0107fba186b16` (merged PR379) and the reviewed
successor endpoint `9526055abc95fb74c53f4c9452b01c6db53d3c51`, both descended
from `d53be753925d6f55a1dc2199317c7add7d16ff38`. Their merge had no conflicts.
The successor product files and PR379 native-auth/application product files
remain byte-identical. The integration adds a regression to the existing
compiled-provider application harness and this attribution; it is local only.

## Change and invariants

- Preserve every submitted original/successor schema, source and client key.
- Append one explicit higher-version, same-session/same-working-ID successor
  only after durable CAS confirmation. Retain note/transcript history.
- Remove the previously displayed draft when its transcript version advances.
  Failed preflight/CAS leaves the updated-source screen, never the old editor.
- Match the selected key, source and schema after asynchronous receipt parsing;
  reject late replies, wrong sessions, changed lineage and superseded sources.
- Opening and automatic recovery remain GET-only. Only an explicit successor
  retry, after paired current `not_prepared` reads, reuses its retained key.
- Unconfirmed saves and retained unsaved edits block append/retry. Do not apply
  older edits to the replacement. Current clinical review is still required;
  preparation or correction alone never makes a note Session Prep eligible.
- Reconcile only exact terminal older saves with a fresh ready, same-lineage
  newer review/note pair and full pending-identity CAS. Without a matching
  editor, preserve a valid retained queue byte-exact. With a matching readonly
  editor, retain its latest old-source values (including reverts) before
  remount; those values may supersede the staged queue. Retain original unsaved
  fields for a closed save when no later buffer exists. Never treat a historical
  outcome as current-draft or review authority.

## Local acceptance and limits

Use real encrypted-journal adapter/CAS in memory and actual Core wire parsers.
Exercise correction v1→v4→v7, lost-CAS response/reopen, same-key explicit recovery,
source advance, late replies, duplicate clicks, malformed/full history and
pending edits/saves; automatic/manual saved/closed outcomes; mismatched/pending
receipts; later buffer and unstaged/reverted field retention; late request
replacement during reads/CAS; same-source handling; and legacy no-intent
read-only edit discard followed by ordinary template selection. Surface and
controlled-textarea fixtures prove command/state behavior; separately
inspect actual rendered controls in the offline synthetic browser fixture.
Run applicable capture TypeScript checks and lint. No hosted CI, live API,
recording/upload, private journal, model, note write or deployment proof is
inferred from these tests. Core may perform more than one model call on a manual
retry; there is no exactly-once inference claim.

The combined application regression holds a synthetic preparation reply while
the session becomes unavailable, deliberately signs the same simulated owner
out and in, and reopens the visit with the actual journal adapter. It verifies
the retained original/successor key and history, one durable successor append,
no automatic prepare/save, and no display of the old request's late reply.
The session owner and secure-store plugin are offline fixtures: this does not
verify live account authorization or native encryption.

Actual integration validation: 63 successor/journal tests in two files and 26
compiled-provider application checks pass; provider build, full capture
typecheck and affected-file lint exit zero. Commands, timestamps, source and
bundle hashes are retained locally under
`build/session-prep-integration-validation/`. The initial harness run exposed
a cross-VM JSON-prototype comparison mismatch; only that fixture assertion was
corrected, with its failure retained. PR379's 17 Swift checks are prior evidence
for unchanged native source; they were not rerun or relabeled as this execution.

## Deliberate recovery

Before a successor append, existing root-only read recovery is unchanged. After
append, retain encrypted metadata and use a successor-capable client: the old
build-97 closed journal reader rejects the extension. Do not install an old
client, reset private storage, relabel old content or silently clear a pending
save as rollback. Exact terminal past-outcome recovery is permitted only under
the source, request and CAS fences above; uncertain/pending or mismatched old
saves remain retained and can block preparation. Saved notes/history are never
discarded, old fields are never rebased, and recovery never replays a save.
No backend database migration or destructive cleanup is part of this change.

Independent exact-final-source and Cursor reviews precede any remote publication.
A later release/install/runtime decision and live native corrected-draft
acceptance are separate and remain unperformed by this local source work.
