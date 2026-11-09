# ADR 0100: Open the iPhone microphone before Core's start decision

Status: proposed; prototype under device test. Not for production until reviewed
and qualified.

Native iPhone recording asks Core for its one-use start decision before the
microphone opens. On a physical iPhone that request takes about five seconds, so a
clinician can start speaking before capture is live. Microphone startup itself
takes about half a second. The decision owner and compliance have accepted
holding audio briefly in memory before Core confirms it, once a consent record
exists and the clinician has tapped Record.

The native encrypted run may open its own source before consuming the start
permit. The PCM core then starts with no source authority and an authority hold
shorter than one 10-second chunk (9 seconds). Until the permit binds:

- Audio stays in the PCM accumulator. The core refuses to emit any packet, so
  nothing reaches the encrypted queue or leaves the phone.
- Any stop, interruption, route change or failure discards. A full chunk without
  authority is a buffer overflow and is discarded.
- If no permit binds within the hold, the core erases the audio and reports
  `ios_capture_authority_hold_expired`.
- The run stays in its starting phase, so the screen and Live Activity do not
  show recording, and the recording haptic waits for the permit.

The start gate lets only the installed encrypted owner's own source be live
while it consumes. Every other source must still be idle, and retirement still
fences a late permit. Binding gives the source its first authority window and a
one-use run ID. Frames held before binding count toward its frame limit.

A run opts in through `opensBeforeAuthorization`. The iOS factory sets it, and
the previous order remains the default everywhere else.

Consequences: a refused or failed start discards a few seconds of audio the
clinician spoke, and they must be told nothing was recorded. A permit slower than
9 seconds now fails the start instead of succeeding late.

Recovery: set the factory's `opensBeforeAuthorization` back to false. No stored
data, schema or server contract changes.
