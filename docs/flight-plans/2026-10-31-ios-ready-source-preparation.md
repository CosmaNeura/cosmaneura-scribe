# iOS first-Record source preparation

Risk: Tier 2, existing native source authority boundary. This change moves only
unissued first-interval preparation into the retained native Ready host. It does
not change the receiver contract, consent, microphone permission, process fences,
source preparation expiry, or the 15-second capture capability lifetime.

The observed build 89 full synthetic workflow completed recording, Pause/Resume,
Finish, Save/reopen, Listen and dashboard verification. Its native start-to-first
PCM was 5,854.812 ms; 5,384.628 ms was the combined source preparation request
issued inside Record. This source change does not establish a new timing result.

## Sequence and custody

1. The existing authenticated host opens the durable recording window. For an
   unused first interval only, persist the original source stop proof and send
   preparation without an authorization request. Ready opens no audio graph and
   asks for no microphone permission. The existing opening state keeps Record
   unavailable until this preparation has succeeded.
2. Refresh only after the native preparation expires. Confirm cancellation of
   the expired owner before constructing another. Ambiguous preparation or
   cancellation remains retained in preparationFailed; it never schedules a
   background retry. Expiry refresh returns to opening until the new owner is
   valid, rather than continuing to claim Ready.
3. Record revalidates session, lease, sequence and
   native expiry, and preserves the existing durable source checkpoint. The run
   still requests permission, authorizes once and consumes its native capability
   immediately before acquiring audio. Resumed intervals keep the existing path.
4. Pause, close or account retirement fences refresh and joins any in-flight
   source preparation before confirming the original stop proof. Recording and
   encrypted finalization guards remain unchanged.

## Validation and recovery

Compile the actual Swift bridge for macOS and iOS, and run the maintained
synthetic native host/source/run checks. Focused cases cover unissued Ready,
same-owner Record reuse, expiry cancellation, cancellation failure custody,
in-flight close, expiry refresh and no early authorization. Independent review
must follow the final source push. A rebuilt current iOS client must pass the
real first-PCM timing gate; source checks cannot qualify it.

Recovery: revert this source change and rebuild the client. Preserve all durable
recording data and source stop proofs; existing stop-only recovery settles a
retained unissued owner. No migration, cloud setting or production activation is
included.
