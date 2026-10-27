# Synthetic dashboard verification: owned notes list

Tier 2: this changes the lab browser's read boundary. It changes no product API,
account, consent, stored note, deployment, or production behavior.

The ordinary Core note detail route has a notes-layout loader which requires
`GET /internal/v1/notes`. Blocking that read prevents the layout from rendering
its child even when the exact saved-note request returns 200. Core at
`97614048041a0de6b50cd43dea6502d956a26f03` scopes that list to the authenticated
`request.state.doctor.id`; it accepts no appointment query parameter. Its list
contains appointments, patient display names, and current-note status, not note
or transcript bodies. The lab accounts and Cosmas MD synthetic practice are the
authorized cohort. This permission must not be reused for a non-synthetic account.

The verifier now permits only that exact GET URL after normal Settings, inactive
view-as, and current Clerk identity verification. It retires the permission while
refreshing account evidence before reopen. Missing or mismatched account evidence,
query strings, other methods, other origins, and other appointment details remain
blocked. Cross-account denial verification retains its existing list restriction.
The exact saved note, transcript, ordered content hash, doctor, and new reopen
response remain required; a successful list or network response cannot establish
a visual pass. A failed rendered check retains its stage and a bounded screenshot
only after a fresh passive account check confirms the same identity, session,
and doctor. A missing, failed, or pending scope response retains no screenshot.

Validation includes the exact request boundary and the maintained verifier's
normal account-before-list ordering, wrong-account refusal, failure screenshot,
and browser cleanup. A fresh actual staging run is required after source review.
The earlier dashboard failure and all native recording, Finish, Pause/Resume, and
Listen limitations remain unchanged.

Recovery is to retire this lab runtime and rebuild the next lab runtime from the
prior coordinator source. No data rollback, schema change, or live account change
is involved. Do not edit sealed failed-run artifacts or relabel them as passing.
