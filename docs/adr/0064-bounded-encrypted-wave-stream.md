# ADR 0064: Stream a WAV view over retained capture envelopes

Status: accepted for local implementation, September 25, 2026.

## Context

Three-hour mono PCM visits require roughly 346 MB before encryption overhead.
The prior assembly path held all plaintext chunks, a joined WAV, whole-track
ciphertext and later another decrypted WAV. Increasing limits alone would
increase memory pressure. The owner requires reuse and accelerated capacity
verification without a real-time three-hour recording exercise.

## Decision

Reuse the existing per-chunk AES-GCM capture envelopes and authenticated
tenant/session/channel/object/sequence binding. After validating the complete
leased manifest and every chunk, retain original encrypted envelopes in a
private, per-attempt temporary file with a small volatile index. Expose a
seekable WAV using Python RawIOBase/BufferedReader and the current Azure SDK's
multipart transport. Each chunk is digest-checked and authenticated before its
PCM is returned. Only one chunk per stream is retained in plaintext.

Keep media-profile and size checks, nonce uniqueness, private Speech endpoint
validation, consent/job-lease checks, and encrypted temporary-file cleanup.
Close open stream buffers before clearing reader keys. Never expose the
encrypted file's descriptor as if its length were the virtual WAV's length.
The SDK may therefore send a streaming multipart request with chunked transfer;
service acceptance remains part of the later deployment rehearsal.

## Consequences

No new dependency, encryption format or plaintext file is introduced. Chunk
authentication is repeated during consumption to detect changed temporary
data. Seeking is supported for WAV readers and transport retries. Memory is
bounded when the consumer uses bounded reads, as the installed SDK does;
explicit read-all callers can still allocate their requested output.

Admission/configuration limits, native capture renewal, device storage and
screen-lock behavior are separate follow-ups. A three-hour stream-component
test does not establish end-to-end long-visit support. Temporary indexes and
files do not survive worker restart and require no data migration; original
uploaded chunks are untouched. Rollback selects the previous worker after
active jobs finish or cancel.
