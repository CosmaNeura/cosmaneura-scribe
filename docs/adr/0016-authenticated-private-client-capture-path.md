# ADR 0016: Route authenticated capture through the platform and a private Blob edge

**Status:** Accepted (implementation and clinical capture remain disabled)

## Context

ADR 0009 makes responsive web and native mobile capture separate first-class clients. ADR 0011
defines per-session key custody and the encrypted chunk format. Two network and identity gaps still
prevent either client from implementing that design safely:

- every Scribe `/v1/*` route accepts only the master platform's Entra workload identity, which must
  never be placed in a browser or mobile application; and
- the audio account has `public_network_access_enabled = false`, while the current upload-grant
  response names the account's public Blob hostname. A client on the public internet cannot use
  that URL even when its one-object user-delegation SAS is otherwise valid.

The current grant also creates the object ID and expiring credential together. An offline client
cannot encrypt a final ADR 0011 envelope until it knows the server-issued object ID used in the
AES-GCM additional authenticated data (AAD). After that grant expires, the API cannot issue a new
credential for the same object. Those are protocol gaps, not client retry bugs.

## Decision

### Keep user authentication and workload identity at the platform boundary

Web and mobile authenticate to the existing master platform as users. The platform backend-for-
frontend (BFF) verifies the user, practice, appointment, and encounter authorization, derives the
practice tenant itself, and then calls the private Scribe API with its Entra workload identity and
the `Scribe.Workflow.Access` application role. A client-supplied tenant ID is never trusted.

The browser or native application receives neither the Entra access token nor a credential capable
of requesting one. The BFF returns only the minimum client contract: consent and session receipts,
the public wrapping JWK, server-generated AAD bytes, opaque object IDs, an edge upload URL, and
metadata-only operation receipts. It strips internal endpoints and never returns an Azure resource
ID, Key Vault URL, Blob origin hostname, managed-identity client ID, or Scribe bearer token.

The web client uses the platform's same-origin, secure user-session mechanism with CSRF protection.
The native client uses the platform's authorization-code/PKCE flow and stores refresh material only
in platform secure storage. Exact web origins are allowlisted; wildcard CORS, embedded client
secrets, and a direct user-token authentication mode on Scribe are rejected. User authorization is
checked on every BFF operation, not just at session creation.

`GET /v1/audio-encryption-key` remains a private workload route. After it authorizes a specific
user and encounter, the BFF calls that route and may briefly cache its non-secret public response
by `key_version`. A bind rejected because a cached version rotated causes one authenticated refresh
and rewrap with a new idempotency key. The private RSA material and unwrap permission remain only in
Key Vault and the separately gated transcription identity.

### Bind one client-generated key before capture

After the server has accepted an all-party consent record and created a session, the client:

1. generates one 32-byte session DEK with the operating system CSPRNG;
2. wraps it with the returned RSA-3072 public JWK using RSA-OAEP with SHA-256;
3. submits only the unpadded base64url 384-byte wrapped value and `key_version` through the BFF; and
4. waits for the immutable audio-key receipt before it opens an audio input.

The DEK is never sent in plaintext, copied into application logs or analytics, or repeated in a
chunk. Each mutation has a client-generated idempotency key that is persisted before the request
and reused with the byte-identical body after timeouts or process restarts.

### Separate durable object reservation from an expiring upload credential

Before client implementation, extend the server contract so a tenant-scoped, consent-gated,
idempotent reservation binds `(session, channel, sequence)` to one server-generated `object_id`.
The response includes the exact base64url AAD bytes produced by the server's authoritative capture-
protocol encoder. Reservations may be allocated in a bounded batch while online so an authorized
client can continue an already-started capture during a short outage.

Upload authorization becomes a separate operation over an existing reservation. Reissuing an
expired credential keeps the same object ID and AAD, revalidates consent and session state, and is
refused after that chunk is registered or the session is closed. The current endpoint that creates
a new object with every new idempotency key is not sufficient for offline recovery and must not be
wrapped in client-side workarounds.

