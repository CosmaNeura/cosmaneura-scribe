# ADR 0011: Per-session audio-key custody and leased assembly

**Status:** Accepted

## Decision

Each capture session uses one client-generated 256-bit AES-GCM data-encryption key (DEK). Scribe
publishes only the current RSA-3072 Key Vault public material as `key_version`, `public_jwk`, and
the fixed `RSA-OAEP-256` algorithm. It validates Key Vault's returned versioned key identifier and
requires the key to permit both `wrapKey` and `unwrapKey`, but no vault or key URL crosses the API.
Only an exact Azure Key Vault hostname and versionless configured key path may receive the
vault-scoped token, and registration rejects a key version that is no longer current.

Before the first upload grant or chunk, while the session is still `created`, the client wraps the
session DEK once and registers only the server-issued key version token and the exact 384-byte RSA
ciphertext. The mutating registration is tenant-scoped, consent-gated, idempotent across processes,
and insert-once per session. Replays return a receipt containing only session ID, key version, and
creation time. PostgreSQL rejects updates while allowing a later authorized retention workflow to
delete the row for cryptographic erasure.

Each chunk uses a unique 12-byte nonce with the session DEK. Its envelope repeats neither the
wrapped DEK nor any key URL. AES-GCM additional authenticated data binds tenant, session, object,
channel, and sequence. The production assembler re-resolves the manifest through the repository
and proceeds only when the request exactly matches registered tenant/session chunks and the named
transcription job holds the matching unexpired lease. The worker atomically renews that exact job
and lease token again after assembly and immediately before any audio is sent to Speech.

The assembler uses managed identity to read the derived object names from private Blob storage and
to call Key Vault `unwrapkey` with RSA-OAEP-256 once per assembly. It verifies each registered
ciphertext length and SHA-256 before decryption, rejects duplicate nonces and noncontiguous channel
sequences, bounds chunk count and aggregate ciphertext before Blob access, and emits channels in
the canonical capture-channel order. The plaintext ceiling is deliberately capped for the 1-GiB
Container Apps memory boundary until assembly and provider upload are fully streaming.

Plaintext WAV tracks are never written to a filesystem. The assembler builds each track in memory,
encrypts it with a fresh process-local AES-256-GCM key, and writes only the encrypted track into a
mode-0700 directory as a mode-0600 file. The transcriber receives a scoped reader that decrypts the
track into memory while its request is active. Context exit zeroes plaintext buffers and ephemeral
keys on a best-effort basis, overwrites and fsyncs encrypted files, and removes the directory on
success, error, or cancellation. Errors are fixed metadata-only codes and never include object
paths, URLs, wrapped keys, or clinical values.

## Consequences

- Key Vault operations and persisted wrapped-key material are constant per session rather than per
  chunk.
- A caller cannot steer unwrap operations to another vault, key, or algorithm.
- Blob compromise alone does not reveal audio, and local ephemeral files remain application-level
  encrypted even if the host-volume encryption boundary is misconfigured.
- Assembly cannot be used as a general Blob reader: repository registration and a live worker lease
  are required together.
- Clients must guarantee nonce uniqueness for all chunks in a session; the assembler detects reuse
  before accepting a track.
- Upload-grant replay revalidates current consent and the bound session key before reissuing the
  still-live, same-object credential.
- This decision does not activate a worker trigger, configure Speech, implement capture clients, or
  define retention timing. Those remain separate reviewed changes.
