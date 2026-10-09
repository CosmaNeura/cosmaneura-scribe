# Desktop passage playback

Owner authorized the twelve desktop usability fixes, including listening while
correcting transcript wording. This adds local playback for newly recorded
visits. Older uploaded audio already purged on this device is unavailable.

Retain an immutable encrypted envelope copy before acknowledging local chunk
storage. Keep a separate copy of the device-wrapped session key after completed
upload recovery clears its active key. Both use the existing encrypted SQLite
store and creator/encounter device custody. No plaintext audio is written to disk.
Storage capacity reserves twice the queue requirement for the additional copy;
retained audio consumes local disk until a separately authorized retention or
removal workflow is implemented. Logout closes custody; it does not delete audio.

The renderer sends only the session and source segment UUID. Native main checks
the current encounter journal and performs a fresh authorized creator-review
read. It decrypts a maximum of thirty seconds from the current source segment,
refuses uncertain capture continuity and active or unconfirmed native capture,
and returns bounded WAV content. The key is nonextractable and decrypt-only.
The renderer uses a local blob URL with no external media origin and revokes it
on replacement, navigation and logout. Existing upload ciphertext purging,
confirmed-stop, consent, native source authority and recovery remain unchanged.

Synthetic tests cover passage clipping, missing frames, ciphertext authentication,
wrong session/key, revoked mount, and wrapped-key retention after queue recovery.
Physical microphone/phone/application capture and installed latency still require
measured qualification; fixture success does not establish those results.
