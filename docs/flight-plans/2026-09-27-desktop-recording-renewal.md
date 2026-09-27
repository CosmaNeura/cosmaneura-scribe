# Desktop continuous recording

Tier 2. The owner requested long visits, unattended Zoom/Chrome qualification and
performance/essential UX. Existing local checks, implementer review and merge
authority applies. No production, live data, microphone permission or fixture
writes are implied. Preserve original recordings, keys, queues and source proof.

The desktop flow currently has one Core 900-second lease/reservation window.
Its native source, mixer, PCM chunker and flow each enforce that window. Raising
one timer does not support a three-hour visit. Reuse Core issue/renew/reserve,
the existing encrypted flow/queue, native capture/mixer and original exclusive
source owner. No replacement conferencing SDK or additional service is needed.

Receiver first: add an explicit private capture-v3 mode with renewable windows.
The trusted main process must supply its original source identity, short current
deadline, initial frame allowance and fixed hard budget. A continuation may only
extend that active source, in order, within the hard budget, before its existing
wall and monotonic deadlines expire. Duplicate replies must not refresh time.
Existing capture-v2 stays one-window. Native stop, lock/sleep, parent-loss,
backpressure, selection and persistent ownership remain unchanged.

Then connect the main-process recorder to durable Core renewal and reservation
intents. Stage verified reservations before extending native capture; serialize
metadata commits with chunk persistence without placing network work on the PCM
callback. Retain ambiguous renewals/receipts for exact retry. Pause/stop/revocation
must fence late extensions; recovery uses the same key and canonical positions.
Only advertise/use the renewable mode when the complete composition is present.

Validate receiver ordering/expiry/budget/stop races, native mixer continuity and
actual private-pipe behavior with generated samples and synthetic consent. Then
validate accelerated three-hour encrypted flow and crash/upload recovery through
the complete desktop composition. These checks do not prove real Zoom/Chrome,
ScreenCaptureKit permission/silence semantics, microphone routes or elapsed device
latency. Those remain actual-app acceptance, with isolated synthetic audio.

Release control is owner-managed native beta packaging, initially synthetic MCD
acceptance, re-evaluated before the next candidate promotion. No deployment or
cohort activation in the receiver change. Recovery keeps the prior v2 entry and
installed candidate; never erase or downgrade custody records created by a later
continuous writer. No schema/data migration or new external dependency.
