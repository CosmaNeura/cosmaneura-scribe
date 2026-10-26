# Native saved-passage playback

Status: implementation in a reviewed stack; not device-qualified.

The shared review UI has Desktop passage playback, but the iOS provider supplies
no playback capability and its upload queue correctly purges registered audio.
Adding a Listen button alone cannot recover that audio.

Retain immutable encrypted envelopes in a separate `scribe-native-passage:v1`
namespace, protected by the existing device-encrypted SecureQueue store. Its
renderer interface excludes all `scribe-native-` custody. Keep upload receipts,
queue purge, consent and source admission unchanged. Native seal completes this
retention before upload purge, including an explicit upload recovery after a
crash. Missing historical audio stays unavailable; it is never reconstructed
from transcript text or another client's recording.

Playback uses the current native account and a fresh authorized Core
`creator_review` response for the selected workspace, binding and session. The
renderer selects only a source segment identifier. Native code selects its
original time range, limits it to 30 seconds, authenticates the original AAD and
envelopes, and restores the existing Swift-held key without replacement or
rebind. No tenant, time range, key, URL or file path comes from the renderer.
Audio remains in native memory and is passed to an owned native player. Only
playback metadata and Stop/Read commands cross the bridge.

Playback stops on cancellation, authority change, navigation/disposal,
backgrounding and audio interruption. Native capture takes priority and cannot
start while an old playback operation can complete late.

This is Tier 2. See the [flight plan](../flight-plans/2026-10-26-ios-saved-passage.md).
