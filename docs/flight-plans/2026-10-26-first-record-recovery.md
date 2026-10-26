# First Record after a proven pre-dispatch failure

Tier 2: lab ownership and explicit input recovery. No app, service, consent,
capture, TLS, source gate or UI assertion changes. This entry point is dormant
until a separately reviewed concrete operator calls it.

An actual lab wrapper required a new admission-observer delivery after a long
consent pause. The delivery cache had expired after 120 seconds. The maintained
restore path already accepts the original normal consent receipt when a fresh
native read still answers for that session. The wrapper failed before calling
its base input method, but the engine had already journaled pending Record.
Default recovery correctly quarantines that unknown action and must keep doing so.

## Explicit proof and ownership

`recoverFirstRecord` requires a bounded independent review, not just a caller's
claim that counters are zero. The review binds the full original wrapper bytes,
failure result, hash-chain journal, cleanup, original intent and exact retained
lease. The reviewer must trace the precise failure through those wrapper bytes
and establish that no Record/native-source input was dispatched. The current
implementation accepts only the demonstrated `admission_not_observed` boundary.
A matching error label alone is insufficient review evidence.

The original journal stays FAIL with pending Record. Its original runtime is
loaded from a separately pinned frozen directory, checked against its existing
implementation receipt and journal identity. Its `recoverRun` still acquires
the guard, refuses live/foreign owners, inspects current native state, closes
only newly owned controls and grants its opaque same-process lease. The new
helper is separately hash-bound recovery code; it is not inserted into the old
runtime or represented as its original implementation.

Before inspection and first input, the operator's reviewed `inspectTarget`
callback must independently observe the exact PID/start/executable/bundle and
hardware, absence of the old coordinator, the current owned control session,
no foreign control session, no active input client, and no unresolved source
process ownership. During restored preparation, the exact owned silent source
graph may exist; its identity must be checked rather than inferred from an
empty new adapter. Existing native/source initial-silence and custody gates
remain in `AppiumUI.perform`.

Fresh native proof must show the same mount/auth revision/session/recorder,
ready and not busy, zero capture attempts/frames/chunks/bytes, null signal and
the unchanged observer implementations with no pending replies. Zero counters
alone do not prove no dispatched input: native start can reject before the
diagnostic counter increments. The independently reviewed pre-dispatch failure
and settled controls are also mandatory. Process identity is essential because
the native attempt counter resets on process restart.

The original consent receipt and timestamps are preserved. A non-null current
receipt must match it, and a current native read must match that session.
Unknown/malformed cache state is refused. This is not a consent renewal;
normal product authorization still decides whether Record can proceed.

The operator's `beforeRecord` callback must validate the currently approved
speech observation scope and its actual consent tuple. The complete additional
current proof is bounded to two seconds; no existing observer or custody budget
is extended. The outer operator must preserve the existing bounded parent-loss,
abort and cleanup supervision, and must independently pin this helper and all
of its imports in addition to the frozen original runtime.

## One input and retained failures

Only pending Record can use the explicit path. An exclusive, fsynced
`first-record-recovery.intent.json` in the original output is written before
the first normal `perform(record)` call. Any existing intent, lost response,
aborted call or later failure prevents another dispatch. No automatic retry,
intent removal or new intent path is supported.

The original engine records only actual UI/native observations. It appends its
normal observed Record event after the first successful dispatch; the previous
failure and every original event remain unchanged. It then follows the existing
source, Finish, Save, reopen and dashboard gates. Results are recovery evidence,
never pristine journey/performance acceptance. A failed release remains under
the original quarantine policy.

Recovery is to stop using this entry point, retain all artifacts/intent/leases,
and return to read-only reconciliation. No deployed runtime rollback or data
migration applies. Local tests use synthetic controls only; actual native
recovery remains NOT_RUN until a separately reviewed operator succeeds.