The current Python envelope and AAD functions remain authoritative until they are promoted into one
versioned capture-protocol source that generates the Python and TypeScript implementations plus
cross-language golden vectors. Web and mobile must consume that package; they must not independently
recreate JSON ordering, envelope framing, enums, or limits. A reservation-provided AAD value also
keeps the platform-derived tenant boundary out of client input.

For each reservation, the client encodes one accepted WAV chunk, generates a unique 12-byte AES-GCM
nonce, encrypts with the session DEK and returned AAD, and writes the complete immutable envelope to
its encrypted queue before any network request. The nonce and ciphertext are never regenerated for
that object. Registration reports SHA-256 over the complete envelope and its exact byte length.
Retries upload those identical stored bytes, so a lost success response is an idempotent overwrite,
not a second encryption under the same nonce. The server continues to reject duplicate nonces,
objects, and `(channel, sequence)` positions and verifies the digest before decryption.

### Use an Azure Front Door Premium private origin for direct ciphertext upload

The recommended production data path is a dedicated upload hostname on Azure Front Door Premium
with Private Link to the Blob origin. The storage account keeps public network access disabled and
shared-key access disabled. The BFF obtains the existing one-object user-delegation SAS from Scribe
and returns an HTTPS URL on the approved upload hostname; it never redirects a client to the Blob
account hostname. Front Door forwards the request to the approved private `blob` origin.

The route permits only `PUT` and the minimum browser preflight behavior, disables caching and
compression, enforces TLS, bounds request bodies and edge request rate, and uses exact origin rules.
The BFF separately rate-limits grant issuance per user, tenant, and session. The SAS remains
create/write-only, scoped to one reserved object, and uses a production-configured maximum lifetime
of 15 minutes. It is held in memory only and excluded from service-worker caches, browser history
where supported, persistent queues, analytics, crash reports, support captures, and logs. Front
Door, WAF, Storage, and BFF diagnostics may be enabled only after a synthetic test proves that query
strings, SAS values, Blob paths, object names, and bodies are absent or reliably scrubbed. Metrics
and fixed result codes remain available.

This choice must be proven with a real synthetic `PUT` through Front Door while the storage public
endpoint remains denied, followed by a private-path read and envelope verification. Front Door's
private-link approval, custom-host forwarding, SAS validation, CORS behavior, maximum body size,
and log scrubbing are platform acceptance gates rather than assumptions.

An API-mediated streaming upload is the fallback if that proof, service eligibility, diagnostics,
or cost review fails. In that design a dedicated, bounded upload gateway authenticates the user via
the BFF/capability boundary, hashes ciphertext while streaming, and writes to private Blob with a
write-only managed identity. It must not add Blob read/list/delete or Key Vault permissions to the
BFF. It costs more compute and makes the application tier an audio data plane, so it is not the
default. Enabling the Blob public endpoint, allowing arbitrary networks, placing a storage account
key in a client, or requiring a general-purpose VPN for ordinary mobile capture are rejected.

### Make retries and recovery explicit state machines

The shared client contract has durable states for `reserved`, `encrypted`, `uploading`, `uploaded`,
`registered`, and `purged`. It stores the reservation, envelope, digest, byte length, and stable
idempotency keys atomically. It never persists a SAS URL, Entra token, raw DEK, patient display
value, or Blob path. At most two chunks upload concurrently, with exponential backoff, jitter, and
`Retry-After` support.

A timeout at any mutation is treated as an unknown success and replayed with the same key and body.
An expired upload URL is refreshed for the same reservation. Authentication may refresh once; a
consent, authorization, immutable-field, quota, or closed-session rejection stops capture rather
than looping. The client registers a chunk only after Blob accepts the complete envelope, retains
the local envelope until the server returns the registration receipt, and completes a session only
after every channel has a contiguous registered sequence. A retriable receipt/status operation is
required so recovery never has to infer success from a local flag.

