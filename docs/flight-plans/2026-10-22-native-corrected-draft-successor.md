# Native corrected-transcript draft successor

Risk: **Tier 2**, deliberately scoped to clinical-source selection and the
additive encrypted local journal contract. Owner: founder; intended initial
cohort: providers' own beta visits. This plan does not activate a cohort or
change Scribe/Core staging, installed applications or configuration.

## Change and invariants

- Preserve every submitted original/successor schema, source and client key.
- Append one explicit higher-version, same-session/same-working-ID successor
  only after durable CAS confirmation. Retain note/transcript history.
- Match the selected key, source and schema after asynchronous receipt parsing;
  reject late replies, wrong sessions, changed lineage and superseded sources.
- Opening and automatic recovery remain GET-only. Only an explicit successor
  retry, after paired current `not_prepared` reads, reuses its retained key.
- Unconfirmed saves and retained unsaved edits block append/retry. Do not apply
  older edits to the replacement. Current clinical review is still required;
  preparation or correction alone never makes a note Session Prep eligible.

## Local acceptance and limits

Use real encrypted-journal adapter/CAS in memory and actual Core wire parsers.
Exercise correction v1→v4→v7, lost-CAS response/reopen, same-key explicit recovery,
source advance, late replies, duplicate clicks, malformed/full history and
pending edits/saves. Surface fixtures prove command/state behavior; separately
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
save as rollback. An unresolved source-bound old save remains retained for
explicit comparison/reconciliation in the dashboard; it can block preparation.
No backend database migration or destructive cleanup is part of this change.

Independent exact-final-source and Cursor reviews precede any remote publication.
A later release/install/runtime decision and live native corrected-draft
acceptance are separate and remain unperformed by this local source work.
