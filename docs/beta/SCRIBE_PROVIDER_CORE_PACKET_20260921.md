# Creator review through Core — proposed local integration packet

Status: prepared for owner approval; no Core edits or activation performed.

## Provider outcome and verified gap

After recording, the creating provider opens the persisted Spanish/English
review, saves an exact accept/reject decision, and returns to the same encounter.
The existing Scribe recorder now mounts that review under an explicit host
binding. The binding requires fresh authorized transport, a scoped encrypted
decision journal and logout/revocation/encounter-change disposal. Its optional
Continue to note entry calls the host's existing Core flow after a fresh review
read. It does not deliver a transcript or generate a note itself.

Read-only inspection of `/Users/jw/Desktop/Cosmas/cosmas-os-core-integration`,
HEAD `e21ba4c1fb1027de8123aca9b8aee25b8a11b612`, found existing dirty/untracked
capture integration work. It was preserved. The existing closed operation union
and `ScribeWorkflowClient.capture_operation` have no creator-review read/decision
operation and never send `X-Scribe-Creator-Actor-ID`. Existing protected source
reads send `X-Capture-Practitioner`, which is a different contract. Merely changing
the URL in a client cannot bridge these contracts safely.

`authorize_admitted_capture_locked` rechecks the existing creator/encounter
binding but returns no immutable Scribe creator actor. Its current admission uses
legacy `SessionCreate`; it does not configure the new captured bilingual source.
The two migration histories also remain unreconciled. Do not imply that adding
the review proxy alone makes new recordings compatible or completes SOAP.

## Smallest next approval requested

Approve **local Core receiver/consumer implementation only**, using the existing
Core capture facade and synthetic disposable databases. Preserve all existing
dirty work. Before each edit, inspect its exact local diff. No other task contact.

Bounded changes in the inspected Core checkout:

1. Add a closed `scribe_creator_review_contract.py` consumer of Scribe's generated
   review view, decision and receipt. Require exact session/current-source lineage,
   bounded responses, and no browser-supplied creator/tenant/reviewer fields.
2. Extend `app/services/scribe_capture_protocol.py` with only `creator_review`
   and `decide_translation` operations. Reuse
   `app/routes/scribe_capture.py`'s existing authenticated operation endpoint and
   current interaction checks, without editing shared authentication parsers.
3. Extend `app/services/scribe_capture_admission.py` and
   `app/services/scribe_capture_gateway.py` to carry the freshly authorized,
   stable creator from the existing binding. Match that actor against the
   configured Scribe session's immutable creator. Fail closed if existing
   identity correspondence does not establish the match; never guess a mapping
   from the practitioner ID or accept an actor header from the browser.
4. Extend `app/services/scribe_workflow.py` to call only
   `GET/POST /v1/captured-sessions/{admitted_session_id}/review`, using the existing
   server-held Entra credential. Supply the matched creator header on the server;
   preserve the exact decision and retry key; prohibit response caching and
   provider-call retries. Reauthorize before returning protected results.
5. Add focused tests under `tests/authority_kernel/` for creator/tenant/view-as/
   revocation rejection, exact retry after lost reply, changed-source conflict,
   and one local HTTP Core→Scribe accepted/rejected review. Use fresh synthetic
   fixtures with explicit matching creator/admission; do not convert old sessions.

This packet does **not** authorize changes to Core auth/session policy, Clerk,
IAM, native token custody, beta invitation/grant schemas, database migration,
combined migration reconciliation, existing recorded sessions, deployment,
environment settings, live providers, release, cohort enrollment or PHI. It does
not activate the new operations in the OS/native host or import another branch.
Recovery leaves this new consumer unused behind the existing disabled facade.

## Subsequent precise blockers

- Configured capture admission must bind the selected language, actual source
  profile and the same immutable creator. Qualify this with the combined migration
  base before proposing an apply. No new admission route is hidden in this packet.
- Core's existing capture-note reader expects its older raw/working-source
  contract. Reviewed bilingual English must enter the existing canonical import
  and SOAP path with preserved lineage. This needs its own concrete consumer
  change once the review route and admission identity are verified.
- The standalone host needs its approved native identity and scoped recovery
  binding. The W13 OS package remains a separate product snapshot. This packet
  does not relabel it or replace its callback/origin configuration.
- A phone-reachable approved HTTPS backend and real credential lifecycle remain
  required. The completed Speech/translation trials stay terminal.

The Scribe handoff section 4 explicitly prohibits shared Core/Auth/IAM/Zoom/staging
edits without a new exact scoped approval. This packet requests only the first
local Core review consumer increment. The full desktop+iOS Scribe goal stays open.