Browser refresh or crash recovery may resume upload of already encrypted envelopes. It must not
claim that a lost in-memory audio buffer was durable. Native recovery additionally handles process
death, lock, audio-route changes, and background limits with platform-specific tests. Neither
client silently falls back to plaintext storage or starts a second session to evade a conflict.

### Keep consent and worker triggering on the server side

Recording controls remain disabled until the server has accepted all-party consent, created the
session, bound the wrapped DEK, and issued a short-lived capture-authorization lease. The lease is a
bounded offline authorization derived from the consent record, not a second consent source. It is
renewed only after the BFF rechecks authorization and Scribe revalidates consent. Expiry, explicit
revocation, sign-out, or a user stop immediately closes audio input and blocks new chunks. Offline
capture cannot start without a live lease and pauses when the lease or reserved-object budget is
exhausted.

The client may request `complete` through the BFF; that transition is only a declaration that its
registered upload is finished. It does not authorize Speech, start an Azure Container Apps Job, or
receive job arguments or Azure control-plane permission. A separately reviewed internal trigger
claims the uploaded session, revalidates consent, and starts the leased transcription path behind
its own false-by-default flag. Until that trigger is activated, only the governed manual operator
path in ADR 0012 may start transcription.

### Separate web and native custody

The clients share generated API/envelope code and visual components, not runtime promises or
release artifacts.

- **Web/PWA:** foreground capture only. The active DEK is a non-extractable WebCrypto key after its
  one-time wrap. A supported browser may persist that origin-bound `CryptoKey` in IndexedDB for
  crash recovery, but never raw key bytes; strict CSP, Trusted Types where available, no third-party
  script/analytics, storage-eviction tests, and an exact-origin service worker are required. Same-
  origin script compromise can still invoke a non-extractable key, so web is not presented as
  hardware-backed custody and cannot promise recording through lock/background suspension.
- **Native iOS/Android:** native modules own audio, background behavior, and the queue. A non-
  exportable, this-device-only Keychain/Keystore key protects the session DEK at rest; cloud backup
  and device migration are disabled. The DEK is available in process memory only while needed.
  Signed builds, jailbreak/root posture, calls/alarms/Bluetooth/route changes, lock, disk pressure,
  and remote sign-out receive separate acceptance tests.

Both clients best-effort zero temporary key/audio buffers, purge each envelope after its server
receipt and the bounded recovery window, and remove remaining local custody on completion,
revocation, sign-out, or policy expiry. The server retention and legal-hold workflow remains
independent under ADR 0013.

### Advertise and enforce server-owned limits

Session bootstrap returns versioned server capabilities instead of clients hard-coding a second set
of limits: accepted media format, target chunk duration, maximum envelope bytes, maximum chunks,
remaining aggregate plaintext bytes, capture-lease expiry, reservation window, and upload
concurrency. The client warns before a limit, stops safely at it, and never truncates or silently
drops a completed chunk.

The current 64-MiB aggregate assembly boundary allows roughly 35 minutes of one-channel PCM16 mono
16-kHz audio or 17 minutes total for two channels. That is an activation limit, not a client UX
default. A clinical pilot whose maximum encounter can exceed it requires the separately reviewed
streaming/memory change already called out in ADR 0011. Offline duration is additionally bounded by
the unexpired capture lease, reserved objects, encrypted local storage budget, and the server's
remaining assembly budget.

## Threat model and controls

