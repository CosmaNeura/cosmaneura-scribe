# ADR 0050 — Preserve the authorized recorder's audio channel through recovery

Status: implemented and checked locally, 2026-09-22; no native activation.

Risk: Tier 2 local capture/recovery metadata change. The qualification and
recovery scope below apply before this code is selected in a native package.

The shared capture controller hardcoded `microphone` in reservation intents and
capture completion. That prevents a desktop source from accurately identifying
mixed meeting audio. The existing server protocol and encrypted queue already
support `microphone`, `mixed` and `system_audio`.

`CaptureSource.channel` identifies one fixed output channel. Omission preserves
the existing microphone behavior. The controller captures the selection at
construction, uses it for reservations and completion, and rejects a different
channel in a server receipt, pending reservation or retained queue. Non-microphone
capture requires the existing configured Core admission path; the direct preview
continues to use its microphone channel and synthetic source.

Configured preparation and active flow records retain the channel immutably.
Existing microphone records remain version 2 with their previous shape. New
mixed/system-audio records use version 3, so older microphone-only clients reject
them before resuming. No existing record is converted, and the store rejects a
channel change or a downgrade to version 2. Database version, encryption, keys,
queue protocol and consent policy are unchanged. This is local encrypted flow
metadata, not a shared/backend schema migration.

The selected source must match retained recording work before restoring capture
authority or audio. A completed configured upload can still enter creator review
without acquiring the old recorder. No source change or recording restart occurs
automatically. This component handles one output channel per capture; it does
not combine two independent sources or implement the desktop audio producer.

Two focused checks reproduce the original microphone-label error, then verify
mixed and system-audio reservation, immutable state, interruption, real encrypted
store reopening, rejection of a microphone source and explicit upload/completion
without restarting recording. They use invented consent and generated PCM with
the local protocol server. All 192 capture checks pass, as do affected types and
lint. The first baseline used a modality outside the existing mock's fixed
consent fixture; `baseline-r2.log` is the actual channel-defect reproduction.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-provider-channels-20260922.ulHYxlkX/`.
The rebuilt provider entry also passes the existing iOS host composition check
with `AbortSignal.any` absent, preserving the microphone host's integration.
This is preparation for the desktop workflow, not Meet/Zoom, microphone, physical
device or live Speech acceptance. Recovery preserves all records and uses a
client supporting their version. Do not remove the channel or downgrade saved
version-3 work to make an older client accept it. No installed app changed.
