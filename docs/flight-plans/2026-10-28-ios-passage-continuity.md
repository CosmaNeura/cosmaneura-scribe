# iOS passage playback across verified capture restarts

Risk: Tier 2, because this changes authorization-adjacent native audio review.

The iOS passage selector currently refuses every Core continuity receipt. Desktop
already permits an authorized passage when its local encrypted archive proves the
concatenated PCM mapping. This change applies that bounded mapping to iOS's native
microphone archive, including a short PCM chunk flushed by Pause.

Parse Core's closed continuity contract after the unchanged fresh account,
workspace, binding, nonce, session and server-selected segment checks. Preserve
the unknown-gap warning. Pass only ordered restart sequence boundaries to the
native archive; renderer-supplied time ranges remain prohibited.

For continuity playback require the complete sealed manifest, its authenticated
frame index, every consecutive native archive chunk and original microphone AAD,
and every restart boundary within the sealed chunk count. The selected WAV still
requires the original native DEK and authenticated envelope. No pause duration or
missing speech is fabricated; malformed, incomplete or foreign custody is refused.

Validate with synthetic native selection and encrypted-archive tests, Swift 6
checks and iOS native typechecking. Independent source review precedes integration.
Rebuild and rerun the actual normal Pause/Resume, authorized Listen, progress,
Stop/end and same-note hash checks before claiming live playback qualification.
The retained failed Play run remains failed regardless of source-test outcomes.

Recovery: revert this commit and rebuild the native client. No migration, new
credential, cloud setting, queue write, recording or deployment occurs here.