| Threat | Primary controls and remaining limit |
| --- | --- |
| Stolen user session | BFF encounter authorization on every call, short sessions, revocation, rate/size limits, and no Scribe workload token in the client. A valid stolen user session still has that user's bounded authority. |
| Workload-token disclosure | Entra token acquisition and `X-Tenant-ID` stay server-side; responses strip internal identifiers/endpoints; token/SAS values are prohibited from logs and telemetry. |
| SAS leakage or replay | One object, create/write only, at most 15 minutes, edge hostname only, no persistence/referrer/telemetry, and no new grant after registration. The edge route can be disabled immediately; an issued SAS otherwise remains valid until expiry. |
| Blob or edge compromise | Blob contains AES-GCM envelopes only; the DEK is wrapped to Key Vault; no client or edge has unwrap permission. Encrypted audio is still regulated data and must use approved services and diagnostics. |
| Malicious/reordered client | Server-derived tenant/AAD, immutable reservations, unique nonce checks, digest/size verification, contiguous sequence checks, consent gates, quotas, and PostgreSQL tenant isolation. |
| XSS or compromised native process | Strict first-party web origin and signed native builds reduce risk, but code executing in the client can use an active DEK. No design can make capture safe after full client-process compromise. |
| Lost device or browser profile | Encrypted queue, origin/device-bound key, no backup, short offline lease, remote revocation on reconnect, and bounded purge. Already decrypted audio in an active process cannot be remotely recalled. |
| Network loss or duplicated requests | Stable reservation/object/AAD, atomically stored immutable envelope, distributed idempotency records, same-object grant refresh, receipt lookup, and bounded retry. |

## Rollout and rollback

1. Record the accepted defaults below. Do not add client implementation in this infrastructure
   slice.
2. Add the reservation/refresh/receipt/capability contract, one generated protocol source, and
   Python/TypeScript golden vectors. Prove every mutation with HTTP-level PostgreSQL/RLS tests and
   cross-process retries. Keep capture flags false.
3. Add BFF authorization with a synthetic tenant and prove no client can supply tenant context or
   obtain a Scribe workload token. Test consent revocation and cross-tenant denial.
4. Deploy the upload edge disabled, approve only its Blob private link, and run the synthetic
   private-origin, diagnostics-scrubbing, retry, expiry, and size-limit acceptance suite.
5. Enable a synthetic web canary, then a separately signed native canary. Web and mobile have
   independent tenant allowlists and kill switches. Clinical enablement requires the duration,
   offline, retention, BAA/service-eligibility, support, and incident decisions below.

Rollback disables capture initiation in the platform first, then the edge route and client tenant
flags. Existing registered ciphertext remains private and follows ADR 0013; in-flight clients may
only drain already authorized immutable envelopes during a deliberately bounded window. Do not
delete the wrapping key, identities, reservations, or receipts as a rollback mechanism. A protocol
failure stops capture and preserves the encrypted queue for governed recovery; it never enables a
public Blob endpoint or plaintext fallback.

## Accepted rollout defaults

1. **Upload edge:** Azure Front Door Premium with a Private Link Blob origin is the production
   ciphertext path, contingent on the real private-origin/SAS/log-scrubbing proof and an approved
   cost/service review. Use the API-mediated gateway only if a gate fails.
2. **Offline consent bound:** Capture cannot start offline. Use a renewable 15-minute lease and a
   15-minute pre-reservation window, and pause visibly at expiry.
3. **Web key recovery:** A supported browser may persist a non-extractable origin-bound WebCrypto
   session key only on the tested browser allowlist. Otherwise recover completed-envelope uploads
   but do not resume recording after refresh or crash.
4. **Clinical duration:** Clinical capture requires streaming assembly sufficient for a 60-minute,
   two-channel visit; do not raise the current 1-GiB job's memory limit by guess.
5. **Abandoned device custody:** Keep an encrypted, unregistered local queue for at most 24 hours,
   with prominent recovery warnings and metadata-only support escalation, then policy-driven purge.
   MDM remains optional for the first controlled pilot and becomes tenant-configurable.

## Consequences

- Clients use the platform's existing user authorization without weakening Scribe's private
  workload-identity boundary.
- Public network access stays disabled on the PHI storage account while encrypted chunks have a
  narrowly scoped internet ingress path.
- Offline-safe encryption requires a server reservation/refresh protocol and generated wire
  contract before either client can be written.
- Direct edge upload avoids application-tier audio bandwidth but adds Front Door Premium cost,
  private-link approval, diagnostic-scrubbing, and real-platform acceptance work.
- Web and native share cryptographic semantics while making materially different custody and
  background guarantees explicit.
- This ADR does not implement a client, expose Scribe publicly, activate transcription, grant job
  start permission, enable clinical capture, or change retention policy.
