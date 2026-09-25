# Bounded audio assembly for long visits — Tier 2

The owner requires three-hour visit capacity and reuse of existing components.
The present assembler holds every decrypted chunk, then a combined WAV, then
whole-track ciphertext in memory. Its reader decrypts the entire track again.
This increment removes that growth before increasing admission limits.

Reuse the existing authenticated capture envelopes, Python file/stream interfaces,
and the installed Azure SDK's streaming multipart transport. Write original
encrypted envelopes into a private temporary track file, retaining only a small
in-memory index. Present a seekable WAV stream that authenticates one bounded
chunk before returning its PCM. Recheck ciphertext digest and AEAD on every
chunk load, including after seeks, so changed temporary data is never trusted.
Validate every chunk and the manifest before presenting any track to Speech.

Keep current consent/tenant/job-lease validation, envelope/AAD/nonce rules,
worker heartbeat, private Speech endpoint checks, permissions and cleanup.
No plaintext files, new dependencies, schema, native changes, service activation,
production deployment, or larger recording capability are part of this increment.
The existing protocol and worker configuration limits remain enforced.

Local validation covers exact WAV frames and seeks across chunk boundaries,
tampering/truncation, invalid media, cancellation and failed-assembly cleanup,
closed readers, bounded read memory, and the actual installed SDK's multipart
path with an offline transport. Use generated synthetic capacity data and
accelerated checks; a real-time three-hour recording is not a beta gate.

Implementation is authorized as the next local capacity fix in the ongoing MCD
beta task. Apply the owner's September 25 local-tests/implementer-review/PR-merge
policy. Record the final commit and findings. Deployment remains separately
controlled. Recovery selects the previous worker image/source after active jobs
finish or cancel; per-attempt encrypted temporary files have no restart format
or database contract. Original uploaded chunks and keys remain unchanged.

Follow with aligned protocol/server/client budgets, continuous verified source
renewal, device disk headroom and screen-lock/background support. Passing this
increment alone does not establish three-hour end-to-end support.
