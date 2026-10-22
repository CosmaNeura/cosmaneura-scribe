# Native corrected-transcript draft successor

Risk: **Tier 2**, deliberately scoped to clinical-source selection and the
additive encrypted local journal contract. Owner: founder; intended initial
cohort: providers' own beta visits. This plan does not activate a cohort or
change Scribe/Core staging, installed applications or configuration.

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
