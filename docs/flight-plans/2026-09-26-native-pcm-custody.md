# Native PCM acknowledgement through the encrypted queue

Tier 2. Implements the owner's long-visit/background continuity direction by
joining existing IOSPCMCore delivery to NativeRecordingQueueWriter. The native
sink acknowledges only after the exact encrypted queue record has committed.
Full packets and the final drained partial are cleared on all paths. Lost write
responses reuse the writer's existing exact-successor verification; repeated
packet positions cannot overwrite ciphertext. No WebView acknowledgement is used.

Reuse the existing PCMEmissionSink, native reservation owner, Apple encryption
and SecureQueue schema. Keep at most two 90-position metadata windows. Validate
scope, canonical authenticated data, contiguous reservations and object identity;
late batch replies may omit positions already committed without replaying them.
Retain total byte/position limits and storage headroom in the existing writer.
Window closure permits one final drained partial; termination refuses later PCM.

Package the adapter as a separate product in native-recording, with a local
dependency on the existing ios-pcm-capture core. The package minimum now matches
the established iOS17 capture host. No external dependency or new raw-audio IPC.
The existing Mac auth helper keeps its unchanged base recording target.

Validation covers real IOSPCMCore full/partial drain into reservations produced
by NativeRecordingReservationOwner, native encryption and queue CAS, storage
failure/ambiguous success, cancellation of a durable acknowledgement, sequence
and scope mismatch, late replenishment, bounded reservation storage and the
1080-position three-hour budget. Use generated samples and explicit synthetic
consent only; no microphone, live data, account or fixture writes.

This is a native component, not activation of background capture. Native source
authority/renewal, exclusive flow ownership, host integration and physical
acceptance remain required. Preserve the beta's existing background/extension
guards until that integration is complete. Recovery keeps the foreground host
and all recordings/journals/keys. Record exact-SHA checks and implementer review
under the owner's local-validation merge authority.
