# Native recording flow recovery

Tier 2 under the owner's long-visit/recovery implementation and merge authority.
Store the native recording's stable completion intent in the existing encrypted
queue before key/source work. The host must hold exclusive source/flow ownership
and confirm physical stop before reconciliation or sealing. Fresh flow creation
never adopts unknown queue records or replaces legacy key custody.

Recover actual native ciphertext one record at a time, with an autorelease pool
per record. Reuse the existing queue schema/writer and native AES-GCM key to check
scope/AAD, GCM authentication and exact native WAV format. Return counts only;
clear transient plaintext. Reject duplicate/gapped/foreign positions, missing
previously counted audio, upload states before sealing, corruption and excess
capacity. Preserve records on every failure. Retain the 384 MiB ceiling.

Seal the count, completion lease and idempotency intent atomically before upload.
Sealed recovery requires no audio bytes and freezes its original completion
payload, including after uploader purge or a lost Core completion response. It
cannot resume capture. This component does not grant source permission.

Native journals are not a renderer storage surface: hide their keys and reject
reads/writes/deletes through the generic plugin. Renderer Clear refuses before
any deletion when native custody exists, under the same store lock as native
creation. Keep the existing scoped ciphertext upload API and legacy queue decoder
compatible. Native key/source proof and installed app identity are preserved.

Validate crash/lost-write recovery, ciphertext authentication and missing records,
account changes, stable completion/purge recovery, rejection before sealing an
empty recording, full three-hour streaming volume and private-journal protection.
Run applicable native, existing queue/TS, iOS adapter/plugin compilation and local
implementer review. No microphone, device, fixture write, install or deployment.

Recovery leaves this journal/host path unselected; do not delete private custody
or downgrade over an active native flow. Provider/Capacitor routing, live/Core
end-to-end and screen-lock acceptance remain dependent work, not claims here.
