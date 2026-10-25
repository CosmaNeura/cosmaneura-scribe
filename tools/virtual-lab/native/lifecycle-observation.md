# Closed recorder observation

The lab distinguishes a fresh recording snapshot from an absorbing close reply.
Navigating to a saved note invalidates recording and admission snapshots; missing
state never proves physical stop. `readClosed()` returns metadata only after a
normal product operation has positively closed the previously observed recorder.
It sends no native request.

On iOS the real bridge reply is `{requestId, ok, recording}`. Normal recording
observations unwrap `recording` only after matching the request ID and success.
A close qualifies only with `ok:true`, `recording:null`, the exact request ID,
and the previously observed recorder/session/auth revision. The pinned
`NativeProviderRecordingBridge.command` awaits `NativeProviderRecordingHost.close`,
then removes its entry. The host drains pending work and confirms physical stop;
its closed instance cannot start again. An idempotent old close reply cannot
settle a later open because every new open/mutation invalidates the observer's
capture generation.

On desktop the exact recorder reply `{requestId,ok:true,state:null}` qualifies
only for a normal `deactivate` of the previously observed recorder. The existing
`DesktopProviderRecorder.deactivate` drains work, confirms stopped state, retires
the source, releases ownership, and leaves the instance unavailable. A normal
workspace `list` or `open` success can also prove closure of its known previous
encounter: `ProviderWorkspaceMain` awaits recorder disposal before returning.
The earlier `encounter_closed` event cannot qualify. Malformed, failed or
uncorrelated transition replies remain unavailable.

The receipt includes `source` (`normal-native-recorder-close-response` or
`normal-desktop-recorder-close-response`), run/workspace/appointment/session,
recorder ID, auth revision, `recordingSource`, `nativeRevisionBeforeClose`,
`closeRequestId`, `closeMethod`, `phase:"closed"`, and the original reply clock.
It also includes `captureMutationSequence`, the unchanged
`currentCaptureMutationSequence`, a fresh `inspectedAtMonotonicMs`, and actual
pending-reply count. The original close timestamp is never refreshed by reads
or a subsequent correlated idempotent close of the same recorder. That repeated
acknowledgement advances the observed mutation sequence but retains the first
close request ID and clock. A failed repetition leaves closure unavailable;
the close reply does not invent a native revision. These fields require the
same verified observer implementation and its still-owned native transport.

Authentication changes, another recorder open/start/mutation/admission, or a
different visit invalidate closure. Normal same-scope saved-note navigation may
retain it while clearing cached notes. A successful actual remount re-arms note
projection; the normal coordinated `note-opening` response is projected as
`action:"read", transportAction:"note_opening"` after exact nonce, scope and
both nested session IDs match. It retains IDs/hashes/field order, never prose.

Coordinator validation must independently match the close scope/recorder/source
and revision baseline against recorded Record and Finish, require current
same-scope mount, a fresh inspection with unchanged capture sequence and zero
pending work, and verify the observer's exact implementation identity. Closure
alone does not prove saved audio, note content, or full acceptance.
